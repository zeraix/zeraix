//! Tests for `estimate.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;
use serde_json::json;

#[test]
fn english_and_code_keep_four_characters_a_token() {
    assert_eq!(estimate(&"a".repeat(400)), 100);
}

#[test]
fn a_cjk_character_is_about_a_token_not_a_quarter_of_one() {
    assert_eq!(estimate(&"你".repeat(400)), 400);
    assert_eq!(estimate(&"こんにちは".repeat(10)), 50);
    // Mixed text is the sum of its parts.
    assert_eq!(estimate(&format!("{}{}", "a".repeat(40), "好".repeat(10))), 20);
}

#[test]
fn an_image_costs_a_flat_amount_whatever_its_encoding_weighs() {
    let small = Message::parts(
        "user",
        vec![json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } })],
    );
    let screenshot = Message::parts(
        "user",
        vec![
            json!({ "type": "text", "text": "a".repeat(40) }),
            json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", "A".repeat(300_000)) } }),
        ],
    );
    assert_eq!(estimate_message(&small), 4 + IMAGE_TOKENS);
    assert_eq!(estimate_message(&screenshot), 4 + 10 + IMAGE_TOKENS);
}

#[test]
fn trimming_keeps_the_same_number_of_tokens_in_any_script() {
    let english = truncate_to(&"a".repeat(1000), 50);
    let chinese = truncate_to(&"好".repeat(1000), 50);
    assert_eq!(english.strip_suffix(TRUNCATED).expect("marked").len(), 200);
    assert_eq!(chinese.strip_suffix(TRUNCATED).expect("marked").chars().count(), 50);
    assert_eq!(truncate_to("short", 50), "short", "a text within the allowance is untouched");
    assert_eq!(truncate_to("short", u64::MAX), "short");
}
