//! The session's permission state (TODO §4.1, §12): the ceiling the host declares at `runtime.initialize`, and
//! the one part of it the host may replace afterwards — which MCP servers the user has approved.
//!
//! ## Why that one part is replaceable
//!
//! Approved roots are known when the app starts. An approved MCP server is not: the user says yes to one
//! whenever they add it, which is routinely long after the sidecar was spawned. A ceiling frozen at the
//! handshake therefore denied every server approved later — and since the host sent no approved servers at
//! the handshake at all, in practice it denied every MCP call there was, with "outside the configured
//! ceiling".
//!
//! Replacing the list is not the runtime widening its own ceiling. Only the host can send it, the host sends
//! exactly the servers its config marks approved — a flag only a human sets — and nothing a model produces
//! reaches this method. The filesystem half of the ceiling cannot be changed after the handshake at all.

use agent_ipc::protocol::InitializeParams;
use agent_permission::{Capability, CapabilityKind, Grant, PermissionRuntime, Policy, Scope};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

#[derive(Default)]
pub struct SessionPermissions {
    /// `None` until the handshake — and until then the ceiling grants nothing, which is the safe default
    /// rather than a permissive one.
    ///
    /// Replaced whole, never edited in place: a decision already under way keeps the policy it started with.
    runtime: RwLock<Option<Arc<PermissionRuntime>>>,
    /// Whether the host declared a policy at the handshake.
    ///
    /// Read only by the SANDBOX now: MCP enforcement became unconditional (§0.2 F7), but confining a command
    /// to an empty allowlist would stop it exec'ing a shell at all, which is a different failure from denying
    /// it — so an undeclared policy means "unconfined", not "confined to nothing". Deliberately NOT set by
    /// [`Self::set_approved_mcp_servers`]: approving a server says nothing about where commands may write.
    declared: AtomicBool,
}

impl SessionPermissions {
    /// Build the ceiling from the handshake. The first handshake's policy stands, as it always has.
    pub fn initialize(&self, p: &InitializeParams) {
        let roots: Vec<PathBuf> = p.workspace_roots.iter().map(PathBuf::from).collect();
        // Did the host declare a policy at all? The distinction matters more than the contents.
        let declared = !roots.is_empty() || !p.approved_mcp_servers.is_empty();
        self.declared.store(declared, Ordering::SeqCst);

        let mut capabilities = Vec::new();
        if !roots.is_empty() {
            // Read AND write. An approved root is a directory the user has told the agent to work in, and a
            // grant that allowed reading but not writing would deny `write_file` inside the very workspace the
            // sandbox already lets a command write to — two layers disagreeing about the same directory.
            for kind in [CapabilityKind::FilesystemRead, CapabilityKind::FilesystemWrite] {
                capabilities.push(Capability::paths(kind, roots.clone()));
            }
        }
        capabilities.extend(mcp_capability(p.approved_mcp_servers.clone()));
        let policy = Policy {
            ceiling: Grant::of(capabilities),
            approval_required: if p.require_approval_for_mutations {
                vec![CapabilityKind::FilesystemWrite, CapabilityKind::FilesystemDelete, CapabilityKind::ProcessSpawn]
            } else {
                Vec::new()
            },
            max_depth: agent_permission::DEFAULT_MAX_DEPTH,
        };

        let mut slot = self.runtime.write().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(Arc::new(PermissionRuntime::new(policy)));
        }
        if !declared {
            tracing::warn!(
                "the host declared no permission policy; commands run unconfined and no MCP server may be called \
                 until the host approves one"
            );
        }
        tracing::info!(roots = roots.len(), mcp_servers = p.approved_mcp_servers.len(), "permission policy set");
    }

    /// Replace the approved MCP servers with exactly `servers`, leaving the rest of the ceiling as it is.
    ///
    /// The whole list rather than a delta, so the host never has to know what the runtime last heard: a
    /// restarted sidecar, a lost reply and a revoked approval are all settled by sending the list again.
    /// Returns false before the handshake, when there is no policy to amend.
    pub fn set_approved_mcp_servers(&self, servers: Vec<String>) -> bool {
        let mut slot = self.runtime.write().unwrap_or_else(|e| e.into_inner());
        let Some(current) = slot.as_ref() else { return false };
        let old = current.policy();
        let capabilities = old
            .ceiling
            .capabilities()
            .iter()
            .filter(|c| c.kind != CapabilityKind::McpInvoke)
            .cloned()
            .chain(mcp_capability(servers.clone()));
        let policy = Policy {
            ceiling: Grant::of(capabilities),
            approval_required: old.approval_required.clone(),
            max_depth: old.max_depth,
        };
        *slot = Some(Arc::new(PermissionRuntime::new(policy)));
        tracing::info!(mcp_servers = servers.len(), "approved MCP servers replaced");
        true
    }

    /// The session's permission runtime, or `None` before the handshake.
    pub fn get(&self) -> Option<Arc<PermissionRuntime>> {
        self.runtime.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The session's permission runtime, or a deny-everything one if the handshake set none.
    ///
    /// For call sites that decide: a missing ceiling must fail closed, and an `Option` there would invite a
    /// caller to treat "not configured" as "unrestricted".
    pub fn current(&self) -> Arc<PermissionRuntime> {
        self.get().unwrap_or_else(|| {
            Arc::new(PermissionRuntime::new(Policy {
                ceiling: Grant::empty(),
                approval_required: Vec::new(),
                max_depth: agent_permission::DEFAULT_MAX_DEPTH,
            }))
        })
    }

    /// The filesystem roots the ceiling approves, or `None` when the host declared no policy (see `declared`).
    pub fn declared_roots(&self) -> Option<Vec<PathBuf>> {
        if !self.declared.load(Ordering::SeqCst) {
            return None;
        }
        let permissions = self.get()?;
        let mut roots: Vec<PathBuf> = Vec::new();
        // Read and write each carry the same roots; keep the first of each, in order, since the first root is
        // the one the sandbox builds its workspace around.
        for c in permissions.policy().ceiling.capabilities() {
            if let Scope::Paths(paths) = &c.scope {
                for p in paths {
                    if !roots.contains(p) {
                        roots.push(p.clone());
                    }
                }
            }
        }
        Some(roots)
    }
}

/// The `mcp.invoke` capability for these servers, or none at all for an empty list.
fn mcp_capability(servers: Vec<String>) -> Option<Capability> {
    (!servers.is_empty()).then(|| Capability::new(CapabilityKind::McpInvoke, Scope::Names(servers)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_permission::Resource;

    fn handshake(roots: &[&str], servers: &[&str]) -> SessionPermissions {
        let params: InitializeParams = serde_json::from_value(serde_json::json!({
            "protocol_version": "1.1",
            "workspace_roots": roots,
            "approved_mcp_servers": servers,
            "require_approval_for_mutations": true,
        }))
        .expect("params");
        let session = SessionPermissions::default();
        session.initialize(&params);
        session
    }

    fn may_call(session: &SessionPermissions, server: &str) -> bool {
        session.current().policy().ceiling.allows(CapabilityKind::McpInvoke, &Resource::Name(server.into()))
    }

    #[test]
    fn a_server_approved_after_the_handshake_is_callable() {
        let session = handshake(&["/work"], &[]);
        assert!(!may_call(&session, "local-mcp"));
        assert!(session.set_approved_mcp_servers(vec!["local-mcp".into()]));
        assert!(may_call(&session, "local-mcp"));
    }

    #[test]
    fn the_list_is_replaced_not_merged_so_a_withdrawn_approval_is_denied() {
        let session = handshake(&[], &["a", "b"]);
        session.set_approved_mcp_servers(vec!["b".into()]);
        assert!(!may_call(&session, "a"));
        assert!(may_call(&session, "b"));
        session.set_approved_mcp_servers(Vec::new());
        assert!(!may_call(&session, "b"));
    }

    /// The filesystem half is the handshake's alone: amending the MCP list must neither drop nor widen it.
    #[test]
    fn replacing_the_servers_keeps_the_roots_and_the_approval_rules() {
        let session = handshake(&["/work"], &[]);
        session.set_approved_mcp_servers(vec!["x".into()]);
        let permissions = session.current();
        let policy = permissions.policy();
        assert!(policy.ceiling.allows(CapabilityKind::FilesystemWrite, &Resource::Path("/work/a".into())));
        assert!(!policy.ceiling.allows(CapabilityKind::FilesystemWrite, &Resource::Path("/etc/a".into())));
        assert_eq!(policy.approval_required.len(), 3);
        assert_eq!(session.declared_roots(), Some(vec![PathBuf::from("/work")]));
    }

    /// An approved server is not a sandbox policy: a host that declared nothing stays unconfined.
    #[test]
    fn approving_a_server_does_not_confine_commands() {
        let session = handshake(&[], &[]);
        session.set_approved_mcp_servers(vec!["x".into()]);
        assert_eq!(session.declared_roots(), None);
    }

    #[test]
    fn nothing_is_amended_before_the_handshake() {
        let session = SessionPermissions::default();
        assert!(!session.set_approved_mcp_servers(vec!["x".into()]));
        assert!(!may_call(&session, "x"));
    }
}
