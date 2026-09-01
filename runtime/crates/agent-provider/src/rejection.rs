//! Reading a provider's "no" — which of three specific rejections a failure is, if any.
//!
//! Ported from `thinking.ts` (`isThinkingParamError`, `isReasoningContentError`) and `wireHelpers.ts`
//! (`isVisionRejection`). The word lists are reproduced rather than re-derived: each entry is a real provider's
//! real wording, collected from failures in the field, and a list rewritten from first principles would be a
//! list that has never met any of them.
//!
//! ## Why two of these are narrow and one is not
//!
//! The asymmetry is about what a wrong answer costs.
//!
//! **Thinking and reasoning are matched narrowly**, because acting on them *silently drops a user setting* —
//! the thinking switch, or the replay of past reasoning — for the rest of the session. A false positive there
//! is invisible: the model keeps answering, just without the deliberation the user asked for and paid for. So
//! both require a 400 that actually names one of our own fields.
//!
//! **The image retry is not matched at all** (see `agent-provider`'s `complete`): a failed request carrying
//! images is retried without them whatever the error said, because providers word that rejection every
//! possible way and a signature that misses one turns into a hard failure on a picture the user can see on
//! screen. The cost of guessing wrong is one request that was already failing.
//!
//! **The image *verdict* is narrow again** — [`is_vision_rejection`] — because its cost is not one request but
//! every later turn: the model is remembered as text-only and the user's images are stripped before sending.
//! Pairing a broad retry with a broad verdict is exactly what once turned transient failures into permanently
//! image-blind models, curable only by deleting and re-adding the model.

/// Fields that belong to us rather than to the message, so a 400 naming one is a rejection of our request
/// shape and not of the conversation.
const THINKING_PARAM_KEYS: [&str; 5] =
    ["chat_template_kwargs", "enable_thinking", "thinking_budget", "thinking", "reasoning_effort"];

/// Wording that names the image input as the problem.
const VISION_REJECTION_WORDS: [&str; 9] = [
    "image_url",
    "invalid_image",
    "image input",
    "image content",
    "not support image",
    "support images",
    "image is not supported",
    "images are not supported",
    "cannot process image",
];

/// Wording that explains a failure *without* the model being image-blind — the images were merely the bulk.
const NOT_VISION_WORDS: [&str; 28] = [
    // Size / context: images are by far the biggest part of the body, so stripping them "fixes" these every
    // time, which is precisely why a retry succeeding proves nothing on its own.
    "context length",
    "context_length",
    "maximum context",
    "too many tokens",
    "token limit",
    "reduce the length",
    "too large",
    "entity too large",
    "payload",
    "body limit",
    // Load / quota / billing.
    "rate limit",
    "rate_limit",
    "quota",
    "overload",
    "capacity",
    "insufficient",
    "balance",
    "billing",
    "try again",
    // Transport: no status at all, so the retry succeeding says nothing about the model.
    "timeout",
    "timed out",
    "network",
    "failed to fetch",
    "fetch failed",
    "socket",
    "econnreset",
    "etimedout",
    "enotfound",
];

/// Does this failure look like the provider rejecting the thinking switch itself?
///
/// A 400 that names one of our own fields. Anything broader would start dropping the user's setting on
/// failures that had nothing to do with it.
pub fn is_thinking_param_error(message: &str) -> bool {
    let msg = message.to_lowercase();
    if !msg.contains("400") {
        return false;
    }
    THINKING_PARAM_KEYS.iter().any(|k| msg.contains(k))
}

/// Does this failure look like the provider rejecting a *replayed* thinking block?
///
/// `reasoning_content` is an output-side field, so a strict provider answers an input carrying it with a 400
/// "unknown field". Matched the same narrow way, because the fallback it guards drops the replay for the rest
/// of the session.
pub fn is_reasoning_content_error(message: &str) -> bool {
    let msg = message.to_lowercase();
    if !msg.contains("400") {
        return false;
    }
    if msg.contains("reasoning_content") {
        return true;
    }
    // A bare "reasoning" counts, but not when the complaint is about the request-level `reasoning_effort`
    // knob — that one belongs to `is_thinking_param_error`, and answering it by dropping the replay would fix
    // nothing while costing the user their reasoning context.
    msg.contains("reasoning") && !msg.contains("reasoning_effort")
}

/// Does this failure mean *this model cannot accept images*, as opposed to *this request failed and happened
/// to be carrying images*?
///
/// Three gates, in this order and for these reasons:
///
///  1. **The status.** Only 400 / 415 / 422 — the codes that mean "I will not process this body as sent". 5xx
///     is the provider failing at its own end, and 408/409/413/429 are load, conflict and size, every one of
///     which a smaller retry "fixes" by being smaller. No status at all means the request never reached the
///     provider, and a retry succeeding after that says nothing whatever about the model.
///  2. **The provider named the image input.** Checked *before* the exclusions, and safe to now that the
///     status gate has removed the errors that merely quote a model's name: a 400 that says `image_url` is
///     telling us the answer even if the body also says "please try again".
///  3. **A client error that explains itself as something else.** Not a vision verdict.
///
/// Falling through all three is an unexplained rejection of the body we sent, and the images were the only
/// unusual thing in it.
pub fn is_vision_rejection(message: &str) -> bool {
    let msg = message.to_lowercase();
    if msg.is_empty() {
        return false;
    }
    let Some(status) = extract_status(&msg) else { return false };
    if status != 400 && status != 415 && status != 422 {
        return false;
    }
    if VISION_REJECTION_WORDS.iter().any(|w| msg.contains(w)) {
        return true;
    }
    if NOT_VISION_WORDS.iter().any(|w| msg.contains(w)) {
        return false;
    }
    true
}

/// The HTTP status in an error message.
///
/// Prefers our own `HTTP <status>` prefix; falls back to a bare 4xx/5xx anywhere in the text. The fallback is
/// restricted to 4xx/5xx so that a model name like `gpt-4o-2024-11-20` or a port number cannot pose as a
/// status — the reason the whole predicate is gated on this in the first place.
fn extract_status(msg: &str) -> Option<u16> {
    let bytes = msg.as_bytes();
    // `http <ddd>`
    if let Some(at) = msg.find("http ") {
        let rest = &msg[at + 5..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.len() == 3 {
            if let Ok(n) = digits.parse::<u16>() {
                return Some(n);
            }
        }
    }
    // A standalone 4xx/5xx: three digits with no digit on either side.
    for i in 0..bytes.len().saturating_sub(2) {
        if !(bytes[i] == b'4' || bytes[i] == b'5') {
            continue;
        }
        if !bytes[i + 1].is_ascii_digit() || !bytes[i + 2].is_ascii_digit() {
            continue;
        }
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
        let after_ok = i + 3 >= bytes.len() || !bytes[i + 3].is_ascii_digit();
        if before_ok && after_ok {
            return msg[i..i + 3].parse().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thinking_rejection_needs_both_a_400_and_one_of_our_own_field_names() {
        assert!(is_thinking_param_error("HTTP 400 — unknown parameter: reasoning_effort"));
        assert!(is_thinking_param_error("HTTP 400 — chat_template_kwargs is not supported"));
        // A 400 about something else must not retire the user's thinking setting.
        assert!(!is_thinking_param_error("HTTP 400 — messages[3] has no content"));
        // The right words, but the provider did not reject the request shape.
        assert!(!is_thinking_param_error("HTTP 500 — reasoning_effort"));
        assert!(!is_thinking_param_error("connection reset"));
    }

    #[test]
    fn a_replayed_thinking_block_rejection_is_told_apart_from_the_effort_knob() {
        assert!(is_reasoning_content_error("HTTP 400 — extra inputs are not permitted: reasoning_content"));
        assert!(is_reasoning_content_error("HTTP 400 — unknown field `reasoning`"));
        // `reasoning_effort` is the request-level knob, and dropping the REPLAY would not fix it.
        assert!(!is_reasoning_content_error("HTTP 400 — unsupported parameter: reasoning_effort"));
        assert!(!is_reasoning_content_error("HTTP 400 — bad request"));
    }

    #[test]
    fn a_vision_verdict_requires_a_status_that_means_the_body_was_refused() {
        assert!(is_vision_rejection("HTTP 400 — unknown variant `image_url`"));
        assert!(is_vision_rejection("HTTP 415 — image input is not supported"));
        assert!(is_vision_rejection("HTTP 422 — invalid_image"));
        // The provider's own failure, not a verdict on the model.
        assert!(!is_vision_rejection("HTTP 500 — image_url"));
        assert!(!is_vision_rejection("HTTP 503 — service unavailable"));
        // Size and load are "fixed" by a smaller retry and say nothing about image support.
        assert!(!is_vision_rejection("HTTP 413 — entity too large"));
        assert!(!is_vision_rejection("HTTP 429 — rate limit exceeded"));
    }

    /// The failure this gate exists to prevent: a model permanently marked image-blind by a transient error.
    #[test]
    fn a_failure_that_explains_itself_as_something_else_never_brands_the_model() {
        for msg in [
            "HTTP 400 — maximum context length is 128000 tokens",
            "HTTP 400 — please reduce the length of the messages",
            "HTTP 400 — insufficient balance",
            "HTTP 400 — please try again later",
            "HTTP 400 — request timeout",
        ] {
            assert!(!is_vision_rejection(msg), "{msg} must not brand the model as image-blind");
        }
    }

    /// Gate 2 before gate 3: a provider that names the image input is telling us the answer, even when the
    /// body also carries a phrase from the exclusion list.
    #[test]
    fn naming_the_image_input_outranks_a_soothing_phrase_in_the_same_body() {
        assert!(is_vision_rejection("HTTP 400 — invalid_image_url; please try again"));
    }

    #[test]
    fn an_unexplained_refusal_of_the_body_is_treated_as_a_vision_rejection() {
        // Nothing in the text explains the failure, and the images were the only unusual thing in the body.
        assert!(is_vision_rejection("HTTP 400 — bad request"));
    }

    /// No status means the request never reached the provider.
    #[test]
    fn a_transport_failure_is_never_a_verdict_about_the_model() {
        for msg in ["fetch failed", "socket hang up", "aborted", ""] {
            assert!(!is_vision_rejection(msg), "{msg:?} reached no provider");
        }
    }

    /// The reason the status gate is a gate: a model name full of digits must not pose as one.
    #[test]
    fn a_model_name_containing_digits_is_not_read_as_a_status() {
        assert_eq!(extract_status("model gpt-4o-2024-11-20 is unavailable"), None);
        assert_eq!(extract_status("http 400 — nope"), Some(400));
        assert_eq!(extract_status("returned 422 unprocessable"), Some(422));
        // Four digits in a row is a year or an id, not a status.
        assert_eq!(extract_status("at 40000 tokens"), None);
    }
}
