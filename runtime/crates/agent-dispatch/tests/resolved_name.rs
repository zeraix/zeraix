//! `resolved_name`: the name a call will run as, read before it runs.
//!
//! The loop batches calls on this name. The chat reaches its reads through the `call_tool` dispatcher, so a
//! resolver that answered with the wrapper's name made every batch of reads run one at a time.

use agent_dispatch::resolved_name;
use serde_json::json;

#[test]
fn a_call_that_is_not_routed_is_its_own_name() {
    assert_eq!(resolved_name("read_file", r#"{"path":"a"}"#), "read_file");
    // Its arguments are not even read: unreadable ones are the tool's own problem to report.
    assert_eq!(resolved_name("write_file", "{not json"), "write_file");
}

#[test]
fn a_routed_call_is_the_tool_it_routes_to_in_every_shape_models_send() {
    let envelope = json!({ "name": "read_file", "arguments": { "path": "a" } }).to_string();
    let stringified = json!({ "name": "search_files", "arguments": "{\"pattern\":\"*.ts\"}" }).to_string();
    let flattened = json!({ "name": "list_directory", "path": "." }).to_string();
    assert_eq!(resolved_name("call_tool", &envelope), "read_file");
    assert_eq!(resolved_name("call_tool", &stringified), "search_files");
    assert_eq!(resolved_name("call_tool", &flattened), "list_directory");
}

#[test]
fn an_envelope_that_cannot_be_read_keeps_the_dispatchers_name() {
    // It fails without running, so it must not be batched as the read it was reaching for.
    assert_eq!(resolved_name("call_tool", r#"{"name":"read_file","arguments":{"pa"#), "call_tool");
    assert_eq!(resolved_name("call_tool", r#"{"arguments":{}}"#), "call_tool", "an envelope naming nothing");
}
