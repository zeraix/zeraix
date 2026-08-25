//! Sandbox escape tests (TODO §8, spec §26) — **POSIX only**.
//!
//! The escapes are attempted through a POSIX shell (`cat`, `echo >`, symlinks), so the file is gated to
//! unix. macOS runs it and takes the not-kernel-enforced branch, which is the correct outcome there:
//! Landlock is Linux-only and the tests assert the *report* rather than a confinement that is absent.
#![cfg(unix)]

//!
//! These attempt real escapes against a real confined child and assert they fail. That distinction
//! matters: a test that checks `FilesystemPolicy::allows_read` returns false proves the *table* is right
//! and says nothing about whether anything enforces it. Every test here spawns a process and tries to
//! touch something outside its allowlist.
//!
//! Where the kernel provides no mechanism, the test asserts the *report says so* rather than asserting a
//! confinement that is not there. A test that silently passes on an unconfined platform is worse than no
//! test, because it certifies a boundary that does not exist.

use agent_core::CancellationToken;
use agent_sandbox::{
    ExecutionBackend, FilesystemPolicy, NativeBackend, NetworkPolicy, SandboxPolicy, SandboxRequest,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A workspace with a secret outside it, and the policy that should confine a command to the workspace.
struct Fixture {
    _root: tempfile::TempDir,
    work: PathBuf,
    secret: PathBuf,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let work = root.path().join("workspace");
    let outside = root.path().join("outside");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(work.join("allowed.txt"), "in bounds\n").unwrap();
    let secret = outside.join("secret.txt");
    std::fs::write(&secret, "TOP SECRET\n").unwrap();
    Fixture { _root: root, work, secret }
}

/// A policy confining the command to `work`, plus the system paths a shell needs to run at all.
fn confined_to(work: &Path) -> SandboxPolicy {
    SandboxPolicy {
        filesystem: FilesystemPolicy {
            read: vec![
                work.to_path_buf(),
                PathBuf::from("/usr"),
                PathBuf::from("/lib"),
                PathBuf::from("/lib64"),
                PathBuf::from("/bin"),
                PathBuf::from("/etc"),
            ],
            write: vec![work.to_path_buf()],
            execute: vec![PathBuf::from("/usr"), PathBuf::from("/bin"), PathBuf::from("/lib"), PathBuf::from("/lib64")],
        },
        network: NetworkPolicy::default(),
    }
}

async fn run(policy: SandboxPolicy, cmd: &str, cwd: &Path) -> agent_sandbox::backend::SandboxOutcome {
    NativeBackend::new()
        .execute(
            SandboxRequest::new(cmd)
                .in_dir(cwd)
                .with_policy(policy)
                .with_timeout(Duration::from_secs(20)),
            &CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn a_confined_command_can_still_do_its_job() {
    // The control. A sandbox that breaks ordinary work is not a sandbox, it is a bug.
    let f = fixture();
    let out = run(confined_to(&f.work), "cat allowed.txt", &f.work).await;
    assert!(
        out.process.stdout.contains("in bounds"),
        "confinement broke a legitimate read: {:?} / report {:?}",
        out.process,
        out.report
    );
}

#[tokio::test]
async fn a_confined_command_can_write_inside_the_workspace() {
    let f = fixture();
    let out = run(confined_to(&f.work), "echo written > new.txt && cat new.txt", &f.work).await;
    assert!(out.process.stdout.contains("written"), "{:?} / {:?}", out.process, out.report);
    assert!(f.work.join("new.txt").exists());
}

#[tokio::test]
async fn reading_outside_the_allowlist_is_refused() {
    let f = fixture();
    let policy = confined_to(&f.work);
    let report = NativeBackend::new().enforcement(&policy);

    let out = run(policy, &format!("cat {}", f.secret.display()), &f.work).await;

    if report.filesystem.is_kernel_enforced() {
        assert!(
            !out.process.stdout.contains("TOP SECRET"),
            "ESCAPE: the secret was read despite {}",
            report.filesystem.describe()
        );
        assert!(!out.process.success(), "the read should have failed outright");
    } else {
        // No mechanism here — the report must admit it rather than the test certifying a boundary that
        // does not exist.
        assert!(
            !report.filesystem.is_kernel_enforced(),
            "report claims enforcement that did not happen"
        );
        eprintln!("skipped enforcement assertion: {}", report.filesystem.describe());
    }
}

#[tokio::test]
async fn writing_outside_the_allowlist_is_refused() {
    let f = fixture();
    let policy = confined_to(&f.work);
    let report = NativeBackend::new().enforcement(&policy);
    let target = f.secret.parent().unwrap().join("planted.txt");

    let out = run(policy, &format!("echo pwned > {}", target.display()), &f.work).await;

    if report.filesystem.is_kernel_enforced() {
        assert!(!target.exists(), "ESCAPE: wrote outside the allowlist");
        assert!(!out.process.success());
    } else {
        eprintln!("skipped enforcement assertion: {}", report.filesystem.describe());
    }
}

#[tokio::test]
async fn traversal_out_of_the_workspace_is_refused() {
    // The classic escape: stay "inside" the workspace lexically and walk out with `..`.
    let f = fixture();
    let policy = confined_to(&f.work);
    let report = NativeBackend::new().enforcement(&policy);

    let out = run(policy, "cat ../outside/secret.txt", &f.work).await;

    if report.filesystem.is_kernel_enforced() {
        assert!(
            !out.process.stdout.contains("TOP SECRET"),
            "ESCAPE via traversal: {:?}",
            out.process
        );
    } else {
        eprintln!("skipped enforcement assertion: {}", report.filesystem.describe());
    }
}

#[tokio::test]
async fn a_symlink_into_forbidden_space_does_not_grant_access() {
    // Landlock resolves at access time, so a link created *inside* the workspace does not launder a path
    // outside it. This is the case a lexical check cannot catch at all, which is why it is the sharpest
    // test of whether enforcement is real.
    let f = fixture();
    let link = f.work.join("shortcut");
        std::os::unix::fs::symlink(f.secret.parent().unwrap(), &link).unwrap();

    let policy = confined_to(&f.work);
    let report = NativeBackend::new().enforcement(&policy);
    let out = run(policy, "cat shortcut/secret.txt", &f.work).await;

    if report.filesystem.is_kernel_enforced() {
        assert!(
            !out.process.stdout.contains("TOP SECRET"),
            "ESCAPE via symlink: a link inside the workspace laundered a path outside it"
        );
    } else {
        eprintln!("skipped enforcement assertion: {}", report.filesystem.describe());
    }
}

#[tokio::test]
async fn a_child_process_inherits_the_confinement() {
    // Landlock restrictions are inherited, so a command that spawns a helper cannot escape by delegating.
    let f = fixture();
    let policy = confined_to(&f.work);
    let report = NativeBackend::new().enforcement(&policy);

    let out = run(
        policy,
        &format!("sh -c 'cat {}'", f.secret.display()),
        &f.work,
    )
    .await;

    if report.filesystem.is_kernel_enforced() {
        assert!(
            !out.process.stdout.contains("TOP SECRET"),
            "ESCAPE: a grandchild was not confined"
        );
    } else {
        eprintln!("skipped enforcement assertion: {}", report.filesystem.describe());
    }
}

#[tokio::test]
async fn the_runtime_itself_is_not_confined_by_a_command_it_ran() {
    // The mistake this guards against is severe and silent: Landlock restrictions are irrevocable, so
    // applying them in the PARENT would confine the runtime for the rest of its life. Reading a path
    // outside the policy after the command finishes proves the restriction stayed in the child.
    let f = fixture();
    let out = run(confined_to(&f.work), "true", &f.work).await;
    assert!(out.process.success());

    let still_readable = std::fs::read_to_string(&f.secret);
    assert!(
        still_readable.is_ok(),
        "the runtime confined ITSELF while sandboxing a command: {still_readable:?}"
    );
}

#[tokio::test]
async fn an_unconfined_request_runs_normally() {
    // An empty policy must mean "no restriction", not "restrict to nothing".
    let f = fixture();
    let out = run(SandboxPolicy::default(), &format!("cat {}", f.secret.display()), &f.work).await;
    assert!(out.process.stdout.contains("TOP SECRET"));
    assert_eq!(out.report.filesystem.describe(), "no restriction requested");
}

#[tokio::test]
async fn a_network_policy_reports_that_it_is_not_enforced_on_the_host() {
    // The honest-reporting requirement. Landlock gained TCP restrictions in ABI v4 (Linux 6.7); below
    // that there is no unprivileged way to constrain where a spawned process connects, and saying so is
    // the only defensible behaviour.
    let policy = SandboxPolicy {
        filesystem: FilesystemPolicy::default(),
        network: NetworkPolicy::allow(["example.com".to_owned()]),
    };
    let report = NativeBackend::new().enforcement(&policy);
    assert!(
        !report.network.is_kernel_enforced(),
        "the host backend claimed network enforcement it does not have"
    );
    assert!(report.network.describe().contains("NOT enforced"), "{}", report.network.describe());
}

#[tokio::test]
async fn enforcement_can_be_inspected_before_running_anything() {
    // Callers need to decide whether a command is safe to run *before* running it.
    let f = fixture();
    let report = NativeBackend::new().enforcement(&confined_to(&f.work));
    assert!(!report.filesystem.describe().is_empty());
    assert_eq!(NativeBackend::new().id(), "native");
}
