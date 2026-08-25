//! The runtime error model (spec §17).
//!
//! The JS runtime this replaces returns `{ ok: false, content: "<human sentence>" }` for every failure
//! mode there is — a denied permission, a timeout, a missing binary and an internal bug are
//! indistinguishable to a caller, so nothing downstream can decide whether to retry, escalate, or give
//! up. That is the gap this type closes.
//!
//! Two audiences, deliberately separated:
//!
//!   - **Machines** read `code` and `class`. `class` answers "what should the caller do about it?" and
//!     is the only thing a retry policy is allowed to branch on.
//!   - **Models and humans** read `message`. It is the text that ends up in a tool result, so it says
//!     what happened in a sentence, without a stack trace.
//!
//! `Cancelled` is a variant rather than a flag because spec §14 requires cancellation to be
//! distinguishable from failure everywhere: a cancelled call did not fail, and reporting it as a
//! failure is what makes a stopped turn look broken to the user.

use serde::{Deserialize, Serialize};
use std::fmt;

/// What a caller should do about an error. The only field a retry policy may branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    /// Transient. The same call may succeed if repeated.
    Retryable,
    /// The call was wrong, not the world. Repeating it unchanged cannot help.
    Invalid,
    /// Refused by policy. Retrying is not merely useless, it is the wrong response.
    Denied,
    /// Stopped on purpose — by the user, a parent task, or a deadline.
    Cancelled,
    /// A bug in the runtime. Surfaced rather than swallowed so it can be fixed.
    Internal,
}

impl ErrorClass {
    /// Whether a retry policy is permitted to repeat the call.
    pub fn is_retryable(self) -> bool {
        matches!(self, ErrorClass::Retryable)
    }
}

/// A structured runtime failure.
#[derive(Debug, Clone, thiserror::Error)]
pub struct RuntimeError {
    /// Stable machine-readable identifier, e.g. `tool.not_found`. Never localised, never reworded.
    pub code: &'static str,
    /// What a caller should do about it.
    pub class: ErrorClass,
    /// Human- and model-facing sentence. This is what reaches a tool result.
    pub message: String,
    /// Optional underlying cause, kept as text so this type stays `Clone` and serialisable.
    pub cause: Option<String>,
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.cause {
            Some(c) => write!(f, "{} ({c})", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl RuntimeError {
    pub fn new(code: &'static str, class: ErrorClass, message: impl Into<String>) -> Self {
        Self { code, class, message: message.into(), cause: None }
    }

    /// Attach the underlying cause. Kept out of `message` so a tool result stays a sentence.
    pub fn with_cause(mut self, cause: impl fmt::Display) -> Self {
        self.cause = Some(cause.to_string());
        self
    }

    pub fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Invalid, message)
    }

    pub fn denied(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Denied, message)
    }

    pub fn retryable(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(code, ErrorClass::Retryable, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("runtime.internal", ErrorClass::Internal, message)
    }

    /// The cancellation error. One constructor so the code and class can never disagree.
    pub fn cancelled() -> Self {
        Self::new("runtime.cancelled", ErrorClass::Cancelled, "The operation was cancelled.")
    }

    /// A deadline elapsed.
    ///
    /// Classed `Cancelled`, not `Retryable`: spec §15 requires a timeout to *cause* real cancellation
    /// rather than merely report one, so by the time this is constructed the work has been stopped.
    pub fn timeout(what: &str, ms: u64) -> Self {
        Self::new(
            "runtime.timeout",
            ErrorClass::Cancelled,
            format!("{what} timed out after {ms}ms."),
        )
    }

    pub fn is_cancelled(&self) -> bool {
        self.class == ErrorClass::Cancelled
    }
}

/// Wire form. `retryable` is precomputed so a host in another language does not have to know the
/// class taxonomy in order to implement a retry policy correctly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: String,
    pub class: ErrorClass,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

impl From<&RuntimeError> for ErrorPayload {
    fn from(e: &RuntimeError) -> Self {
        Self {
            code: e.code.to_string(),
            class: e.class,
            message: e.message.clone(),
            retryable: e.class.is_retryable(),
            cause: e.cause.clone(),
        }
    }
}

pub type Result<T> = std::result::Result<T, RuntimeError>;
