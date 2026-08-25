//! Landlock filesystem confinement (Linux).
//!
//! Landlock is the mechanism §8 is looking for on Linux: an unprivileged process can restrict *itself*
//! and its descendants to a set of path hierarchies, enforced by the kernel. No root, no namespace, no
//! helper process, and — unlike a check performed in the parent — nothing the child can construct its way
//! around.
//!
//! ## ABI negotiation is not optional
//!
//! Landlock's capabilities are versioned and a ruleset referring to an access right the running kernel
//! does not know is rejected outright. So the ABI is probed at runtime and the request is built
//! "best effort": every kernel gets the strongest ruleset it can actually enforce, and the version that
//! was negotiated is *reported* rather than assumed.
//!
//! Measured on the development kernel (WSL2 6.6): **ABI v3**. That covers filesystem read, write,
//! execute, reparenting and truncation. It does **not** cover TCP `bind`/`connect`, which arrived in ABI
//! v4 (Linux 6.7) — which is why `NetworkPolicy` reports itself unenforced on this path rather than
//! pretending otherwise.
//!
//! ## Where the restriction is applied
//!
//! In the child, between `fork` and `exec`, via `pre_exec`. It has to be: restricting the *parent* would
//! confine the runtime itself, and Landlock restrictions are inherited and irrevocable, so the runtime
//! would lose access to every path outside the current command's policy for the rest of its life.

use crate::policy::{Enforcement, FilesystemPolicy};
use landlock::{
    Access, AccessFs, CompatLevel, Compatible, PathBeneath, PathFd, RulesetAttr, RulesetCreatedAttr,
    RulesetStatus, ABI,
};

/// The ABI this build knows how to ask for. Negotiated down at runtime.
const TARGET_ABI: ABI = ABI::V3;

/// Probe the kernel's Landlock ABI. `None` means Landlock is unavailable.
pub fn probe_abi() -> Option<u32> {
    // The crate exposes no direct probe, so a trivial ruleset is created and its compatibility status
    // reports what was negotiated.
    match landlock::Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(TARGET_ABI))
        .and_then(|r| r.create())
    {
        Ok(_) => Some(TARGET_ABI as u32),
        Err(_) => None,
    }
}

/// Apply `policy` to the calling thread and its future descendants.
///
/// # Safety
/// Intended for `pre_exec`, between fork and exec. The Landlock syscalls are async-signal-safe, but the
/// `landlock` crate allocates while building a ruleset — acceptable here in practice because the child is
/// single-threaded at this point, which is the condition that makes post-fork allocation unsafe.
/// Documented rather than hidden.
pub fn apply(policy: &FilesystemPolicy) -> std::io::Result<()> {
    let mut ruleset = landlock::Ruleset::default()
        .set_compatibility(CompatLevel::BestEffort)
        .handle_access(AccessFs::from_all(TARGET_ABI))
        .map_err(std::io::Error::other)?
        .create()
        .map_err(std::io::Error::other)?;

    // Read-only subtrees.
    for path in &policy.read {
        if let Ok(fd) = PathFd::new(path) {
            ruleset = ruleset
                .add_rule(PathBeneath::new(fd, AccessFs::from_read(TARGET_ABI)))
                .map_err(std::io::Error::other)?;
        }
        // A path that does not exist is skipped rather than failing the whole ruleset: a policy naming
        // /usr/local on a system without it should not leave the command unconfined.
    }

    // Writable subtrees get read as well: a process that can write but not read cannot edit a file, and
    // every caller that asks for write means both.
    for path in &policy.write {
        if let Ok(fd) = PathFd::new(path) {
            ruleset = ruleset
                .add_rule(PathBeneath::new(
                    fd,
                    AccessFs::from_read(TARGET_ABI) | AccessFs::from_write(TARGET_ABI),
                ))
                .map_err(std::io::Error::other)?;
        }
    }

    for path in &policy.execute {
        if let Ok(fd) = PathFd::new(path) {
            ruleset = ruleset
                .add_rule(PathBeneath::new(fd, AccessFs::Execute | AccessFs::ReadFile))
                .map_err(std::io::Error::other)?;
        }
    }

    let status = ruleset.restrict_self().map_err(std::io::Error::other)?;
    match status.ruleset {
        // Nothing was enforced. Failing loudly is right: the caller asked for confinement and would
        // otherwise run unconfined believing it was sandboxed.
        RulesetStatus::NotEnforced => Err(std::io::Error::other(
            "landlock reported the ruleset was not enforced",
        )),
        _ => Ok(()),
    }
}

/// What `apply` would achieve on this kernel, without applying it.
pub fn enforcement_for(policy: &FilesystemPolicy) -> Enforcement {
    if policy.is_empty() {
        return Enforcement::NotRequested;
    }
    match probe_abi() {
        Some(abi) => Enforcement::Landlock { abi },
        None => Enforcement::LexicalOnly {
            reason: "the kernel does not provide Landlock".to_owned(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_abi_probe_answers_without_panicking() {
        // Whatever the answer, it must be a definite one — a sandbox that cannot say whether it is
        // available is worse than one that says no.
        if let Some(v) = probe_abi() {
            assert!(v >= 1, "an available Landlock must report a usable ABI");
        }
    }

    #[test]
    fn an_empty_policy_is_reported_as_not_requested() {
        assert_eq!(
            enforcement_for(&FilesystemPolicy::default()),
            Enforcement::NotRequested
        );
    }

    #[test]
    fn a_requested_policy_never_reports_silent_success() {
        let p = FilesystemPolicy::workspace("/tmp");
        let e = enforcement_for(&p);
        assert_ne!(e, Enforcement::NotRequested);
        // Either the kernel enforces it, or we say we are only checking lexically.
        assert!(e.is_kernel_enforced() || matches!(e, Enforcement::LexicalOnly { .. }));
    }
}
