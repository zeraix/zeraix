//! `removed_field_compat` for `protocol.rs`, kept out of the source file (declared there as `mod removed_field_compat`).

use super::*;

/// A host still sending `max_turns` must not be rejected.
///
/// The field was removed from `AgentRunParams` with the rest of the round ceilings. Nothing in this repo
/// ever sent it, but an older host binary might, and nothing in this protocol sets
/// `deny_unknown_fields` — so the extra key is ignored and the run parses. That is what makes dropping
/// the field a compatible change rather than a protocol break.
#[test]
fn a_host_that_still_sends_max_turns_is_not_rejected() {
    let old_shape = serde_json::json!({
        "run_id": "r1",
        "workdir": ".",
        "provider": { "endpoint": "http://localhost:1", "model": "m" },
        "messages": [],
        "max_turns": 8
    });
    let p: AgentRunParams =
        serde_json::from_value(old_shape).expect("an extra max_turns must not break parsing");
    assert_eq!(p.run_id, "r1");
}
