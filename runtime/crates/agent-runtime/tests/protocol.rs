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

    /// Read the next reply, whatever it answers.
    fn read(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).expect("read reply");
        assert!(n > 0, "runtime closed the stream unexpectedly");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad reply {line:?}: {e}"))
    }

    fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let id = self.send(method, params);
        let reply = self.read();
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
    assert_eq!(result["protocol_version"], "1.0");
    let tools = result["tools"].as_array().expect("tools array");
    for expected in ["read_file", "list_directory", "file_info", "search_files", "search_in_files"] {
        assert!(tools.iter().any(|t| t == expected), "{expected} missing from {tools:?}");
    }
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
    let dir = big_tree(1500);
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
    // Long enough that the search is genuinely under way, short enough that it cannot have finished:
    // the same workload measures in the hundreds of milliseconds.
    std::thread::sleep(Duration::from_millis(30));
    let sent_at = Instant::now();
    rt.notify("tool.cancel", serde_json::json!({ "call_id": "cancel-me" }));

    let reply = rt.read();
    assert_eq!(reply["id"].as_u64(), Some(id));
    let result = &reply["result"];
    assert_eq!(result["ok"], false, "a cancelled search must not report success");
    assert_eq!(result["error"]["code"], "runtime.cancelled");
    assert_eq!(result["error"]["class"], "cancelled");
    // The point of the exercise: Stop takes effect promptly rather than at the end of the work.
    assert!(
        sent_at.elapsed() < Duration::from_secs(2),
        "cancellation took {:?}, which is not 'stopped'",
        sent_at.elapsed()
    );
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
