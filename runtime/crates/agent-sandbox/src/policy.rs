//! What a sandboxed command may touch, and what actually enforced it.

use agent_permission::{host_matches, path_contains};
use std::path::{Path, PathBuf};

/// Filesystem allowlist (TODO §8).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FilesystemPolicy {
    /// Readable subtrees.
    pub read: Vec<PathBuf>,
    /// Writable subtrees. A writable path is not implicitly readable — declare both when both are meant.
    pub write: Vec<PathBuf>,
    /// Subtrees from which binaries may be executed.
    ///
    /// Separate from `read` because a toolchain almost always lives outside the project: confining
    /// execution to the workspace would break `git`, and confining reads to `/usr` would be pointless.
    pub execute: Vec<PathBuf>,
}

impl FilesystemPolicy {
    /// A workspace-scoped policy: the project is readable and writable, the system is executable and
    /// readable enough for a toolchain to run.
    pub fn workspace(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            read: vec![root.clone(), PathBuf::from("/usr"), PathBuf::from("/lib"), PathBuf::from("/etc")],
            write: vec![root, PathBuf::from("/tmp")],
            execute: vec![PathBuf::from("/usr"), PathBuf::from("/bin"), PathBuf::from("/lib")],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.read.is_empty() && self.write.is_empty() && self.execute.is_empty()
    }

    /// Lexical pre-check: whether `path` is readable under this policy.
    ///
    /// This is a *check*, not a boundary — it runs in the parent and a child could reach a path the
    /// parent never inspected. Its value is refusing an obviously out-of-bounds request before anything
    /// is spawned, and being available on platforms where no kernel mechanism is. Real confinement is
    /// `Enforcement::Landlock`.
    pub fn allows_read(&self, path: &Path) -> bool {
        self.read.iter().chain(self.write.iter()).any(|r| path_contains(r, path))
    }

    pub fn allows_write(&self, path: &Path) -> bool {
        self.write.iter().any(|r| path_contains(r, path))
    }
}

/// Network allowlist (TODO §8).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkPolicy {
    /// Permitted hosts. `*.example.com` matches subdomains, not the apex. Empty means deny all.
    pub allow_hosts: Vec<String>,
    /// Whether any network access at all is permitted.
    pub enabled: bool,
}

impl NetworkPolicy {
    pub fn deny_all() -> Self {
        Self { allow_hosts: Vec::new(), enabled: false }
    }

    pub fn allow(hosts: impl IntoIterator<Item = String>) -> Self {
        Self { allow_hosts: hosts.into_iter().collect(), enabled: true }
    }

    /// Lexical check, for callers that resolve a host before connecting (the runtime's own HTTP tools).
    ///
    /// It cannot constrain a spawned `curl`: see `Enforcement`.
    pub fn allows_host(&self, host: &str) -> bool {
        self.enabled && self.allow_hosts.iter().any(|p| host_matches(p, host))
    }
}

/// The full policy for one execution.
#[derive(Debug, Clone, Default)]
pub struct SandboxPolicy {
    pub filesystem: FilesystemPolicy,
    pub network: NetworkPolicy,
}

/// Which mechanism enforced a restriction — and, when none did, why.
///
/// The whole point of this type is that there is no variant meaning "assume it worked".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "mechanism", rename_all = "snake_case")]
pub enum Enforcement {
    /// Nothing was requested.
    NotRequested,
    /// The Linux kernel is enforcing it. `abi` is the negotiated Landlock ABI.
    Landlock { abi: u32 },
    /// A hardware-isolated guest is enforcing it.
    Guest,
    /// Checked in the parent before spawning, and **not** enforced against the child thereafter.
    ///
    /// Honest about its own weakness: a child that constructs a path the parent never saw is not stopped
    /// by this. It exists so a plainly out-of-bounds request fails early, and so platforms with no
    /// kernel mechanism are not silently unrestricted.
    LexicalOnly { reason: String },
    /// Requested and not enforced at all.
    None { reason: String },
}

impl Enforcement {
    /// Whether a mechanism outside the process is enforcing this.
    pub fn is_kernel_enforced(&self) -> bool {
        matches!(self, Enforcement::Landlock { .. } | Enforcement::Guest)
    }

    pub fn describe(&self) -> String {
        match self {
            Enforcement::NotRequested => "no restriction requested".to_owned(),
            Enforcement::Landlock { abi } => format!("enforced by Landlock (ABI v{abi})"),
            Enforcement::Guest => "enforced by the sandbox guest".to_owned(),
            Enforcement::LexicalOnly { reason } => {
                format!("checked before spawn only, not enforced against the child ({reason})")
            }
            Enforcement::None { reason } => format!("NOT enforced ({reason})"),
        }
    }
}

/// What confined a single execution.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SandboxReport {
    pub filesystem: Enforcement,
    pub network: Enforcement,
    /// From `agent-process`, so one report covers every restriction on the command.
    pub limits: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_policy_permits_the_project_and_denies_elsewhere() {
        let p = FilesystemPolicy::workspace("/home/u/proj");
        assert!(p.allows_read(Path::new("/home/u/proj/src/a.rs")));
        assert!(p.allows_write(Path::new("/home/u/proj/out.txt")));
        assert!(!p.allows_write(Path::new("/home/u/other/x")));
        assert!(!p.allows_read(Path::new("/home/u/.ssh/id_rsa")));
    }

    #[test]
    fn a_sibling_path_is_not_inside_the_allowlist() {
        let p = FilesystemPolicy { write: vec![PathBuf::from("/a/proj")], ..Default::default() };
        assert!(p.allows_write(Path::new("/a/proj/x")));
        assert!(!p.allows_write(Path::new("/a/project-two/x")));
    }

    #[test]
    fn traversal_does_not_escape_the_allowlist() {
        let p = FilesystemPolicy { read: vec![PathBuf::from("/a/proj")], ..Default::default() };
        assert!(!p.allows_read(Path::new("/a/proj/../../etc/passwd")));
    }

    #[test]
    fn write_is_not_implicitly_read_but_read_covers_written_paths() {
        let p = FilesystemPolicy { write: vec![PathBuf::from("/w")], ..Default::default() };
        // Writable implies readable for the check, since a writer that cannot read cannot edit.
        assert!(p.allows_read(Path::new("/w/f")));
        let r = FilesystemPolicy { read: vec![PathBuf::from("/r")], ..Default::default() };
        assert!(!r.allows_write(Path::new("/r/f")));
    }

    #[test]
    fn network_denies_by_default() {
        assert!(!NetworkPolicy::default().allows_host("example.com"));
        assert!(!NetworkPolicy::deny_all().allows_host("example.com"));
    }

    #[test]
    fn network_allowlist_uses_host_matching() {
        let n = NetworkPolicy::allow(["*.example.com".to_owned()]);
        assert!(n.allows_host("api.example.com"));
        assert!(!n.allows_host("example.com"), "a wildcard must not match the apex");
        assert!(!n.allows_host("evil.com"));
    }

    #[test]
    fn enforcement_has_no_variant_meaning_assume_it_worked() {
        // Every non-enforcing variant carries a reason, so a caller can always tell what it got.
        for e in [
            Enforcement::LexicalOnly { reason: "no kernel support".into() },
            Enforcement::None { reason: "requires ABI v4".into() },
        ] {
            assert!(!e.is_kernel_enforced());
            assert!(!e.describe().is_empty());
        }
        assert!(Enforcement::Landlock { abi: 3 }.is_kernel_enforced());
        assert!(Enforcement::Guest.is_kernel_enforced());
    }
}
