//! Fault injection (TODO §10, spec §26) — **POSIX only**.
//!
//! Same gate and same reason as `process.rs`: these inject POSIX faults (`kill -9`, `trap '' TERM`,
//! closing fd 1, process trees) against a POSIX shell. Ungated, the ones using `sleep` would compile on
//! Windows and then fail, because `cmd.exe` has no `sleep` — a green-looking test file that reddens the
//! release build.
#![cfg(unix)]

//!
//! Distinct from the behavioural tests in `process.rs`: those check that the runtime does the right thing
//! when a command behaves badly. These check that it survives when the *environment* does — a process
//! killed out from under it, a pipe that dies mid-write, a hung child, an executable that vanishes.
//!
//! The property under test throughout is the same one: **the runtime keeps working**. A fault produces a
//! result, not a panic, not a hang, and not a leak.

use agent_core::CancellationToken;
use agent_process::{run, ExitCode, ProcessRequest};
use std::time::{Duration, Instant};

fn sh(script: &str) -> ProcessRequest {
    ProcessRequest::new(script)
}

#[tokio::test]
async fn a_child_killed_by_sigkill_reports_unknown_rather_than_a_fake_code() {
    // A signalled process has no exit code. Inventing one (0, or 137) would let a caller mistake a kill
    // for a normal exit.
    let r = run(sh("kill -9 $$"), &CancellationToken::new()).await;
    assert_eq!(r.code, ExitCode::Unknown, "a SIGKILLed child should report Unknown");
    assert!(!r.success());
    assert!(!r.killed, "the runtime did not time it out");
    assert!(!r.canceled, "the runtime did not cancel it");
}

#[tokio::test]
async fn a_child_that_kills_its_own_process_group_does_not_take_the_runtime_with_it() {
    // The child is in its own group, so `kill -9 0` (the whole group) must stay contained. If group
    // isolation were broken this would kill the test runner.
    let r = run(sh("kill -9 0"), &CancellationToken::new()).await;
    assert!(!r.success());
    // Still alive and still able to run commands.
    let after = run(sh("echo survived"), &CancellationToken::new()).await;
    assert_eq!(after.stdout.trim(), "survived");
}

#[tokio::test]
async fn output_written_before_a_sigkill_is_still_returned() {
    let r = run(sh("echo before-the-kill; kill -9 $$"), &CancellationToken::new()).await;
    assert!(
        r.stdout.contains("before-the-kill"),
        "output produced before the kill was lost: {:?}",
        r.stdout
    );
}

#[tokio::test]
async fn a_closed_stdout_mid_stream_does_not_hang_or_panic() {
    // The pipe dies while the command is still writing. A naive reader waits forever on EOF that has
    // already happened in an unusual order.
    let started = Instant::now();
    let r = run(sh("exec 1>&-; echo lost; exit 7"), &CancellationToken::new()).await;
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    // The exit status still arrives even though stdout was gone.
    assert!(matches!(r.code, ExitCode::Code(_)), "no exit status: {:?}", r.code);
}

#[tokio::test]
async fn a_missing_executable_is_a_result_not_a_failure_to_launch() {
    let r = run(sh("definitely-not-a-real-binary-zzz"), &CancellationToken::new()).await;
    assert!(!r.success());
    // The shell exists, so the shell reports it — either way the caller gets text to show the model.
    assert!(!r.stderr.is_empty() || r.code != ExitCode::Code(0));
}

#[tokio::test]
async fn a_missing_working_directory_is_reported_not_panicked() {
    let mut req = sh("echo hi");
    req.cwd = Some("/definitely/not/a/real/path/zzz".into());
    let r = run(req, &CancellationToken::new()).await;
    assert!(!r.success());
    assert!(!r.stderr.is_empty(), "the reason should be reported");
}

#[tokio::test]
async fn a_hung_child_is_bounded_by_its_timeout() {
    // The canonical hang: a process that will never exit and ignores TERM.
    let started = Instant::now();
    let r = run(
        sh("trap '' TERM INT; while :; do sleep 1; done").with_timeout(Duration::from_millis(200)),
        &CancellationToken::new(),
    )
    .await;
    assert!(r.killed, "the timeout was not reported");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "a hung child outlived its timeout: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_fork_bomb_shaped_command_is_contained_by_the_process_group_kill() {
    // Not an actual fork bomb — a modest tree, which is enough to prove the group kill reaches
    // descendants rather than only the shell.
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    // The parent must stay alive until the cancel arrives. An earlier version used `(sleep 60 &)`
    // subshells followed by `wait`: the subshells exit immediately, so `wait` returned in milliseconds
    // and the command COMPLETED before the cancellation fired — the test was measuring a natural exit
    // and would have passed against a broken group kill.
    let script = format!(
        "for i in 1 2 3 4 5; do sleep 60 & echo $! >> {}; done; sleep 60",
        pids.display()
    );

    let token = CancellationToken::new();
    let t = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        t.cancel();
    });
    let r = run(sh(&script), &token).await;
    assert!(r.canceled);

    let recorded = std::fs::read_to_string(&pids).unwrap_or_default();
    let children: Vec<u32> = recorded.lines().filter_map(|l| l.trim().parse().ok()).collect();
    assert!(!children.is_empty(), "the fixture never recorded any children");

    let alive = |pid: u32| {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
    };
    for _ in 0..60 {
        if children.iter().all(|p| !alive(*p)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let survivors: Vec<u32> = children.iter().copied().filter(|p| alive(*p)).collect();
    for p in &survivors {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(*p as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    panic!("{} descendant(s) survived the group kill: {survivors:?}", survivors.len());
}

#[tokio::test]
async fn repeated_faults_do_not_leak_processes() {
    // A soak: every kind of fault, many times, then check nothing accumulated.
    for _ in 0..15 {
        let _ = run(sh("kill -9 $$"), &CancellationToken::new()).await;
        let _ = run(sh("exit 1"), &CancellationToken::new()).await;
        let _ = run(
            sh("sleep 30").with_timeout(Duration::from_millis(30)),
            &CancellationToken::new(),
        )
        .await;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "--ppid", &std::process::id().to_string()])
        .output()
        .expect("ps");
    let stats = String::from_utf8_lossy(&out.stdout);
    let zombies = stats.lines().filter(|l| l.trim().starts_with('Z')).count();
    assert_eq!(zombies, 0, "faults left {zombies} zombie(s)");
}

#[tokio::test]
async fn cancelling_many_commands_at_once_settles_all_of_them() {
    let token = CancellationToken::new();
    let mut handles = Vec::new();
    for _ in 0..12 {
        let t = token.clone();
        handles.push(tokio::spawn(async move { run(sh("sleep 30"), &t).await }));
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    token.cancel();

    let started = Instant::now();
    for h in handles {
        let r = h.await.expect("a run task panicked");
        assert!(r.canceled, "a command did not report cancellation");
    }
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
}
