//! Resolving what the model emitted into the call to actually run.
//!
//! Ported from `src/lib/ai/toolRouter.ts`.
//!
//! Most tools are not declared to the model. They are reached through one dispatcher — `call_tool` — because
//! declaring them all would put every schema in the prompt prefix, and a prefix that changes invalidates the
//! provider's cache from token 0. MCP and plugin tools make that worse than the token count suggests: they
//! differ per user and can change *mid-conversation*, so every change re-prefilled the whole request.
//!
//! The cost of that saving is this module. A model reaching for a routed tool has to wrap it, and models wrap
//! it in several shapes — so unwrapping is a small pile of tolerances rather than one rule.
//!
//! ## Total by construction
//!
//! [`resolve_tool_call`] never fails. A malformed wrapper resolves to itself and falls through to the
//! registry, which already answers an unknown name cleanly. The alternative — an error channel here as well as
//! at execution — is a dispatch path with two ways to say the same thing and two places to keep them
//! consistent.

use serde_json::{Map, Value};

/// The dispatcher every routed tool arrives through.
pub const DISPATCHER_NAME: &str = "call_tool";

/// Prefixes whose tools are supplied by the user's own environment rather than by this build.
pub const MCP_TOOL_PREFIX: &str = "mcp__";
pub const PLUGIN_TOOL_PREFIX: &str = "plugin__";

pub fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_TOOL_PREFIX)
}

pub fn is_plugin_tool_name(name: &str) -> bool {
    name.starts_with(PLUGIN_TOOL_PREFIX)
}

/// One resolved call: the tool to run and the arguments to run it with.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedCall {
    pub name: String,
    pub args: Map<String, Value>,
}

/// Resolve a `call_tool` wrapper into the call it names. Anything else passes through untouched.
///
/// A **declared** tool's name arriving through `call_tool` resolves normally rather than erroring. Models do
/// this — the catalog lists every tool, so one that reads the catalog and ignores which entries also have
/// schemas is behaving reasonably, and there is nothing to gain by refusing it.
pub fn resolve_tool_call(name: &str, args: Map<String, Value>) -> ResolvedCall {
    if name != DISPATCHER_NAME {
        return ResolvedCall { name: name.to_owned(), args };
    }
    let inner = args.get("name").and_then(Value::as_str).unwrap_or("").trim().to_owned();
    if inner.is_empty() {
        return ResolvedCall { name: name.to_owned(), args };
    }

    // Flattened: `call_tool{name, …the inner tool's own parameters}`, with no envelope at all.
    //
    // The last resort for every branch below, because it is what a model produces when it treats the wrapper
    // as ceremony — common, and commonest on exactly the large nested payloads (a `spawn_subagents` batch)
    // where losing the arguments hurts most. Reading the siblings is unambiguous; discarding them produced the
    // WRAPPED tool complaining that a required parameter was missing, against arguments the model can see
    // itself having sent.
    let siblings: Map<String, Value> =
        args.iter().filter(|(k, _)| *k != "name" && *k != "arguments").map(|(k, v)| (k.clone(), v.clone())).collect();
    let fallback = || ResolvedCall { name: inner.clone(), args: siblings.clone() };

    match args.get("arguments") {
        // A JSON string is tolerated because models emit both: the declared shape is an object, but rejecting
        // the string would cost a whole round trip to correct something we can simply read.
        Some(Value::String(raw)) => {
            let text = if raw.trim().is_empty() { "{}" } else { raw.as_str() };
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(map)) => ResolvedCall { name: inner, args: map },
                // Not a readable object: fall through, and the tool reports what it actually needs.
                _ => fallback(),
            }
        }
        Some(Value::Object(map)) => ResolvedCall { name: inner, args: map.clone() },
        _ => fallback(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().cloned().expect("an object")
    }

    #[test]
    fn a_call_that_is_not_dispatched_passes_through_untouched() {
        let r = resolve_tool_call("read_file", obj(json!({"path": "a.ts"})));
        assert_eq!(r.name, "read_file");
        assert_eq!(Value::Object(r.args), json!({"path": "a.ts"}));
    }

    #[test]
    fn a_wrapped_call_resolves_to_its_inner_name_and_arguments() {
        let r = resolve_tool_call(
            DISPATCHER_NAME,
            obj(json!({"name": "search_files", "arguments": {"query": "todo"}})),
        );
        assert_eq!(r.name, "search_files");
        assert_eq!(Value::Object(r.args), json!({"query": "todo"}));
    }

    #[test]
    fn an_envelope_sent_as_a_json_string_is_read_rather_than_refused() {
        let r = resolve_tool_call(
            DISPATCHER_NAME,
            obj(json!({"name": "search_files", "arguments": "{\"query\":\"todo\"}"})),
        );
        assert_eq!(r.name, "search_files");
        assert_eq!(Value::Object(r.args), json!({"query": "todo"}));
    }

    /// The shape that used to lose the arguments entirely.
    #[test]
    fn a_flattened_call_keeps_the_parameters_that_sit_beside_the_name() {
        let r = resolve_tool_call(
            DISPATCHER_NAME,
            obj(json!({"name": "spawn_subagents", "tasks": [{"agent": "reviewer", "task": "look"}]})),
        );
        assert_eq!(r.name, "spawn_subagents");
        assert_eq!(r.args["tasks"][0]["agent"], "reviewer");
    }

    #[test]
    fn an_explicit_envelope_wins_over_the_flattened_reading() {
        let r = resolve_tool_call(
            DISPATCHER_NAME,
            obj(json!({"name": "t", "arguments": {"from": "envelope"}, "from": "siblings"})),
        );
        assert_eq!(Value::Object(r.args), json!({"from": "envelope"}));
    }

    #[test]
    fn an_unreadable_envelope_falls_back_to_the_siblings_rather_than_to_nothing() {
        let r = resolve_tool_call(
            DISPATCHER_NAME,
            obj(json!({"name": "t", "arguments": "not json at all", "path": "a.ts"})),
        );
        assert_eq!(r.name, "t");
        assert_eq!(Value::Object(r.args), json!({"path": "a.ts"}));
    }

    #[test]
    fn an_empty_envelope_string_is_a_no_argument_call() {
        let r = resolve_tool_call(DISPATCHER_NAME, obj(json!({"name": "t", "arguments": ""})));
        assert_eq!(r.name, "t");
        assert!(r.args.is_empty());
    }

    /// A malformed wrapper resolves to itself, so the registry answers it with its own clean message.
    #[test]
    fn a_dispatcher_call_with_no_inner_name_resolves_to_itself() {
        for args in [json!({}), json!({"name": ""}), json!({"name": "   "}), json!({"name": 42})] {
            let r = resolve_tool_call(DISPATCHER_NAME, obj(args.clone()));
            assert_eq!(r.name, DISPATCHER_NAME, "{args}");
        }
    }

    #[test]
    fn an_envelope_that_is_an_array_falls_back_rather_than_being_coerced() {
        let r = resolve_tool_call(DISPATCHER_NAME, obj(json!({"name": "t", "arguments": [1, 2]})));
        assert_eq!(r.name, "t");
        assert!(r.args.is_empty());
    }

    #[test]
    fn user_supplied_tool_names_are_recognised_by_prefix() {
        assert!(is_mcp_tool_name("mcp__blender__render"));
        assert!(is_plugin_tool_name("plugin__gmail__send"));
        assert!(!is_mcp_tool_name("read_file"));
        assert!(!is_plugin_tool_name("mcp__x__y"));
    }
}
