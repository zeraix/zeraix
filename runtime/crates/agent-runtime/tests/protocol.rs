//! End-to-end protocol tests: the real binary, over real pipes.
//!
//! The unit tests cover each tool's logic and the registry's cancellation wrapper. What they cannot
//! reach is the thing the sidecar architecture actually rests on — that the process serves requests
//! *concurrently*, so a cancellation can arrive and take effect while the call it targets is still
//! running. That property is invisible to an in-process test and is exactly what the JS runtime lacks:
//! an `ipcMain.handle` promise cannot be interrupted, which is why a second IPC channel had to be
//! invented there.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

struct Runtime {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Runtime {
    fn start() -> Self {
        Self::start_with(&[])
    }

    /// Start with extra command-line arguments — `--state-dir`, for the recovery tests.
    fn start_with(args: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_zeraix-agent-runtime"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn runtime");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self { child, stdin, stdout, next_id: 0 }
    }

    /// Write a request without waiting for its reply. Returns the id to match against later.
    fn send(&mut self, method: &str, params: serde_json::Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let msg = serde_json::json!({ "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
        id
    }

    /// Answer a request the RUNTIME made of us. Same shape `serve_until` writes.
    fn reply(&mut self, id: serde_json::Value, result: serde_json::Value) {
        let msg = serde_json::json!({ "id": id, "result": result });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Write a notification (no id, no reply).
    fn notify(&mut self, method: &str, params: serde_json::Value) {
        let msg = serde_json::json!({ "method": method, "params": params });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Read the next line of any kind — a reply or an event.
    fn read(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).expect("read reply");
        assert!(n > 0, "runtime closed the stream unexpectedly");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad reply {line:?}: {e}"))
    }

    /// Read the next *reply*, skipping any events that arrive first.
    ///
    /// Since 1.1 the runtime also pushes notifications, which share the stream with replies and can
    /// land between a request and its answer. A reader that did not skip them would fail whenever a
    /// background service happened to exit at the wrong moment.
    fn read_reply(&mut self) -> serde_json::Value {
        loop {
            let msg = self.read();
            // A message with an id AND a method is a request FROM the runtime (Stage 4), not an
            // answer to one of ours. Only the absence of `method` makes it a reply.
            if msg.get("id").is_some() && !msg["method"].is_string() {
                return msg;
            }
        }
    }

    /// Read lines until an event with this method arrives, discarding replies on the way.
    fn read_event(&mut self, method: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {method} event arrived");
            let msg = self.read();
            if msg["method"] == method {
                return msg;
            }
        }
    }

    fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let id = self.send(method, params);
        let reply = self.read_reply();
        assert_eq!(reply["id"].as_u64(), Some(id), "replies arrived out of order");
        reply
    }

    fn init(&mut self) -> serde_json::Value {
        self.call("runtime.initialize", serde_json::json!({ "protocol_version": "1.0", "client": "test" }))
    }

    /// Handshake declaring which roots the user approved — the ceiling every tool call is decided against.
    fn init_with_roots(&mut self, roots: &[&str]) -> serde_json::Value {
        self.call(
            "runtime.initialize",
            serde_json::json!({ "protocol_version": "1.1", "client": "test", "workspace_roots": roots }),
        )
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

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

// ── process.run (Stage 2) ─────────────────────────────────────────────────────────────────────────

/// A command that runs long enough to be cancelled, spelled for whichever shell this platform uses.
fn slow_command(seconds: u32) -> String {
    if cfg!(windows) {
        // No `sleep` on cmd.exe. `timeout` needs a console it does not have when stdin is a pipe, so
        // ping's one-second interval is the portable spelling that actually works detached.
        format!("ping -n {} 127.0.0.1 > nul", seconds + 1)
    } else {
        format!("sleep {seconds}")
    }
}

#[test]
fn process_run_returns_the_engine_contract() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": "echo parity", "timeout_ms": 30_000 }),
    );
    let result = &r["result"];
    assert!(result["stdout"].as_str().unwrap().contains("parity"));
    assert_eq!(result["code"], 0);
    assert_eq!(result["killed"], false);
    assert_eq!(result["canceled"], false);
}

/// `"?"` rather than a number, because that is what the JS engine contract returns for a process that
/// never produced an exit status, and callers render it verbatim.
#[test]
fn a_command_that_cannot_start_reports_an_unknown_code() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": "definitely-not-a-command-xyz", "timeout_ms": 30_000 }),
    );
    // The shell itself runs and fails, so this is a real non-zero exit rather than "?" — what matters
    // is that it is reported as a result at all, with the shell's own message kept for the model.
    let result = &r["result"];
    assert_ne!(result["code"], 0);
    assert!(!result["stderr"].as_str().unwrap().is_empty(), "the shell's error must reach the caller");
}

#[test]
fn the_deadline_kills_the_command_and_keeps_what_it_printed() {
    let mut rt = Runtime::start();
    rt.init();
    let started = Instant::now();
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": format!("echo before && {}", slow_command(30)), "timeout_ms": 1500 }),
    );
    let result = &r["result"];
    assert_eq!(result["killed"], true, "the deadline must report `killed`, not a clean exit");
    assert_eq!(result["canceled"], false, "a timeout is not a cancellation; run_command words them differently");
    assert!(result["stdout"].as_str().unwrap().contains("before"), "output printed before the kill is still the useful part");
    assert!(started.elapsed() < Duration::from_secs(20), "the deadline did not fire");
}

/// The property the JS path cannot have: Stop reaches a running command.
///
/// Sent as a notification while the run is still in flight, which is only answerable because the server
/// spawns each request rather than serving them in order.
#[test]
fn cancel_stops_a_running_command() {
    let mut rt = Runtime::start();
    rt.init();
    let started = Instant::now();
    let id = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(30), "call_id": "c-run-1" }),
    );
    std::thread::sleep(Duration::from_millis(400));
    rt.notify("call.cancel", serde_json::json!({ "call_id": "c-run-1" }));

    let reply = rt.read_reply();
    assert_eq!(reply["id"].as_u64(), Some(id));
    assert_eq!(reply["result"]["canceled"], true);
    assert_eq!(reply["result"]["killed"], false, "a user stop is not a timeout");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "cancel did not reach the process: took {:?}",
        started.elapsed()
    );
}

/// `tool.cancel` is the 1.0 spelling and stays accepted — a host and a runtime are versioned
/// separately, so the older name has to keep working against a newer binary.
#[test]
fn the_legacy_cancel_spelling_still_reaches_a_command() {
    let mut rt = Runtime::start();
    rt.init();
    let id = rt.send(
        "process.run",
        serde_json::json!({ "command": slow_command(30), "call_id": "c-run-2" }),
    );
    std::thread::sleep(Duration::from_millis(400));
    rt.notify("tool.cancel", serde_json::json!({ "call_id": "c-run-2" }));
    let reply = rt.read_reply();
    assert_eq!(reply["id"].as_u64(), Some(id));
    assert_eq!(reply["result"]["canceled"], true);
}

/// Reading stops at the cap rather than buffering the whole stream and trimming afterwards. The
/// observable half of that is what the caller gets back, which must match the JS path byte for byte.
#[test]
fn output_is_capped() {
    let mut rt = Runtime::start();
    rt.init();
    let node = serde_json::to_string(&std::env::var("PARITY_NODE").unwrap_or_else(|_| "node".to_owned())).unwrap();
    let r = rt.call(
        "process.run",
        serde_json::json!({
            "command": format!("{node} -e \"process.stdout.write('x'.repeat(50000))\""),
            "timeout_ms": 30_000,
            "max_buffer": 1000,
        }),
    );
    let out = r["result"]["stdout"].as_str().unwrap();
    // Node may be absent from the test environment; the cap is what is under test, not node.
    if !out.is_empty() {
        assert_eq!(out.len(), 1000, "output was not capped at max_buffer");
        assert_eq!(r["result"]["truncated"], true);
    }
}

// ── process.start_background (Stage 2b) ───────────────────────────────────────────────────────────

#[test]
fn a_background_service_starts_and_is_readable_while_it_runs() {
    let mut rt = Runtime::start();
    rt.init();
    let cmd = if cfg!(windows) {
        "echo service-is-up && ping -n 100000 127.0.0.1 > nul"
    } else {
        "echo service-is-up && sleep 600"
    };
    let pid = rt.call("process.start_background", serde_json::json!({ "command": cmd }))["result"]["pid"]
        .as_u64()
        .expect("a pid");

    // The host polls exactly like this while deciding whether a service has started.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "the service's output never became visible");
        let peek = rt.call("process.peek", serde_json::json!({ "pid": pid }));
        assert_eq!(peek["result"]["alive"], true);
        if peek["result"]["output"].as_str().unwrap_or_default().contains("service-is-up") {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    rt.call("process.stop", serde_json::json!({ "pid": pid }));
}

/// The reason the event direction exists: nothing polls a settled service, so an exit has no other
/// way to be noticed. Without it a dead dev server stays in the UI and `stop_service` targets a pid
/// that belongs to nothing.
#[test]
fn an_exit_is_pushed_to_the_host_without_being_asked() {
    let mut rt = Runtime::start();
    rt.init();
    let pid = rt.call("process.start_background", serde_json::json!({ "command": "echo done && exit 5" }))
        ["result"]["pid"]
        .as_u64()
        .expect("a pid");

    let event = rt.read_event("process.exited");
    assert_eq!(event["params"]["pid"].as_u64(), Some(pid));
    assert_eq!(event["params"]["code"], 5);
    assert!(
        event["params"]["output"].as_str().unwrap().contains("done"),
        "the event carries what the service printed, which is what a notify job reports"
    );
}

/// A killed service must announce itself the same way one that ended on its own does — otherwise the
/// host cleans up after an exit it noticed and leaks after one it caused.
#[test]
fn stopping_a_service_also_pushes_the_exit() {
    let mut rt = Runtime::start();
    rt.init();
    let cmd = if cfg!(windows) { "ping -n 100000 127.0.0.1 > nul" } else { "sleep 600" };
    let pid = rt.call("process.start_background", serde_json::json!({ "command": cmd }))["result"]["pid"]
        .as_u64()
        .expect("a pid");

    assert_eq!(rt.call("process.stop", serde_json::json!({ "pid": pid }))["result"]["stopped"], true);
    let event = rt.read_event("process.exited");
    assert_eq!(event["params"]["pid"].as_u64(), Some(pid));
}

#[test]
fn a_service_that_ended_is_no_longer_listed_or_peekable() {
    let mut rt = Runtime::start();
    rt.init();
    let pid = rt.call("process.start_background", serde_json::json!({ "command": "echo bye" }))["result"]["pid"]
        .as_u64()
        .expect("a pid");

    rt.read_event("process.exited");
    // Removed from the registry before the event is pushed, so a host acting on the event never sees
    // the service still listed.
    assert_eq!(rt.call("process.peek", serde_json::json!({ "pid": pid }))["result"]["alive"], false);
    let listed = rt.call("process.list", serde_json::json!({}));
    let services = listed["result"]["services"].as_array().unwrap();
    assert!(!services.iter().any(|s| s["pid"].as_u64() == Some(pid)));
}

#[test]
fn stopping_a_pid_the_runtime_never_started_is_refused() {
    let mut rt = Runtime::start();
    rt.init();
    // The pid space is shared with the rest of the machine; signalling a stranger is the difference
    // between stopping a dev server and stopping something of the user's.
    assert_eq!(rt.call("process.stop", serde_json::json!({ "pid": 999_999 }))["result"]["stopped"], false);
}

// ── mcp.* (Stage 3a) ──────────────────────────────────────────────────────────────────────────────

/// The MCP fixture, reached through the runtime binary rather than in-process.
///
/// Shares `agent-mcp`'s fixture server deliberately: one strict server, exercised both by the crate's
/// own tests and across the wire, so a divergence between the two paths cannot hide.
fn mcp_fixture() -> Option<(String, String)> {
    let out = std::process::Command::new(if cfg!(windows) { "where" } else { "which" })
        .arg("node")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let node = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_owned();
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../agent-mcp/tests/fixtures/mcp-server.mjs"
    );
    (!node.is_empty()).then(|| (node, script.to_owned()))
}

/// Wait for an `mcp.state` event reporting `ready`, and return it.
fn await_mcp_ready(rt: &mut Runtime, id: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        assert!(Instant::now() < deadline, "{id} never reported ready");
        let msg = rt.read();
        if msg["method"] == "mcp.state" && msg["params"]["id"] == id && msg["params"]["state"] == "ready" {
            return msg;
        }
    }
}

#[test]
fn an_mcp_server_connects_declares_and_serves_a_call() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    // Approved, because MCP enforcement is unconditional (§0.2 F7): connecting a server is not the
    // same as being allowed to call it.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["fix"]
        }),
    );

    let accepted = rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    // Accepted immediately: a connecting server must never hold up the turn that configured it.
    assert_eq!(accepted["result"]["id"], "fix");
    assert_ne!(accepted["result"]["state"], "ready", "connecting is asynchronous by contract");

    // Readiness arrives as an event, carrying what the server declares — raw, exactly as the server
    // described it. Namespacing, the `[server]` description prefix and schema normalisation are the
    // host's, because those declarations sit in the cached prompt prefix.
    let ready = await_mcp_ready(&mut rt, "fix");
    let tools = ready["params"]["tools"].as_array().expect("tools");
    let echo = tools.iter().find(|t| t["name"] == "echo").unwrap_or_else(|| panic!("raw names: {tools:?}"));
    assert_eq!(echo["description"], "Echo the text back.");
    assert_eq!(echo["inputSchema"]["properties"]["text"]["type"], "string");
    assert!(
        !tools.iter().any(|t| t["name"].as_str().unwrap_or_default().starts_with("mcp__")),
        "the runtime must not be namespacing: {tools:?}"
    );

    let called = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": { "text": "over ipc" } }),
    );
    assert_eq!(called["result"]["delivered"], true);
    // The server's reply, untouched: the host flattens content blocks its own way.
    assert_eq!(called["result"]["raw"]["content"][0]["text"], "over ipc");
}

/// A tool that ran and failed is still `delivered`. The distinction matters: the host reads `isError`
/// to decide `ok`, and treating it as an undelivered call would make a failing tool look like a broken
/// connection.
#[test]
fn a_tool_that_reports_an_error_is_still_delivered() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    // Approved, because MCP enforcement is unconditional (§0.2 F7): connecting a server is not the
    // same as being allowed to call it.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["fix"]
        }),
    );
    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "fix");

    let called = rt.call("mcp.call", serde_json::json!({ "server": "fix", "tool": "boom", "args": {} }));
    assert_eq!(called["result"]["delivered"], true, "a server answered, so it was delivered");
    assert_eq!(called["result"]["raw"]["isError"], true, "and the host decides `ok` from this");
}

/// The invariant `callMcpTool` carries in JS, preserved across the wire: a broken MCP call is a
/// result, never a protocol error, because an external server must not be able to abort a turn.
#[test]
fn a_call_to_an_unconfigured_server_fails_as_a_result() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("mcp.call", serde_json::json!({ "server": "nope", "tool": "thing", "args": {} }));
    assert!(r["error"].is_null(), "no protocol error: {r}");
    assert_eq!(r["result"]["delivered"], false);
    assert!(r["result"]["error"].as_str().unwrap().contains("nope"));
}

#[test]
fn disconnecting_stops_declaring_the_server() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.init();
    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "bye",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "bye");

    assert_eq!(rt.call("mcp.disconnect", serde_json::json!({ "id": "bye" }))["result"]["disconnected"], true);
    let status = rt.call("mcp.status", serde_json::json!({}));
    let servers = status["result"]["servers"].as_array().unwrap();
    let bye = servers.iter().find(|s| s["id"] == "bye").expect("still listed, as closed");
    assert_eq!(bye["state"], "closed");
    assert!(
        bye["tools"].as_array().unwrap().is_empty(),
        "a server that cannot serve a call must not be declaring tools"
    );
}

// ── subagent.* (Stage 4a) ─────────────────────────────────────────────────────────────────────────

impl Runtime {
    /// Answer the runtime's own requests until a reply to `id` arrives.
    ///
    /// This is the shape of the whole stage: the runtime asks the host to run each delegation, and the
    /// host answers. A test that only read replies would deadlock, because the runtime is waiting on
    /// the very messages it would be skipping.
    fn serve_until(
        &mut self,
        id: u64,
        mut answer: impl FnMut(&serde_json::Value) -> serde_json::Value,
    ) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "no reply to {id}");
            let msg = self.read();
            // A request FROM the runtime: it has both a method and an id.
            if msg["method"].is_string() && msg["id"].is_u64() {
                let reply = serde_json::json!({ "id": msg["id"], "result": answer(&msg) });
                writeln!(self.stdin, "{reply}").unwrap();
                self.stdin.flush().unwrap();
                continue;
            }
            if msg["id"].as_u64() == Some(id) {
                return msg;
            }
        }
    }

    /// Read the runtime's next request without answering it.
    fn read_request(&mut self) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "the runtime asked for nothing");
            let msg = self.read();
            if msg["method"].is_string() && msg["id"].is_u64() {
                return msg;
            }
        }
    }
}

#[test]
fn the_runtime_schedules_and_the_host_runs_each_delegation() {
    let mut rt = Runtime::start();
    rt.init();

    let spawned = rt.call(
        "subagent.spawn",
        serde_json::json!({
            "turn": "t1",
            "jobs": [
                { "meta": { "role": "explore", "prompt": "one" } },
                { "meta": { "role": "explore", "prompt": "two" } },
            ],
        }),
    );
    let jobs = spawned["result"]["jobs"].as_array().unwrap();
    assert_eq!(jobs.len(), 2);
    assert!(jobs.iter().all(|j| j["refused"].is_null()));

    // Join blocks until both settle, so the host has to serve the bodies while it waits.
    let join_id = rt.send("subagent.join", serde_json::json!({ "turn": "t1", "mode": "all" }));
    let joined = rt.serve_until(join_id, |req| {
        assert_eq!(req["method"], "subagent.run");
        // The meta is handed back verbatim: the scheduler never interprets it.
        let prompt = req["params"]["meta"]["prompt"].as_str().unwrap_or("?").to_owned();
        serde_json::json!({ "result": format!("answered {prompt}") })
    });

    let ready = joined["result"]["ready"].as_array().unwrap();
    assert_eq!(ready.len(), 2);
    // Reported in spawn order, whoever finished first, so a fan-out reads the same way every time.
    assert_eq!(ready[0]["result"], "answered one");
    assert_eq!(ready[1]["result"], "answered two");
    assert!(ready.iter().all(|r| r["state"] == "done"));
    assert!(joined["result"]["pending"].as_array().unwrap().is_empty());
}

/// Two identical spawns in one batch fold into one job, so one delegation runs and both callers are
/// attached to it. The existing repeat-guard compares against delegations that already finished, so it
/// cannot see a twin still in flight.
#[test]
fn identical_delegations_are_coalesced() {
    let mut rt = Runtime::start();
    rt.init();
    let spawned = rt.call(
        "subagent.spawn",
        serde_json::json!({
            "turn": "t2",
            "jobs": [
                { "meta": { "prompt": "same" }, "key": "k" },
                { "meta": { "prompt": "same" }, "key": "k" },
            ],
        }),
    );
    let jobs = spawned["result"]["jobs"].as_array().unwrap();
    assert_eq!(jobs[0]["coalesced"], false);
    assert_eq!(jobs[1]["coalesced"], true, "the twin folds into the job already in flight");
    assert_eq!(jobs[0]["id"], jobs[1]["id"], "and both callers hold the same handle");

    let mut ran = 0;
    let join_id = rt.send("subagent.join", serde_json::json!({ "turn": "t2" }));
    let joined = rt.serve_until(join_id, |_| {
        ran += 1;
        serde_json::json!({ "result": "once" })
    });
    assert_eq!(ran, 1, "one delegation ran, not two");
    assert_eq!(joined["result"]["ready"].as_array().unwrap().len(), 1);
}

/// An outcome is delivered exactly once. Reporting a conclusion twice makes the model believe the work
/// happened twice.
#[test]
fn an_outcome_is_delivered_once() {
    let mut rt = Runtime::start();
    rt.init();
    rt.call("subagent.spawn", serde_json::json!({ "turn": "t3", "jobs": [{ "meta": {} }] }));

    let first = rt.send("subagent.join", serde_json::json!({ "turn": "t3" }));
    let joined = rt.serve_until(first, |_| serde_json::json!({ "result": "done once" }));
    assert_eq!(joined["result"]["ready"].as_array().unwrap().len(), 1);

    // Nothing is outstanding now, so a second join has nothing to deliver and must not block.
    let again = rt.call("subagent.join", serde_json::json!({ "turn": "t3", "block": false }));
    assert!(again["result"]["ready"].as_array().unwrap().is_empty());
}

/// `block: false` harvests what is already settled without committing the turn to a wait.
#[test]
fn a_non_blocking_join_returns_immediately() {
    let mut rt = Runtime::start();
    rt.init();
    rt.call("subagent.spawn", serde_json::json!({ "turn": "t4", "jobs": [{ "meta": {} }] }));
    // Drain the run request so it cannot be mistaken for the reply below.
    rt.read_request();

    let started = Instant::now();
    let r = rt.call("subagent.join", serde_json::json!({ "turn": "t4", "block": false }));
    assert!(started.elapsed() < Duration::from_secs(5), "a non-blocking join must not wait");
    // The body was never answered, so it is still running rather than ready.
    assert!(r["result"]["ready"].as_array().unwrap().is_empty());
    assert_eq!(r["result"]["pending"].as_array().unwrap().len(), 1);
}

/// Cancelling a turn reaches a delegation that is waiting on the host, without the host answering.
///
/// This is the cancellation chain the JS path cannot express: there a delegation is a promise in the
/// renderer sharing one flat signal, so "stop this turn's sub-agents" and "stop the turn" are the same
/// event and neither reaches work already handed out.
#[test]
fn cancelling_a_turn_stops_a_delegation_waiting_on_the_host() {
    let mut rt = Runtime::start();
    rt.init();
    rt.call("subagent.spawn", serde_json::json!({ "turn": "t5", "jobs": [{ "meta": {} }] }));

    // The runtime asks the host to run it; the host deliberately never answers.
    let asked = rt.read_request();
    assert_eq!(asked["method"], "subagent.run");

    let started = Instant::now();
    rt.call("subagent.cancel", serde_json::json!({ "turn": "t5", "reason": "stopped" }));
    // Blocking, because a RUNNING delegation is not settled the instant it is cancelled: the
    // supervisor gives the body a grace window to return a partial conclusion before abandoning it.
    // Joining without blocking here would race that window and see nothing — which is a property of
    // the test, not of the runtime.
    let r = rt.call("subagent.join", serde_json::json!({ "turn": "t5", "timeout_ms": 15000 }));

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancel must not wait out the body's 30-minute ceiling"
    );
    let ready = r["result"]["ready"].as_array().unwrap();
    assert_eq!(ready.len(), 1, "a cancelled delegation still reports, so the turn can explain itself");
    assert_eq!(ready[0]["state"], "cancelled");
}

#[test]
fn status_reports_what_a_turn_is_doing() {
    let mut rt = Runtime::start();
    rt.init();
    rt.call(
        "subagent.spawn",
        serde_json::json!({ "turn": "t6", "jobs": [{ "meta": {} }, { "meta": {} }] }),
    );
    let s = rt.call("subagent.status", serde_json::json!({ "turn": "t6" }));
    assert_eq!(s["result"]["total"], 2);
    assert_eq!(s["result"]["outstanding"].as_array().unwrap().len(), 2);

    // A turn nobody spawned into is empty rather than an error.
    let empty = rt.call("subagent.status", serde_json::json!({ "turn": "never" }));
    assert_eq!(empty["result"]["total"], 0);
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

// ── agent.run: the whole turn inside the runtime (TODO §2.1) ──────────────────────────────────────

/// A provider that answers from a script, on a real socket, in a background thread.
///
/// Deliberately not a mock inside the process: the point of `agent.run` is that the SIDECAR holds the turn,
/// so the model has to be something the sidecar can actually reach over the network.
fn fake_provider(replies: Vec<String>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::Read;
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = std::thread::spawn(move || {
        for (i, reply) in replies.into_iter().enumerate() {
            let Ok((mut socket, _)) = listener.accept() else { return };
            // Read the request headers and body far enough to let the client finish writing.
            let mut buf = [0u8; 8192];
            let _ = socket.read(&mut buf);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
            let _ = std::io::Write::write_all(&mut socket, response.as_bytes());
            let _ = std::io::Write::flush(&mut socket);
            let _ = i;
        }
    });
    (format!("http://{addr}/v1/chat/completions"), handle)
}

/// An SSE provider: one `data:` frame per chunk, then `[DONE]`.
fn sse_provider(chunks: Vec<&str>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::Read;
    use std::net::TcpListener;

    let mut body = String::new();
    for c in chunks {
        let frame = serde_json::json!({ "choices": [{ "delta": { "content": c } }] });
        body.push_str(&format!("data: {frame}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handle = std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else { return };
        let mut buf = [0u8; 8192];
        let _ = socket.read(&mut buf);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = std::io::Write::write_all(&mut socket, response.as_bytes());
        let _ = std::io::Write::flush(&mut socket);
    });
    (format!("http://{addr}/v1/chat/completions"), handle)
}

fn assistant_text(text: &str) -> String {
    serde_json::json!({
        "choices": [{ "message": { "content": text } }],
        "usage": { "prompt_tokens": 11, "completion_tokens": 7 }
    })
    .to_string()
}

fn assistant_tool_call(id: &str, name: &str, args: serde_json::Value) -> String {
    serde_json::json!({
        "choices": [{ "message": { "content": "", "tool_calls": [
            { "id": id, "function": { "name": name, "arguments": args.to_string() } }
        ]}}],
        "usage": { "prompt_tokens": 5, "completion_tokens": 3 }
    })
    .to_string()
}

fn run_params(endpoint: &str, workdir: &str, run_id: &str, messages: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "run_id": run_id,
        "workdir": workdir,
        "provider": { "endpoint": endpoint, "model": "test-model" },
        "messages": messages,
        "max_turns": 8
    })
}

#[test]
fn the_runtime_runs_a_whole_agent_turn_without_the_host_driving_it() {
    let (endpoint, _server) = fake_provider(vec![assistant_text("the answer is 42")]);
    let mut rt = Runtime::start();
    rt.init();

    let r = rt.call(
        "agent.run",
        run_params(&endpoint, ".", "run-1", serde_json::json!([{ "role": "user", "content": "what is it" }])),
    );
    let result = &r["result"];
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(result["stop_reason"], "completed");
    assert_eq!(result["content"], "the answer is 42");
    assert_eq!(result["rounds"], 1);
    assert_eq!(result["tool_calls"], 0);
    assert_eq!(result["prompt_tokens"], 11);
    // The transcript comes back with the assistant turn appended.
    let messages = result["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["role"], "assistant");
}

/// The whole cycle: the model asks for a tool, the RUNTIME runs it, and the model answers from its result.
#[test]
fn a_tool_call_is_executed_by_the_runtime_and_fed_back_to_the_model() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("note.txt"), "the file says hello").unwrap();

    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": "note.txt" })),
        assistant_text("it says hello"),
    ]);
    let mut rt = Runtime::start();
    // The workdir is approved, so the loop's tool calls are inside the ceiling. Without this the run is
    // denied — see `a_tool_call_outside_the_approved_roots_is_denied_inside_the_run`.
    rt.init_with_roots(&[dir.path().to_str().unwrap()]);

    let r = rt.call(
        "agent.run",
        run_params(
            &endpoint,
            dir.path().to_str().unwrap(),
            "run-2",
            serde_json::json!([{ "role": "user", "content": "read note.txt" }]),
        ),
    );
    let result = &r["result"];
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(result["stop_reason"], "completed");
    assert_eq!(result["rounds"], 2, "one round to call the tool, one to answer");
    assert_eq!(result["tool_calls"], 1);

    // user, assistant+call, tool result, assistant — in the order it happened.
    let messages = result["messages"].as_array().expect("messages");
    let roles: Vec<&str> = messages.iter().map(|m| m["role"].as_str().unwrap_or("")).collect();
    assert_eq!(roles, vec!["user", "assistant", "tool", "assistant"]);
    assert!(
        messages[2]["content"].as_str().unwrap_or("").contains("the file says hello"),
        "the tool's real output must reach the model: {}",
        messages[2]["content"]
    );
    // Usage is summed across every round of the turn, not just the last.
    assert_eq!(result["prompt_tokens"], 16);
}

/// A turn stopped by its own limit is reported as stopped, not as finished.
#[test]
fn a_run_that_hits_its_turn_cap_says_so_rather_than_reporting_success() {
    let looping: Vec<String> = (0..12)
        .map(|i| assistant_tool_call(&format!("c{i}"), "file_info", serde_json::json!({ "path": "." })))
        .collect();
    let (endpoint, _server) = fake_provider(looping);
    let mut rt = Runtime::start();
    rt.init();

    let mut params = run_params(&endpoint, ".", "run-3", serde_json::json!([{ "role": "user", "content": "go" }]));
    params["max_turns"] = serde_json::json!(3);
    let r = rt.call("agent.run", params);
    let result = &r["result"];
    let reason = result["stop_reason"].as_str().unwrap_or("");
    assert!(reason == "max-turns" || reason == "doom-loop", "unexpected reason: {reason} in {result}");
    assert_ne!(reason, "completed", "a run cut short must never read as finished");
}

/// Stop reaches a run the same way it reaches every other kind of work.
#[test]
fn a_run_is_cancellable_by_the_id_it_was_started_with() {
    // The provider never answers, so the run is still waiting when the cancel arrives.
    let (endpoint, _server) = fake_provider(vec![]);
    let mut rt = Runtime::start();
    rt.init();

    let run_id = rt.send(
        "agent.run",
        run_params(&endpoint, ".", "run-4", serde_json::json!([{ "role": "user", "content": "go" }])),
    );
    std::thread::sleep(Duration::from_millis(300));
    rt.send("call.cancel", serde_json::json!({ "call_id": "run-4" }));

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "the run did not answer after being cancelled");
        let msg = rt.read();
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            // Either a cancelled stop reason or a transport failure is acceptable — the provider was
            // killed mid-request. What must NOT happen is the run reporting success.
            let reason = msg["result"]["stop_reason"].as_str().unwrap_or("");
            assert_ne!(reason, "completed", "a cancelled run must not report success: {msg}");
            break;
        }
    }
}

/// The permission ceiling is enforced on the agent path too, and a denial does not end the turn.
///
/// This is what fail-closed looks like from the outside: a host that approves nothing gets a runtime whose
/// agent can call no tools, rather than one that quietly runs them.
#[test]
fn a_tool_call_outside_the_approved_roots_is_denied_inside_the_run() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("note.txt"), "SHOULD NOT BE READABLE").unwrap();

    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": "note.txt" })),
        assistant_text("I could not read it"),
    ]);
    let mut rt = Runtime::start();
    // No approved roots at all.
    rt.init();

    let r = rt.call(
        "agent.run",
        run_params(
            &endpoint,
            dir.path().to_str().unwrap(),
            "run-5",
            serde_json::json!([{ "role": "user", "content": "read note.txt" }]),
        ),
    );
    let result = &r["result"];
    let messages = result["messages"].as_array().expect("messages");
    let tool_result = messages[2]["content"].as_str().unwrap_or("");
    assert!(tool_result.contains("Permission denied"), "{tool_result}");
    assert!(!tool_result.contains("SHOULD NOT BE READABLE"), "the file leaked: {tool_result}");
    // The turn continues: a denial is something the model answers, not something that aborts the run.
    assert_eq!(result["stop_reason"], "completed");
    assert_eq!(result["content"], "I could not read it");
}

/// The host needs to know which tools change something, or a lost reply becomes a second edit.
#[test]
fn the_handshake_names_the_tools_that_mutate() {
    let mut rt = Runtime::start();
    let r = rt.init();
    let result = &r["result"];

    let tools = result["tools"].as_array().expect("tools");
    for expected in ["write_file", "edit_file"] {
        assert!(tools.iter().any(|t| t == expected), "{expected} missing from {tools:?}");
    }

    let mutating = result["mutating_tools"].as_array().expect("mutating_tools");
    for expected in ["write_file", "edit_file"] {
        assert!(mutating.iter().any(|t| t == expected), "{expected} missing from {mutating:?}");
    }
    // And the read-only ones are NOT in it — a host that treated every tool as unsafe to retry would lose
    // the fallback that makes the sidecar optional.
    for read_only in ["read_file", "list_directory", "file_info", "search_files", "search_in_files"] {
        assert!(!mutating.iter().any(|t| t == read_only), "{read_only} must not be listed as mutating");
    }
}

/// The mutating tools work over the real protocol, with their guarantees intact.
#[test]
fn write_file_and_edit_file_work_over_the_wire_and_preserve_the_files_newlines() {
    let dir = tempfile::tempdir().expect("temp dir");
    let workdir = dir.path().to_str().expect("utf-8 path");
    std::fs::write(dir.path().join("crlf.txt"), "one\r\ntwo\r\n").unwrap();

    let mut rt = Runtime::start();
    rt.init();

    let r = rt.call(
        "tool.call",
        serde_json::json!({
            "name": "write_file",
            "args": { "path": "new.txt", "content": "hello\n" },
            "workdir": workdir,
            "call_id": "w1"
        }),
    );
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert_eq!(std::fs::read_to_string(dir.path().join("new.txt")).unwrap(), "hello\n");

    // The model sends LF; the CRLF file must stay CRLF.
    let r = rt.call(
        "tool.call",
        serde_json::json!({
            "name": "edit_file",
            "args": { "path": "crlf.txt", "old_string": "one\ntwo", "new_string": "one\nTWO" },
            "workdir": workdir,
            "call_id": "e1"
        }),
    );
    assert_eq!(r["result"]["ok"], true, "{r}");
    assert_eq!(std::fs::read_to_string(dir.path().join("crlf.txt")).unwrap(), "one\r\nTWO\r\n");
}

// ── MCP permission (TODO §4.1, §12) ───────────────────────────────────────────────────────────────

/// MCP reached the outside world without the capability check every native tool passes. It does not now —
/// but only once the host has said what it approves.
///
/// Uses a genuinely CONNECTED server, because existence is checked before permission (a typo should be
/// reported as a typo, not as a refusal — the order `agent-dispatch` established). Denial is therefore only
/// observable on a server that is actually there.
#[test]
fn a_connected_but_unapproved_mcp_server_is_denied_and_nothing_is_sent() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    // A policy IS declared, and it approves a DIFFERENT server than the one connected below.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["something-else"]
        }),
    );

    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "fix");

    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": {}, "call_id": "m1" }),
    );
    let result = &r["result"];
    assert_eq!(result["delivered"], false, "a denied call must not reach the server: {result}");
    let error = result["error"].as_str().unwrap_or("");
    assert!(error.contains("Permission denied"), "{error}");
    assert!(error.contains("Nothing was sent"), "{error}");
}

/// The same server, approved, reaches the server it was denied to before.
#[test]
fn an_approved_mcp_server_is_reached() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "approved_mcp_servers": ["fix"]
        }),
    );
    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "fix");

    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": { "text": "hi" }, "call_id": "m2" }),
    );
    let error = r["result"]["error"].as_str().unwrap_or("");
    assert!(!error.contains("Permission denied"), "an approved server must pass the check: {r}");
}

/// A host that declares nothing has no MCP tools. The gate that used to exempt it is gone (§0.2 F7).
///
/// This is the deliberate cost of making §12's "MCP must not bypass Runtime Permission" unconditional: it is
/// not a property that can hold for some hosts and not others.
#[test]
fn a_host_that_declared_no_policy_has_no_mcp_access_at_all() {
    let Some((node, script)) = mcp_fixture() else { return };
    let mut rt = Runtime::start();
    rt.init(); // no workspace_roots, no approved_mcp_servers // no workspace_roots, no approved_mcp_servers

    rt.call(
        "mcp.connect",
        serde_json::json!({
            "id": "fix",
            "command": node,
            "args": [script],
            "env": std::env::vars().collect::<Vec<_>>(),
        }),
    );
    await_mcp_ready(&mut rt, "fix");

    let r = rt.call(
        "mcp.call",
        serde_json::json!({ "server": "fix", "tool": "echo", "args": {}, "call_id": "m2" }),
    );
    let result = &r["result"];
    assert_eq!(result["delivered"], false, "a connected but unapproved server must not be reached");
    assert!(
        result["error"].as_str().unwrap_or("").contains("Permission denied"),
        "{result}"
    );
}

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

// ── Sandbox and command hardening (TODO §4.2, §11, §12) ───────────────────────────────────────────

/// The differential proof: the SAME command, unconfined and confined.
///
/// Asserting that a policy struct has the right shape proves nothing about the kernel. This runs a real
/// command that reads a real secret outside the workspace, twice, and the only difference is whether the host
/// declared a policy.
#[test]
#[cfg(target_os = "linux")]
fn a_command_cannot_read_outside_the_approved_roots_when_a_policy_is_declared() {
    // NOT under /tmp: `FilesystemPolicy::workspace` makes the whole of /tmp writable, because build tools
    // need temp space — so a "secret" placed there is legitimately inside the allowlist and the test would be
    // asserting against its own fixture rather than against the sandbox.
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandbox-differential");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();
    let secret = base.join("secret.txt");
    std::fs::write(&secret, "SHOULD-NOT-BE-READABLE").unwrap();
    let cmd = format!("cat {}", secret.display());

    // Unconfined: the host declared nothing, so nothing is enforced and the read succeeds. This half is what
    // makes the other half meaningful — without it, a failure could just mean the command was wrong.
    let unconfined = {
        let mut rt = Runtime::start();
        rt.init();
        let r = rt.call(
            "process.run",
            serde_json::json!({ "command": cmd, "cwd": workspace.to_str().unwrap(), "timeout_ms": 20000 }),
        );
        r["result"]["stdout"].as_str().unwrap_or("").to_owned()
    };
    if !unconfined.contains("SHOULD-NOT-BE-READABLE") {
        // The unconfined read did not work, so this machine cannot demonstrate the difference. Skipping is
        // honest; asserting would certify a boundary the test never actually observed.
        eprintln!("skipping: the unconfined read did not succeed, so there is no difference to measure");
        return;
    }

    // Confined: the same command, with only the workspace approved.
    let mut rt = Runtime::start();
    rt.init_with_roots(&[workspace.to_str().unwrap()]);
    let r = rt.call(
        "process.run",
        serde_json::json!({ "command": cmd, "cwd": workspace.to_str().unwrap(), "timeout_ms": 20000 }),
    );
    let stdout = r["result"]["stdout"].as_str().unwrap_or("");
    assert!(
        !stdout.contains("SHOULD-NOT-BE-READABLE"),
        "the sandbox did not confine the command; it read: {stdout}"
    );
}

/// A command inside the approved roots must still work — confinement that breaks the build is not a feature.
#[test]
fn a_command_inside_the_approved_roots_still_runs() {
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandbox-inside");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("inside.txt"), "READABLE").unwrap();

    let mut rt = Runtime::start();
    rt.init_with_roots(&[workspace.to_str().unwrap()]);
    // `type`, not `cat`, on Windows: the runner only has `cat` because Git for Windows' usr/bin is on its
    // PATH, and a test about what the sandbox permits should not lean on a coincidence of the image.
    let command = if cfg!(windows) { "type inside.txt" } else { "cat inside.txt" };
    let r = rt.call(
        "process.run",
        serde_json::json!({
            "command": command,
            "cwd": workspace.to_str().unwrap(),
            "timeout_ms": 20000
        }),
    );
    assert!(
        r["result"]["stdout"].as_str().unwrap_or("").contains("READABLE"),
        "confinement must not break work inside the workspace: {}",
        r["result"]
    );
}

/// §12's command-injection row.
///
/// `run_command` takes a shell command line by design — the model is *supposed* to be able to write
/// `a && b`, and calling that "injection" would be calling the feature a vulnerability. What must hold is
/// narrower and is what these check: the shell metacharacters a model emits are passed through to the shell
/// as written, they cannot escape the sandbox, and they cannot reach the protocol.
#[test]
fn shell_metacharacters_are_executed_as_written_and_do_not_corrupt_the_protocol() {
    let mut rt = Runtime::start();
    rt.init();

    // Quotes, newlines, NUL-adjacent bytes and JSON metacharacters in the OUTPUT must not break the stream:
    // the protocol is newline-delimited JSON, and a command that prints a newline-laden blob is ordinary.
    //
    // One table per shell, because the shell is a platform fact — `/bin/sh -c` on POSIX, `%ComSpec% /d /s /c`
    // on Windows (see `spawn_command` in agent-process) — and "passed through as written" can only be judged
    // against what THAT shell does with the characters. `$((1+1))` is POSIX arithmetic expansion; cmd.exe
    // has no such thing and prints it verbatim, which is exactly what the Windows release leg reported. The
    // cmd.exe rows exercise its own metacharacters instead: `&` chains commands, and `set /a` evaluates an
    // expression — printing the result only when handed to cmd.exe as a command line rather than a batch
    // file, so it also confirms the `/c` invocation is the one Node's `shell: true` builds. (`printf` is not
    // a cmd.exe command either; it only worked on the runner because Git for Windows' usr/bin is on PATH.)
    let cases = if cfg!(windows) {
        [
            (r#"echo 'a"b'"#, "a\"b"),
            ("echo one& echo two", "one"),
            (r#"echo {"id":1,"method":"runtime.shutdown"}"#, "runtime.shutdown"),
            ("set /a 1+1", "2"),
        ]
    } else {
        [
            (r#"echo 'a"b'"#, "a\"b"),
            ("printf 'one\ntwo\n'", "one"),
            (r#"echo '{"id":1,"method":"runtime.shutdown"}'"#, "runtime.shutdown"),
            ("echo $((1+1))", "2"),
        ]
    };
    for (command, expected) in cases {
        let r = rt.call(
            "process.run",
            serde_json::json!({ "command": command, "timeout_ms": 20000 }),
        );
        let stdout = r["result"]["stdout"].as_str().unwrap_or("");
        assert!(stdout.contains(expected), "{command} → {stdout:?}");
    }

    // The runtime is still alive and answering: a command that printed a protocol frame did not inject one.
    let status = rt.call("runtime.status", serde_json::json!({}));
    assert_eq!(status["result"]["protocol_version"], "1.1", "the stream was corrupted by command output");
}

/// A command that fails is a result, not a protocol error — the same contract the JS path has.
#[test]
fn a_command_that_exits_non_zero_is_reported_rather_than_thrown() {
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("process.run", serde_json::json!({ "command": "exit 3", "timeout_ms": 20000 }));
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(r["result"]["code"], 3);
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

// ── Token streaming (TODO §10.1, M8) ──────────────────────────────────────────────────────────────

#[test]
fn streaming_is_announced_as_a_feature() {
    let mut rt = Runtime::start();
    let r = rt.init();
    let features = r["result"]["features"].as_array().expect("features");
    assert!(features.iter().any(|f| f == "agent.stream"), "{features:?}");
}

/// Tokens reach the host while the run is still going, as INCREMENTS rather than growing snapshots.
#[test]
fn a_streamed_run_pushes_its_tokens_as_they_arrive() {
    let (endpoint, _server) = sse_provider(vec!["Hel", "lo ", "world"]);
    let mut rt = Runtime::start();
    rt.init();

    let run_id = rt.send(
        "agent.run",
        serde_json::json!({
            "run_id": "stream-1",
            "workdir": ".",
            "provider": { "endpoint": endpoint, "model": "test-model", "stream": true },
            "messages": [{ "role": "user", "content": "hi" }],
            "max_turns": 4
        }),
    );

    let mut pieces: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "the run never answered; deltas so far: {pieces:?}");
        let msg = rt.read();
        if msg["method"] == "agent.delta" {
            assert_eq!(msg["params"]["run_id"], "stream-1");
            pieces.push(msg["params"]["content"].as_str().unwrap_or("").to_owned());
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            assert_eq!(msg["result"]["content"], "Hello world");
            break;
        }
    }

    assert!(pieces.len() > 1, "expected several deltas, got {pieces:?}");
    // Increments, not snapshots: concatenating them reconstructs the answer exactly once. A stream that sent
    // the accumulation would concatenate to "HelHello Hello world".
    assert_eq!(pieces.concat(), "Hello world", "deltas must be increments: {pieces:?}");
}

/// A non-streamed run must not push deltas at all.
#[test]
fn a_run_that_did_not_ask_for_streaming_pushes_no_deltas() {
    let (endpoint, _server) = fake_provider(vec![assistant_text("all at once")]);
    let mut rt = Runtime::start();
    rt.init();

    let run_id = rt.send(
        "agent.run",
        run_params(&endpoint, ".", "quiet-1", serde_json::json!([{ "role": "user", "content": "hi" }])),
    );

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "the run never answered");
        let msg = rt.read();
        assert_ne!(msg["method"], "agent.delta", "a non-streamed run must not push deltas");
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            assert_eq!(msg["result"]["content"], "all at once");
            break;
        }
    }
}

// ── Consent and tool events (TODO §2.1: what the loop needs from a host) ──────────────────────────

/// A capability check that can only ever deny is a wall, not a permission system.
///
/// The runtime asks the host, and the host's answer decides. This is the counterpart of the TypeScript loop's
/// `onConsent`, and without it switching the app onto `agent.run` would silently lose every consent prompt.
#[test]
fn a_denied_tool_asks_the_host_and_honours_a_yes() {
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("consent-yes");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();

    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call(
            "c1",
            "write_file",
            serde_json::json!({ "path": "written.txt", "content": "APPROVED-CONTENT\n" }),
        ),
        assistant_text("wrote it"),
    ]);

    let mut rt = Runtime::start();
    // A write INSIDE the approved root: permitted by the ceiling, and gated on a human. A capability the
    // ceiling forbids is denied outright and never escalated, so it could not exercise consent at all.
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "workspace_roots": [workspace.to_str().unwrap()],
            "require_approval_for_mutations": true
        }),
    );

    let run_id = rt.send(
        "agent.run",
        run_params(
            &endpoint,
            workspace.to_str().unwrap(),
            "consent-1",
            serde_json::json!([{ "role": "user", "content": "read it" }]),
        ),
    );

    let mut asked = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "the run never answered (asked={asked})");
        let msg = rt.read();
        // A request FROM the runtime: it has an id AND a method.
        if msg["method"] == "host.consent" && msg["id"].is_number() {
            asked = true;
            assert_eq!(msg["params"]["capability"], "filesystem.write");
            let id = msg["id"].clone();
            rt.reply(id, serde_json::json!({ "approved": true }));
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            assert!(asked, "the runtime denied without ever asking the host");
            assert_eq!(
                std::fs::read_to_string(workspace.join("written.txt")).unwrap_or_default(),
                "APPROVED-CONTENT\n",
                "a granted consent must let the call through"
            );
            break;
        }
    }
}

/// And a no is a no — the file is not read.
#[test]
fn a_host_that_refuses_consent_stops_the_call() {
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("consent-no");
    let _ = std::fs::remove_dir_all(&base);
    let workspace = base.join("proj");
    std::fs::create_dir_all(&workspace).unwrap();

    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call(
            "c1",
            "write_file",
            serde_json::json!({ "path": "refused.txt", "content": "SHOULD-NOT-EXIST\n" }),
        ),
        assistant_text("could not"),
    ]);

    let mut rt = Runtime::start();
    rt.call(
        "runtime.initialize",
        serde_json::json!({
            "protocol_version": "1.1",
            "client": "test",
            "workspace_roots": [workspace.to_str().unwrap()],
            "require_approval_for_mutations": true
        }),
    );
    let run_id = rt.send(
        "agent.run",
        run_params(
            &endpoint,
            workspace.to_str().unwrap(),
            "consent-2",
            serde_json::json!([{ "role": "user", "content": "read it" }]),
        ),
    );

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "the run never answered");
        let msg = rt.read();
        if msg["method"] == "host.consent" && msg["id"].is_number() {
            rt.reply(msg["id"].clone(), serde_json::json!({ "approved": false }));
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            assert!(
                !workspace.join("refused.txt").exists(),
                "a refused consent must stop the write; the file was created anyway"
            );
            break;
        }
    }
}

/// A UI needs to show work in flight, not only its result.
#[test]
fn a_run_pushes_tool_activity_as_it_happens() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("note.txt"), "contents").unwrap();

    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": "note.txt" })),
        assistant_text("done"),
    ]);
    let mut rt = Runtime::start();
    rt.init_with_roots(&[dir.path().to_str().unwrap()]);

    let run_id = rt.send(
        "agent.run",
        run_params(
            &endpoint,
            dir.path().to_str().unwrap(),
            "tools-1",
            serde_json::json!([{ "role": "user", "content": "read it" }]),
        ),
    );

    let mut phases: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "the run never answered; phases {phases:?}");
        let msg = rt.read();
        if msg["method"] == "agent.tool" {
            assert_eq!(msg["params"]["run_id"], "tools-1");
            assert_eq!(msg["params"]["name"], "read_file");
            phases.push(msg["params"]["phase"].as_str().unwrap_or("").to_owned());
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            break;
        }
    }
    assert_eq!(phases, vec!["start", "end"], "a tool must be announced before it runs, not only after");
}

/// `ask_user` is a tool whose implementation is a person, so the runtime forwards it and waits.
///
/// The last of the loop's host callbacks (§0.2 F9). Without it, a model that needs to ask something would get
/// "unknown tool" and answer its own question.
#[test]
fn ask_user_is_forwarded_to_the_host_and_its_answer_reaches_the_model() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call(
            "c1",
            "ask_user",
            serde_json::json!({ "questions": [{ "question": "Which database?" }] }),
        ),
        assistant_text("using postgres then"),
    ]);
    let mut rt = Runtime::start();
    rt.init();

    let run_id = rt.send(
        "agent.run",
        run_params(&endpoint, ".", "ask-1", serde_json::json!([{ "role": "user", "content": "set it up" }])),
    );

    let mut asked = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "the run never answered (asked={asked})");
        let msg = rt.read();
        if msg["method"] == "host.ask" && msg["id"].is_number() {
            asked = true;
            assert_eq!(msg["params"]["questions"][0]["question"], "Which database?");
            rt.reply(msg["id"].clone(), serde_json::json!({ "answers": ["postgres"] }));
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            assert!(asked, "the runtime never put the question to the host");
            let messages = msg["result"]["messages"].as_array().expect("messages");
            let answer = messages[2]["content"].as_str().unwrap_or("");
            assert!(answer.contains("postgres"), "the user's answer must reach the model: {answer}");
            break;
        }
    }
}

/// A host that cannot ask leaves the model needing to proceed without an answer — and told so.
#[test]
fn a_question_the_host_cannot_answer_is_reported_to_the_model_rather_than_ending_the_run() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "ask_user", serde_json::json!({ "questions": [] })),
        assistant_text("proceeded anyway"),
    ]);
    let mut rt = Runtime::start();
    rt.init();

    let run_id = rt.send(
        "agent.run",
        run_params(&endpoint, ".", "ask-2", serde_json::json!([{ "role": "user", "content": "go" }])),
    );

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "the run never answered");
        let msg = rt.read();
        if msg["method"] == "host.ask" && msg["id"].is_number() {
            // Answer with an ERROR, as a host with no UI would. `HostReply::error` is a STRING — sending an
            // object here fails to decode, and the runtime then waits out the full ask timeout on a reply it
            // could not read.
            let reply = serde_json::json!({ "id": msg["id"], "error": "no UI available" });
            writeln!(rt.stdin, "{reply}").unwrap();
            rt.stdin.flush().unwrap();
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            assert_eq!(msg["result"]["stop_reason"], "completed", "a failed question must not end the run");
            break;
        }
    }
}

/// Turn boundaries, so a UI can show a turn opening and what it cost.
#[test]
fn a_run_pushes_its_turn_boundaries() {
    let (endpoint, _server) = fake_provider(vec![assistant_text("done")]);
    let mut rt = Runtime::start();
    rt.init();

    let run_id = rt.send(
        "agent.run",
        run_params(&endpoint, ".", "turn-1", serde_json::json!([{ "role": "user", "content": "hi" }])),
    );

    let mut phases: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "the run never answered; phases {phases:?}");
        let msg = rt.read();
        if msg["method"] == "agent.turn" {
            assert_eq!(msg["params"]["run_id"], "turn-1");
            phases.push(msg["params"]["phase"].as_str().unwrap_or("").to_owned());
            continue;
        }
        if msg["id"].as_u64() == Some(run_id) && !msg["method"].is_string() {
            break;
        }
    }
    assert_eq!(phases, vec!["start", "end"], "a turn must be announced before the request, not only after");
}
