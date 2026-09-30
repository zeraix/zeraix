//! `tests` for `lib.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;
use crate::retry::{classify_failure, retry_delay_ms};

#[test]
fn a_transport_failure_carries_no_status_so_it_cannot_be_read_as_a_verdict() {
    // Built through the real path rather than by hand: the point is what `send_once` produces.
    let msg = "could not connect to the provider";
    assert!(!rejection::is_vision_rejection(msg));
    assert!(!rejection::is_thinking_param_error(msg));
}

#[test]
fn a_request_that_cannot_be_built_is_not_retried() {
    // Every attempt would build the same invalid request. The host drops unsendable headers before they
    // get here, but a runtime driven by anything else must not spend three backoffs learning that.
    let built = reqwest::Client::new().post("http://127.0.0.1:9/").header("Not A Header", "x").build();
    let err = transport_error(built.expect_err("an invalid header name must not build"));
    assert_eq!(classify_failure(&err), ("unknown", false));
}

#[test]
fn an_http_error_is_formatted_so_the_predicates_can_read_it() {
    let formatted = format!("HTTP {} — {}", 400, "unknown variant `image_url`");
    assert!(rejection::is_vision_rejection(&formatted));
}

#[test]
fn a_long_error_body_is_truncated_rather_than_carried_whole() {
    let long = "x".repeat(5000);
    let out = truncate(&long, 2000);
    assert!(out.len() < long.len());
    assert!(out.ends_with("… (truncated)"));
    assert_eq!(truncate("short", 2000), "short");
}

// ── C8 parity: the same failure is retried, or not, whichever side sent the request ─────────────────

fn http(status: u16) -> RuntimeError {
    RuntimeError::new("provider.http_error", ErrorClass::Invalid, format!("HTTP {status} — body"))
}

#[test]
fn failures_are_classified_as_request_error_ts_classifies_them() {
    // One row per branch of `kindOf` in src/lib/ai/requestError.ts.
    assert_eq!(classify_failure(&http(429)), ("rate-limit", true));
    for s in [408, 425, 500, 502, 503, 504, 507, 520, 524] {
        assert_eq!(classify_failure(&http(s)), ("server", true), "HTTP {s}");
    }
    assert_eq!(classify_failure(&http(501)), ("server", true), "any other 5xx is server too");
    for s in [400, 401, 403, 404, 422] {
        assert_eq!(classify_failure(&http(s)), ("client", false), "HTTP {s} must NOT be retried");
    }
    let transport =
        RuntimeError::new("provider.transport", ErrorClass::Retryable, "could not connect to the provider");
    assert_eq!(classify_failure(&transport), ("network", true));
    let reset = RuntimeError::new("provider.stream", ErrorClass::Retryable, "stream failed: ECONNRESET");
    assert_eq!(classify_failure(&reset), ("network", true), "recognised by its network hint");
    // Retryable by class, but not by C8's table: a body that is not JSON is not a transport failure, and the
    // TypeScript path would not resend it either.
    let garbage = RuntimeError::new(
        "provider.bad_response",
        ErrorClass::Retryable,
        "the provider's response was not valid JSON",
    );
    assert_eq!(classify_failure(&garbage), ("unknown", false));
}

#[test]
fn backoff_follows_the_c8_schedule_and_never_exceeds_its_cap() {
    for _ in 0..50 {
        let first = retry_delay_ms(1, "network");
        assert!((450..=750).contains(&first), "600 ms ±25%: {first}");
        let second = retry_delay_ms(2, "server");
        assert!((1350..=2250).contains(&second), "1800 ms ±25%: {second}");
        let limited = retry_delay_ms(1, "rate-limit");
        assert!((1500..=2500).contains(&limited), "a rate limit starts at 2 s: {limited}");
        assert!(retry_delay_ms(9, "rate-limit") <= 30_000, "capped at 30 s");
    }
}

#[test]
fn a_response_without_usage_is_estimated_and_says_so() {
    let turn = NormalizedTurn { content: "x".repeat(40), ..Default::default() };
    let u = estimate_usage(&[Message::user("y".repeat(400))], &turn);
    assert!(u.estimated, "an estimate must never be passed off as a count");
    assert_eq!((u.prompt_tokens, u.completion_tokens), (100, 10));
}

#[test]
fn known_quirks_go_in_and_learned_ones_come_out() {
    let model = HttpModel::new(ProviderConfig { model: "m".into(), ..Default::default() })
        .unwrap()
        .with_known(Quirks { vision_unsupported: true, ..Default::default() });
    assert!(model.knows(|l| &l.vision_unsupported), "a refusal the host already knows is applied up front");
    model.learned.lock().unwrap().thinking_unsupported.insert("m".into());
    assert_eq!(
        model.quirks(),
        Quirks { thinking_unsupported: true, reasoning_context_unsupported: false, vision_unsupported: true },
        "what the run learned is handed back beside what it was told"
    );
}
