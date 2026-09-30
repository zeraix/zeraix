//! Token estimates: how compaction decides *when* to act, and how much of a message to keep when it does.
//!
//! An estimate, not a tokenizer — nobody is billed from it. What it must not do is be wrong by a factor, in
//! either direction, because both directions have failed in practice:
//!
//! - **Under.** A flat four characters a token counts Chinese at a quarter of its cost; a CJK character is about
//!   one token on its own. A turn that read large Chinese documents overflowed the real window while the
//!   estimate still said it had room, and the provider's context-length 400 ended the run instead of compaction
//!   saving it.
//! - **Over.** An image part was estimated from its JSON — the base64 data URI a local model is sent. A 220 KB
//!   screenshot came out at about 75,000 "tokens", so a 32K window was over budget on every round, the image
//!   could not be compressed, and the elision step stubbed every tool result instead: the model only ever saw
//!   `[tool output removed…]`, asked again, and looped.

use agent_loop::Message;
use serde_json::Value;

use crate::TRUNCATED;

/// Estimated tokens for one image part.
///
/// What a provider actually charges depends on the model and the image — OpenAI's high detail is 765 for a
/// 1024 px square, Qwen-VL's default cap is about 1,280 — so this is a round figure in that range. It is
/// deliberately NOT derived from the part's size: that measures the encoding, not the cost.
pub const IMAGE_TOKENS: u64 = 1_000;

/// What one character costs, in quarter-tokens.
///
/// Three bands, because the tokenizers providers use fall into roughly three: ASCII — English and code — at
/// about four characters a token; the other alphabetic scripts (accented Latin, Greek, Cyrillic, Arabic,
/// Hebrew…) at about two; and everything from the CJK radicals up (CJK, kana, Hangul, fullwidth forms,
/// emoji) at one or more. Erring high in the last two is the safe side: it only makes compaction a little eager.
fn quarter_tokens(c: char) -> u64 {
    if c.is_ascii() {
        1
    } else if (c as u32) < 0x2E80 {
        2
    } else {
        4
    }
}

/// Estimated tokens for a string.
pub fn estimate(text: &str) -> u64 {
    if text.is_ascii() {
        return text.len() as u64 / 4;
    }
    text.chars().map(quarter_tokens).sum::<u64>() / 4
}

/// Estimated tokens for a message, including the per-message overhead a provider charges for role and
/// separators.
pub fn estimate_message(m: &Message) -> u64 {
    let content = match &m.content {
        Value::String(s) => estimate(s),
        Value::Array(parts) => parts.iter().map(estimate_part).sum(),
        Value::Null => 0,
        other => estimate(&other.to_string()),
    };
    let calls: u64 = m.tool_calls.iter().map(|c| estimate(&c.name) + estimate(&c.arguments)).sum();
    let reasoning = m.reasoning_content.as_deref().map(estimate).unwrap_or(0);
    4 + content + calls + reasoning
}

/// One typed part of an array `content`: its text, or the flat cost of an image.
fn estimate_part(part: &Value) -> u64 {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => part.get("text").and_then(Value::as_str).map_or(0, estimate),
        Some("image_url" | "input_image" | "image") => IMAGE_TOKENS,
        _ => estimate(&part.to_string()),
    }
}

/// Trim to roughly `tokens`, keeping the head and marking the cut.
///
/// The head rather than the tail: the opening of a message is where its subject is, and a fragment that starts
/// mid-sentence is harder to use than one that stops mid-sentence. Measured with the same per-character costs
/// as [`estimate`], so a trimmed Chinese message is as long, in tokens, as a trimmed English one.
pub(crate) fn truncate_to(text: &str, tokens: u64) -> String {
    let budget = tokens.saturating_mul(4);
    let mut spent = 0;
    for (at, c) in text.char_indices() {
        spent += quarter_tokens(c);
        if spent > budget {
            return format!("{}{TRUNCATED}", &text[..at]);
        }
    }
    text.to_owned()
}

#[cfg(test)]
#[path = "estimate_tests.rs"]
mod tests;
