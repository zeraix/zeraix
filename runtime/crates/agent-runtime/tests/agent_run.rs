//! `agent.run`: a whole turn inside the runtime — the loop, host-served tools, the round gate, context
//! management, the run's workspace, and Stop. Split out of protocol.rs; the provider fakes are in
//! `common/agent.rs`.

mod common;

use common::*;
use std::io::Write;
use std::time::{Duration, Instant};

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

/// The other half of the cycle: a tool the runtime does NOT implement, run by the host, inside the same loop.
///
/// This is what makes `agent.run` usable by the app rather than merely demonstrable. Most of the catalog a real
/// run is offered — every MCP server's tools, every plugin's, the app's own — is implemented in Electron and
/// always will be. Before the bridge, a model that called one of them inside a run was told it did not exist.
#[test]
fn a_tool_the_runtime_does_not_implement_is_run_by_the_host_inside_the_loop() {
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("note.txt"), "local note").unwrap();

    let (endpoint, _server) = fake_provider(vec![
        // One of each, in one run: a registry tool and a host tool. The pair is the point — the bridge must
        // pick up what the runtime lacks WITHOUT intercepting what it has.
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": "note.txt" })),
        assistant_tool_call("c2", "web_search", serde_json::json!({ "query": "zeraix" })),
        assistant_text("done"),
    ]);
    let mut rt = Runtime::start();
    rt.init_with_roots(&[dir.path().to_str().unwrap()]);

    let id = rt.send(
        "agent.run",
        run_params(
            &endpoint,
            dir.path().to_str().unwrap(),
            "run-host-tool",
            serde_json::json!([{ "role": "user", "content": "look it up" }]),
        ),
    );

    // Pump the stream until the run answers, serving whatever the runtime asks for on the way.
    let mut host_calls: Vec<serde_json::Value> = Vec::new();
    let result = loop {
        let msg = rt.read();
        if msg["method"] == "host.tool" && msg["id"].is_number() {
            host_calls.push(msg["params"].clone());
            rt.reply(
                msg["id"].clone(),
                serde_json::json!({ "ok": true, "content": "three results about zeraix" }),
            );
            continue;
        }
        if msg["id"].as_u64() == Some(id) && !msg["method"].is_string() {
            break msg;
        }
    };

    assert!(result["error"].is_null(), "{result}");
    assert_eq!(result["result"]["stop_reason"], "completed");
    assert_eq!(result["result"]["tool_calls"], 2);

    // Exactly one crossing: `read_file` is the runtime's and must never be handed back to Electron, or the
    // migration would be running in reverse.
    assert_eq!(host_calls.len(), 1, "only the unimplemented tool belongs to the host: {host_calls:?}");
    assert_eq!(host_calls[0]["name"], "web_search");
    assert_eq!(host_calls[0]["args"]["query"], "zeraix");

    // Both results reached the model, each from the side that produced it.
    let messages = result["result"]["messages"].as_array().expect("messages");
    let tool_results: Vec<&str> =
        messages.iter().filter(|m| m["role"] == "tool").map(|m| m["content"].as_str().unwrap_or("")).collect();
    assert_eq!(tool_results.len(), 2);
    assert!(tool_results[0].contains("local note"), "the runtime's own tool: {tool_results:?}");
    assert!(tool_results[1].contains("three results"), "the host's tool: {tool_results:?}");
}

/// A host that refuses answers the model, not the transport: a refusal is a tool result it can act on.
#[test]
fn a_host_tool_that_fails_is_reported_to_the_model_rather_than_failing_the_run() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "image_generation", serde_json::json!({ "prompt": "a cat" })),
        assistant_text("I could not generate the image"),
    ]);
    let mut rt = Runtime::start();
    rt.init();

    let id = rt.send(
        "agent.run",
        run_params(&endpoint, ".", "run-host-fail", serde_json::json!([{ "role": "user", "content": "draw" }])),
    );
    let result = loop {
        let msg = rt.read();
        if msg["method"] == "host.tool" && msg["id"].is_number() {
            rt.reply(
                msg["id"].clone(),
                serde_json::json!({ "ok": false, "content": "image generation is not configured" }),
            );
            continue;
        }
        if msg["id"].as_u64() == Some(id) && !msg["method"].is_string() {
            break msg;
        }
    };

    assert!(result["error"].is_null(), "a refused tool must not fail the run: {result}");
    assert_eq!(result["result"]["stop_reason"], "completed");
    let messages = result["result"]["messages"].as_array().expect("messages");
    assert!(
        messages.iter().any(|m| m["role"] == "tool"
            && m["content"].as_str().unwrap_or("").contains("not configured")),
        "the refusal must reach the model verbatim: {messages:?}"
    );
}

/// The host keeps the right to stop a loop it no longer drives.
///
/// A spending limit, a workflow node's round budget and a withdrawn approval are all things the caller knows
/// and the loop cannot observe. Before the gate, enforcing one meant owning the loop — which is exactly what
/// moving the loop into the runtime takes away, and the reason the automation path could not be routed here.
#[test]
fn the_host_can_stop_a_run_between_rounds() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "file_info", serde_json::json!({ "path": "." })),
        assistant_tool_call("c2", "file_info", serde_json::json!({ "path": "." })),
        assistant_text("never reached"),
    ]);
    let mut rt = Runtime::start();
    rt.init();

    let mut params = run_params(&endpoint, ".", "run-gate", serde_json::json!([{ "role": "user", "content": "go" }]));
    params["round_gate"] = serde_json::json!(true);
    let id = rt.send("agent.run", params);

    let mut rounds_asked = 0;
    let result = loop {
        let msg = rt.read();
        if msg["method"] == "host.round" && msg["id"].is_number() {
            rounds_asked += 1;
            // Let the first round run, refuse the second — the shape of a budget that runs out mid-run.
            let allow = rounds_asked < 2;
            rt.reply(
                msg["id"].clone(),
                serde_json::json!({ "proceed": allow, "detail": "the token budget for this step is spent" }),
            );
            continue;
        }
        if msg["id"].as_u64() == Some(id) && !msg["method"].is_string() {
            break msg;
        }
    };

    assert!(result["error"].is_null(), "a gated stop is an outcome, not a failure: {result}");
    assert_eq!(result["result"]["stop_reason"], "host-stopped");
    assert_eq!(result["result"]["detail"], "the token budget for this step is spent");
    // The work the run DID do comes back. Throwing away a completed round because the next one was refused is
    // how a budget stop turns into a step that paid for everything and reported nothing.
    assert_eq!(result["result"]["rounds"], 1);
    assert_eq!(result["result"]["tool_calls"], 1);
    assert_eq!(rounds_asked, 2, "the gate is consulted before every round, including the first");
}

/// The gate's other answer: not "stop", but "answer now with what you have".
#[test]
fn the_host_can_withdraw_the_tools_for_one_round() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "file_info", serde_json::json!({ "path": "." })),
        assistant_text("here is what I found"),
    ]);
    let mut rt = Runtime::start();
    rt.init();

    let mut params = run_params(
        &endpoint,
        ".",
        "run-withdraw",
        serde_json::json!([{ "role": "user", "content": "go" }]),
    );
    params["round_gate"] = serde_json::json!(true);
    params["tools"] = serde_json::json!([
        { "type": "function", "function": { "name": "file_info", "parameters": { "type": "object" } } }
    ]);
    let id = rt.send("agent.run", params);

    let mut round = 0;
    let result = loop {
        let msg = rt.read();
        if msg["method"] == "host.round" && msg["id"].is_number() {
            round += 1;
            rt.reply(
                msg["id"].clone(),
                // Round 2 is the answer round: proceed, but with nothing to call.
                serde_json::json!({ "proceed": true, "withdraw_tools": round >= 2 }),
            );
            continue;
        }
        if msg["id"].as_u64() == Some(id) && !msg["method"].is_string() {
            break msg;
        }
    };

    assert!(result["error"].is_null(), "{result}");
    // The run finished normally: withdrawing tools shapes a round, it does not end the run.
    assert_eq!(result["result"]["stop_reason"], "completed");
    assert_eq!(result["result"]["content"], "here is what I found");
    assert_eq!(result["result"]["rounds"], 2);
}

/// A message the host injected is reported as such, so a transcript can leave it out.
///
/// The "answer now" instruction enters the conversation as `role: "user"`. It has to be in `messages` — the
/// model answered it — but a host rendering `messages` as-is would show the user something they never typed.
#[test]
fn an_injected_message_is_reported_so_the_user_view_can_leave_it_out() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "file_info", serde_json::json!({ "path": "." })),
        assistant_text("final answer"),
    ]);
    let mut rt = Runtime::start();
    rt.init();

    let mut params = run_params(&endpoint, ".", "run-inject", serde_json::json!([{ "role": "user", "content": "go" }]));
    params["round_gate"] = serde_json::json!(true);
    let id = rt.send("agent.run", params);

    let mut round = 0;
    let result = loop {
        let msg = rt.read();
        if msg["method"] == "host.round" && msg["id"].is_number() {
            round += 1;
            let reply = if round == 2 {
                serde_json::json!({
                    "proceed": true,
                    "withdraw_tools": true,
                    "inject": [{ "role": "user", "content": "HOST-INJECTED: answer now" }]
                })
            } else {
                serde_json::json!({ "proceed": true })
            };
            rt.reply(msg["id"].clone(), reply);
            continue;
        }
        if msg["id"].as_u64() == Some(id) && !msg["method"].is_string() {
            break msg;
        }
    };

    assert!(result["error"].is_null(), "{result}");
    let messages = result["result"]["messages"].as_array().expect("messages");
    let injected: Vec<usize> = result["result"]["injected"]
        .as_array()
        .expect("`injected` is always present")
        .iter()
        .map(|v| v.as_u64().expect("an index") as usize)
        .collect();

    assert_eq!(injected.len(), 1, "exactly the one message the host injected: {injected:?}");
    assert_eq!(messages[injected[0]]["content"], "HOST-INJECTED: answer now");
    assert_eq!(messages[injected[0]]["role"], "user", "it really is user-role — which is why it must be flagged");
    // The user's own message is NOT flagged, though it has the same role.
    assert_eq!(messages[0]["content"], "go");
    assert!(!injected.contains(&0), "the user's own message must never be reported as injected");
}

/// With no injection, `injected` is present and empty — never absent.
#[test]
fn a_run_with_nothing_injected_reports_an_empty_list() {
    let (endpoint, _server) = fake_provider(vec![assistant_text("hello")]);
    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("agent.run", run_params(&endpoint, ".", "run-noinject", serde_json::json!([{ "role": "user", "content": "hi" }])));
    assert_eq!(r["result"]["injected"], serde_json::json!([]), "{r}");
}

/// A gate that cannot be reached must not become a gate that is not applied.
#[test]
fn a_run_stops_when_the_gate_cannot_be_answered() {
    let (endpoint, _server) = fake_provider(vec![assistant_text("should never be asked for")]);
    let mut rt = Runtime::start();
    rt.init();

    let mut params = run_params(&endpoint, ".", "run-nogate", serde_json::json!([{ "role": "user", "content": "go" }]));
    params["round_gate"] = serde_json::json!(true);
    let id = rt.send("agent.run", params);

    // Refuse to answer the gate, exactly as a host with no handler registered would.
    let result = loop {
        let msg = rt.read();
        if msg["method"] == "host.round" && msg["id"].is_number() {
            let msg_id = msg["id"].clone();
            let err = serde_json::json!({ "id": msg_id, "error": "the host has no handler for host.round" });
            writeln!(rt.stdin, "{err}").unwrap();
            rt.stdin.flush().unwrap();
            continue;
        }
        if msg["id"].as_u64() == Some(id) && !msg["method"].is_string() {
            break msg;
        }
    };

    assert_eq!(
        result["result"]["stop_reason"], "host-stopped",
        "an unanswerable permission is a denied one: {result}"
    );
    assert_eq!(result["result"]["rounds"], 0, "nothing may run before the gate answers");
}

/// Context management, end to end: the runtime summarises the history rather than sending it.
///
/// `ContextManager` has implemented `ContextStrategy` since it was written and `run_agent` never installed it,
/// so the loop always ran on `PassThroughContext` — a strategy crate that could not affect a single real run.
/// This is the test that the wiring exists: declare a window, hand over a conversation far bigger than it, and
/// look at what actually left the process.
#[test]
fn a_run_with_a_context_window_summarises_instead_of_sending_the_history() {
    // Two replies: the first request out is the summariser's, the second is the round itself.
    let (endpoint, seen) = recording_provider(vec![
        assistant_text("Earlier: the user asked about six files; all were read."),
        assistant_text("done"),
    ]);

    // A conversation that cannot fit in the declared window, with four short turns at the end to keep.
    let mut messages = vec![serde_json::json!({ "role": "system", "content": "be helpful" })];
    for i in 0..6 {
        let padding = "detail ".repeat(200);
        messages.push(serde_json::json!({ "role": "user", "content": format!("old question {i}: {padding}") }));
        messages.push(serde_json::json!({ "role": "assistant", "content": format!("old answer {i}: {padding}") }));
    }
    for i in 0..4 {
        messages.push(serde_json::json!({ "role": "user", "content": format!("recent question {i}") }));
        messages.push(serde_json::json!({ "role": "assistant", "content": format!("recent answer {i}") }));
    }

    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "run-context", serde_json::Value::Array(messages));
    params["context_window"] = serde_json::json!(2000);
    let r = rt.call("agent.run", params);
    assert!(r["error"].is_null(), "{r}");
    assert_eq!(r["result"]["stop_reason"], "completed");

    let bodies = seen.lock().expect("seen").clone();
    assert_eq!(bodies.len(), 2, "one summariser call, then the round");

    // The summariser was asked to summarise, and was given the ORIGINALS.
    assert!(bodies[0].contains("compacting an agent's conversation"), "not a summarisation request");
    assert!(bodies[0].contains("old question 0"), "the summariser must see the history it is folding");

    // The round itself carries the summary and the recent turns, and NOT the folded originals.
    let round: serde_json::Value = serde_json::from_str(&bodies[1]).expect("round body");
    let sent = serde_json::to_string(&round["messages"]).expect("messages");
    assert!(sent.contains("Summary of the earlier part"), "the summary must be sent: {sent:.400}");
    assert!(sent.contains("all were read"), "the summary text must be sent");
    assert!(sent.contains("recent question 3"), "the recent turns must survive verbatim");
    assert!(!sent.contains("old answer 0"), "a folded message must not also be sent");
    assert!(
        bodies[1].len() < bodies[0].len(),
        "the round must be smaller than the history it replaced: {} vs {}",
        bodies[1].len(),
        bodies[0].len()
    );
}

/// Compaction changes what is SENT, never what is returned.
///
/// The transcript in `AgentRunResult` is what the host persists and what the user reads back. A run that
/// summarised its history away must still hand back the history: the wire view is a way to fit a window, not
/// an edit to the conversation. The mistake this guards against is one line — reusing the prepared array as
/// the loop's own — and it would pass every other test in this file.
#[test]
fn a_compacted_run_returns_the_conversation_verbatim_not_the_compacted_view() {
    let (endpoint, seen) = recording_provider(vec![
        assistant_text("Earlier: six files were read."),
        assistant_text("done"),
    ]);

    let mut messages = vec![serde_json::json!({ "role": "system", "content": "be helpful" })];
    for i in 0..6 {
        let padding = "detail ".repeat(200);
        messages.push(serde_json::json!({ "role": "user", "content": format!("old question {i}: {padding}") }));
        messages.push(serde_json::json!({ "role": "assistant", "content": format!("old answer {i}: {padding}") }));
    }
    for i in 0..4 {
        messages.push(serde_json::json!({ "role": "user", "content": format!("recent question {i}") }));
        messages.push(serde_json::json!({ "role": "assistant", "content": format!("recent answer {i}") }));
    }
    let sent_count = messages.len();

    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "run-verbatim", serde_json::Value::Array(messages));
    params["context_window"] = serde_json::json!(2000);
    let r = rt.call("agent.run", params);
    assert!(r["error"].is_null(), "{r}");

    // It really did compact — otherwise this asserts nothing.
    let bodies = seen.lock().expect("seen").clone();
    assert_eq!(bodies.len(), 2, "the summariser must have run");
    assert!(!bodies[1].contains("old answer 0"), "the model must NOT have been sent the folded history");

    let returned = r["result"]["messages"].as_array().expect("messages");
    let transcript = serde_json::to_string(returned).expect("transcript");
    // Every original is still there, in full.
    for i in 0..6 {
        assert!(
            transcript.contains(&format!("old question {i}")),
            "the returned transcript lost original turn {i} — the user's record was rewritten"
        );
        assert!(transcript.contains(&format!("old answer {i}")), "the returned transcript lost answer {i}");
    }
    // And the wire view's artefacts are not in it.
    assert!(
        !transcript.contains("Summary of the earlier part"),
        "the summary belongs to the wire view only; it must not appear in the conversation"
    );
    assert!(
        !transcript.contains("trimmed to make room") && !transcript.contains("removed to make room"),
        "an elision marker must not reach the returned transcript"
    );
    // The loop appends its own assistant turn; nothing is dropped.
    assert_eq!(
        returned.len(),
        sent_count + 1,
        "every message sent in, plus the answer, and nothing removed"
    );
}

/// The default is untouched: no window declared, no compaction, the conversation goes as it stands.
#[test]
fn a_run_without_a_context_window_sends_the_conversation_unchanged() {
    let (endpoint, seen) = recording_provider(vec![assistant_text("done")]);
    let messages = serde_json::json!([
        { "role": "user", "content": "first" },
        { "role": "assistant", "content": "second" },
        { "role": "user", "content": "third" },
    ]);

    let mut rt = Runtime::start();
    rt.init();
    let r = rt.call("agent.run", run_params(&endpoint, ".", "run-nocontext", messages));
    assert!(r["error"].is_null(), "{r}");

    let bodies = seen.lock().expect("seen").clone();
    assert_eq!(bodies.len(), 1, "no summariser call may happen without a declared window");
    for text in ["first", "second", "third"] {
        assert!(bodies[0].contains(text), "{text} must be sent unchanged");
    }
}

/// A project opened AFTER launch is usable inside a run.
///
/// The ceiling is fixed at the handshake from the workspace open at boot; a run works in the workspace open
/// now. Opening a project after launch — the ordinary case — made every file tool the runtime executes inside
/// `agent.run` fail as "outside the configured ceiling". It shipped with the automation path and no test
/// caught it, because none used a file tool the runtime runs itself.
#[test]
fn a_run_can_use_file_tools_in_a_workspace_opened_after_the_handshake() {
    let boot = tempfile::tempdir().expect("boot");
    let project = tempfile::tempdir().expect("project");
    std::fs::write(project.path().join("note.txt"), "PROJECT-NOTE").unwrap();
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": "note.txt" })),
        assistant_text("done"),
    ]);
    let mut rt = Runtime::start();
    // The app declares the workspace open at boot...
    rt.init_with_roots(&[boot.path().to_str().unwrap()]);
    // ...and the run happens in a different one.
    let r = rt.call(
        "agent.run",
        run_params(
            &endpoint,
            project.path().to_str().unwrap(),
            "run-moved",
            serde_json::json!([{ "role": "user", "content": "read it" }]),
        ),
    );
    let tool = r["result"]["messages"].as_array().expect("messages").iter().find(|m| m["role"] == "tool").cloned();
    let content = tool.map(|t| t["content"].to_string()).unwrap_or_default();
    assert!(content.contains("PROJECT-NOTE"), "the run's own workspace must be readable: {content}");
    assert!(!content.contains("Permission denied"), "{content}");
}

/// The grant is the run's workspace and nothing beyond it: moving the workspace must not open the rest of the disk.
#[test]
fn a_runs_workspace_grant_does_not_reach_outside_it() {
    let boot = tempfile::tempdir().expect("boot");
    let project = tempfile::tempdir().expect("project");
    let elsewhere = tempfile::tempdir().expect("elsewhere");
    let secret = elsewhere.path().join("secret.txt");
    std::fs::write(&secret, "SHOULD-NOT-LEAK").unwrap();
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": secret.to_str().unwrap() })),
        assistant_text("done"),
    ]);
    let mut rt = Runtime::start();
    rt.init_with_roots(&[boot.path().to_str().unwrap()]);
    let r = rt.call(
        "agent.run",
        run_params(
            &endpoint,
            project.path().to_str().unwrap(),
            "run-escape",
            serde_json::json!([{ "role": "user", "content": "read the secret" }]),
        ),
    );
    let transcript = r["result"]["messages"].to_string();
    assert!(!transcript.contains("SHOULD-NOT-LEAK"), "a file outside the run's workspace leaked");
}

/// Stop interrupts a model request that is still in flight.
///
/// The token used to be checked only between steps, so a Stop pressed during a request waited for the
/// provider — a minute or more for a long answer — and then discarded what arrived. The TypeScript loop aborts
/// its fetch at once; a user comparing the two would see a Stop that works and one that does not.
#[test]
fn stop_interrupts_a_model_request_in_flight() {
    let endpoint = stalled_provider();
    let mut rt = Runtime::start();
    rt.init();
    let id = rt.send("agent.run", run_params(&endpoint, ".", "run-stall", serde_json::json!([{ "role": "user", "content": "go" }])));
    std::thread::sleep(Duration::from_millis(300));
    let stopped_at = Instant::now();
    rt.notify("call.cancel", serde_json::json!({ "call_id": "run-stall" }));

    let reply = loop {
        let msg = rt.read_reply();
        if msg["id"].as_u64() == Some(id) {
            break msg;
        }
    };
    assert_eq!(reply["result"]["stop_reason"], "cancelled", "{reply}");
    assert!(
        stopped_at.elapsed() < Duration::from_secs(3),
        "Stop waited {:?} for a provider that was never going to answer",
        stopped_at.elapsed()
    );
}

/// Stop does not wait for a host tool nobody will answer.
///
/// A host tool is answered by another process, often by a person, and the runtime waits minutes for it. When
/// the window that owned a run closed with a tool outstanding, the run sat out the whole three-minute host
/// timeout before noticing it had been cancelled.
#[test]
fn stop_does_not_wait_for_a_host_tool_nobody_answers() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "web_search", serde_json::json!({ "query": "q" })),
        assistant_text("never reached"),
    ]);
    let mut rt = Runtime::start();
    rt.init();
    let id = rt.send("agent.run", run_params(&endpoint, ".", "run-orphan", serde_json::json!([{ "role": "user", "content": "go" }])));

    // Wait until the runtime is blocked on the host, then stop — and never answer the question.
    loop {
        let msg = rt.read();
        if msg["method"] == "host.tool" {
            break;
        }
    }
    let stopped_at = Instant::now();
    rt.notify("call.cancel", serde_json::json!({ "call_id": "run-orphan" }));

    let reply = loop {
        let msg = rt.read_reply();
        if msg["id"].as_u64() == Some(id) {
            break msg;
        }
    };
    assert_eq!(reply["result"]["stop_reason"], "cancelled", "{reply}");
    assert!(
        stopped_at.elapsed() < Duration::from_secs(3),
        "Stop waited {:?} on a host tool the stopped run had no use for",
        stopped_at.elapsed()
    );
}
