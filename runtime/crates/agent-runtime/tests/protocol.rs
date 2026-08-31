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
        let mut child = Command::new(env!("CARGO_BIN_EXE_zeraix-agent-runtime"))
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

    let first = rt.read();
    assert_eq!(
        first["id"].as_u64(),
        Some(fast_id),
        "the cheap request should not have queued behind the expensive one"
    );
    let second = rt.read();
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
    rt.init();

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
    rt.init();
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
