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
    /// A workspace-scoped policy: [`Self::system`] plus one project root, readable and writable.
    pub fn workspace(root: impl Into<PathBuf>) -> Self {
        let mut policy = Self::system();
        let root = root.into();
        policy.read.insert(0, root.clone());
        policy.write.insert(0, root);
        policy
    }

    /// Everything a toolchain needs and nothing of the user's — no project root at all.
    ///
    /// Split out of [`Self::workspace`] because a session has more than one kind of root: the project is
    /// read AND written, while the media library is only read. Building from a single root forced every
    /// declared directory into both lists, so naming the library at all made it writable — which is not what
    /// the file tools mean by it (`resolvePath` refuses to write there) and not what anyone declaring it
    /// intends.
    ///
    ///
    /// ## Why this is longer than "the project plus /usr"
    ///
    /// The first version of this list was exactly that, and it was never exercised against a real command —
    /// `agent-sandbox` was orphaned until the host declared a policy (2026-09-21). The moment it was armed, the
    /// narrow list turned out to forbid ordinary work rather than forbid harm:
    ///
    /// - a toolchain installed per-user (`~/.nvm`, `~/.cargo`, `~/.rustup`, `~/.local/bin`) could not be
    ///   **exec'd at all**, so an nvm-installed `node` failed before it ran a line;
    /// - `npm`, `pnpm`, `cargo` and friends write to a per-user cache (`~/.npm`, `~/.cache`, `~/.cargo`), so
    ///   every install failed on a directory that has nothing to do with the workspace;
    /// - `/dev/null` was unreachable, which breaks the shell redirect in almost every build script there is.
    ///
    /// A sandbox that fails all of those does not get tightened in the field, it gets turned off. So the list
    /// grants what a build genuinely needs and nothing broader.
    ///
    /// ## What stays out, deliberately
    ///
    /// `$HOME` itself is **not** granted, in either direction. That is what keeps `~/Documents`, `~/.ssh`,
    /// `~/.aws`, `~/.gnupg` and `~/.netrc` out of reach — the paths whose loss is the reason to confine a
    /// command in the first place. `~/.config` is readable (git and npm read their configuration from under it)
    /// and deliberately **not** writable: it is also where several CLIs keep tokens, and a writable subtree is
    /// a readable one in [`crate::landlock_backend::apply`].
    ///
    /// Nothing here is required to exist — `apply` skips a path it cannot open, so naming `~/.bun` on a machine
    /// without Bun costs nothing.
    pub fn system() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        // Relative to `$HOME`, or nothing at all when the environment has none (a service account, a test).
        let at_home = |rel: &str| home.as_ref().map(|h| h.join(rel));

        let mut read: Vec<PathBuf> = vec![
            PathBuf::from("/usr"),
            PathBuf::from("/lib"),
            PathBuf::from("/lib64"),
            PathBuf::from("/bin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/etc"),
            PathBuf::from("/opt"),
            // Read by anything that inspects itself or the machine: node, git, the JVM, every `nproc`.
            PathBuf::from("/proc"),
            PathBuf::from("/sys"),
            // Distribution-specific toolchain roots. Absent on most systems, skipped when they are.
            PathBuf::from("/snap"),
            PathBuf::from("/nix"),
            PathBuf::from("/var/lib"),
        ];
        let mut write: Vec<PathBuf> = vec![
            PathBuf::from("/tmp"),
            PathBuf::from("/var/tmp"),
            // `/dev/null`, `/dev/urandom`, `/dev/tty`. Write rather than read because a redirect to
            // /dev/null opens it for writing, and a policy without it breaks most build scripts. The
            // process is unprivileged, so the block devices alongside them are not reachable anyway.
            PathBuf::from("/dev"),
        ];
        let mut execute: Vec<PathBuf> = vec![
            PathBuf::from("/usr"),
            PathBuf::from("/bin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/lib"),
            PathBuf::from("/lib64"),
            PathBuf::from("/opt"),
            PathBuf::from("/snap"),
            PathBuf::from("/nix"),
        ];

        // Per-user toolchains and their caches. Each is both executable and writable: a version manager
        // installs INTO the same tree it runs from, so splitting the two would break `nvm install` while
        // leaving `node` working, which is the more confusing half-failure.
        for rel in [
            ".nvm", ".cargo", ".rustup", ".bun", ".deno", ".pyenv", ".rbenv", ".sdkman", ".volta",
            ".local", "go",
        ] {
            if let Some(p) = at_home(rel) {
                write.push(p.clone());
                execute.push(p);
            }
        }
        // Caches and per-user state. Written constantly by package managers, never executed from.
        for rel in [".cache", ".npm", ".yarn", ".pnpm-store", ".gradle", ".m2", ".bundle", ".composer"] {
            if let Some(p) = at_home(rel) {
                write.push(p);
            }
        }
        // Configuration a toolchain reads and must not be allowed to rewrite. See the note above.
        for rel in [".config", ".gitconfig", ".npmrc", ".yarnrc", ".yarnrc.yml", ".gitignore_global"] {
            if let Some(p) = at_home(rel) {
                read.push(p);
            }
        }

        Self { read, write, execute }
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

    /// The failures that made the narrow list unusable the moment it was armed. Each of these is a command
    /// that does ordinary work, not a command doing something questionable.
    #[test]
    fn workspace_policy_lets_a_real_toolchain_run() {
        let p = FilesystemPolicy::workspace("/home/u/proj");
        // A shell redirect. Nothing builds without it.
        assert!(p.allows_write(Path::new("/dev/null")));
        // `nproc`, and everything else that reads the machine.
        assert!(p.allows_read(Path::new("/proc/cpuinfo")));
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
        // A per-user toolchain: installed, executed and updated in the same tree.
        assert!(p.allows_read(&home.join(".nvm/versions/node/v20.0.0/bin/node")));
        assert!(p.allows_write(&home.join(".cargo/registry/index")));
        // A package manager's cache.
        assert!(p.allows_write(&home.join(".npm/_cacache/tmp")));
        // Configuration is readable, so git and npm find their settings.
        assert!(p.allows_read(&home.join(".gitconfig")));
    }

    /// What confinement is FOR. Widening the list to make builds work must not have widened it to here.
    #[test]
    fn workspace_policy_still_withholds_the_paths_that_matter() {
        let p = FilesystemPolicy::workspace("/home/u/proj");
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
        for secret in [".ssh/id_rsa", ".aws/credentials", ".gnupg/secring.gpg", ".netrc"] {
            assert!(!p.allows_read(&home.join(secret)), "{secret} must stay out of reach");
        }
        assert!(!p.allows_write(&home.join("Documents/taxes.pdf")));
        // $HOME itself is never granted, so a file that is not on the list is not reachable by being near one.
        assert!(!p.allows_write(&home.join(".bashrc")));
        // Readable configuration is not writable configuration: a token under ~/.config stays put.
        assert!(!p.allows_write(&home.join(".config/gh/hosts.yml")));
        // The system is readable and executable, never writable.
        assert!(!p.allows_write(Path::new("/etc/passwd")));
        assert!(!p.allows_write(Path::new("/usr/bin/node")));
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
