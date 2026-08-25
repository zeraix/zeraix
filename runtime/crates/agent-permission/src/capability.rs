//! Capabilities and the scopes that bound them (spec §8).
//!
//! A capability is a *kind* of action plus the *extent* it may be taken over: not "may write files" but
//! "may write files under `/home/u/proj`". That pairing is the whole difference between a capability
//! model and the name-based ACL it replaces — `SENSITIVE_TOOLS.has("write_file")` can only ask whether
//! writing is allowed at all, so the only available answers are "prompt the user again" or "allow
//! everything they already said yes to".

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// What kind of action is being attempted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    FilesystemRead,
    FilesystemWrite,
    FilesystemDelete,
    ProcessSpawn,
    ProcessKill,
    NetworkRequest,
    BrowserControl,
    McpInvoke,
    PluginExecute,
}

impl CapabilityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CapabilityKind::FilesystemRead => "filesystem.read",
            CapabilityKind::FilesystemWrite => "filesystem.write",
            CapabilityKind::FilesystemDelete => "filesystem.delete",
            CapabilityKind::ProcessSpawn => "process.spawn",
            CapabilityKind::ProcessKill => "process.kill",
            CapabilityKind::NetworkRequest => "network.request",
            CapabilityKind::BrowserControl => "browser.control",
            CapabilityKind::McpInvoke => "mcp.invoke",
            CapabilityKind::PluginExecute => "plugin.execute",
        }
    }

    /// Whether this kind can change the world outside the runtime.
    ///
    /// Used for the sub-agent default (see `Grant::derive_child`) and for deciding what needs a human.
    pub fn is_mutating(self) -> bool {
        !matches!(self, CapabilityKind::FilesystemRead)
    }

    /// Kinds that are never granted to a delegated sub-agent implicitly.
    pub fn is_elevated(self) -> bool {
        matches!(
            self,
            CapabilityKind::ProcessSpawn
                | CapabilityKind::ProcessKill
                | CapabilityKind::BrowserControl
                | CapabilityKind::PluginExecute
                | CapabilityKind::FilesystemDelete
        )
    }
}

/// What a capability applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Scope {
    /// Everything of this kind.
    ///
    /// Only ever legitimate on the human-edited ceiling. Nothing in the runtime constructs it, which is
    /// deliberate: an unrestricted scope should have to be typed by a person into a config file.
    Unrestricted,
    /// Directory subtrees, matched component-wise.
    Paths(Vec<PathBuf>),
    /// Hostnames. `*.example.com` matches subdomains but not the apex.
    Hosts(Vec<String>),
    /// Named resources — MCP server ids, plugin ids.
    Names(Vec<String>),
    /// Nothing. A denied capability, kept explicit so a grant can say "asked for and refused".
    Nothing,
}

/// The thing an action is being attempted against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resource {
    Path(PathBuf),
    Host(String),
    Name(String),
    /// The action has no target beyond its kind (spawning a process at all).
    Unscoped,
}

impl Scope {
    /// Whether this scope covers `resource`.
    pub fn covers(&self, resource: &Resource) -> bool {
        match (self, resource) {
            (Scope::Nothing, _) => false,
            (Scope::Unrestricted, _) => true,
            (Scope::Paths(roots), Resource::Path(p)) => roots.iter().any(|r| path_contains(r, p)),
            (Scope::Hosts(hosts), Resource::Host(h)) => hosts.iter().any(|pat| host_matches(pat, h)),
            (Scope::Names(names), Resource::Name(n)) => names.iter().any(|x| x == n),
            // An unscoped action is covered only by an unrestricted scope: a path list says nothing
            // about whether a process may be spawned.
            (_, Resource::Unscoped) => false,
            // Mismatched shapes never match. A path scope cannot authorise a host.
            _ => false,
        }
    }

    /// The scope both permit — used to clamp a request against the ceiling.
    pub fn intersect(&self, other: &Scope) -> Scope {
        match (self, other) {
            (Scope::Nothing, _) | (_, Scope::Nothing) => Scope::Nothing,
            (Scope::Unrestricted, s) | (s, Scope::Unrestricted) => s.clone(),
            (Scope::Paths(a), Scope::Paths(b)) => {
                // Keep the deeper of any two nested roots: the narrower one is the intersection.
                let mut out = Vec::new();
                for p in a {
                    for q in b {
                        if path_contains(q, p) {
                            out.push(p.clone());
                        } else if path_contains(p, q) {
                            out.push(q.clone());
                        }
                    }
                }
                out.sort();
                out.dedup();
                if out.is_empty() { Scope::Nothing } else { Scope::Paths(out) }
            }
            (Scope::Hosts(a), Scope::Hosts(b)) => {
                let out: Vec<String> = a
                    .iter()
                    .filter(|h| b.iter().any(|p| host_matches(p, h) || p == *h))
                    .cloned()
                    .collect();
                if out.is_empty() { Scope::Nothing } else { Scope::Hosts(out) }
            }
            (Scope::Names(a), Scope::Names(b)) => {
                let out: Vec<String> = a.iter().filter(|n| b.contains(n)).cloned().collect();
                if out.is_empty() { Scope::Nothing } else { Scope::Names(out) }
            }
            // Different shapes have nothing in common.
            _ => Scope::Nothing,
        }
    }

    pub fn is_nothing(&self) -> bool {
        matches!(self, Scope::Nothing)
            || matches!(self, Scope::Paths(v) if v.is_empty())
            || matches!(self, Scope::Hosts(v) if v.is_empty())
            || matches!(self, Scope::Names(v) if v.is_empty())
    }
}

/// Whether `child` is `root` or lives beneath it, compared **component-wise**.
///
/// A string prefix test is the classic bug here: `/home/u/proj` would "contain" `/home/u/project-b`,
/// handing a sub-agent write access to a directory nobody granted. Comparing components makes the
/// boundary a real path boundary.
///
/// Purely lexical, like the workspace containment check in `agent-tools`: no symlink resolution, so a
/// scope means what it reads as. Hard isolation is the sandbox's job, not this table's.
pub fn path_contains(root: &Path, child: &Path) -> bool {
    let norm = |p: &Path| -> Vec<std::ffi::OsString> {
        let mut out = Vec::new();
        for c in p.components() {
            match c {
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str().to_owned()),
            }
        }
        out
    };
    let r = norm(root);
    let c = norm(child);
    c.len() >= r.len() && r.iter().zip(c.iter()).all(|(a, b)| a == b)
}

/// `*.example.com` matches `a.example.com` but not `example.com`; anything else is exact.
pub fn host_matches(pattern: &str, host: &str) -> bool {
    let p = pattern.trim().to_ascii_lowercase();
    let h = host.trim().to_ascii_lowercase();
    if p == "*" {
        return true;
    }
    match p.strip_prefix("*.") {
        Some(suffix) => h.ends_with(&format!(".{suffix}")),
        None => p == h,
    }
}

/// One capability: a kind, bounded by a scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub kind: CapabilityKind,
    pub scope: Scope,
}

impl Capability {
    pub fn new(kind: CapabilityKind, scope: Scope) -> Self {
        Self { kind, scope }
    }

    pub fn paths(kind: CapabilityKind, roots: impl IntoIterator<Item = PathBuf>) -> Self {
        Self::new(kind, Scope::Paths(roots.into_iter().collect()))
    }

    pub fn unscoped(kind: CapabilityKind) -> Self {
        Self::new(kind, Scope::Unrestricted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_containment_respects_component_boundaries() {
        let root = Path::new("/home/u/proj");
        assert!(path_contains(root, Path::new("/home/u/proj")));
        assert!(path_contains(root, Path::new("/home/u/proj/src/a.rs")));
        // The bug a string prefix test would introduce.
        assert!(!path_contains(root, Path::new("/home/u/project-b/secret")));
        assert!(!path_contains(root, Path::new("/home/u")));
        assert!(!path_contains(root, Path::new("/etc/passwd")));
    }

    #[test]
    fn traversal_cannot_escape_a_path_scope() {
        let root = Path::new("/home/u/proj");
        assert!(!path_contains(root, Path::new("/home/u/proj/../../etc/passwd")));
        assert!(path_contains(root, Path::new("/home/u/proj/src/../lib/a.rs")));
    }

    #[test]
    fn host_wildcards_do_not_match_the_apex() {
        assert!(host_matches("*.example.com", "api.example.com"));
        assert!(!host_matches("*.example.com", "example.com"));
        assert!(!host_matches("*.example.com", "notexample.com"));
        assert!(host_matches("example.com", "EXAMPLE.com"));
        assert!(!host_matches("example.com", "evil.com"));
    }

    #[test]
    fn unscoped_actions_need_an_unrestricted_scope() {
        let paths = Scope::Paths(vec![PathBuf::from("/a")]);
        assert!(!paths.covers(&Resource::Unscoped));
        assert!(Scope::Unrestricted.covers(&Resource::Unscoped));
    }

    #[test]
    fn mismatched_scope_shapes_never_match() {
        let paths = Scope::Paths(vec![PathBuf::from("/a")]);
        assert!(!paths.covers(&Resource::Host("example.com".into())));
        let hosts = Scope::Hosts(vec!["example.com".into()]);
        assert!(!hosts.covers(&Resource::Path(PathBuf::from("/a/b"))));
    }

    #[test]
    fn intersection_keeps_the_narrower_path() {
        let broad = Scope::Paths(vec![PathBuf::from("/home/u")]);
        let narrow = Scope::Paths(vec![PathBuf::from("/home/u/proj")]);
        assert_eq!(broad.intersect(&narrow), Scope::Paths(vec![PathBuf::from("/home/u/proj")]));
        assert_eq!(narrow.intersect(&broad), Scope::Paths(vec![PathBuf::from("/home/u/proj")]));
    }

    #[test]
    fn intersection_of_disjoint_paths_is_nothing() {
        let a = Scope::Paths(vec![PathBuf::from("/a")]);
        let b = Scope::Paths(vec![PathBuf::from("/b")]);
        assert!(a.intersect(&b).is_nothing());
    }

    #[test]
    fn nothing_absorbs_everything() {
        assert!(Scope::Nothing.intersect(&Scope::Unrestricted).is_nothing());
        assert!(Scope::Unrestricted.intersect(&Scope::Nothing).is_nothing());
    }
}
