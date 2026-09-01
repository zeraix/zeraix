//! Reading the `arguments` a model emitted for a tool call.
//!
//! Ported from `src/lib/ai/toolArgs.ts`, and the reason that module exists is worth restating because it is
//! the whole specification for this one.
//!
//! Every provider hands tool arguments over as a **string** that is supposed to be JSON, and models get that
//! string wrong in a small number of recurring ways. The old reading of it was `JSON.parse` inside a `try`
//! whose `catch` produced `{}` — which turned every one of those failures into the same lie: the call ran with
//! no arguments at all, and the tool then complained about a missing parameter the model is looking at in its
//! own transcript. `spawn_subagents` showed it worst, because its payload is the largest and most nested one
//! on the wire: a batch of long task descriptions would come back "tasks must be a non-empty array", the model
//! would conclude the array shape was wrong, and it would fall back to one blocking delegation at a time —
//! the exact concurrency the tool exists to provide, lost to a parse error nobody was told about.
//!
//! So this module does two things the `catch {}` could not:
//!
//!  - **Recovers what is recoverable.** Fenced JSON, a doubly-encoded string, a trailing remark, and a payload
//!    truncated mid-value are all read rather than discarded.
//!  - **Reports what is not.** A genuinely unreadable payload produces an error the model can act on — that
//!    the call did not run, that its JSON was cut short, and which keys did arrive — instead of a schema
//!    complaint about arguments it did send.
//!
//! **Truncated payloads are deliberately not executed.** A repaired object is used only to *describe* the
//! failure. Running a delegation whose task text was cut in half is worse than telling the model to send it
//! again, because the sub-agent would work for minutes on half a brief and report a confident answer to the
//! wrong question.

use serde_json::{Map, Value};

/// The outcome of reading one call's `arguments` string.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedArgs {
    Ok(Map<String, Value>),
    /// Unreadable. `partial` is what a truncated payload was carrying before it stopped — used to describe the
    /// failure, never to run it.
    Failed { error: String, partial: Option<Map<String, Value>> },
}

impl ParsedArgs {
    pub fn is_ok(&self) -> bool {
        matches!(self, ParsedArgs::Ok(_))
    }

    pub fn args(&self) -> Option<&Map<String, Value>> {
        match self {
            ParsedArgs::Ok(map) => Some(map),
            ParsedArgs::Failed { .. } => None,
        }
    }
}

/// How a model spells "this tool takes no arguments" when it does not simply send `{}`.
///
/// Tolerated because the old `catch → {}` tolerated it, and a no-argument tool is exactly where a model is
/// most likely to write something that is not JSON at all. Failing these would trade one class of wasted round
/// trip for another.
const EMPTY_SPELLINGS: [&str; 10] =
    ["null", "undefined", "none", "nil", "nan", "{}", "()", "[]", "\"\"", "''"];

/// Read one tool call's `arguments` string.
///
/// Total on the happy path and on every recoverable near-miss; the error branch is reserved for a payload that
/// carries no usable object at all. An empty string is a legitimate no-argument call, not a failure.
pub fn parse_tool_arguments(raw: &str) -> ParsedArgs {
    let text = raw.trim();
    if text.is_empty() || EMPTY_SPELLINGS.contains(&text.to_lowercase().as_str()) {
        return ParsedArgs::Ok(Map::new());
    }

    let unfenced = strip_fence(text);
    let embedded = first_object(unfenced);
    let direct = try_json(text)
        .or_else(|| try_json(unfenced))
        .or_else(|| embedded.and_then(try_json));

    if let Some(value) = direct {
        match value {
            Value::Object(map) => return ParsedArgs::Ok(map),
            // `null` is how some providers spell "no arguments".
            Value::Null => return ParsedArgs::Ok(Map::new()),
            // A doubly-encoded object is a common near-miss worth unwrapping once.
            Value::String(inner) => {
                let inner = inner.trim();
                if inner.is_empty() {
                    return ParsedArgs::Ok(Map::new());
                }
                if let Some(Value::Object(map)) = try_json(inner) {
                    return ParsedArgs::Ok(map);
                }
                return ParsedArgs::Failed { error: bare_value_error("string"), partial: None };
            }
            other => {
                let shape = if other.is_array() { "array" } else { type_name(&other) };
                return ParsedArgs::Failed { error: bare_value_error(shape), partial: None };
            }
        }
    }

    let recovered = repair_truncated(unfenced);
    let partial = match &recovered {
        Some(Value::Object(map)) => Some(map.clone()),
        _ => None,
    };
    ParsedArgs::Failed { error: unreadable(text, recovered.is_some(), partial.as_ref()), partial }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn try_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// ```` ```json … ``` ```` around the payload. Small models wrap tool arguments the way they wrap code blocks.
fn strip_fence(text: &str) -> &str {
    let t = text.trim();
    if !t.starts_with("```") || !t.ends_with("```") || t.len() < 6 {
        return text;
    }
    let inner = &t[3..t.len() - 3];
    // Drop an optional language tag on the opening line.
    match inner.find('\n') {
        Some(nl) if inner[..nl].chars().all(|c| c.is_ascii_alphanumeric()) => inner[nl + 1..].trim(),
        _ => inner.trim(),
    }
}

/// The first complete JSON object in a payload that carries more than JSON.
///
/// Models append a sentence to the arguments the way they annotate a code block ("{…} — I have used the narrow
/// set here"), and a payload that is entirely valid up to a trailing remark is one a plain parse throws away
/// whole. Scanned with string awareness so a brace inside a task description cannot end the object early.
fn first_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for i in start..bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Close a JSON payload that simply stops.
///
/// Walks the text once tracking string/escape state and the open-bracket stack, then completes it: terminate
/// an unfinished string, drop a dangling separator, and close every container left open. Several endings are
/// ambiguous (a cut key, a key with no value yet), so the completions are tried in order of likelihood and the
/// first that parses wins.
fn repair_truncated(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut closers: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for &c in bytes {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' => closers.push('}'),
            b'[' => closers.push(']'),
            b'}' | b']' => {
                closers.pop();
            }
            _ => {}
        }
    }
    if closers.is_empty() && !in_string {
        // Not a truncation: something else is malformed, and guessing at it would invent content.
        return None;
    }

    let mut head = if escaped { text[..text.len() - 1].to_owned() } else { text.to_owned() };
    if in_string {
        head.push('"');
    }
    let tail: String = closers.iter().rev().collect();

    // Ordered by how a cut usually lands: mid-value, right after a comma, on a key with no value.
    let trimmed_comma = head.trim_end().trim_end_matches(',').to_owned();
    let mut candidates = vec![head.clone(), trimmed_comma];
    let t = head.trim_end();
    if t.ends_with(':') {
        candidates.push(format!("{head} null"));
    }
    if t.ends_with('"') {
        candidates.push(format!("{head}: null"));
    }
    for candidate in candidates {
        if let Some(v) = try_json(&format!("{candidate}{tail}")) {
            return Some(v);
        }
    }
    None
}

fn bare_value_error(shape: &str) -> String {
    format!(
        "Tool arguments must be a JSON OBJECT of named parameters, but this call sent a bare {shape}, so \
         nothing ran. Wrap it in the parameter the tool declares — e.g. {{\"tasks\": [ … ]}} rather than [ … ]."
    )
}

/// What the model is told when its arguments could not be read.
///
/// Says the call did not run, and why, and what to do about it — deliberately not a complaint about the
/// parameters it chose, because that is the message that once sent models correcting a correct shape.
fn unreadable(text: &str, was_truncated: bool, partial: Option<&Map<String, Value>>) -> String {
    let received = match partial {
        Some(map) if !map.is_empty() => {
            format!(" The keys that did arrive: {}.", map.keys().cloned().collect::<Vec<_>>().join(", "))
        }
        _ => String::new(),
    };
    let cause = if was_truncated {
        format!(
            "The payload stopped after {} characters, mid-value, which is what a response cut off at its \
             token limit looks like.",
            text.chars().count()
        )
    } else {
        format!(
            "The payload ({} characters) is not parseable JSON — check for an unescaped quote, a stray \
             newline inside a string, or a trailing comma.",
            text.chars().count()
        )
    };
    format!(
        "The arguments for this call were not valid JSON, so NOTHING RAN — this is not a complaint about the \
         parameters you chose. {cause}{received} Send the same call again with shorter argument text (split \
         one long call into several smaller ones rather than trimming what the tool needs to know)."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(raw: &str) -> Map<String, Value> {
        match parse_tool_arguments(raw) {
            ParsedArgs::Ok(map) => map,
            ParsedArgs::Failed { error, .. } => panic!("expected readable arguments, got: {error}"),
        }
    }

    fn failed(raw: &str) -> (String, Option<Map<String, Value>>) {
        match parse_tool_arguments(raw) {
            ParsedArgs::Ok(map) => panic!("expected a failure, got: {map:?}"),
            ParsedArgs::Failed { error, partial } => (error, partial),
        }
    }

    #[test]
    fn ordinary_arguments_parse_and_an_absent_payload_is_a_no_argument_call() {
        assert_eq!(Value::Object(ok(r#"{"a":1}"#)), json!({"a": 1}));
        assert!(ok("").is_empty());
        assert!(ok("null").is_empty());
        assert!(ok("{}").is_empty());
    }

    #[test]
    fn a_fenced_or_doubly_encoded_payload_is_read_rather_than_discarded() {
        assert_eq!(Value::Object(ok("```json\n{\"a\":1}\n```")), json!({"a": 1}));
        assert_eq!(Value::Object(ok(&serde_json::to_string(r#"{"a":1}"#).unwrap())), json!({"a": 1}));
    }

    #[test]
    fn an_object_with_a_remark_after_it_is_read_and_a_brace_in_a_string_does_not_end_it_early() {
        assert_eq!(Value::Object(ok(r#"{"a":1} — narrow set, as asked"#)), json!({"a": 1}));
        assert_eq!(
            Value::Object(ok(r#"{"task":"fix the `}` handling"} done"#)),
            json!({"task": "fix the `}` handling"})
        );
    }

    /// The failure that cost real concurrency, and the message that has to be right.
    #[test]
    fn a_truncated_payload_does_not_run_and_the_message_says_why_and_what_to_do() {
        let cut = r#"{"tasks":[{"agent":"reviewer","task":"Review every source file under src/ for arch"#;
        let (error, partial) = failed(cut);
        assert!(error.contains("NOTHING RAN"), "{error}");
        assert!(error.contains("token limit"), "{error}");
        assert!(error.contains("tasks"), "the keys that arrived must be named: {error}");
        // It must NOT read as a complaint about the arguments the model chose.
        assert!(!error.contains("must be a non-empty array"), "{error}");
        assert!(partial.is_some(), "a truncated payload should yield something to describe");
    }

    /// The repaired object exists to describe the failure, never to run it.
    #[test]
    fn a_truncated_payload_is_never_silently_completed_into_a_runnable_call() {
        let cut = r#"{"tasks":[{"agent":"reviewer","task":"half a brief"#;
        assert!(!parse_tool_arguments(cut).is_ok());
        assert!(parse_tool_arguments(cut).args().is_none());
    }

    #[test]
    fn a_bare_array_is_refused_with_the_wrapper_it_needs_not_a_parse_error() {
        let (error, _) = failed("[1,2,3]");
        assert!(error.contains("JSON OBJECT"), "{error}");
        assert!(error.contains("bare array"), "{error}");
    }

    #[test]
    fn a_bare_scalar_is_refused_by_shape() {
        for (raw, shape) in [("42", "number"), ("true", "boolean")] {
            let (error, _) = failed(raw);
            assert!(error.contains(shape), "{raw} → {error}");
        }
    }

    /// Not a truncation, so nothing is invented — the message names the likely causes instead.
    #[test]
    fn a_payload_that_is_malformed_rather_than_cut_short_says_so() {
        let (error, partial) = failed(r#"{"a": 1,, "b": 2}"#);
        assert!(error.contains("not parseable JSON"), "{error}");
        assert!(!error.contains("token limit"), "{error}");
        assert_eq!(partial, None);
    }

    #[test]
    fn a_cut_that_lands_on_a_key_with_no_value_is_still_described() {
        let (error, partial) = failed(r#"{"tasks":[{"agent":"reviewer","#);
        assert!(error.contains("NOTHING RAN"));
        assert!(partial.expect("a partial").contains_key("tasks"));
    }

    #[test]
    fn an_escaped_quote_inside_a_truncated_string_does_not_confuse_the_repair() {
        let cut = r#"{"task":"he said \"go\" and then"#;
        let (_, partial) = failed(cut);
        assert!(partial.is_some(), "the repair should still close this");
    }
}
