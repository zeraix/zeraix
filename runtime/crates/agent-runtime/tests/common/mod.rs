//! The harness every end-to-end test file shares: the real runtime binary over real pipes, and the MCP fixture.
//!
//! Each file under `tests/` is its own crate and uses a different slice of this, hence the `dead_code` allowance.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Runtime {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: BufReader<ChildStdout>,
    pub next_id: u64,
}

impl Runtime {
    pub fn start() -> Self {
        Self::start_with(&[])
    }

    /// Start with extra command-line arguments — `--state-dir`, for the recovery tests.
    pub fn start_with(args: &[&str]) -> Self {
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
    pub fn send(&mut self, method: &str, params: serde_json::Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let msg = serde_json::json!({ "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
        id
    }

    /// Answer a request the RUNTIME made of us. Same shape `serve_until` writes.
    pub fn reply(&mut self, id: serde_json::Value, result: serde_json::Value) {
        let msg = serde_json::json!({ "id": id, "result": result });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Write a notification (no id, no reply).
    pub fn notify(&mut self, method: &str, params: serde_json::Value) {
        let msg = serde_json::json!({ "method": method, "params": params });
        writeln!(self.stdin, "{msg}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Read the next line of any kind — a reply or an event.
    pub fn read(&mut self) -> serde_json::Value {
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
    pub fn read_reply(&mut self) -> serde_json::Value {
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
    pub fn read_event(&mut self, method: &str) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "no {method} event arrived");
            let msg = self.read();
            if msg["method"] == method {
                return msg;
            }
        }
    }

    pub fn call(&mut self, method: &str, params: serde_json::Value) -> serde_json::Value {
        let id = self.send(method, params);
        let reply = self.read_reply();
        assert_eq!(reply["id"].as_u64(), Some(id), "replies arrived out of order");
        reply
    }

    pub fn init(&mut self) -> serde_json::Value {
        self.call("runtime.initialize", serde_json::json!({ "protocol_version": "1.0", "client": "test" }))
    }

    /// Handshake declaring which roots the user approved — the ceiling every tool call is decided against.
    pub fn init_with_roots(&mut self, roots: &[&str]) -> serde_json::Value {
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

/// The MCP fixture, reached through the runtime binary rather than in-process.
///
/// Shares `agent-mcp`'s fixture server deliberately: one strict server, exercised both by the crate's
/// own tests and across the wire, so a divergence between the two paths cannot hide.
pub fn mcp_fixture() -> Option<(String, String)> {
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
pub fn await_mcp_ready(rt: &mut Runtime, id: &str) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        assert!(Instant::now() < deadline, "{id} never reported ready");
        let msg = rt.read();
        if msg["method"] == "mcp.state" && msg["params"]["id"] == id && msg["params"]["state"] == "ready" {
            return msg;
        }
    }
}
