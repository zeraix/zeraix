//! What a host can do between rounds — and what the loop tells it — now that a whole chat turn runs here.
//!
//! The chat page used to own its loop, and with it a set of habits a turn depends on: nudges written into the
//! tool result the model is about to read, a silent final answer sent back for another round, independent reads
//! run side by side, thinking replayed within the turn, and malformed tool calls repaired before they poison
//! every later request. Each of these is the host's decision or the loop's mechanism, and each is pinned here
//! against a scripted model, where the request the loop built can be read back exactly.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_core::CancellationToken;
use agent_loop::model::call;
use agent_loop::{
    AgentLoop, AgentTurnRecord, LoopConfig, LoopObserver, Message, ModelClient, NormalizedTurn, RoundContext,
    RoundDecision, RoundGate, ScriptedModel, StopReason, ToolCall, ToolExecutor, ToolOutcome, ToolRecord,
};
use serde_json::json;

/// Tools that answer "ok", optionally after a delay, recording what ran and what they were given.
struct Tools {
    delay: Duration,
    ran: Mutex<Vec<(String, String)>>,
}

impl Tools {
    fn new(delay_ms: u64) -> Arc<Self> {
        Arc::new(Self { delay: Duration::from_millis(delay_ms), ran: Mutex::new(Vec::new()) })
    }
}

#[async_trait::async_trait]
impl ToolExecutor for Tools {
    async fn execute(&self, call: &ToolCall, _: &CancellationToken) -> (String, serde_json::Value, ToolOutcome) {
        self.ran.lock().unwrap().push((call.name.clone(), call.arguments.clone()));
        tokio::time::sleep(self.delay).await;
        let args = serde_json::from_str(&call.arguments).unwrap_or(json!({}));
        (call.name.clone(), args, ToolOutcome::ok(format!("result of {}", call.id)))
    }

    // Stands in for agent-dispatch's rule: anything that is not JSON is replayed as `{}`.
    fn replay_arguments(&self, call: &ToolCall) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(&call.arguments).is_err().then(|| "{}".to_owned())
    }
}

/// A gate that answers from a script, in order, and records every question.
struct Gate {
    answers: Mutex<Vec<RoundDecision>>,
    asked: Mutex<Vec<RoundContext>>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Gate {
    fn new(answers: Vec<RoundDecision>, log: Arc<Mutex<Vec<String>>>) -> Arc<Self> {
        Arc::new(Self { answers: Mutex::new(answers), asked: Mutex::new(Vec::new()), log })
    }
    fn asked(&self) -> Vec<RoundContext> {
        self.asked.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl RoundGate for Gate {
    async fn before_round(&self, ctx: &RoundContext) -> RoundDecision {
        self.log.lock().unwrap().push(if ctx.after_final { "gate:final".into() } else { "gate".into() });
        self.asked.lock().unwrap().push(ctx.clone());
        let mut answers = self.answers.lock().unwrap();
        if answers.is_empty() { RoundDecision::proceed() } else { answers.remove(0) }
    }
}

/// Records the order things happened in, flushes included.
struct Recorder(Arc<Mutex<Vec<String>>>);

impl LoopObserver for Recorder {
    fn response_received(&self, record: &AgentTurnRecord) {
        self.0.lock().unwrap().push(format!("response:{}", record.round));
    }
    fn tool_started(&self, call: &ToolCall) {
        self.0.lock().unwrap().push(format!("start:{}", call.id));
    }
    fn tool_finished(&self, record: &ToolRecord) {
        self.0.lock().unwrap().push(format!("end:{}", record.tool_call_id));
    }
    fn flush(&self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.0.lock().unwrap().push("flush".into());
        None
    }
}

fn agent(model: &Arc<ScriptedModel>, tools: Arc<Tools>, cfg: LoopConfig) -> AgentLoop {
    AgentLoop::new(Arc::clone(model) as Arc<dyn ModelClient>, tools, cfg)
}

fn tool_text(m: &Message) -> String {
    m.content.as_str().unwrap_or("").to_owned()
}

#[tokio::test]
async fn the_gate_hears_what_the_last_round_ran() {
    let model = Arc::new(ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({ "path": "a" }))]),
        NormalizedTurn::text("done"),
    ]));
    let gate = Gate::new(vec![], Arc::default());
    let out = agent(&model, Tools::new(0), LoopConfig::default())
        .with_gate(Arc::clone(&gate) as Arc<dyn RoundGate>)
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(out.stop.reason, Some(StopReason::Completed));

    let asked = gate.asked();
    // Before round 0, before round 1, and once more after the final answer.
    assert_eq!(asked.iter().map(|c| (c.round, c.after_final)).collect::<Vec<_>>(), vec![(0, false), (1, false), (2, true)]);
    assert!(asked[0].last.is_none(), "nothing has run before the first round");
    let last = asked[1].last.as_ref().expect("round 0 is reported before round 1");
    assert_eq!(last.calls.len(), 1);
    assert_eq!((last.calls[0].id.as_str(), last.calls[0].name.as_str()), ("c1", "read_file"));
    assert_eq!(last.calls[0].args, json!({ "path": "a" }));
    assert!(last.content_empty);
    let final_round = asked[2].last.as_ref().expect("the final round is reported too");
    assert!(!final_round.content_empty);
}

#[tokio::test]
async fn a_repetition_the_detector_notices_reaches_the_gate() {
    let same = || NormalizedTurn::calls(vec![call("c", "read_file", json!({ "path": "a" }))]);
    let model = Arc::new(ScriptedModel::new(vec![same(), same(), NormalizedTurn::text("done")]));
    let gate = Gate::new(vec![], Arc::default());
    agent(&model, Tools::new(0), LoopConfig::default())
        .with_gate(Arc::clone(&gate) as Arc<dyn RoundGate>)
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .unwrap();
    // The second identical call with an identical result is the detector's first note (REPEAT_NOTE_AT).
    let signals: Vec<_> = gate.asked().iter().filter_map(|c| c.last.clone()).flat_map(|l| l.signals).collect();
    assert_eq!(signals.len(), 1, "{signals:?}");
    assert_eq!(signals[0].name, "read_file");
    assert_eq!(signals[0].signal, agent_loop::DoomSignal::Identical);
    assert_eq!(signals[0].repeat, 2);
}

/// A nudge rides the tool result the model is about to read, joined the way the chat page joins a reminder.
#[tokio::test]
async fn a_nudge_is_appended_to_the_latest_tool_result() {
    let model = Arc::new(ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({ "path": "a" }))]),
        NormalizedTurn::text("done"),
    ]));
    let nudge = |t: &str| RoundDecision { nudge: Some(t.into()), ..RoundDecision::proceed() };
    // Round 0 has no tool result to carry a nudge, so that one must go nowhere rather than somewhere wrong.
    let gate = Gate::new(vec![nudge("TOO EARLY"), nudge("REVIEW IT")], Arc::default());
    let out = agent(&model, Tools::new(0), LoopConfig::default())
        .with_gate(gate as Arc<dyn RoundGate>)
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .unwrap();

    let sent = &model.requests()[1].messages;
    let tool = sent.iter().find(|m| m.role == "tool").unwrap();
    assert_eq!(tool_text(tool), "result of c1\n\nREVIEW IT");
    assert!(!format!("{sent:?}").contains("TOO EARLY"));
    // It is part of what happened, so the transcript the run returns carries it too.
    assert_eq!(tool_text(out.messages.iter().find(|m| m.role == "tool").unwrap()), "result of c1\n\nREVIEW IT");
}

/// A final answer that says nothing, after the turn did real work, goes back for another round.
#[tokio::test]
async fn a_silent_final_answer_can_be_sent_back_for_another_round() {
    let model = Arc::new(ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({ "path": "a" }))]),
        NormalizedTurn::text(""),
        NormalizedTurn::text("the answer"),
    ]));
    let resume = RoundDecision { resume: true, nudge: Some("ANSWER NOW".into()), ..RoundDecision::proceed() };
    // proceed before rounds 0 and 1; `resume` after the silent final; the second final completes the run.
    let gate = Gate::new(vec![RoundDecision::proceed(), RoundDecision::proceed(), resume], Arc::default());
    let out = agent(&model, Tools::new(0), LoopConfig::default())
        .with_gate(Arc::clone(&gate) as Arc<dyn RoundGate>)
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(out.stop.reason, Some(StopReason::Completed));
    assert_eq!(out.final_text(), "the answer");
    assert_eq!(model.request_count(), 3);
    // The empty assistant turn is not sent — providers refuse it — and the nudge rides the tool result.
    let third = &model.requests()[2].messages;
    assert!(!third.iter().any(|m| m.role == "assistant" && m.tool_calls.is_empty() && tool_text(m).is_empty()));
    assert!(tool_text(third.iter().find(|m| m.role == "tool").unwrap()).ends_with("\n\nANSWER NOW"));
    // Asked once per final answer, and the resumed round was not asked about a second time.
    let finals = gate.asked().iter().filter(|c| c.after_final).count();
    assert_eq!(finals, 2);
    assert_eq!(gate.asked().len(), 4, "rounds 0 and 1, then one question per final answer");
}

#[tokio::test]
async fn without_resume_a_final_answer_completes_the_run() {
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text("")]));
    // Even a gate that says "stop" at the final answer cannot turn a completed run into a stopped one.
    let gate = Gate::new(vec![RoundDecision::proceed(), RoundDecision::stop("budget")], Arc::default());
    let out = agent(&model, Tools::new(0), LoopConfig::default())
        .with_gate(gate as Arc<dyn RoundGate>)
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(out.stop.reason, Some(StopReason::Completed));
    assert_eq!(model.request_count(), 1);
}

/// Consecutive reads run side by side; their results still line up with the calls.
#[tokio::test]
async fn consecutive_parallel_safe_calls_run_at_the_same_time() {
    let reads = (1..=3).map(|i| call(&format!("r{i}"), "read_file", json!({ "path": i }))).collect();
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::calls(reads), NormalizedTurn::text("done")]));
    let cfg = LoopConfig { parallel_safe: HashSet::from(["read_file".to_owned()]), ..Default::default() };
    let began = Instant::now();
    let out = agent(&model, Tools::new(300), cfg).run(vec![Message::user("go")], CancellationToken::new()).await.unwrap();
    assert!(began.elapsed() < Duration::from_millis(800), "three 300 ms reads took {:?}", began.elapsed());
    let ids: Vec<_> = out.messages.iter().filter_map(|m| m.tool_call_id.clone()).collect();
    assert_eq!(ids, vec!["r1", "r2", "r3"], "results in the order the model asked");
}

#[tokio::test]
async fn a_call_that_is_not_parallel_safe_is_never_batched() {
    let calls = vec![
        call("r1", "read_file", json!({})),
        call("w1", "write_file", json!({})),
        call("r2", "read_file", json!({})),
    ];
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::calls(calls), NormalizedTurn::text("done")]));
    let cfg = LoopConfig { parallel_safe: HashSet::from(["read_file".to_owned()]), ..Default::default() };
    let began = Instant::now();
    let tools = Tools::new(200);
    agent(&model, Arc::clone(&tools), cfg).run(vec![Message::user("go")], CancellationToken::new()).await.unwrap();
    // A read must never overtake the edit issued before it: three separate steps.
    assert!(began.elapsed() >= Duration::from_millis(600), "took {:?}", began.elapsed());
    let order: Vec<_> = tools.ran.lock().unwrap().iter().map(|(n, _)| n.clone()).collect();
    assert_eq!(order, vec!["read_file", "write_file", "read_file"]);
}

#[tokio::test]
async fn thinking_is_replayed_within_the_turn_only_when_asked() {
    for replay in [true, false] {
        let mut first = NormalizedTurn::calls(vec![call("c1", "read_file", json!({}))]);
        first.reasoning = "LOOKING".into();
        let model = Arc::new(ScriptedModel::new(vec![first, NormalizedTurn::text("done")]));
        let cfg = LoopConfig { replay_reasoning: replay, ..Default::default() };
        agent(&model, Tools::new(0), cfg).run(vec![Message::user("go")], CancellationToken::new()).await.unwrap();
        let assistant = model.requests()[1].messages.iter().find(|m| m.role == "assistant").cloned().unwrap();
        assert_eq!(assistant.reasoning_content.as_deref(), replay.then_some("LOOKING"), "replay_reasoning = {replay}");
    }
}

/// Arguments no provider would accept are replayed repaired — but the call ran as the model wrote it.
#[tokio::test]
async fn unreadable_arguments_are_replayed_repaired_and_executed_as_sent() {
    let broken = ToolCall { id: "c1".into(), name: "read_file".into(), arguments: "{\"path\": \"a".into() };
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::calls(vec![broken]), NormalizedTurn::text("done")]));
    let tools = Tools::new(0);
    let out =
        agent(&model, Arc::clone(&tools), LoopConfig::default()).run(vec![Message::user("go")], CancellationToken::new()).await.unwrap();
    assert_eq!(tools.ran.lock().unwrap()[0].1, "{\"path\": \"a", "executed as sent");
    let requests = model.requests();
    let replayed = &requests[1].messages.iter().find(|m| m.role == "assistant").unwrap().tool_calls[0];
    assert_eq!(replayed.arguments, "{}");
    assert_eq!(out.turns[0].tool_calls[0].arguments, "{}", "and the record carries the replayed copy");
}

#[tokio::test]
async fn an_empty_assistant_turn_is_kept_in_the_transcript_and_left_out_of_the_request() {
    let model = Arc::new(ScriptedModel::new(vec![NormalizedTurn::text("ok")]));
    let history = vec![Message::user("a"), Message::assistant(""), Message::user("b")];
    let out = agent(&model, Tools::new(0), LoopConfig::default()).run(history, CancellationToken::new()).await.unwrap();
    let roles: Vec<_> = model.requests()[0].messages.iter().map(|m| m.role.clone()).collect();
    assert_eq!(roles, vec!["user", "user"]);
    assert_eq!(out.messages.len(), 4, "the conversation itself is never edited");
}

/// The reply is reported before its tools run, and everything is flushed before the host is asked anything.
#[tokio::test]
async fn the_reply_is_reported_before_its_tools_and_flushed_before_every_question() {
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let model = Arc::new(ScriptedModel::new(vec![
        NormalizedTurn::calls(vec![call("c1", "read_file", json!({}))]),
        NormalizedTurn::text("done"),
    ]));
    agent(&model, Tools::new(0), LoopConfig::default())
        .with_observer(Arc::new(Recorder(Arc::clone(&log))))
        .with_gate(Gate::new(vec![], Arc::clone(&log)) as Arc<dyn RoundGate>)
        .run(vec![Message::user("go")], CancellationToken::new())
        .await
        .unwrap();
    let log = log.lock().unwrap().clone();
    let at = |e: &str| log.iter().position(|x| x == e).unwrap_or_else(|| panic!("no {e} in {log:?}"));
    assert!(at("response:0") < at("start:c1"), "{log:?}");
    for (i, e) in log.iter().enumerate() {
        if e.starts_with("gate") {
            assert_eq!(log[i - 1], "flush", "the host was asked before the events were flushed: {log:?}");
        }
    }
}
