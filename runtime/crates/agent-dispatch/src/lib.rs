//! Tool dispatch — turning what a model emitted into something that actually ran.
//!
//! Stage 6c of TODO §2.1, and the stage that finally gives `agent-permission` a caller. Until now that crate
//! was complete, tested, and reachable from nothing: TODO §0.2 recorded it as orphaned, and §4's pipeline
//! existed as a diagram rather than as code.
//!
//! ## The pipeline
//!
//! §3.3 requires every tool call to follow one path. This is it, in order:
//!
//! ```text
//! model's call
//!      ↓  route      —  unwrap `call_tool`, so the RESOLVED name is what everything downstream sees
//!      ↓  read args  —  the `arguments` string, with its near-misses recovered and its truncations refused
//!      ↓  permission —  capability + scope, decided once, at one boundary
//!      ↓  execute    —  the registry, which owns timeout and cancellation
//!      ↓  result
//! ```
//!
//! Each step can end the call, and each ends it by producing a **result the model reads** rather than an error
//! that aborts the turn. A denied call, an unreadable payload and a failing tool all come back the same way,
//! because from the model's side they are the same kind of event: something it asked for did not happen, and
//! it needs to know why in order to do something else.
//!
//! ## Why routing happens before everything
//!
//! The resolved name is what the permission check reads, what the doom-loop detector counts, and what the
//! audit trail records. Checking permission on `call_tool` would ask "may this agent call the dispatcher",
//! which is a question with no useful answer — every routed call is a dispatcher call. The interesting
//! question is whether it may run `run_command`, and that name only exists after routing.
//!
//! ## What a capability is derived from
//!
//! The registry already knows: `ToolMetadata::capabilities` names what each tool needs (`filesystem.read` and
//! so on), and `risk_level` says whether it changes anything. [`capability_for`] turns those, plus the call's
//! own arguments, into the `(kind, resource)` pair the permission runtime decides on — so a `read_file` under
//! the workspace is a different request from a `read_file` outside it, which is the whole point of a scope.

pub mod args;
pub mod router;

use std::sync::Arc;

use agent_core::{AgentId, CallId, CancellationToken, TaskId};
use agent_loop::{ToolCall, ToolExecutor, ToolOutcome};
use agent_permission::{
    CapabilityKind, Decision, PermissionRuntime, Principal, Request, Resource,
};
use agent_tools::registry::ToolRegistry;
use agent_tools::tool::{RiskLevel, ToolContext};
use serde_json::{Map, Value};

pub use args::{ParsedArgs, parse_tool_arguments};
pub use router::{DISPATCHER_NAME, ResolvedCall, resolve_tool_call};

/// Argument keys that name a filesystem target, in the order a tool is likely to declare them.
///
/// Used only to give the permission check a *scope*. A call whose target cannot be identified is decided
/// against `Resource::Unscoped`, which a path-shaped grant never covers — so an unrecognised argument shape
/// fails closed rather than being waved through as "no path, no problem".
const PATH_KEYS: [&str; 6] = ["path", "file", "filename", "dir", "directory", "target"];

/// What the permission runtime should be asked about this call.
///
/// Derived from the tool's own declared capabilities rather than from a name list, because a name list lives
/// somewhere else and is remembered separately from the tool it describes — the failure mode the JS runtime's
/// `SENSITIVE_TOOLS` set has, where adding a tool means remembering to edit a set in another file.
pub fn capability_for(
    capabilities: &[&str],
    risk: RiskLevel,
    args: &Map<String, Value>,
    workspace_root: &std::path::Path,
) -> (CapabilityKind, Resource) {
    let kind = capabilities
        .iter()
        .find_map(|c| match *c {
            "filesystem.read" => Some(CapabilityKind::FilesystemRead),
            "filesystem.write" => Some(CapabilityKind::FilesystemWrite),
            "filesystem.delete" => Some(CapabilityKind::FilesystemDelete),
            "process.spawn" => Some(CapabilityKind::ProcessSpawn),
            "process.kill" => Some(CapabilityKind::ProcessKill),
            "network.request" => Some(CapabilityKind::NetworkRequest),
            "browser.control" => Some(CapabilityKind::BrowserControl),
            "mcp.invoke" => Some(CapabilityKind::McpInvoke),
            "plugin.execute" => Some(CapabilityKind::PluginExecute),
            _ => None,
        })
        // A tool that declares nothing is still doing something. Reading is the least it can be, and a
        // read-only tool that reaches outside its scope is still worth stopping.
        .unwrap_or(match risk {
            RiskLevel::ReadOnly => CapabilityKind::FilesystemRead,
            _ => CapabilityKind::FilesystemWrite,
        });

    let resource = PATH_KEYS
        .iter()
        .find_map(|k| args.get(*k).and_then(Value::as_str))
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let path = std::path::Path::new(p);
            // Resolved against the workspace so a relative path is decided as the file it will actually
            // open. A scope check on "src/a.ts" against "/home/u/proj" would otherwise never match, and
            // every relative call would be denied for the wrong reason.
            Resource::Path(if path.is_absolute() { path.to_path_buf() } else { workspace_root.join(path) })
        })
        .unwrap_or(Resource::Unscoped);

    (kind, resource)
}

/// Tools the RUNTIME cannot implement, because their implementation is a person.
///
/// `ask_user` is the whole of it today. The runtime cannot render a dialog and must not guess an answer, so
/// the call is forwarded and the loop waits — which is the point: a question the model asks and answers itself
/// is not a question.
#[async_trait::async_trait]
pub trait HostTools: Send + Sync {
    /// Whether this name is one the host implements.
    fn serves(&self, name: &str) -> bool;
    /// Run it. The returned text goes back to the model as the tool's result.
    async fn call(&self, name: &str, args: &Value) -> ToolOutcome;
}

/// Executes a model's tool calls: route, read, check, run.
pub struct DispatchingExecutor {
    registry: Arc<ToolRegistry>,
    permissions: Arc<PermissionRuntime>,
    /// Who is calling. Carries the grant the check is made against.
    principal: Principal,
    context: ToolContext,
    /// Tools the host implements. Consulted after the registry and before "unknown tool".
    host: Option<Arc<dyn HostTools>>,
}

impl DispatchingExecutor {
    pub fn new(
        registry: Arc<ToolRegistry>,
        permissions: Arc<PermissionRuntime>,
        principal: Principal,
        context: ToolContext,
    ) -> Self {
        Self { registry, permissions, principal, context, host: None }
    }

    /// Route the names this host implements to it rather than reporting them unknown.
    pub fn with_host_tools(mut self, host: Arc<dyn HostTools>) -> Self {
        self.host = Some(host);
        self
    }

    /// The identifiers a delegation should run under: same task, its own agent, one level deeper.
    pub fn for_delegation(&self, agent: AgentId) -> Principal {
        Principal {
            task: self.principal.task.clone(),
            agent,
            depth: self.principal.depth + 1,
            grant: self.permissions.issue_child(&self.principal),
        }
    }
}

#[async_trait::async_trait]
impl ToolExecutor for DispatchingExecutor {
    async fn execute(
        &self,
        call: &ToolCall,
        token: &CancellationToken,
    ) -> (String, Value, ToolOutcome) {
        // 1. Route. Everything downstream — permission, the detector, the audit trail — sees the resolved
        //    name, never the dispatcher's.
        let raw_args = match parse_tool_arguments(&call.arguments) {
            ParsedArgs::Ok(map) => map,
            ParsedArgs::Failed { error, partial } => {
                // The call did not run and the model is told so in terms it can act on. `partial` is used to
                // name the tool it was reaching for, so a truncated envelope is reported against
                // `spawn_subagents` rather than against the dispatcher the user never wrote.
                let name = partial
                    .as_ref()
                    .and_then(|p| p.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(&call.name)
                    .to_owned();
                return (name, Value::Object(partial.unwrap_or_default()), ToolOutcome::failed(error));
            }
        };
        let ResolvedCall { name, args } = resolve_tool_call(&call.name, raw_args);
        let args_value = Value::Object(args.clone());

        // 2. A tool the HOST implements — `ask_user`, whose implementation is a person.
        //
        // Checked before the registry rather than after, so a host tool cannot be shadowed by a runtime one
        // appearing later with the same name. No capability check: asking the user a question is not an action
        // taken on their behalf, and gating it would mean the runtime needs permission to talk to them.
        if let Some(host) = &self.host {
            if host.serves(&name) {
                let outcome = host.call(&name, &args_value).await;
                return (name, args_value, outcome);
            }
        }

        // 3. Is there such a tool? Answered before permission so that a typo is reported as a typo rather
        //    than as a refusal, which is the more useful thing for the model to hear.
        let Some(tool) = self.registry.get(&name) else {
            return (
                name.clone(),
                args_value,
                ToolOutcome::failed(format!(
                    "Unknown tool: {name}. It is not one this runtime serves — check the name against the \
                     catalog rather than retrying it."
                )),
            );
        };
        let metadata = tool.metadata();

        // 4. Permission, at one boundary. The only decision point, so a call cannot be authorised twice or
        //    by two different rules.
        let (kind, resource) = capability_for(
            metadata.capabilities,
            metadata.risk_level,
            &args,
            self.context.workspace.root(),
        );
        let request = Request {
            kind,
            resource: resource.clone(),
            call: CallId::from_host(call.id.clone()),
            // Deliberately none. A justification supplied by the model is inert in the decision — see
            // `agent-permission`'s header and the injection test that pins it — and passing the model's own
            // text here would put the shape of that vulnerability back on the call path.
            justification: None,
        };
        match self.permissions.decide(&self.principal, &request).await {
            Decision::Allow => {}
            Decision::Deny { reason } => {
                return (
                    name.clone(),
                    args_value,
                    ToolOutcome::failed(format!(
                        "Permission denied for {name} ({}): {reason}. Nothing ran. This is a policy \
                         decision, not a tool failure — retrying the same call will be denied the same way.",
                        kind.as_str()
                    )),
                );
            }
            Decision::NeedsApproval { reason } => {
                return (
                    name.clone(),
                    args_value,
                    ToolOutcome::failed(format!(
                        "{name} ({}) needs the user's approval and none was given: {reason}. Nothing ran.",
                        kind.as_str()
                    )),
                );
            }
        }

        // 5. Execute. The registry owns the timeout and races the body against the token, so a tool that
        //    ignores cancellation is still cut loose.
        let mut ctx = self.context.clone();
        ctx.cancel = token.child_token();
        ctx.call_id = CallId::from_host(call.id.clone());
        match self.registry.execute(&name, &ctx, &args_value).await {
            Ok(invocation) => (name, args_value, ToolOutcome::ok(invocation.content)),
            Err(e) => {
                // A failing tool is a RESULT, not an error: the model is usually the right thing to hand it
                // to. The one exception is cancellation, which the loop reads from the token rather than
                // from a tool result, and which must not be phrased as something the model could retry.
                let content = if e.is_cancelled() {
                    "The user stopped this operation before it finished.".to_owned()
                } else {
                    agent_tools::registry::to_legacy_content(&name, &e)
                };
                (name, args_value, ToolOutcome::failed(content))
            }
        }
    }
}

/// A principal for the top-level agent of a task.
pub fn root_principal(task: TaskId, agent: AgentId, grant: agent_permission::Grant) -> Principal {
    Principal { task, agent, depth: 0, grant }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn a_declared_capability_decides_the_kind() {
        let root = std::path::Path::new("/proj");
        let (kind, _) = capability_for(&["filesystem.write"], RiskLevel::Mutating, &args(json!({})), root);
        assert_eq!(kind, CapabilityKind::FilesystemWrite);
        let (kind, _) = capability_for(&["process.spawn"], RiskLevel::Elevated, &args(json!({})), root);
        assert_eq!(kind, CapabilityKind::ProcessSpawn);
    }

    /// A tool that declares nothing still gets a kind, chosen by how much damage it could do.
    #[test]
    fn an_undeclared_tool_falls_back_by_risk_level() {
        let root = std::path::Path::new("/proj");
        let (kind, _) = capability_for(&[], RiskLevel::ReadOnly, &args(json!({})), root);
        assert_eq!(kind, CapabilityKind::FilesystemRead);
        let (kind, _) = capability_for(&[], RiskLevel::Mutating, &args(json!({})), root);
        assert_eq!(kind, CapabilityKind::FilesystemWrite);
    }

    /// A relative path has to be resolved, or every relative call is denied for the wrong reason.
    #[test]
    fn a_relative_path_is_resolved_against_the_workspace_before_it_is_scoped() {
        let root = std::path::Path::new("/proj");
        let (_, resource) =
            capability_for(&["filesystem.read"], RiskLevel::ReadOnly, &args(json!({"path": "src/a.ts"})), root);
        assert_eq!(resource, Resource::Path("/proj/src/a.ts".into()));
    }

    #[test]
    fn an_absolute_path_is_left_alone() {
        let root = std::path::Path::new("/proj");
        let (_, resource) = capability_for(
            &["filesystem.read"],
            RiskLevel::ReadOnly,
            &args(json!({"path": "/etc/passwd"})),
            root,
        );
        assert_eq!(resource, Resource::Path("/etc/passwd".into()));
    }

    /// Fails closed: an unidentifiable target is not "no target, therefore fine".
    #[test]
    fn a_call_with_no_recognisable_target_is_unscoped_rather_than_unrestricted() {
        let root = std::path::Path::new("/proj");
        for a in [json!({}), json!({"query": "todo"}), json!({"path": "   "}), json!({"path": 42})] {
            let (_, resource) = capability_for(&["filesystem.read"], RiskLevel::ReadOnly, &args(a.clone()), root);
            assert_eq!(resource, Resource::Unscoped, "{a}");
        }
    }

    #[test]
    fn the_target_is_read_from_whichever_key_names_it() {
        let root = std::path::Path::new("/proj");
        for key in ["path", "file", "filename", "dir", "directory", "target"] {
            let (_, resource) = capability_for(
                &["filesystem.read"],
                RiskLevel::ReadOnly,
                &args(json!({ key: "a.ts" })),
                root,
            );
            assert_eq!(resource, Resource::Path("/proj/a.ts".into()), "{key}");
        }
    }
}
