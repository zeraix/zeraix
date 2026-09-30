//! The `visibleWhen` grammar: a bare `[!]state.path` truthiness test or one `state.path OP literal`
//! comparison, parsed by hand into a [`Condition`].

use super::MAX_VISIBLE_WHEN_LEN;
use super::checks::is_param_name;

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

/// A parsed `visibleWhen`. Either `[!]state.path` (truthiness) or `state.path OP literal`.
#[derive(Debug, Clone, PartialEq)]
pub struct Condition {
    pub path: Vec<String>,
    pub negate: bool,
    pub op: Option<String>,
    pub literal: Option<Literal>,
}

const OPS: &[&str] = &["===", "!==", ">=", "<=", "==", "!=", ">", "<"];

/// Parse the tiny conditional language. Grammar, in full:
///
/// ```text
/// expr    := [ "!" ] path | path ws op ws literal
/// path    := "state" ("." ident)+
/// op      := "===" | "!==" | "==" | "!=" | ">" | "<" | ">=" | "<="
/// literal := "'" chars "'" | '"' chars '"' | number | "true" | "false" | "null"
/// ```
///
/// Nothing combines, nothing calls, nothing indexes. The renderer evaluates the same grammar.
pub fn parse_visible_when(expr: &str) -> Option<Condition> {
    let s = expr.trim();
    if s.is_empty() || s.len() > MAX_VISIBLE_WHEN_LEN {
        return None;
    }
    let (negate, s) = match s.strip_prefix('!') {
        Some(rest) => (true, rest.trim_start()),
        None => (false, s),
    };
    // Find an operator, if any.
    let mut op_at: Option<(usize, &str)> = None;
    for op in OPS {
        if let Some(i) = s.find(op) {
            // Prefer the earliest position; on a tie the longer operator (listed first) wins.
            match op_at {
                Some((j, _)) if j <= i => {}
                _ => op_at = Some((i, op)),
            }
        }
    }
    let (path_str, op, literal) = match op_at {
        Some((i, op)) => {
            if negate {
                return None;
            }
            let lit = parse_literal(s[i + op.len()..].trim())?;
            (s[..i].trim_end(), Some(op.to_string()), Some(lit))
        }
        None => (s, None, None),
    };
    let path = parse_path(path_str)?;
    Some(Condition { path, negate, op, literal })
}

fn parse_path(s: &str) -> Option<Vec<String>> {
    let mut parts = s.split('.');
    if parts.next()? != "state" {
        return None;
    }
    let rest: Vec<String> = parts.map(str::to_string).collect();
    if rest.is_empty() || rest.len() > 6 {
        return None;
    }
    for p in &rest {
        if !is_param_name(p) {
            return None;
        }
    }
    Some(rest)
}

fn parse_literal(s: &str) -> Option<Literal> {
    if s.is_empty() {
        return None;
    }
    if (s.starts_with('\'') && s.ends_with('\'') || s.starts_with('"') && s.ends_with('"')) && s.len() >= 2 {
        let inner = &s[1..s.len() - 1];
        if inner.contains(['\'', '"', '\\']) {
            return None;
        }
        return Some(Literal::Str(inner.to_string()));
    }
    match s {
        "true" => return Some(Literal::Bool(true)),
        "false" => return Some(Literal::Bool(false)),
        "null" => return Some(Literal::Null),
        _ => {}
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite()).map(Literal::Num)
}
