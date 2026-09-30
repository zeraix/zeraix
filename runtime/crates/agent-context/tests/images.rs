//! An image in the conversation must cost what an image costs — not what its base64 weighs.
//!
//! A local model is sent images inline, as data URIs. When those were counted as text, one screenshot put a
//! 32K window over budget on every round; the image itself cannot be compressed, so the elision step stubbed
//! every tool result instead — including the one the model had just asked for. It never saw an answer, asked
//! again, and the turn ended in a doom loop.

use agent_context::{Budget, ContextManager};
use agent_loop::model::call;
use agent_loop::{ContextStrategy, Message};
use serde_json::json;

fn screenshot(base64_len: usize) -> Message {
    Message::parts(
        "user",
        vec![
            json!({ "type": "text", "text": "What is in this screenshot? Then read src/main.rs" }),
            json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", "A".repeat(base64_len)) } }),
        ],
    )
}

#[tokio::test]
async fn a_large_inline_image_leaves_the_fresh_tool_result_readable() {
    let result = "fn main() { println!(\"hello\"); }\n".repeat(20);
    let conversation = vec![
        Message::system("You are helpful."),
        // About 220 KB: a full-screen PNG.
        screenshot(300_000),
        Message::assistant_calls("Reading the file first.", vec![call("c1", "read_file", json!({ "path": "src/main.rs" }))]),
        Message::tool_result("c1", result.clone()),
    ];

    let mut manager = ContextManager::new(Budget::with_window(32_768));
    let (prepared, compacted) = manager.prepare(&conversation).await;

    assert!(!compacted, "one screenshot and one small file are nowhere near a 32K window");
    let tool = prepared.iter().find(|m| m.role == "tool").expect("the tool result");
    assert_eq!(tool.text(), result, "the result the model asked for must reach it");
}

#[tokio::test]
async fn a_phone_photo_does_not_fill_a_128k_window_either() {
    let conversation = vec![
        Message::user("start"),
        // About 2 MB of base64.
        screenshot(2_700_000),
        Message::assistant_calls("", vec![call("c1", "list_directory", json!({ "path": "." }))]),
        Message::tool_result("c1", "a.txt\nb.txt"),
    ];
    let mut manager = ContextManager::new(Budget::with_window(131_072));
    let (prepared, compacted) = manager.prepare(&conversation).await;
    assert!(!compacted);
    assert_eq!(prepared.last().expect("the result").text(), "a.txt\nb.txt");
}
