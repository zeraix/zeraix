//! Model providers for `agent.run` tests: real sockets the sidecar can reach, answering from a script.

use super::Runtime;
use std::time::Duration;

// ── agent.run: the whole turn inside the runtime (TODO §2.1) ──────────────────────────────────────

/// A provider that answers from a script, on a real socket, in a background thread.
///
/// Deliberately not a mock inside the process: the point of `agent.run` is that the SIDECAR holds the turn,
/// so the model has to be something the sidecar can actually reach over the network.
pub fn fake_provider(replies: Vec<String>) -> (String, std::thread::JoinHandle<()>) {
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

/// A provider that also hands back what it was ASKED.
///
/// `fake_provider` discards the request body, which is enough while a test only cares about the answer. It is
/// not enough for context management, where the whole question is what the runtime decided to SEND — a summary
/// instead of the history, and a shorter history than the host supplied. Bodies are read to Content-Length
/// rather than into a fixed buffer, because a conversation big enough to trigger compaction is bigger than
/// 8 KiB by construction.
pub fn recording_provider(replies: Vec<String>) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let recorder = std::sync::Arc::clone(&seen);

    std::thread::spawn(move || {
        for (i, reply) in replies.into_iter().enumerate() {
            let Ok((socket, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(socket);
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            recorder.lock().expect("seen").push(String::from_utf8_lossy(&body).into_owned());

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
            let mut socket = reader.into_inner();
            let _ = std::io::Write::write_all(&mut socket, response.as_bytes());
            let _ = std::io::Write::flush(&mut socket);
            let _ = i;
        }
    });
    (format!("http://{addr}/v1/chat/completions"), seen)
}

/// A provider that accepts the request and never answers: the in-flight state a Stop has to interrupt.
pub fn stalled_provider() -> String {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    std::thread::spawn(move || {
        let Ok((socket, _)) = listener.accept() else { return };
        // Held open, answering nothing, well past any bound the tests below assert.
        std::thread::sleep(Duration::from_secs(60));
        drop(socket);
    });
    format!("http://{addr}/v1/chat/completions")
}

/// One scripted reply: a status, a body, and whether to cut the connection partway through it.
pub struct Scripted {
    status: u16,
    body: String,
    /// Advertise far more body than is sent, then close — a stream that dies mid-reply.
    truncate: bool,
}
pub fn ok_json(v: serde_json::Value) -> Scripted {
    Scripted { status: 200, body: v.to_string(), truncate: false }
}
pub fn status(code: u16, body: &str) -> Scripted {
    Scripted { status: code, body: body.to_owned(), truncate: false }
}
pub fn sse(chunks: &[&str], truncate: bool) -> Scripted {
    let mut body = String::new();
    for c in chunks {
        body.push_str(&format!("data: {}\n\n", serde_json::json!({ "choices": [{ "delta": { "content": c } }] })));
    }
    if !truncate {
        body.push_str("data: [DONE]\n\n");
    }
    Scripted { status: 200, body, truncate }
}

/// Each request as `(headers, body)`, in arrival order.
pub type SeenRequests = std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>;

/// A provider that records each request's HEADERS as well as its body.
///
/// Transport parity is about what goes on the wire around the body — `X-Conversation-Id` above all — which
/// `recording_provider` never looks at.
pub fn scripted_provider(replies: Vec<Scripted>) -> (String, SeenRequests) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let recorder = std::sync::Arc::clone(&seen);
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((socket, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(socket);
            let (mut headers, mut length) = (String::new(), 0usize);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                if line == "\r\n" || line == "\n" {
                    break;
                }
                headers.push_str(&line.to_ascii_lowercase());
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            recorder.lock().expect("seen").push((headers, String::from_utf8_lossy(&body).into_owned()));

            let kind = if reply.body.starts_with("data:") { "text/event-stream" } else { "application/json" };
            let advertised = if reply.truncate { reply.body.len() + 100_000 } else { reply.body.len() };
            let head = format!(
                "HTTP/1.1 {} X\r\nContent-Type: {kind}\r\nContent-Length: {advertised}\r\nConnection: close\r\n\r\n",
                reply.status
            );
            let mut socket = reader.into_inner();
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(reply.body.as_bytes());
            let _ = socket.flush();
            // Dropped here. For a truncated reply the client was promised 100 KB more, and sees the stream die.
        }
    });
    (format!("http://{addr}/v1/chat/completions"), seen)
}

/// Drive a run to its reply, collecting every event and host request on the way. Host tools answer "ok".
pub fn run_collecting(rt: &mut Runtime, params: serde_json::Value) -> (serde_json::Value, Vec<serde_json::Value>) {
    let id = rt.send("agent.run", params);
    let mut events = Vec::new();
    loop {
        let msg = rt.read();
        if msg["method"].is_string() && msg["id"].is_number() {
            rt.reply(msg["id"].clone(), serde_json::json!({ "ok": true, "content": "ok", "proceed": true }));
            continue;
        }
        if msg["method"].is_string() {
            events.push(msg);
            continue;
        }
        if msg["id"].as_u64() == Some(id) {
            return (msg, events);
        }
    }
}

/// An SSE provider: one `data:` frame per chunk, then `[DONE]`.
pub fn sse_provider(chunks: Vec<&str>) -> (String, std::thread::JoinHandle<()>) {
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

pub fn assistant_text(text: &str) -> String {
    serde_json::json!({
        "choices": [{ "message": { "content": text } }],
        "usage": { "prompt_tokens": 11, "completion_tokens": 7 }
    })
    .to_string()
}

pub fn assistant_tool_call(id: &str, name: &str, args: serde_json::Value) -> String {
    serde_json::json!({
        "choices": [{ "message": { "content": "", "tool_calls": [
            { "id": id, "function": { "name": name, "arguments": args.to_string() } }
        ]}}],
        "usage": { "prompt_tokens": 5, "completion_tokens": 3 }
    })
    .to_string()
}

pub fn run_params(endpoint: &str, workdir: &str, run_id: &str, messages: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "run_id": run_id,
        "workdir": workdir,
        "provider": { "endpoint": endpoint, "model": "test-model" },
        "messages": messages
    })
}
