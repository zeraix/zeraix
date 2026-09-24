//! What an `agent.run` needs from its host, and what it tells it: consent, questions, tool and round events,
//! cancellation by run id, the approved roots, and the write tools. Split out of protocol.rs.

mod common;

use common::*;
use std::io::Write;
use std::time::{Duration, Instant};

/// A turn cut short is reported as stopped, not as finished.
///
/// It used to be cut short by `max_turns`, which the host set to 3 here. The round ceilings are gone, so what
/// ends this run is the doom-loop detector — twelve identical `file_info` calls produce no new information —
/// and that is the point worth keeping: the run must not come back as `completed`.
#[test]
fn a_run_cut_short_says_so_rather_than_reporting_success() {
    let looping: Vec<String> = (0..12)
        .map(|i| assistant_tool_call(&format!("c{i}"), "file_info", serde_json::json!({ "path": "." })))
        .collect();
    let (endpoint, _server) = fake_provider(looping);
    let mut rt = Runtime::start();
    rt.init();

    let params = run_params(&endpoint, ".", "run-3", serde_json::json!([{ "role": "user", "content": "go" }]));
    let r = rt.call("agent.run", params);
    let result = &r["result"];
    let reason = result["stop_reason"].as_str().unwrap_or("");
    assert_eq!(reason, "doom-loop", "unexpected reason: {reason} in {result}");
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
    // `response` between them: the reply itself, before its tools run, so a host keeping the conversation can
    // store the assistant turn ahead of the results that answer it.
    assert_eq!(
        phases,
        vec!["start", "response", "end"],
        "a turn must be announced before the request, not only after"
    );
}

/// A chat window runs every tool through its own path — consent under the user's approval mode, the tool's row,
/// its log entry — so a run can hand it EVERY call, including the runtime's own tools and `ask_user`.
#[test]
fn a_run_can_hand_every_tool_call_to_the_host() {
    let (endpoint, _server) = fake_provider(vec![
        assistant_tool_call("c1", "read_file", serde_json::json!({ "path": "a.txt" })),
        assistant_tool_call("c2", "ask_user", serde_json::json!({ "questions": [] })),
        assistant_text("done"),
    ]);
    let mut rt = Runtime::start();
    rt.init();
    let mut params = run_params(&endpoint, ".", "all-host", serde_json::json!([{ "role": "user", "content": "go" }]));
    params["host_tools_only"] = serde_json::json!(true);
    let id = rt.send("agent.run", params);

    let mut asked: Vec<(String, String)> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let reply = loop {
        assert!(Instant::now() < deadline, "no reply; host was asked {asked:?}");
        let msg = rt.read();
        if msg["method"].is_string() && msg["id"].is_number() {
            let method = msg["method"].as_str().unwrap_or("").to_owned();
            asked.push((method, msg["params"]["name"].as_str().unwrap_or("").to_owned()));
            rt.reply(msg["id"].clone(), serde_json::json!({ "ok": true, "content": "from the window" }));
            continue;
        }
        if msg["id"].as_u64() == Some(id) {
            break msg;
        }
    };
    assert_eq!(reply["result"]["stop_reason"], "completed", "{reply}");
    assert_eq!(
        asked,
        vec![("host.tool".to_owned(), "read_file".to_owned()), ("host.tool".to_owned(), "ask_user".to_owned())],
        "the runtime's own read_file and ask_user both went to the host, through one path"
    );
}
