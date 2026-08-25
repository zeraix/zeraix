//! Process Runtime tests (spec §10, §26) — **POSIX only**.
//!
//! Gated at the file level because every test here drives a POSIX shell (`sleep`, `trap`, `head -c`,
//! `/dev/zero`, `$$`) and asserts POSIX process semantics (process groups, SIGTERM→SIGKILL). None of
//! that has a `cmd.exe` equivalent, and the helpers were already `#[cfg(unix)]` while the tests using
//! them were not — so on Windows this file did not compile at all, which would have failed the release
//! build's Windows leg the moment CI started running `cargo test`.
//!
//! **This leaves Windows process behaviour untested.** `kill_tree` there is `taskkill /T /F` rather
//! than `killpg`, and that path has never executed anywhere. Covering it needs a Windows machine to
//! validate against; writing tests here that cannot be run would only move the failure into CI.
#![cfg(unix)]

//!
//! The interesting assertions here are the ones about what happens to a process *tree* when a command
//! is stopped. That is the property the JS implementation had to work around explicitly (Node's `exec`
//! signal support rejects the promise but leaves the child alive), and the one a test can easily fake
//! by checking only that the call returned quickly. These check that the grandchild is actually gone.

use agent_core::CancellationToken;
use agent_process::{run, ExitCode, ProcessRequest, ResourceLimits};
use std::time::{Duration, Instant};

fn sh(script: &str) -> ProcessRequest {
    ProcessRequest::new(script)
}

/// Whether a pid is still alive. Signal 0 checks existence without delivering anything.
fn alive(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), None).is_ok()
}

#[tokio::test]
async fn a_successful_command_reports_output_and_zero() {
    let r = run(sh("echo hello"), &CancellationToken::new()).await;
    assert_eq!(r.stdout.trim(), "hello");
    assert_eq!(r.code, ExitCode::Code(0));
    assert!(r.success());
    assert!(!r.killed && !r.canceled);
}

#[tokio::test]
async fn stderr_and_a_nonzero_exit_are_both_reported() {
    let r = run(sh("echo oops >&2; exit 3"), &CancellationToken::new()).await;
    assert_eq!(r.stderr.trim(), "oops");
    assert_eq!(r.code, ExitCode::Code(3));
    assert!(!r.success());
}

#[tokio::test]
async fn the_working_directory_is_honoured() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("marker.txt"), "x").unwrap();
    let r = run(sh("ls").in_dir(dir.path()), &CancellationToken::new()).await;
    assert!(r.stdout.contains("marker.txt"));
}

#[tokio::test]
async fn environment_variables_are_passed() {
    let r = run(sh("echo $ZERAIX_TEST_VAR").with_env("ZERAIX_TEST_VAR", "present"), &CancellationToken::new()).await;
    assert_eq!(r.stdout.trim(), "present");
}

#[tokio::test]
async fn a_command_that_cannot_start_reports_the_reason_rather_than_failing() {
    // Not an error the caller has to handle: the model needs to read what went wrong.
    let r = run(sh("this-command-does-not-exist-zzz"), &CancellationToken::new()).await;
    assert!(!r.success());
    // The shell reports it, so it arrives on stderr with a nonzero code.
    assert!(!r.stderr.is_empty() || r.code != ExitCode::Code(0));
}

#[tokio::test]
async fn a_timeout_stops_the_command_and_says_so() {
    let started = Instant::now();
    let r = run(sh("sleep 30").with_timeout(Duration::from_millis(150)), &CancellationToken::new()).await;
    assert!(r.killed, "the timeout should be reported as killed");
    assert!(!r.canceled, "a timeout is not a user cancellation");
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn cancellation_stops_the_command_and_is_distinguished_from_a_timeout() {
    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        t.cancel();
    });
    let started = Instant::now();
    let r = run(sh("sleep 30"), &token).await;
    assert!(r.canceled, "a user stop should be reported as canceled");
    assert!(!r.killed, "a cancellation is not a timeout");
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn cancelling_before_the_start_runs_nothing() {
    let token = CancellationToken::new();
    token.cancel();
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("should-not-exist");
    let r = run(
        sh(&format!("touch {}", target.display())),
        &token,
    )
    .await;
    assert!(r.canceled);
    assert_eq!(r.code, ExitCode::Unknown);
    assert!(!target.exists(), "the command ran despite being cancelled first");
}

#[tokio::test]
async fn output_produced_before_the_stop_is_kept() {
    // Often the most useful part, and what the model needs to explain what happened.
    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        t.cancel();
    });
    let r = run(sh("echo early-output; sleep 30"), &token).await;
    assert!(r.canceled);
    assert!(r.stdout.contains("early-output"), "stdout was {:?}", r.stdout);
}

#[tokio::test]
async fn cancelling_kills_the_whole_tree_not_just_the_shell() {
    // The property the JS implementation needed an explicit workaround for. A grandchild left running
    // with nobody waiting on it is indistinguishable, from the user's side, from Stop not working.
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("grandchild.pid");

    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        t.cancel();
    });

    // The shell backgrounds a long sleep and records its pid, then waits.
    let script = format!("sleep 60 & echo $! > {}; wait", pidfile.display());
    let r = run(sh(&script), &token).await;
    assert!(r.canceled);

    let pid: u32 = std::fs::read_to_string(&pidfile)
        .expect("the grandchild never recorded its pid")
        .trim()
        .parse()
        .expect("bad pid");

    // Give the signal a moment to be delivered through the group.
    for _ in 0..50 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Clean up before failing so the test does not leak a 60s sleep.
    let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGKILL);
    panic!("the grandchild ({pid}) survived cancellation — the tree kill did not reach it");
}

#[tokio::test]
async fn a_process_that_ignores_sigterm_is_still_killed() {
    // The SIGTERM → grace → SIGKILL escalation. Without it, one `trap` in a script hangs the turn.
    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        t.cancel();
    });
    let started = Instant::now();
    let r = run(sh("trap '' TERM; sleep 30"), &token).await;
    assert!(r.canceled);
    // Bounded by the grace window, not by the sleep.
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "escalation to SIGKILL did not happen in time: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn the_runtime_survives_killing_the_child_group() {
    // A regression guard for the mistake this design exists to avoid: if the child shared THIS
    // process's group, the tree kill would take the test runner down with it. Reaching the assertion
    // at all is the proof.
    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        t.cancel();
    });
    let r = run(sh("sleep 10"), &token).await;
    assert!(r.canceled);
    let after = run(sh("echo still-here"), &CancellationToken::new()).await;
    assert_eq!(after.stdout.trim(), "still-here");
}

#[tokio::test]
async fn output_is_capped_and_reports_truncation() {
    // 2 MB of output against a 4 KB cap.
    let r = run(
        sh("head -c 2000000 /dev/zero | tr '\\0' 'x'").with_max_buffer(4096),
        &CancellationToken::new(),
    )
    .await;
    assert!(r.truncated, "the cap was not reported");
    assert!(r.stdout.len() <= 4096, "kept {} bytes despite a 4096 cap", r.stdout.len());
}

#[tokio::test]
async fn a_large_stream_does_not_have_to_be_buffered_whole() {
    // The reason for stopping the read rather than draining-and-discarding: this must be bounded by the
    // cap, not by how much the command decided to print.
    let started = Instant::now();
    let r = run(
        sh("yes x | head -c 50000000").with_max_buffer(8192),
        &CancellationToken::new(),
    )
    .await;
    assert!(r.truncated);
    assert!(r.stdout.len() <= 8192);
    assert!(started.elapsed() < Duration::from_secs(20), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn a_detached_grandchild_holding_the_pipe_does_not_hang_the_call() {
    // The pipes are inherited, so a deliberately detached grandchild can hold them open after the
    // shell exits. Waiting forever for that is its own hang; the drain window bounds it.
    let started = Instant::now();
    let r = run(sh("(sleep 5 &) ; echo done"), &CancellationToken::new()).await;
    assert!(r.stdout.contains("done"));
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the call waited for the detached grandchild: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn no_zombies_are_left_behind() {
    // Every child is awaited by construction. This checks it holds across many sequential runs, which
    // is where a missed `wait` would accumulate visibly.
    for _ in 0..40 {
        let r = run(sh("true"), &CancellationToken::new()).await;
        assert_eq!(r.code, ExitCode::Code(0));
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "--ppid", &std::process::id().to_string()])
        .output()
        .expect("ps");
    let stats = String::from_utf8_lossy(&out.stdout);
    let zombies = stats.lines().filter(|l| l.trim().starts_with('Z')).count();
    assert_eq!(zombies, 0, "left {zombies} zombie(s): {stats:?}");
}

#[tokio::test]
async fn limits_are_either_enforced_or_reported_as_unavailable() {
    let r = run(
        sh("echo limited").with_limits(ResourceLimits {
            memory_bytes: Some(512 << 20),
            cpu_seconds: Some(30),
            max_processes: None,
        }),
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(r.stdout.trim(), "limited");
    // The property that matters: limits are never silently dropped.
    assert!(
        r.limits.is_enforced() || matches!(r.limits, agent_process::LimitsApplied::Unsupported { .. }),
        "limits were requested but reported as {:?}",
        r.limits
    );
}

#[tokio::test]
async fn an_rlimit_actually_constrains_the_child() {
    // Proof the fallback is real rather than decorative: a 32 MB address-space cap must defeat an
    // attempt to allocate far more. `head -c` on /dev/zero into a shell variable forces the allocation
    // inside the limited process.
    let r = run(
        sh("A=$(head -c 200000000 /dev/zero | tr '\\0' 'x'); echo ${#A}").with_limits(ResourceLimits {
            memory_bytes: Some(32 << 20),
            ..Default::default()
        }),
        &CancellationToken::new(),
    )
    .await;
    // Either the allocation failed (nonzero exit / empty output) or, if this platform could not apply
    // the limit at all, the result says so. What must not happen is a silent success at 200 MB.
    if r.limits.is_enforced() {
        assert!(
            !r.success() || r.stdout.trim() != "200000000",
            "the memory limit did not constrain the child: {r:?}"
        );
    }
}

#[tokio::test]
async fn concurrent_runs_do_not_interfere() {
    let mut handles = Vec::new();
    for i in 0..24 {
        handles.push(tokio::spawn(async move {
            let r = run(sh(&format!("echo {i}")), &CancellationToken::new()).await;
            (i, r.stdout.trim().to_owned())
        }));
    }
    for h in handles {
        let (i, out) = h.await.unwrap();
        assert_eq!(out, i.to_string(), "output crossed between concurrent runs");
    }
}
