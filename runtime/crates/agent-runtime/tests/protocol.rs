//! End-to-end protocol tests: the real binary, over real pipes.
//!
//! The unit tests cover each tool's logic and the registry's cancellation wrapper. What they cannot
//! reach is the thing the sidecar architecture actually rests on — that the process serves requests
//! *concurrently*, so a cancellation can arrive and take effect while the call it targets is still
//! running. That property is invisible to an in-process test and is exactly what the JS runtime lacks:
//! an `ipcMain.handle` promise cannot be interrupted, which is why a second IPC channel had to be
//! invented there.
//!
//! The runtime's other surfaces have files of their own beside this one: `processes.rs`, `mcp.rs`,
//! `subagents.rs`, `agent_run.rs`, `agent_host.rs` and `transport.rs`. Shared harness in `common/`.

mod common;

use common::*;
use std::io::Write;
use std::time::{Duration, Instant};

/// A tree big enough that an exhaustive content search over it takes long enough to cancel.
///
/// Note the queries below search for a string that is *absent*. A matching query would trip the
/// 200-match cap within the first file and return in microseconds, which is how the first version of
/// the cancellation test managed to pass a completed search off as a slow one.
fn big_tree(files: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..files {
        let sub = dir.path().join(format!("d{}", i % 20));
        std::fs::create_dir_all(&sub).unwrap();
        // Enough content per file that the search does real work rather than just stat-ing.
        std::fs::write(sub.join(format!("f{i}.txt")), "lorem ipsum dolor sit amet\n".repeat(200)).unwrap();
    }
    dir
}

#[test]
fn initialize_reports_version_and_tools() {
    let mut rt = Runtime::start();
    let r = rt.init();
    let result = &r["result"];
    assert_eq!(result["protocol_version"], "1.1");
    let tools = result["tools"].as_array().expect("tools array");
    for expected in ["read_file", "list_directory", "file_info", "search_files", "search_in_files"] {
        assert!(tools.iter().any(|t| t == expected), "{expected} missing from {tools:?}");
    }
}

/// `init()` above asks for 1.0 and this build serves 1.1, which is the skew a packaged app hits when
/// its binary is newer than its bridge. It must still negotiate, and it must say what it can do beyond
/// the baseline — otherwise the host has no way to tell that apart from a runtime that cannot.
#[test]
fn a_baseline_host_negotiates_and_learns_the_new_features() {
    let mut rt = Runtime::start();
    let features = rt.init()["result"]["features"].clone();
    let features = features.as_array().expect("features array");
    assert!(features.iter().any(|f| f == "process.run"), "process.run missing from {features:?}");
}

#[test]
fn incompatible_major_version_is_refused() {
    let mut rt = Runtime::start();
    let r = rt.call("runtime.initialize", serde_json::json!({ "protocol_version": "2.0" }));
    assert_eq!(r["error"]["code"], "protocol.version_mismatch");
    // Refused rather than dropped: the host needs a structured answer so it can fall back to its own
    // handlers instead of failing somewhere deep in a turn.
    assert!(r["result"].is_null());
}

#[test]
fn methods_are_refused_before_initialize() {
    let mut rt = Runtime::start();
    let r = rt.call("tool.list", serde_json::json!({}));
    assert_eq!(r["error"]["code"], "protocol.not_initialized");
}

#[test]
fn unknown_method_is_an_error_not_a_crash() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("tool.nonexistent", serde_json::json!({}));
    assert_eq!(r["error"]["code"], "protocol.unknown_method");
    // Still alive and serving.
    assert!(rt.call("runtime.status", serde_json::json!({}))["result"].is_object());
}

#[test]
fn malformed_input_does_not_kill_the_connection() {
    let mut rt = Runtime::start();
    rt.init();
    writeln!(rt.stdin, "{{not json at all").unwrap();
    rt.stdin.flush().unwrap();
    // The next well-formed request must still be answered.
    let r = rt.call("runtime.status", serde_json::json!({}));
    assert!(r["result"]["runtime_version"].is_string());
}

#[test]
fn tool_call_returns_the_legacy_shape() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
    let mut rt = Runtime::start();
    rt.init();

    let r = rt.call(
        "tool.call",
        serde_json::json!({ "name": "read_file", "args": { "path": "a.txt" }, "workdir": dir.path() }),
    );
    let result = &r["result"];
    assert_eq!(result["ok"], true);
    assert_eq!(result["content"], "hello");
    assert!(result["error"].is_null(), "a successful call carries no error");
}

#[test]
fn a_failing_call_reports_ok_false_and_a_structured_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = Runtime::start();
    rt.init();

    let r = rt.call(
        "tool.call",
        serde_json::json!({ "name": "read_file", "args": { "path": "../escape" }, "workdir": dir.path() }),
    );
    let result = &r["result"];
    // The legacy contract: a tool failure is a RESULT, never a protocol error. Anything else would let
    // a bad tool call abort a turn.
    assert_eq!(result["ok"], false);
    assert!(result["content"].as_str().unwrap().contains("escapes the working directory"));
    assert_eq!(result["error"]["code"], "tool.path_escapes_workspace");
    assert_eq!(result["error"]["class"], "denied");
    assert_eq!(result["error"]["retryable"], false);
}

#[test]
fn requests_are_served_concurrently() {
    let dir = big_tree(600);
    let mut rt = Runtime::start();
    rt.init();

    // A slow call goes out first, then a trivial one. If the runtime served requests in order, the
    // status reply could not arrive first — and cancellation would be unreachable for the same reason.
    let slow_id = rt.send(
        "tool.call",
        serde_json::json!({
            "name": "search_in_files",
            "args": { "query": "zzz-appears-nowhere-zzz" },
            "workdir": dir.path(),
            "call_id": "slow-1"
        }),
    );
    let fast_id = rt.send("runtime.status", serde_json::json!({}));

    // `read_reply` rather than `read`: since the event bridge landed, `runtime.event` notifications share
    // this stream and can arrive before either answer. The claim under test is about the order of REPLIES —
    // that the cheap one is not stuck behind the expensive one — and notifications say nothing about it.
    let first = rt.read_reply();
    assert_eq!(
        first["id"].as_u64(),
        Some(fast_id),
        "the cheap request should not have queued behind the expensive one"
    );
    let second = rt.read_reply();
    assert_eq!(second["id"].as_u64(), Some(slow_id));
}

#[test]
fn cancel_stops_an_in_flight_search() {
    // Escalating corpus, because "long enough to cancel" is a property of the MACHINE, not of the code.
    //
    // The first version searched a fixed 1500-file tree and waited 30ms, on the strength of that
    // workload measuring "hundreds of milliseconds" — which it does on WSL over DrvFs, where it was
    // written. A release build on a macOS runner with APFS finishes it in single-digit milliseconds, so
    // the search completed before the cancel arrived and the test failed asserting that a cancelled
    // search had reported success. It had not been cancelled at all; it had already finished.
    //
    // Sizing up until the search is genuinely still running keeps the assertion strict on every machine
    // instead of encoding one machine's disk speed. The first attempt is what a normal runner takes.
    for (attempt, files) in [1500usize, 8000, 30000].into_iter().enumerate() {
        let dir = big_tree(files);
        let mut rt = Runtime::start();
        rt.init();

        let id = rt.send(
            "tool.call",
            serde_json::json!({
                "name": "search_in_files",
                "args": { "query": "zzz-appears-nowhere-zzz" },
                "workdir": dir.path(),
                "call_id": "cancel-me"
            }),
        );
        // Long enough that the search is genuinely UNDER WAY. Without this pause the cancel routinely
        // beats the task to the starting line, and what gets tested is the queued-cancel path rather
        // than this one — which is covered separately. The property here is narrower and worth keeping:
        // that `search_in_files` honours the token it is handed while it is running.
        std::thread::sleep(Duration::from_millis(30));
        let sent_at = Instant::now();
        rt.notify("call.cancel", serde_json::json!({ "call_id": "cancel-me" }));

        let reply = rt.read_reply();
        assert_eq!(reply["id"].as_u64(), Some(id));
        let result = &reply["result"];

        if result["ok"] == true {
            // The search beat the cancel. Not a failure of cancellation — there was nothing left to
            // cancel — so try again against a corpus this machine cannot chew through as quickly.
            assert!(
                attempt < 2,
                "the search finished before a cancel could reach it even at {files} files; either this \
                 machine is extraordinarily fast or search_in_files stopped doing the work"
            );
            continue;
        }

        assert_eq!(result["error"]["code"], "runtime.cancelled");
        assert_eq!(result["error"]["class"], "cancelled");
        // The point of the exercise: Stop takes effect promptly rather than at the end of the work.
        assert!(
            sent_at.elapsed() < Duration::from_secs(5),
            "cancellation took {:?}, which is not 'stopped'",
            sent_at.elapsed()
        );
        return;
    }
}

#[test]
fn cancelling_an_unknown_id_is_harmless() {
    let mut rt = Runtime::start();
    rt.init();
    // The race this tolerates is real: a call can finish between the user's click and the cancel
    // arriving, so an unknown id must be a no-op rather than an error.
    let r = rt.call("tool.cancel", serde_json::json!({ "call_id": "never-existed" }));
    assert_eq!(r["result"]["ok"], true);
}

#[test]
fn workspace_is_per_call_not_global() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    std::fs::write(a.path().join("only-in-a.txt"), "x").unwrap();
    std::fs::write(b.path().join("only-in-b.txt"), "x").unwrap();

    let mut rt = Runtime::start();
    rt.init();

    // Interleaved on one connection. The JS runtime cannot express this at all: WORKDIR is process
    // global there, so two conversations on two projects share one working directory.
    let ra = rt.call(
        "tool.call",
        serde_json::json!({ "name": "search_files", "args": { "pattern": "*.txt" }, "workdir": a.path() }),
    );
    let rb = rt.call(
        "tool.call",
        serde_json::json!({ "name": "search_files", "args": { "pattern": "*.txt" }, "workdir": b.path() }),
    );

    assert!(ra["result"]["content"].as_str().unwrap().contains("only-in-a.txt"));
    assert!(!ra["result"]["content"].as_str().unwrap().contains("only-in-b.txt"));
    assert!(rb["result"]["content"].as_str().unwrap().contains("only-in-b.txt"));
}

// ── scheduler (Stage 5) ───────────────────────────────────────────────────────────────────────────

#[test]
fn status_reports_what_the_scheduler_is_doing() {
    let mut rt = Runtime::start();
    rt.init();
    let s = rt.call("runtime.status", serde_json::json!({}));
    let sched = &s["result"]["scheduler"];
    assert!(sched["running"].is_u64(), "status carries the scheduler's own view: {s}");
    assert!(sched["queued"].is_u64());
    assert!(sched["tasks"].is_array());
}

/// The property this stage exists for: concurrent work is BOUNDED.
///
/// The JS runtime has no global cap on host commands — parallelism there is `Promise.all` over one
/// round's batch, in one renderer, so two conversations fanning out get no ceiling between them. Here
/// eight run and the rest wait.
///
/// Sleeps rather than searches: this needs work that is reliably slow without being expensive, and a
/// CPU-bound test at this concurrency starves the rest of the suite.
#[test]
fn work_is_bounded_and_the_rest_queues() {
    let mut rt = Runtime::start();
    rt.init();

    // Comfortably more than the Process limit (8).
    for _ in 0..12 {
        rt.send("process.run", serde_json::json!({ "command": slow_command(10) }));
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut saw_queue = false;
    while Instant::now() < deadline && !saw_queue {
        let s = rt.call("runtime.status", serde_json::json!({}));
        let running = s["result"]["scheduler"]["running"].as_u64().unwrap_or(0);
        let queued = s["result"]["scheduler"]["queued"].as_u64().unwrap_or(0);
        assert!(running <= 8, "the process limit was exceeded: {running} running");
        saw_queue = queued > 0;
    }
    assert!(saw_queue, "12 concurrent commands under a limit of 8 must queue");
    // Left running deliberately: dropping the runtime kills them, and waiting out ten seconds of sleep
    // would buy the test nothing.
}

/// Cancelling work that has not STARTED yet.
///
/// A queued task has no cancellation token to signal — it is a row in a queue. Routing `call.cancel`
/// through the scheduler by task id rather than by token is what makes Stop reach it, and pressing Stop
/// while a dozen things are waiting is the case where that matters most.
#[test]
fn a_call_can_be_cancelled_before_it_starts() {
    let mut rt = Runtime::start();
    rt.init();

    // Fill the process class, so the next one is certain to be queued rather than running.
    for _ in 0..8 {
        rt.send("process.run", serde_json::json!({ "command": slow_command(10) }));
    }
    let victim = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(10), "call_id": "cancel-me" }),
    );
    rt.notify("call.cancel", serde_json::json!({ "call_id": "cancel-me" }));

    let started = Instant::now();
    loop {
        assert!(started.elapsed() < Duration::from_secs(20), "the cancelled call never answered");
        let reply = rt.read_reply();
        if reply["id"].as_u64() == Some(victim) {
            assert_eq!(reply["result"]["canceled"], true, "a stopped call reports as cancelled");
            // Well before the command's own ten seconds: it never ran at all.
            assert!(started.elapsed() < Duration::from_secs(9));
            break;
        }
    }
}

/// A cancel that arrives BEFORE the call it names.
///
/// Requests are dispatched concurrently — that is what lets a cancel interrupt running work at all —
/// so nothing orders a call registering itself against a cancel looking it up. Under load the cancel
/// can win, and the naive implementation then does nothing at all: the user presses Stop and the work
/// runs to completion.
///
/// Sent inverted here, which is the same race made deterministic. It was found by running the suite
/// under concurrent load, not by reasoning about it.
#[test]
fn a_cancel_that_arrives_first_is_not_lost() {
    let mut rt = Runtime::start();
    rt.init();

    rt.notify("call.cancel", serde_json::json!({ "call_id": "arrives-first" }));
    let id = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(10), "call_id": "arrives-first" }),
    );

    let started = Instant::now();
    loop {
        assert!(started.elapsed() < Duration::from_secs(20), "the cancelled call never answered");
        let reply = rt.read_reply();
        if reply["id"].as_u64() == Some(id) {
            assert_eq!(reply["result"]["canceled"], true, "the earlier cancel still applies");
            assert!(
                started.elapsed() < Duration::from_secs(9),
                "it must not have run its full ten seconds"
            );
            break;
        }
    }
}

// ── Crash recovery (TODO §10.3) ───────────────────────────────────────────────────────────────────

/// A runtime started with no state directory must behave exactly as it always has.
#[test]
fn a_runtime_without_a_state_directory_reports_no_recovered_work() {
    let mut rt = Runtime::start();
    let r = rt.init();
    // Absent rather than empty: the field is skipped when there is nothing in it, so a host that predates
    // recovery sees the same handshake it always saw.
    assert!(r["result"].get("recovered").is_none(), "unexpected: {}", r["result"]);
}

/// The end-to-end shape of §10.3: a task that was running when the process died is reported at the next
/// handshake, and reported as *interrupted* — never as work that is safe to run again.
#[test]
fn work_interrupted_by_a_killed_runtime_is_reported_at_the_next_handshake() {
    let dir = tempfile::tempdir().expect("temp dir");
    let state = dir.path().to_str().expect("utf-8 path");

    {
        let mut rt = Runtime::start_with(&["--state-dir", state]);
        rt.init();
        // A long command, then a kill before it can finish. A command is the right illustration: it is the
        // case where re-running the recovered task would actually do something to the machine a second time.
        rt.send(
            "process.run",
            serde_json::json!({ "command": slow_command(30), "timeout_ms": 60_000, "call_id": "doomed" }),
        );
        // Give it long enough to be admitted and started, then kill without shutting down.
        std::thread::sleep(Duration::from_millis(400));
        rt.child.kill().expect("kill the runtime");
        let _ = rt.child.wait();
        std::mem::forget(rt); // Drop would try to shut down a process that is already gone.
    }

    let mut rt = Runtime::start_with(&["--state-dir", state]);
    let r = rt.init();
    let recovered = &r["result"]["recovered"];
    assert!(!recovered.is_null(), "the second handshake must report the first run: {}", r["result"]);
    let interrupted = recovered["interrupted"].as_array().expect("interrupted array");
    assert_eq!(interrupted.len(), 1, "expected one interrupted task, got {recovered}");
    assert_eq!(recovered["resumable"].as_array().map(|a| a.len()), Some(0));
    assert_eq!(recovered["clean_shutdown"], false);
}

/// Recovery is reported once. A restart that re-reported the same interrupted task forever would make the
/// warning meaningless, and nothing in a later process can ever settle a task whose body died two runs ago.
#[test]
fn a_recovered_journal_is_rotated_so_the_next_start_is_clean() {
    let dir = tempfile::tempdir().expect("temp dir");
    let state = dir.path().to_str().expect("utf-8 path");

    {
        let mut rt = Runtime::start_with(&["--state-dir", state]);
        rt.init();
        rt.send(
            "process.run",
            serde_json::json!({ "command": slow_command(30), "timeout_ms": 60_000, "call_id": "doomed" }),
        );
        std::thread::sleep(Duration::from_millis(400));
        rt.child.kill().expect("kill the runtime");
        let _ = rt.child.wait();
        std::mem::forget(rt);
    }

    // Second start: reports the interruption.
    {
        let mut rt = Runtime::start_with(&["--state-dir", state]);
        let r = rt.init();
        assert!(!r["result"]["recovered"].is_null(), "the first restart must report it");
    }

    // Third start: the journal was rotated, so there is nothing left to report.
    let mut rt = Runtime::start_with(&["--state-dir", state]);
    let r = rt.init();
    assert!(
        r["result"].get("recovered").is_none(),
        "the same interruption must not be reported forever: {}",
        r["result"]
    );
}

/// A clean stop is not a crash, however much work was in flight when it began.
#[test]
fn a_runtime_that_shuts_down_cleanly_leaves_nothing_to_recover() {
    let dir = tempfile::tempdir().expect("temp dir");
    let state = dir.path().to_str().expect("utf-8 path");

    {
        let mut rt = Runtime::start_with(&["--state-dir", state]);
        rt.init();
        rt.call("tool.call", serde_json::json!({
            "name": "file_info",
            "args": { "path": "Cargo.toml" },
            "workdir": ".",
            "call_id": "quick"
        }));
        rt.call("runtime.shutdown", serde_json::json!({}));
        std::thread::sleep(Duration::from_millis(200));
    }

    let mut rt = Runtime::start_with(&["--state-dir", state]);
    let r = rt.init();
    assert!(r["result"].get("recovered").is_none(), "a clean stop leaves nothing: {}", r["result"]);
}

// ── Runtime events (TODO §3.3, §6.3, §10.1, §10.2) ────────────────────────────────────────────────

/// The bus has existed since the scheduler landed and had no subscriber outside the runtime. This is the
/// bridge that makes §10.2's event list something a host can actually receive.
#[test]
fn the_runtime_pushes_task_events_for_work_the_host_asked_for() {
    let mut rt = Runtime::start();
    rt.init();
    rt.send(
        "tool.call",
        serde_json::json!({
            "name": "file_info",
            "args": { "path": "Cargo.toml" },
            "workdir": ".",
            "call_id": "c1"
        }),
    );

    // Read past the reply, not up to it. The tool's answer is written when the CALL finishes; the scheduler
    // publishes `task_completed` when it settles the task afterwards, so a loop that stopped at the reply
    // would assert on a set of events that is genuinely incomplete at that instant.
    let mut kinds: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !kinds.iter().any(|k| k == "task_completed") {
        assert!(Instant::now() < deadline, "no task_completed within the deadline; saw {kinds:?}");
        let msg = rt.read();
        if msg["method"] == "runtime.event" {
            if let Some(kind) = msg["params"]["type"].as_str() {
                kinds.push(kind.to_owned());
            }
        }
    }

    for expected in ["task_submitted", "task_started", "task_completed"] {
        assert!(kinds.iter().any(|k| k == expected), "{expected} missing from {kinds:?}");
    }
}

/// `seq` is what lets a host detect a gap rather than merely be told it lagged, so it has to be monotonic.
#[test]
fn runtime_events_carry_a_monotonic_sequence_number() {
    let mut rt = Runtime::start();
    rt.init();
    for i in 0..3 {
        rt.send(
            "tool.call",
            serde_json::json!({
                "name": "file_info",
                "args": { "path": "Cargo.toml" },
                "workdir": ".",
                "call_id": format!("c{i}")
            }),
        );
    }

    // Wait for EVENTS, not for replies. A reply is written when its call finishes; the scheduler publishes
    // the task's settle afterwards, so a loop that stopped at the third reply would sometimes have seen only
    // two events and sometimes nine — which is how this test was flaky before.
    const WANTED: usize = 6;
    let mut seqs: Vec<u64> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while seqs.len() < WANTED {
        assert!(Instant::now() < deadline, "only saw {} events: {seqs:?}", seqs.len());
        let msg = rt.read();
        if msg["method"] == "runtime.event" {
            if let Some(seq) = msg["params"]["seq"].as_u64() {
                seqs.push(seq);
            }
        }
    }

    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "sequence numbers must increase: {seqs:?}");
}

/// The feature is advertised, so a host routes on capability rather than on version.
#[test]
fn the_event_bridge_is_announced_as_a_feature() {
    let mut rt = Runtime::start();
    let r = rt.init();
    let features = r["result"]["features"].as_array().expect("features");
    assert!(features.iter().any(|f| f == "runtime.events"), "{features:?}");
}

/// A host that sends no approved roots must behave exactly as it did before the field existed.
#[test]
fn a_handshake_without_approved_roots_is_accepted_and_grants_nothing() {
    let mut rt = Runtime::start();
    let r = rt.call(
        "runtime.initialize",
        serde_json::json!({ "protocol_version": "1.0", "client": "test" }),
    );
    assert_eq!(r["result"]["protocol_version"], "1.1");
    // Nothing to assert about the grant from out here — what matters is that the absence of the field is not
    // an error, which is what keeps an older host working against a newer runtime.
    assert!(r["error"].is_null());
}

#[test]
fn approved_roots_are_accepted_at_the_handshake() {
    let mut rt = Runtime::start();
    let r = rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "workspace_roots": ["/tmp/approved"]
        }),
    );
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(r["result"]["runtime_version"], RUNTIME_VERSION_FOR_TEST);
}

/// Kept beside the test that uses it so a version bump does not silently make the assertion vacuous.
const RUNTIME_VERSION_FOR_TEST: &str = "0.1.0";

// ── Pause and resume over the wire (TODO §2.1) ────────────────────────────────────────────────────

#[test]
fn pause_and_resume_are_announced_as_a_feature() {
    let mut rt = Runtime::start();
    let r = rt.init();
    let features = r["result"]["features"].as_array().expect("features");
    assert!(features.iter().any(|f| f == "task.pause"), "{features:?}");
}

/// Pausing work that has already started is a question with a legitimate negative answer.
#[test]
fn pausing_a_running_call_answers_no_rather_than_failing() {
    let mut rt = Runtime::start();
    rt.init();

    // A command that sleeps, not a search over a big tree. The first version searched 600 files and slept
    // 200ms so the call would be "admitted and started" — which, on a release build with a fast disk (the
    // macOS and Windows release runners), was also long enough for it to FINISH. Its reply then arrived
    // before the pause's, and `call` reported replies out of order. The property under test is about work
    // in progress, so the work has to be in progress when the question is asked, on every machine: a child
    // that sleeps is, for exactly as long as it is told to, whatever the disk speed.
    let slow_id = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(30), "call_id": "slow-1" }),
    );

    // Started, not merely submitted. `task.pause` against QUEUED work answers yes, so asking too early would
    // pass the wrong path off as this one — and a sleep is a guess about admission latency. The scheduler
    // publishes the moment it starts a task; wait for that instead. Nothing else has been submitted on this
    // fresh runtime, so the first start is ours.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline, "the command was never started");
        let msg = rt.read();
        if msg["method"] == "runtime.event" && msg["params"]["type"] == "task_started" {
            break;
        }
        assert_ne!(msg["id"].as_u64(), Some(slow_id), "the command finished before it was seen running: {msg}");
    }

    let r = rt.call("task.pause", serde_json::json!({ "call_id": "slow-1" }));
    assert!(r["error"].is_null(), "a refusal must be an answer, not a protocol error: {r}");
    assert_eq!(r["result"]["ok"], false, "a running call is not pausable");
    assert!(
        r["result"]["reason"].is_null(),
        "the call was known and running, so the refusal is about its state, not its identity: {r}"
    );

    // Stop the command rather than leave a 30s sleep behind, and confirm the refused pause left the call
    // itself untouched: it is still there to be cancelled, and it answers.
    rt.notify("call.cancel", serde_json::json!({ "call_id": "slow-1" }));
    let reply = rt.read_reply();
    assert_eq!(reply["id"].as_u64(), Some(slow_id));
    assert_eq!(reply["result"]["canceled"], true);
}

#[test]
fn pausing_an_unknown_call_is_answered_rather_than_failing() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("task.pause", serde_json::json!({ "call_id": "never-existed" }));
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(r["result"]["ok"], false);
    assert_eq!(r["result"]["reason"], "no such call");
}

// ── Audit (TODO §11) ──────────────────────────────────────────────────────────────────────────────

/// `agent-audit` was complete and depended on by nothing. It is now subscribed to the bus, and its numbers
/// reach the host.
#[test]
fn runtime_status_reports_metrics_derived_from_the_event_stream() {
    let mut rt = Runtime::start();
    rt.init();
    for i in 0..3 {
        rt.call(
            "tool.call",
            serde_json::json!({
                "name": "file_info",
                "args": { "path": "Cargo.toml" },
                "workdir": ".",
                "call_id": format!("m{i}")
            }),
        );
    }
    // The settle events arrive after the replies, so give the bus a moment to drain.
    std::thread::sleep(Duration::from_millis(200));

    let r = rt.call("runtime.status", serde_json::json!({}));
    let metrics = &r["result"]["metrics"];
    assert!(!metrics.is_null(), "metrics missing from status: {}", r["result"]);
    // Percentiles, not averages: a mean hides the tail, which is the interesting part.
    let scheduling = &metrics["scheduling_latency_ms"];
    assert!(scheduling["count"].as_u64().unwrap_or(0) >= 3, "expected samples, got {scheduling}");
}

/// An MCP call is recorded whether or not it reached the server.
#[test]
fn an_mcp_call_publishes_an_audit_event_even_when_it_is_refused() {
    let mut rt = Runtime::start();
    rt.init();
    rt.send(
        "mcp.call",
        serde_json::json!({ "server": "not-connected", "tool": "x", "args": {}, "call_id": "mc1" }),
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(Instant::now() < deadline, "no mcp_called event arrived");
        let msg = rt.read();
        if msg["method"] == "runtime.event" && msg["params"]["type"] == "mcp_called" {
            assert_eq!(msg["params"]["server"], "not-connected");
            assert_eq!(msg["params"]["delivered"], false);
            return;
        }
    }
}

/// A command's confinement is recorded as a decision, not an intention.
#[test]
fn a_command_publishes_what_actually_confined_it() {
    let mut rt = Runtime::start();
    rt.init();
    rt.send("process.run", serde_json::json!({ "command": "echo audited", "timeout_ms": 20000, "call_id": "s1" }));

    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(Instant::now() < deadline, "no sandbox_decided event arrived");
        let msg = rt.read();
        if msg["method"] == "runtime.event" && msg["params"]["type"] == "sandbox_decided" {
            // "not requested" and "requested and unavailable" are different facts; both are recorded.
            assert!(msg["params"]["filesystem"].is_string(), "{msg}");
            assert!(msg["params"]["network"].is_string(), "{msg}");
            return;
        }
    }
}
