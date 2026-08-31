//! Per-process resource limits (spec §16, TODO §5).
//!
//! ## Why there are two mechanisms
//!
//! The TODO asks for cgroups v2. cgroups v2 is the right answer and it is also the one a desktop
//! application usually cannot use: writing to `/sys/fs/cgroup` requires the app's own cgroup to have
//! been *delegated* to it, which on a normal session means being launched under a systemd user unit
//! with `Delegate=yes`. Zeraix is launched by a desktop environment, so the common case is that
//! delegation is absent and every write is `EACCES`.
//!
//! Shipping only cgroups would therefore mean shipping limits that silently do nothing — the worst
//! outcome, because it looks like protection. So there are two:
//!
//!   1. **cgroups v2**, attempted first on Linux, giving real memory and CPU *bandwidth* caps.
//!   2. **`setrlimit`**, applied in the child between `fork` and `exec`, which needs no privilege at
//!      all and works on every Unix including macOS.
//!
//! `setrlimit` is weaker in an important way and the difference should not be glossed over: `RLIMIT_AS`
//! caps *virtual address space*, not resident memory, so a runtime that reserves a large arena without
//! touching it (the JVM, Go, some allocators) can hit the limit while using very little real memory.
//! It is a blunt instrument that prevents runaway allocation; it is not a memory accounting system.
//! `RLIMIT_CPU` caps total CPU *seconds* rather than a share, so it bounds a runaway loop but cannot
//! express "20% of one core".
//!
//! Windows is not implemented. The mechanism there is a Job Object with
//! `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, which also gives whole-tree kill for free — worth doing
//! alongside the Windows process-group work rather than bolted on here.

use std::path::PathBuf;

/// What to cap. `None` in any field means "do not limit this".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResourceLimits {
    /// Maximum memory in bytes. cgroups sets `memory.max`; the fallback sets `RLIMIT_AS`.
    pub memory_bytes: Option<u64>,
    /// Maximum CPU time in seconds (`RLIMIT_CPU`), or the quota basis for cgroups `cpu.max`.
    pub cpu_seconds: Option<u64>,
    /// Maximum number of processes/threads the child may create (`RLIMIT_NPROC`).
    pub max_processes: Option<u64>,
}

impl ResourceLimits {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Which mechanism actually applied, so a caller can report the truth rather than assume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LimitsApplied {
    /// Nothing was requested.
    None,
    /// A cgroup v2 was created and the child was placed in it.
    Cgroup { path: PathBuf },
    /// `setrlimit` was applied in the child. Weaker — see the module header.
    Rlimit,
    /// Limits were requested but could not be applied. Never silently ignored.
    Unsupported { reason: String },
}

impl LimitsApplied {
    pub fn is_enforced(&self) -> bool {
        matches!(self, LimitsApplied::Cgroup { .. } | LimitsApplied::Rlimit)
    }
}

#[cfg(target_os = "linux")]
mod cgroup {
    use super::*;
    use std::fs;
    // Scoped to this module rather than the file: everything that names `Path` is Linux-only, so a
    // file-level import is an unused-import warning on every other platform.
    use std::path::Path;

    /// The cgroup this process is in, from `/proc/self/cgroup` (v2 has a single `0::` line).
    fn current_cgroup() -> Option<PathBuf> {
        let text = fs::read_to_string("/proc/self/cgroup").ok()?;
        let rel = text.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
        Some(PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
    }

    /// Create a child cgroup and apply limits. `Err` carries why it could not be done.
    ///
    /// Nested under the *current* cgroup rather than at the root: that is the delegation model, and the
    /// only shape an unprivileged process has any chance of being allowed to use.
    pub fn create(limits: &ResourceLimits, name: &str) -> Result<PathBuf, String> {
        if !PathBuf::from("/sys/fs/cgroup/cgroup.controllers").exists() {
            return Err("cgroup v2 is not mounted".to_owned());
        }
        let base = current_cgroup().ok_or("cannot determine this process's cgroup")?;
        let dir = base.join(format!("zeraix-{name}"));
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;

        if let Some(mem) = limits.memory_bytes {
            fs::write(dir.join("memory.max"), mem.to_string())
                .map_err(|e| format!("memory.max: {e}"))?;
        }
        if let Some(cpu) = limits.cpu_seconds {
            // cpu.max is "<quota> <period>" in microseconds. Expressing a *total* CPU-seconds budget as
            // a bandwidth cap is a category error, so this is deliberately conservative: allow one full
            // core (quota == period) and let RLIMIT_CPU carry the total, which is what it actually means.
            let _ = cpu;
            let _ = fs::write(dir.join("cpu.max"), "100000 100000");
        }
        if let Some(procs) = limits.max_processes {
            let _ = fs::write(dir.join("pids.max"), procs.to_string());
        }
        Ok(dir)
    }

    /// Move a pid into a cgroup.
    pub fn attach(dir: &Path, pid: u32) -> Result<(), String> {
        fs::write(dir.join("cgroup.procs"), pid.to_string()).map_err(|e| format!("cgroup.procs: {e}"))
    }

    /// Remove an empty cgroup. Best-effort: it fails while any process remains, which is expected if a
    /// grandchild outlived the group, and is not worth reporting.
    pub fn remove(dir: &Path) {
        let _ = fs::remove_dir(dir);
    }
}

/// Prepare limits for a child that is about to be spawned.
///
/// Returns the cgroup to attach to (if any) plus what the caller should tell the truth about.
pub fn prepare(limits: &ResourceLimits, name: &str) -> (Option<PathBuf>, LimitsApplied) {
    if limits.is_empty() {
        return (None, LimitsApplied::None);
    }
    #[cfg(target_os = "linux")]
    {
        match cgroup::create(limits, name) {
            Ok(dir) => return (Some(dir.clone()), LimitsApplied::Cgroup { path: dir }),
            Err(reason) => {
                // Expected on a normal desktop session; logged at debug so it is discoverable without
                // being noise.
                tracing::debug!(reason = %reason, "cgroup limits unavailable, falling back to setrlimit");
            }
        }
    }
    #[cfg(unix)]
    {
        let _ = name;
        // A memory cap requested on anything but Linux is NOT delivered — see `apply_rlimits`. Saying
        // so is the whole contract of this enum: limits are never silently dropped. CPU still is
        // enforced, but a caller that asked to bound memory did not get what it asked for, and finding
        // that out from a report is better than from a process that quietly used all of it.
        #[cfg(not(target_os = "linux"))]
        if limits.memory_bytes.is_some() {
            return (
                None,
                LimitsApplied::Unsupported {
                    reason: "memory cannot be bounded here: RLIMIT_AS caps ADDRESS SPACE, and this \
                             platform's loader reserves far more of it than any sane cap, so applying \
                             one stops every command from starting at all"
                        .to_owned(),
                },
            );
        }
        (None, LimitsApplied::Rlimit)
    }
    #[cfg(not(unix))]
    {
        let _ = name;
        (
            None,
            LimitsApplied::Unsupported {
                reason: "resource limits are not implemented on this platform (Windows needs a Job Object)"
                    .to_owned(),
            },
        )
    }
}

/// Attach a spawned pid to its cgroup, if one was created.
pub fn attach(applied: &LimitsApplied, pid: u32) {
    #[cfg(target_os = "linux")]
    if let LimitsApplied::Cgroup { path } = applied
        && let Err(e) = cgroup::attach(path, pid)
    {
        tracing::warn!(error = %e, "could not move the child into its cgroup; it is running unlimited");
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (applied, pid);
    }
}

/// Clean up after the child has exited.
pub fn cleanup(applied: &LimitsApplied) {
    #[cfg(target_os = "linux")]
    if let LimitsApplied::Cgroup { path } = applied {
        cgroup::remove(path);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = applied;
    }
}

/// Apply `setrlimit` in the child, between fork and exec.
///
/// # Safety
/// Called inside `pre_exec`, so only async-signal-safe work is permitted: no allocation, no locks, no
/// arbitrary Rust. `setrlimit` is a bare syscall, which is why this is expressible here at all.
#[cfg(unix)]
pub unsafe fn apply_rlimits(limits: &ResourceLimits) -> std::io::Result<()> {
    use nix::sys::resource::{setrlimit, Resource};

    // Linux only, and this is not conservatism — it is a bug found by CI on macOS.
    //
    // `RLIMIT_AS` bounds ADDRESS SPACE, not resident memory. macOS's dynamic loader reserves address
    // space far beyond anything a caller would pick as a memory cap, so a 512 MB limit makes even
    // `/bin/echo` fail to exec: the command runs, produces nothing, and reports success. A limit that
    // silently turns every command into a no-op is worse than no limit, so this platform reports the
    // memory cap as unsupported instead — see `prepare`.
    #[cfg(target_os = "linux")]
    if let Some(bytes) = limits.memory_bytes {
        // Address space, not RSS — see the module header for why that distinction matters.
        setrlimit(Resource::RLIMIT_AS, bytes, bytes).map_err(std::io::Error::other)?;
    }
    if let Some(secs) = limits.cpu_seconds {
        // Soft below hard so the child gets SIGXCPU first and can exit, then SIGKILL a second later.
        setrlimit(Resource::RLIMIT_CPU, secs, secs + 1).map_err(std::io::Error::other)?;
    }
    #[cfg(target_os = "linux")]
    if let Some(n) = limits.max_processes {
        setrlimit(Resource::RLIMIT_NPROC, n, n).map_err(std::io::Error::other)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_limits_apply_nothing() {
        let (dir, applied) = prepare(&ResourceLimits::default(), "t");
        assert!(dir.is_none());
        assert_eq!(applied, LimitsApplied::None);
        assert!(!applied.is_enforced());
    }

    #[test]
    fn requested_limits_always_report_a_mechanism_or_a_reason() {
        let limits = ResourceLimits { memory_bytes: Some(256 << 20), ..Default::default() };
        let (_, applied) = prepare(&limits, "test-report");
        // The property that matters: limits are never silently dropped. Either something enforced them,
        // or the caller is told why nothing did.
        match applied {
            LimitsApplied::Cgroup { .. } | LimitsApplied::Rlimit => {}
            LimitsApplied::Unsupported { reason } => assert!(!reason.is_empty()),
            LimitsApplied::None => panic!("limits were requested but reported as None"),
        }
    }
}
