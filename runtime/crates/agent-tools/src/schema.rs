//! JSON Schema validation for tool arguments (spec §7: "Schema Validation").
//!
//! ## Why this warns instead of rejecting
//!
//! The obvious design is to validate strictly and refuse anything that does not match. It would also
//! break Stage 1 on day one. The JS handlers being replaced are *lenient* in ways their schemas do not
//! describe: `read_file` coerces `offset: "3"` through `Number()`, `search_files` runs
//! `String(pattern)` so a missing argument searches for a file named `undefined`, and models rely on
//! both without anyone having decided they should. Enforcing the declared schema would turn calls that
//! work today into failures, and it would do it silently at the moment the feature flag flipped —
//! which is exactly the class of change the A/B harness exists to prevent.
//!
//! So validation runs in `Warn` mode by default: every mismatch is recorded through `tracing`, nothing
//! is rejected, and the result is *evidence* about what models actually send. `Enforce` exists and
//! works; turning it on is a deliberate, separate decision that should be made per tool once the
//! warning stream shows what it would break.
//!
//! ## Scope
//!
//! A deliberate subset of JSON Schema: `type`, `required`, `properties`, `enum`, and numeric bounds.
//! That is everything the 26 tool schemas actually use. A full validator would be a dependency and a
//! surface area, and neither buys anything the tools declare.

use serde_json::Value;

/// What the registry does with a validation failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ValidationMode {
    /// Do not validate at all.
    Off,
    /// Log mismatches, run the tool anyway. The default, and the only mode Stage 1 uses.
    #[default]
    Warn,
    /// Reject mismatching arguments before the tool runs.
    Enforce,
}

/// One thing wrong with the arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    /// Dotted path to the offending value, e.g. `path` or `tasks[0].agent`.
    pub pointer: String,
    pub message: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.pointer, self.message)
    }
}

/// Check `args` against `schema`. An empty result means valid.
pub fn validate(schema: &Value, args: &Value) -> Vec<Violation> {
    let mut out = Vec::new();
    check(schema, args, "", &mut out);
    out
}

fn check(schema: &Value, value: &Value, pointer: &str, out: &mut Vec<Violation>) {
    let Some(obj) = schema.as_object() else { return };

    if let Some(expected) = obj.get("type").and_then(Value::as_str)
        && !type_matches(expected, value)
    {
        out.push(Violation {
            pointer: label(pointer),
            message: format!("expected {expected}, got {}", type_of(value)),
        });
        // Reporting nested problems against a value of the wrong type produces noise, not information.
        return;
    }

    if let Some(allowed) = obj.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        out.push(Violation {
            pointer: label(pointer),
            message: format!("value is not one of the {} permitted options", allowed.len()),
        });
    }

    if let Some(n) = value.as_f64() {
        if let Some(min) = obj.get("minimum").and_then(Value::as_f64)
            && n < min
        {
            out.push(Violation { pointer: label(pointer), message: format!("must be >= {min}") });
        }
        if let Some(max) = obj.get("maximum").and_then(Value::as_f64)
            && n > max
        {
            out.push(Violation { pointer: label(pointer), message: format!("must be <= {max}") });
        }
    }

    if let Some(required) = obj.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            // Present-but-null counts as absent: a model that emits `{"path": null}` has not supplied
            // a path, and reporting it as present would hide the real problem.
            let missing = value.get(key).is_none_or(Value::is_null);
            if missing {
                out.push(Violation {
                    pointer: join(pointer, key),
                    message: "required argument is missing".to_owned(),
                });
            }
        }
    }

    if let (Some(props), Some(map)) = (obj.get("properties").and_then(Value::as_object), value.as_object()) {
        for (key, sub_schema) in props {
            if let Some(sub) = map.get(key).filter(|v| !v.is_null()) {
                check(sub_schema, sub, &join(pointer, key), out);
            }
        }
    }

    if let (Some(items), Some(arr)) = (obj.get("items"), value.as_array()) {
        for (i, item) in arr.iter().enumerate() {
            check(items, item, &format!("{pointer}[{i}]"), out);
        }
    }
}

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        // JSON Schema's `integer` admits 3.0; `as_i64` would reject it, so test the value not the repr.
        "integer" => value.as_f64().is_some_and(|f| f.fract() == 0.0),
        "number" => value.is_number(),
        "null" => value.is_null(),
        _ => true, // unknown type keyword: not this validator's business
    }
}

fn type_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn label(pointer: &str) -> String {
    if pointer.is_empty() { "(arguments)".to_owned() } else { pointer.to_owned() }
}

fn join(pointer: &str, key: &str) -> String {
    if pointer.is_empty() { key.to_owned() } else { format!("{pointer}.{key}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_file_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "offset": { "type": "number" },
                "limit": { "type": "number" }
            },
            "required": ["path"]
        })
    }

    #[test]
    fn valid_arguments_produce_no_violations() {
        assert!(validate(&read_file_schema(), &json!({ "path": "a.txt", "offset": 3 })).is_empty());
    }

    #[test]
    fn a_missing_required_argument_is_reported() {
        let v = validate(&read_file_schema(), &json!({ "offset": 3 }));
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].pointer, "path");
    }

    #[test]
    fn null_counts_as_missing() {
        let v = validate(&read_file_schema(), &json!({ "path": null }));
        assert_eq!(v.len(), 1, "present-but-null must not pass as supplied");
    }

    #[test]
    fn the_lenient_case_is_still_a_violation_even_though_it_is_tolerated() {
        // This is exactly what Warn mode exists to surface: the JS handler coerces "3" via Number()
        // and succeeds, so the call must NOT be rejected — but it is still a schema mismatch, and the
        // point is to find out how often models actually do it.
        let v = validate(&read_file_schema(), &json!({ "path": "a.txt", "offset": "3" }));
        assert_eq!(v.len(), 1);
        assert!(v[0].message.contains("expected number"));
    }

    #[test]
    fn wrong_type_suppresses_nested_noise() {
        let schema = json!({
            "type": "object",
            "properties": { "inner": { "type": "object", "required": ["x"] } }
        });
        let v = validate(&schema, &json!({ "inner": "not an object" }));
        // One clear error, not a cascade about the fields a string does not have.
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn enum_and_bounds_are_checked() {
        let schema = json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "enum": ["explore", "coder"] },
                "context": { "type": "number", "minimum": 0, "maximum": 5 }
            }
        });
        assert!(validate(&schema, &json!({ "agent": "coder", "context": 3 })).is_empty());
        assert_eq!(validate(&schema, &json!({ "agent": "nope" })).len(), 1);
        assert_eq!(validate(&schema, &json!({ "context": 9 })).len(), 1);
    }

    #[test]
    fn array_items_are_validated_with_indexed_paths() {
        let schema = json!({
            "type": "object",
            "properties": {
                "tasks": { "type": "array", "items": { "type": "object", "required": ["agent"] } }
            }
        });
        let v = validate(&schema, &json!({ "tasks": [{ "agent": "a" }, {}] }));
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].pointer, "tasks[1].agent");
    }

    #[test]
    fn integer_admits_a_whole_float() {
        let schema = json!({ "type": "object", "properties": { "n": { "type": "integer" } } });
        assert!(validate(&schema, &json!({ "n": 3.0 })).is_empty());
        assert_eq!(validate(&schema, &json!({ "n": 3.5 })).len(), 1);
    }
}
