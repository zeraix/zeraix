//! How a run's requests reach the provider and what comes back: the route, the headers, retries, usage, known
//! refusals, and streamed tokens.
//!
//! ## The route
//!
//! Chat's requests used to leave from Chromium, which follows the OS proxy settings and PAC scripts. The runtime's
//! client reads neither, so the host resolves the route with Chromium's own resolver and hands it over per run.
//! These pin the three answers it can give: a proxy, "direct", and nothing (the environment decides).

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

use common::*;
use std::time::{Duration, Instant};

/// Answers ONE request with a completion and reports the request line it received.
///
/// Serves as the provider and as the proxy alike: a proxy is sent the same request in absolute form
/// (`POST http://host/path`), which is what tells the two apart in the assertions.
fn one_shot() -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = format!("127.0.0.1:{}", listener.local_addr().expect("addr").port());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let Ok((socket, _)) = listener.accept() else { return };
        let mut reader = BufReader::new(socket);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).ok();
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).ok();
        let reply = r#"{"choices":[{"message":{"role":"assistant","content":"routed"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        let mut socket = reader.into_inner();
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        );
        let _ = tx.send(request_line.trim_end().to_owned());
    });
    (addr, rx)
}

fn run(rt: &mut Runtime, endpoint: &str, proxy: Option<&str>) -> serde_json::Value {
    let mut provider = serde_json::json!({ "endpoint": endpoint, "model": "m" });
    if let Some(proxy) = proxy {
        provider["proxy"] = serde_json::json!(proxy);
    }
    rt.call(
        "agent.run",
        serde_json::json!({
            "run_id": "route",
            "workdir": ".",
            "provider": provider,
            "messages": [{ "role": "user", "content": "hi" }],
        }),
    )
}

/// A closed port, standing in for a proxy that must not be used.
const DEAD_PROXY: &str = "http://127.0.0.1:9";

#[test]
fn a_run_goes_through_the_proxy_the_host_resolved() {
    let (proxy, seen) = one_shot();
    let mut rt = Runtime::start();
    rt.init();
    // A provider nobody can resolve: the only way this completes is through the proxy.
    let r = run(&mut rt, "http://provider.invalid/v1/chat/completions", Some(&format!("http://{proxy}")));
    assert_eq!(r["result"]["stop_reason"], "completed", "{r}");
    assert_eq!(r["result"]["content"], "routed");
    assert_eq!(seen.recv().expect("the proxy saw nothing"), "POST http://provider.invalid/v1/chat/completions HTTP/1.1");
}

#[test]
fn direct_means_direct_even_when_the_environment_names_a_proxy() {
    let env = [("HTTP_PROXY", DEAD_PROXY), ("http_proxy", DEAD_PROXY), ("ALL_PROXY", DEAD_PROXY), ("all_proxy", DEAD_PROXY)];

    // The control first. Without it the second half proves nothing: it would pass just as well if the client
    // ignored the environment entirely.
    let (provider, _) = one_shot();
    let mut rt = Runtime::start_env(&env);
    rt.init();
    let r = run(&mut rt, &format!("http://{provider}/v1/chat/completions"), None);
    assert_eq!(r["result"]["stop_reason"], "error", "with no route given, the environment's proxy applies: {r}");

    let (provider, seen) = one_shot();
    let r = run(&mut rt, &format!("http://{provider}/v1/chat/completions"), Some("direct"));
    assert_eq!(r["result"]["stop_reason"], "completed", "{r}");
    assert_eq!(seen.recv().expect("the provider saw nothing"), "POST /v1/chat/completions HTTP/1.1");
}

#[test]
fn an_unusable_proxy_fails_the_run_without_repeating_it() {
    let mut rt = Runtime::start();
    rt.init();
    let r = run(&mut rt, "http://127.0.0.1:9/v1/chat/completions", Some("http://user:SECRET@[not-a-host"));
    assert!(!r["error"].is_null(), "an unusable route must be refused, not ignored: {r}");
    assert!(!r.to_string().contains("SECRET"), "a proxy URL can carry credentials and must not be echoed: {r}");
}

// ── Transport parity: what `chatRequest.ts` does around the body, the runtime now does too ─────────────

/// `X-Conversation-Id` reaches the provider — and never rides on the summariser's request.
///
/// A local llama-server keys its KV cache by conversation. Without the header a long local conversation paid a
/// full prefill every round; with it on a side request, the server would evict the conversation's own cache.
#[test]
fn headers_reach_the_provider_and_the_summariser_never_carries_the_conversation_id() {
    let (endpoint, seen) = scripted_provider(vec![
        ok_json(serde_json::json!({ "choices": [{ "message": { "content": "SUMMARY" } }] })),
        ok_json(serde_json::json!({ "choices": [{ "message": { "content": "done" } }] })),
    ]);
    let mut messages = vec![serde_json::json!({ "role": "system", "content": "be helpful" })];
    for i in 0..6 {
        let pad = "detail ".repeat(200);
        messages.push(serde_json::json!({ "role": "user", "content": format!("old {i}: {pad}") }));
        messages.push(serde_json::json!({ "role": "assistant", "content": format!("old answer {i}: {pad}") }));
    }
    for i in 0..4 {
        messages.push(serde_json::json!({ "role": "user", "content": format!("recent {i}") }));
        messages.push(serde_json::json!({ "role": "assistant", "content": format!("ok {i}") }));
    }
    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "run-headers", serde_json::Value::Array(messages));
    params["context_window"] = serde_json::json!(2000);
    params["provider"]["headers"] = serde_json::json!({ "X-Conversation-Id": "conv-42", "X-Gateway": "keep" });
    let (reply, _) = run_collecting(&mut rt, params);
    assert!(reply["error"].is_null(), "{reply}");

    let requests = seen.lock().expect("seen").clone();
    assert_eq!(requests.len(), 2, "the summariser's request, then the round's");
    let (summariser, round) = (&requests[0].0, &requests[1].0);
    assert!(requests[0].1.contains("compacting an agent's conversation"), "request 0 is the summariser's");
    assert!(round.contains("x-conversation-id: conv-42"), "the round must carry it: {round}");
    assert!(!summariser.contains("x-conversation-id"), "the summariser must NOT: {summariser}");
    assert!(summariser.contains("x-gateway: keep"), "other headers still reach the summariser");
}

/// Cache hits are counted, and usage a provider never sent is estimated AND flagged — never reported as zero.
#[test]
fn usage_reports_cache_hits_and_says_when_it_was_estimated() {
    let (endpoint, _) = scripted_provider(vec![ok_json(serde_json::json!({
        "choices": [{ "message": { "content": "cached" } }],
        "usage": { "prompt_tokens": 100, "completion_tokens": 5, "prompt_tokens_details": { "cached_tokens": 80 } }
    }))]);
    let mut rt = Runtime::start();
    rt.init();
    let (reply, events) = run_collecting(&mut rt, run_params(&endpoint, ".", "run-cache", serde_json::json!([{ "role": "user", "content": "hi" }])));
    assert_eq!(reply["result"]["cached_tokens"], 80, "{reply}");
    assert_eq!(reply["result"]["estimated"], false);
    let end = events.iter().find(|e| e["method"] == "agent.turn" && e["params"]["phase"] == "end").expect("a round end");
    assert_eq!(end["params"]["cached_tokens"], 80, "the round's own event must carry it for a live context ring");

    let (endpoint, _) = scripted_provider(vec![ok_json(serde_json::json!({
        "choices": [{ "message": { "content": "no usage block at all" } }]
    }))]);
    let (reply, _) = run_collecting(&mut rt, run_params(&endpoint, ".", "run-nousage", serde_json::json!([{ "role": "user", "content": "x".repeat(400) }])));
    assert_eq!(reply["result"]["estimated"], true, "{reply}");
    assert!(reply["result"]["prompt_tokens"].as_u64().unwrap_or(0) >= 100, "an estimate, not a zero: {reply}");
}

/// C8 through the whole runtime: one transient failure costs a retry, the host is told, the turn completes.
#[test]
fn a_transient_failure_is_retried_and_the_host_is_told() {
    let (endpoint, seen) = scripted_provider(vec![
        status(503, "service unavailable"),
        ok_json(serde_json::json!({ "choices": [{ "message": { "content": "recovered" } }] })),
    ]);
    let mut rt = Runtime::start();
    rt.init();
    let (reply, events) = run_collecting(&mut rt, run_params(&endpoint, ".", "run-retry", serde_json::json!([{ "role": "user", "content": "hi" }])));
    assert_eq!(reply["result"]["stop_reason"], "completed", "{reply}");
    assert_eq!(reply["result"]["content"], "recovered");
    assert_eq!(seen.lock().expect("seen").len(), 2);
    let retry = events.iter().find(|e| e["method"] == "agent.retry").expect("the retry must be announced");
    assert_eq!(retry["params"]["attempt"], 1);
    assert_eq!(retry["params"]["attempts"], 3);
    assert_eq!(retry["params"]["kind"], "server");
    assert_eq!(retry["params"]["run_id"], "run-retry");
}

/// A stream that dies mid-reply is retried, and the half-written reply is voided rather than kept.
///
/// Without the reset the host would append the retry's text to the dead attempt's; and without restarting
/// the offsets, the retry's opening words — shorter than what was already sent — would never be sent at all.
#[test]
fn a_retry_after_a_partial_stream_resets_the_reply() {
    let (endpoint, _) = scripted_provider(vec![sse(&["STALE-PARTIAL "], true), sse(&["Hello", " world"], false)]);
    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "run-reset", serde_json::json!([{ "role": "user", "content": "hi" }]));
    params["provider"]["stream"] = serde_json::json!(true);
    let (reply, events) = run_collecting(&mut rt, params);
    assert_eq!(reply["result"]["content"], "Hello world", "{reply}");

    // Replay the deltas the way a UI would: append, and start over on a reset.
    let mut shown = String::new();
    let mut resets = 0;
    for e in events.iter().filter(|e| e["method"] == "agent.delta") {
        if e["params"]["reset"] == true {
            resets += 1;
            shown.clear();
        }
        shown.push_str(e["params"]["content"].as_str().unwrap_or(""));
    }
    assert_eq!(resets, 1, "exactly one reset, when the retry began");
    assert_eq!(shown, "Hello world", "the stale partial must be gone and the retry shown in full");
}

/// A refusal the host already knows costs nothing, and one the run discovers is handed back.
#[test]
fn known_refusals_are_applied_up_front_and_learned_ones_reported() {
    // Told up front: the thinking parameter must not even be sent.
    let (endpoint, seen) = scripted_provider(vec![ok_json(serde_json::json!({ "choices": [{ "message": { "content": "ok" } }] }))]);
    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "run-known", serde_json::json!([{ "role": "user", "content": "hi" }]));
    params["provider"]["thinking_params"] = serde_json::json!({ "chat_template_kwargs": { "enable_thinking": true } });
    params["provider"]["known"] = serde_json::json!({ "thinking_unsupported": true });
    let (reply, _) = run_collecting(&mut rt, params);
    assert!(!seen.lock().expect("seen")[0].1.contains("chat_template_kwargs"), "a known refusal was sent anyway");
    assert_eq!(reply["result"]["learned"]["thinking_unsupported"], true);

    // Discovered: one rejected request, one resend, and the lesson reported for the host to keep.
    let (endpoint, seen) = scripted_provider(vec![
        status(400, "chat_template_kwargs is not supported"),
        ok_json(serde_json::json!({ "choices": [{ "message": { "content": "ok" } }] })),
    ]);
    let mut params = run_params(&endpoint, ".", "run-learn", serde_json::json!([{ "role": "user", "content": "hi" }]));
    params["provider"]["thinking_params"] = serde_json::json!({ "chat_template_kwargs": { "enable_thinking": true } });
    let (reply, _) = run_collecting(&mut rt, params);
    assert_eq!(reply["result"]["stop_reason"], "completed", "{reply}");
    assert_eq!(seen.lock().expect("seen").len(), 2);
    assert_eq!(reply["result"]["learned"]["thinking_unsupported"], true, "what the run learned must come back");
    assert_eq!(reply["result"]["learned"]["vision_unsupported"], false);
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
            "messages": [{ "role": "user", "content": "hi" }]
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

// ── The conversation's shape on the wire ──────────────────────────────────────────────────────────

/// Every assistant tool call in a request body, as sent.
fn sent_tool_calls(body: &str) -> Vec<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(body).expect("json body");
    v["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|m| m["tool_calls"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// A run's own tool call is replayed in the shape an OpenAI-compatible provider accepts.
///
/// It was replayed as `{ id, name, arguments }` — no `type`, no `function` — so the second request of every run
/// that used a tool was one a real provider refuses. Every fake provider here accepted it, which is why this
/// test reads the body instead of trusting a completed run.
#[test]
fn a_tool_call_is_replayed_in_the_shape_providers_accept() {
    let (endpoint, seen) = recording_provider(vec![
        assistant_tool_call("c1", "list_directory", serde_json::json!({ "path": "." })),
        assistant_text("done"),
    ]);
    let mut rt = Runtime::start();
    rt.init();
    let dir = tempfile::tempdir().unwrap();
    let r = rt.call(
        "agent.run",
        run_params(&endpoint, dir.path().to_str().unwrap(), "shape-1", serde_json::json!([{ "role": "user", "content": "go" }])),
    );
    assert_eq!(r["result"]["stop_reason"], "completed", "{r}");
    let calls = sent_tool_calls(&seen.lock().unwrap()[1]);
    assert_eq!(calls.len(), 1, "the second request replays the first round's call");
    assert_eq!(calls[0]["type"], "function");
    assert_eq!(calls[0]["function"]["name"], "list_directory");
    assert!(calls[0]["function"]["arguments"].is_string(), "arguments are a JSON string: {}", calls[0]);
    assert!(calls[0].get("name").is_none(), "no flat fields beside `function`: {}", calls[0]);
    // And the transcript handed back to the host is in the same shape.
    let back = r["result"]["messages"].as_array().unwrap().iter().find(|m| m["tool_calls"].is_array()).cloned().unwrap();
    assert_eq!(back["tool_calls"][0]["function"]["name"], "list_directory");
}

/// A history with tool calls in it — every chat conversation that has used a tool — is accepted, and sent on
/// exactly as it came. It used to be refused outright: "could not read the conversation: missing field `name`".
#[test]
fn a_history_with_tool_calls_is_accepted_and_sent_on_unchanged() {
    let (endpoint, seen) = recording_provider(vec![assistant_text("ok")]);
    let mut rt = Runtime::start();
    rt.init();
    let dir = tempfile::tempdir().unwrap();
    let history = serde_json::json!([
        { "role": "user", "content": "earlier" },
        { "role": "assistant", "content": "", "tool_calls": [
            { "id": "h1", "type": "function", "function": { "name": "list_directory", "arguments": "{ \"path\": \".\" }" } }
        ] },
        { "role": "tool", "tool_call_id": "h1", "content": "a.txt" },
        { "role": "user", "content": "again" }
    ]);
    let r = rt.call("agent.run", run_params(&endpoint, dir.path().to_str().unwrap(), "shape-2", history.clone()));
    assert_eq!(r["result"]["stop_reason"], "completed", "{r}");
    assert_eq!(sent_tool_calls(&seen.lock().unwrap()[0]), vec![history[1]["tool_calls"][0].clone()]);
}

// ── Reasoning effort, per round ───────────────────────────────────────────────────────────────────

/// The effort each request went out at, read from the body.
fn effort_sent(body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).expect("json body");
    v["reasoning_effort"].as_str().unwrap_or("(none)").to_owned()
}

/// A routine round is economised and every other keeps the user's effort — sent, not merely decided.
///
/// The loop resolved a per-round effort from the start and the provider never sent it: every request carried
/// the same thinking fields, fixed at the user's setting. So a run in the runtime paid full reasoning on the
/// "read the next file" rounds the chat's own loop issued at `low`.
#[test]
fn a_routine_round_is_sent_at_low_effort_and_a_recovery_round_at_full() {
    let dir = tempfile::tempdir().unwrap();
    let rounds = || {
        vec![
            assistant_tool_call("c1", "list_directory", serde_json::json!({ "path": "." })),
            assistant_tool_call("c2", "read_file", serde_json::json!({ "path": "missing.txt" })),
            assistant_text("done"),
        ]
    };
    let run = |rt: &mut Runtime, endpoint: &str, per_turn: bool| {
        let mut params =
            run_params(endpoint, dir.path().to_str().unwrap(), "effort", serde_json::json!([{ "role": "user", "content": "go" }]));
        params["provider"]["supports_per_turn_reasoning_effort"] = serde_json::json!(per_turn);
        params["provider"]["thinking_params"] = serde_json::json!({ "reasoning_effort": "high" });
        params["provider"]["thinking_by_effort"] = serde_json::json!({
            "low": { "reasoning_effort": "low" },
            "medium": { "reasoning_effort": "medium" },
            "high": { "reasoning_effort": "high" },
        });
        params["thinking"] = serde_json::json!({ "enabled": true, "effort": "high" });
        let r = rt.call("agent.run", params);
        assert_eq!(r["result"]["stop_reason"], "completed", "{r}");
    };
    let mut rt = Runtime::start();
    rt.init_with_roots(&[dir.path().to_str().unwrap()]);

    let (endpoint, seen) = recording_provider(rounds());
    run(&mut rt, &endpoint, true);
    let efforts: Vec<String> = seen.lock().unwrap().iter().map(|b| effort_sent(b)).collect();
    // Planning at the user's effort; after a clean tool round, economised; after a failure, full again.
    assert_eq!(efforts, vec!["high", "low", "high"]);

    // A provider with no per-request knob gets the user's setting on every round.
    let (endpoint, seen) = recording_provider(rounds());
    run(&mut rt, &endpoint, false);
    let efforts: Vec<String> = seen.lock().unwrap().iter().map(|b| effort_sent(b)).collect();
    assert_eq!(efforts, vec!["high", "high", "high"]);
}

// ── SOCKS and TLS trust ───────────────────────────────────────────────────────────────────────────

/// A SOCKS5 proxy that serves the request itself once the tunnel is up, reporting the target it was asked for.
fn socks5_one_shot() -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = format!("127.0.0.1:{}", listener.local_addr().expect("addr").port());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else { return };
        // Greeting: version, method count, methods. Answer "no authentication".
        let mut head = [0u8; 2];
        socket.read_exact(&mut head).ok();
        let mut methods = vec![0u8; head[1] as usize];
        socket.read_exact(&mut methods).ok();
        socket.write_all(&[0x05, 0x00]).ok();
        // Request: version, CONNECT, reserved, address type, address, port.
        let mut req = [0u8; 4];
        socket.read_exact(&mut req).ok();
        let target = match req[3] {
            0x03 => {
                let mut len = [0u8; 1];
                socket.read_exact(&mut len).ok();
                let mut name = vec![0u8; len[0] as usize];
                socket.read_exact(&mut name).ok();
                String::from_utf8_lossy(&name).into_owned()
            }
            0x01 => {
                let mut ip = [0u8; 4];
                socket.read_exact(&mut ip).ok();
                format!("{}.{}.{}.{}", ip[0], ip[1], ip[2], ip[3])
            }
            _ => "(unsupported address type)".to_owned(),
        };
        let mut port = [0u8; 2];
        socket.read_exact(&mut port).ok();
        socket.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).ok();
        let _ = tx.send(format!("{target}:{}", u16::from_be_bytes(port)));

        // The tunnel is up: what follows is the HTTP request, answered as the provider would.
        let mut reader = BufReader::new(socket);
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).ok();
        let reply = r#"{"choices":[{"message":{"role":"assistant","content":"via socks"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        let mut socket = reader.into_inner();
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
            reply.len()
        );
    });
    (addr, rx)
}

/// A SOCKS5 system proxy is followed — with the host name handed to the proxy to resolve, as Chromium does.
#[test]
fn a_run_goes_through_a_socks5_proxy_the_host_resolved() {
    let (proxy, seen) = socks5_one_shot();
    let mut rt = Runtime::start();
    rt.init();
    let r = run(&mut rt, "http://provider.invalid/v1/chat/completions", Some(&format!("socks5h://{proxy}")));
    assert_eq!(r["result"]["stop_reason"], "completed", "{r}");
    assert_eq!(r["result"]["content"], "via socks");
    assert_eq!(seen.recv().expect("the proxy saw nothing"), "provider.invalid:80");
}

/// A certificate the OPERATING SYSTEM trusts is trusted here too.
///
/// The runtime used to trust only its bundled Mozilla roots, while the chat window's own requests trusted the OS
/// store — so on a network that inspects TLS with a locally installed CA, chat worked in the browser and failed in
/// the runtime. On Linux the OS store honours `SSL_CERT_FILE`, which is how this plants a CA the bundle cannot
/// know. Skipped where `openssl` is not installed to mint one.
#[cfg(target_os = "linux")]
#[test]
fn a_certificate_the_os_trusts_is_trusted() {
    use std::sync::Arc;
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

    let dir = tempfile::tempdir().unwrap();
    let openssl = |args: &[&str]| {
        std::process::Command::new("openssl").args(args).current_dir(dir.path()).output().map(|o| o.status.success())
    };
    if !matches!(openssl(&["version"]), Ok(true)) {
        eprintln!("skipped: no openssl to mint a test CA");
        return;
    }
    std::fs::write(
        dir.path().join("leaf.ext"),
        "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    )
    .unwrap();
    for args in [
        &["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
          "-subj", "/CN=Zeraix Test CA", "-addext", "basicConstraints=critical,CA:TRUE",
          "-addext", "keyUsage=critical,keyCertSign,cRLSign"][..],
        &["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=127.0.0.1"][..],
        &["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out",
          "leaf.pem", "-days", "2", "-extfile", "leaf.ext"][..],
    ] {
        assert_eq!(openssl(args).ok(), Some(true), "openssl {args:?}");
    }

    // An HTTPS provider presenting the leaf. Every connection is served; the untrusted ones fail in the handshake.
    let certs: Vec<CertificateDer<'static>> =
        CertificateDer::pem_file_iter(dir.path().join("leaf.pem")).unwrap().map(|c| c.unwrap()).collect();
    let key = PrivateKeyDer::from_pem_file(dir.path().join("leaf.key")).unwrap();
    let config = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .unwrap(),
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("https://127.0.0.1:{}/v1/chat/completions", listener.local_addr().unwrap().port());
    std::thread::spawn(move || {
        for socket in listener.incoming().flatten() {
            let Ok(conn) = rustls::ServerConnection::new(Arc::clone(&config)) else { continue };
            let mut tls = rustls::StreamOwned::new(conn, socket);
            let mut reader = BufReader::new(&mut tls);
            let mut length = 0usize;
            let mut ok = true;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => { ok = false; break; }
                    Ok(_) if line == "\r\n" => break,
                    Ok(_) => {
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
            if !ok {
                continue;
            }
            let mut body = vec![0u8; length];
            let _ = reader.read_exact(&mut body);
            let reply = r#"{"choices":[{"message":{"role":"assistant","content":"trusted"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
            let _ = write!(
                tls,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            let _ = tls.flush();
            tls.conn.send_close_notify();
            let _ = tls.flush();
        }
    });

    // The control first: without the CA in the OS store, the bundle alone must refuse the server.
    let mut rt = Runtime::start_env(&[("SSL_CERT_FILE", dir.path().join("missing.pem").to_str().unwrap())]);
    rt.init();
    let r = run(&mut rt, &endpoint, Some("direct"));
    assert_eq!(r["result"]["stop_reason"], "error", "a CA nobody trusts must be refused: {r}");

    let ca = dir.path().join("ca.pem");
    let mut rt = Runtime::start_env(&[("SSL_CERT_FILE", ca.to_str().unwrap())]);
    rt.init();
    let r = run(&mut rt, &endpoint, Some("direct"));
    assert_eq!(r["result"]["stop_reason"], "completed", "a CA the OS store trusts must be trusted: {r}");
    assert_eq!(r["result"]["content"], "trusted");
}
