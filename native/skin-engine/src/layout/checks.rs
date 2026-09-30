//! Leaf checks on single values: ref syntax, composite / region / param names, prop keys and
//! values, plain CSS values, and the `{{param}}` placeholder scan run over composite templates.

use serde_json::{Map, Value};

use super::{FORBIDDEN_PROP_KEYS, LResult, LayoutValidationError, MAX_PROPS, MAX_STRING_LEN, REF_PREFIX_APP, REF_PREFIX_CUSTOM, REF_PREFIX_PRIMITIVE};

/* ------------------------------------------------------------------ small checks */

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
}

/// `prefix:key`, key being letters/digits/`_`/`-`/`.`, 1-64 characters.
pub fn split_ref(reference: &str) -> LResult<(&'static str, &str)> {
    let (prefix, key) = if let Some(k) = reference.strip_prefix(REF_PREFIX_APP) {
        (REF_PREFIX_APP, k)
    } else if let Some(k) = reference.strip_prefix(REF_PREFIX_PRIMITIVE) {
        (REF_PREFIX_PRIMITIVE, k)
    } else if let Some(k) = reference.strip_prefix(REF_PREFIX_CUSTOM) {
        (REF_PREFIX_CUSTOM, k)
    } else {
        return Err(LayoutValidationError::InvalidRef {
            reference: reference.to_string(),
            reason: "must start with app:, primitive: or custom:".into(),
        });
    };
    if key.is_empty() || key.len() > 64 || !key.chars().all(is_ident_char) {
        return Err(LayoutValidationError::InvalidRef {
            reference: reference.to_string(),
            reason: "the key must be 1-64 letters, digits, '_', '-' or '.'".into(),
        });
    }
    Ok((prefix, key))
}

/// Composite and region names. The three prototype names are refused although they fit the
/// charset: in the renderer they would land on Object.prototype instead of in the map.
pub fn is_composite_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !matches!(name, "__proto__" | "constructor" | "prototype")
}

pub fn is_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    name.len() <= 32 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_forbidden_prop_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if lower.is_empty() || key.len() > 64 {
        return true;
    }
    // onClick, onclick, onLoad, onAnything — and `on` alone, a handler prefix waiting for a suffix.
    // Lowercase spellings count too: to an HTML parser `onload` is a handler whatever React thinks.
    if lower.starts_with("on") && lower.chars().nth(2).is_none_or(|c| c.is_ascii_alphabetic()) {
        return true;
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return true;
    }
    FORBIDDEN_PROP_KEYS.contains(&lower.as_str())
}

/// A CSS length/track value that can carry no side effect: digits, letters, `% . , - / ( ) + *`
/// and spaces. No quotes, colons, semicolons, angle brackets or backslashes, so no `url(`-style
/// smuggling is possible either (the parenthesis is allowed for `minmax()` / `calc()`, but the
/// property it lands in cannot load anything).
pub(super) fn is_plain_css_value(v: &str, max: usize) -> bool {
    !v.is_empty()
        && v.len() <= max
        && v.chars().all(|c| c.is_ascii_alphanumeric() || " %.,-/()+*".contains(c))
        && !v.to_ascii_lowercase().contains("url(")
        && !v.to_ascii_lowercase().contains("expression(")
}

pub(super) fn check_props(props: &Map<String, Value>) -> LResult<()> {
    if props.len() > MAX_PROPS {
        return Err(LayoutValidationError::TooManyProps { count: props.len(), max: MAX_PROPS });
    }
    for (key, value) in props {
        if is_forbidden_prop_key(key) {
            return Err(LayoutValidationError::ForbiddenProp { key: key.clone() });
        }
        match value {
            Value::String(s) => {
                if s.chars().count() > MAX_STRING_LEN {
                    return Err(LayoutValidationError::PropTooLong { key: key.clone(), max: MAX_STRING_LEN });
                }
            }
            Value::Number(n) => {
                if !n.as_f64().is_some_and(f64::is_finite) {
                    return Err(LayoutValidationError::NonPrimitiveProp { key: key.clone() });
                }
            }
            Value::Bool(_) => {}
            _ => return Err(LayoutValidationError::NonPrimitiveProp { key: key.clone() }),
        }
    }
    Ok(())
}

/* ---------------------------------------------------------- placeholders */

/// Every `{{name}}` in a string, in order. `{{ name }}` with spaces is the same placeholder.
pub fn placeholders(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                out.push(after[..end].trim().to_string());
                rest = &after[end + 2..];
            }
            None => break,
        }
    }
    out
}
