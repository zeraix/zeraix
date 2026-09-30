//! Tests for `agent_run.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;
use super::host_bridges::host_tool_timeout;

#[test]
fn a_host_that_serves_everything_gets_a_persons_timeout() {
    // A chat window's tools include a consent prompt and a whole delegation. Its bridge gives up at 45 minutes
    // (runtimeTurnBridge.mjs TOOL_TIMEOUT_MS); the runtime must not give up first.
    assert!(host_tool_timeout(true) > std::time::Duration::from_secs(45 * 60));
    // Everyone else keeps the tool-sized bound: an MCP server that died must not hold a run for an hour.
    assert_eq!(host_tool_timeout(false), std::time::Duration::from_secs(180));
}

#[test]
fn a_slow_round_is_never_a_reason_to_stop_but_everything_else_still_is() {
    let policy = run_stop_policy();
    assert_eq!(policy.round_timeout, None);
    // Only that limit is lifted: the failure ceiling, the context limit and the rest keep their defaults.
    let defaults = agent_loop::StopPolicyConfig::default();
    assert_eq!(policy.max_consecutive_failures, defaults.max_consecutive_failures);
    assert_eq!(policy.context_limit_fraction, defaults.context_limit_fraction);
    assert_eq!(policy.task_timeout, defaults.task_timeout);
}
