//! Retrying a request whose TRANSPORT failed — C8, ported from `withRequestRetry` in src/lib/ai/requestError.ts.
//!
//! The classification, the attempt budget and the backoff match the TypeScript path, so a turn weathers the same
//! network on either side.

use std::time::Duration;

use agent_core::{Result, RuntimeError};
use agent_loop::{Message, ModelRequest, NormalizedTurn};

use crate::HttpModel;

/// A transport failure being retried, so the caller can say so. "Told, never silent": a retry nobody sees
/// turns a failing network into an app that is merely slow.
#[derive(Debug, Clone)]
pub struct RetryNotice {
    /// The attempt that just failed, 1-based.
    pub attempt: u32,
    pub attempts: u32,
    /// `network`, `rate-limit` or `server` — the three `requestError.ts` retries.
    pub kind: &'static str,
    pub delay_ms: u64,
    pub message: String,
}

/// How a caller hears about retries. Returns nothing: a display that fails must not fail the turn.
pub type OnRetry = Box<dyn Fn(&RetryNotice) + Send + Sync>;

/// Attempts per request, the first included. `MAX_ATTEMPTS` in requestError.ts.
const MAX_ATTEMPTS: u32 = 3;

/// HTTP statuses that mean "try again", not "you asked wrong". `RETRYABLE_STATUS` in requestError.ts.
const RETRYABLE_STATUS: [u16; 13] = [408, 425, 429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524];

/// Substrings of a transport failure. `NETWORK_HINTS` in requestError.ts; matched case-insensitively.
const NETWORK_HINTS: [&str; 24] = [
    "fetch failed",
    "failed to fetch",
    "network error",
    "networkerror",
    "load failed",
    "socket hang up",
    "premature close",
    "terminated",
    "econnreset",
    "econnrefused",
    "econnaborted",
    "enotfound",
    "eai_again",
    "ehostunreach",
    "enetunreach",
    "epipe",
    "etimedout",
    "timeout",
    "connection error",
    "connection closed",
    "getaddrinfo",
    "tls",
    "certificate",
    "could not connect",
];

/// `(kind, retryable)`, by the rule `classifyFailure` in requestError.ts applies — so the same failure is
/// retried, or not, whichever side sent the request.
pub(crate) fn classify_failure(e: &RuntimeError) -> (&'static str, bool) {
    let status: u16 =
        e.message.strip_prefix("HTTP ").and_then(|rest| rest.get(..3)).and_then(|d| d.parse().ok()).unwrap_or(0);
    let lower = e.message.to_lowercase();
    let kind = if status == 429 {
        "rate-limit"
    } else if RETRYABLE_STATUS.contains(&status) {
        "server"
    } else if (400..500).contains(&status) {
        "client"
    } else if status >= 500 {
        "server"
    } else if e.code == "provider.transport" || NETWORK_HINTS.iter().any(|h| lower.contains(h)) {
        "network"
    } else {
        "unknown"
    };
    (kind, matches!(kind, "network" | "rate-limit" | "server"))
}

/// Backoff: 600 ms (2 s when rate-limited) × 3^(attempt-1), ±25% jitter, capped at 30 s. `retryDelayMs`.
///
/// Jitter from the clock rather than a random-number crate: it only has to decorrelate clients hitting the
/// same provider, and the offline build this runtime ships from cannot take on a dependency casually.
pub(crate) fn retry_delay_ms(attempt: u32, kind: &str) -> u64 {
    let base: f64 = if kind == "rate-limit" { 2000.0 } else { 600.0 };
    let ideal = base * 3f64.powi(attempt.saturating_sub(1) as i32);
    let nanos =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let jitter = 1.0 + ((nanos % 1000) as f64 / 1000.0 - 0.5) * 0.5;
    (ideal * jitter).min(30_000.0).round() as u64
}

impl HttpModel {
    /// `send_once`, retried when the failure was the TRANSPORT rather than the request — C8, ported from
    /// `withRequestRetry` in src/lib/ai/requestError.ts, with the same classification, attempt budget and backoff
    /// so a turn weathers the same network either side.
    ///
    /// Beneath the three fallbacks, as in TypeScript: those change the request because the provider objected
    /// to it; this resends the identical request because it never arrived. Kept separate, a dropped connection
    /// during a fallback attempt is retried too, and neither mechanism has to know about the other.
    ///
    /// Safe with respect to side effects: the model request is the first thing a round does, so no tool of this
    /// round has run when a retry fires.
    pub(crate) async fn send_with_retry(
        &self,
        messages: &[Message],
        req: &ModelRequest,
        thinking: bool,
    ) -> Result<NormalizedTurn> {
        let mut attempt: u32 = 1;
        loop {
            let err = match self.send_once(messages, req, thinking).await {
                Ok(turn) => return Ok(turn),
                Err(e) => e,
            };
            if err.is_cancelled() || self.token.is_cancelled() {
                return Err(err);
            }
            let (kind, retryable) = classify_failure(&err);
            if !retryable || attempt >= MAX_ATTEMPTS {
                return Err(err);
            }
            let delay = retry_delay_ms(attempt, kind);
            if let Some(notify) = &self.on_retry {
                notify(&RetryNotice {
                    attempt,
                    attempts: MAX_ATTEMPTS,
                    kind,
                    delay_ms: delay,
                    message: err.message.clone(),
                });
            }
            // Clear the half-streamed reply before the next attempt writes over it, so a reader sees a restart
            // rather than text that appears to un-write itself. Accumulated text going BACKWARDS is the signal;
            // the forwarder turns it into a reset.
            if let Some(on_delta) = &self.on_delta {
                on_delta("", "");
            }
            tokio::select! {
                biased;
                _ = self.token.cancelled() => return Err(RuntimeError::cancelled()),
                _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
            }
            attempt += 1;
        }
    }
}
