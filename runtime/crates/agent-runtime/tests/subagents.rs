//! `subagent.*` over the wire: the runtime schedules delegations and the host runs each one. Split out of
//! protocol.rs.

mod common;

use common::*;
use std::io::Write;
use std::time::{Duration, Instant};

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
