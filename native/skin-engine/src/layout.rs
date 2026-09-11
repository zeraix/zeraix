//! `layout.json` and `components.json`: the declarative layout tree and the composite components a
//! package builds from primitives (Stages 6, 6.1, 6.2 as data; Stage 7 as the checks).
//!
//! What is checked and why, in one place:
//!
//! - **Shape.** Two node kinds, mirrored from the TypeScript/zod schema with `deny_unknown_fields`,
//!   so a key the renderer would never read (`onClick` on a node, say) is refused here as well.
//! - **Props are primitives.** Strings, numbers and booleans only; keys are checked against a
//!   deny-list of anything that could be read as a handler, a URL sink or a React escape hatch. The
//!   zod schema does the same; the prompt set is explicit that neither layer may rely on the other.
//! - **Refs.** `app:`/`primitive:` keys must be in the allow list the app passes in; `custom:` keys
//!   must be defined in components.json.
//! - **Limits.** Literal depth ≤ [`MAX_DEPTH`], literal nodes ≤ [`MAX_NODES`], expanded nodes (with
//!   composites inlined) ≤ [`MAX_EXPANDED_NODES`], expanded depth ≤ [`MAX_EXPANDED_DEPTH`].
//! - **Composite graph.** No cycles (DFS with a path stack, so the error names the loop), no
//!   undeclared `{{param}}` placeholder, and an expansion count that adds as it walks and stops the
//!   moment the cap is passed. A composite that references another ten times, ten levels deep, is
//!   10^10 rendered nodes from a few hundred bytes of JSON; the count must fail before it is ever
//!   computed, never after.
//! - **visibleWhen.** One comparison, parsed by hand. No operators that combine, no calls, no eval.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

pub const MAX_DEPTH: usize = 20;
pub const MAX_NODES: usize = 500;
pub const MAX_EXPANDED_NODES: usize = 2000;
/// A composite placed deep in a layout adds its own template depth on top; the renderer recursion
/// is bounded by this, not by MAX_DEPTH alone.
pub const MAX_EXPANDED_DEPTH: usize = 32;
pub const MAX_PROPS: usize = 32;
pub const MAX_STRING_LEN: usize = 2000;
pub const MAX_COMPOSITES: usize = 200;
pub const MAX_PARAMS: usize = 32;
pub const MAX_REGIONS: usize = 32;
pub const MAX_VISIBLE_WHEN_LEN: usize = 120;
pub const MAX_GRID_TEMPLATE_LEN: usize = 200;
pub const MAX_SIZE_LEN: usize = 64;
pub const MAX_GAP: f64 = 200.0;
pub const MAX_FLEX: f64 = 100.0;

pub const REF_PREFIX_APP: &str = "app:";
pub const REF_PREFIX_PRIMITIVE: &str = "primitive:";
pub const REF_PREFIX_CUSTOM: &str = "custom:";

pub const ALIGN_VALUES: &[&str] = &["start", "center", "end", "stretch", "baseline"];
pub const JUSTIFY_VALUES: &[&str] = &["start", "center", "end", "space-between", "space-around", "space-evenly"];

/// Prop keys that name a behaviour, a sink or a React internal, whatever their value. Matched
/// case-insensitively, after `on` + a capital letter is refused as a class.
pub const FORBIDDEN_PROP_KEYS: &[&str] = &[
    "eval", "script", "function", "callback", "handler", "__proto__", "constructor", "prototype",
    "dangerouslysetinnerhtml", "innerhtml", "outerhtml", "href", "action", "formaction", "srcdoc",
    "style", "class", "classname", "ref", "key", "children", "is", "as", "html", "xlink:href",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Row,
    Column,
    Grid,
    Stack,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Size {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flex: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<String>,
}

/// The recursive layout tree. Tagged by `type`; anything else on a node is refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum LayoutNode {
    Container {
        direction: Direction,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gap: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        justify: Option<String>,
        #[serde(default, rename = "gridTemplate", skip_serializing_if = "Option::is_none")]
        grid_template: Option<String>,
        #[serde(default)]
        children: Vec<LayoutNode>,
    },
    Component {
        #[serde(rename = "ref")]
        reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        props: Option<Map<String, Value>>,
        #[serde(default, rename = "visibleWhen", skip_serializing_if = "Option::is_none")]
        visible_when: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<Size>,
        /// Only a primitive that accepts children (Box) renders them; for any other component the
        /// renderer ignores them. Counted toward depth and node caps like a container's.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        children: Vec<LayoutNode>,
    },
}

/// One entry of components.json: a template over declared parameter names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompositeComponentDef {
    #[serde(default)]
    pub params: Vec<String>,
    pub template: LayoutNode,
}

/// The whole of layout.json: one tree per named region the app exposes through `<LayoutSlot>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutTree {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub regions: BTreeMap<String, LayoutNode>,
}

pub type ComponentMap = HashMap<String, CompositeComponentDef>;

/// Which `app:` and `primitive:` refs exist. Passed in by the app, because only the app knows what
/// it registered; an empty list means "no such components exist", not "anything goes".
#[derive(Debug, Clone, Default)]
pub struct RefAllowList {
    allowed: HashSet<String>,
}

impl RefAllowList {
    pub fn new<I: IntoIterator<Item = S>, S: Into<String>>(refs: I) -> Self {
        Self { allowed: refs.into_iter().map(Into::into).collect() }
    }
    pub fn contains(&self, full_ref: &str) -> bool {
        self.allowed.contains(full_ref)
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum LayoutValidationError {
    #[error("{file} is not valid JSON: {message}")]
    MalformedJson { file: String, message: String },
    #[error("layout \"{region}\" nests {depth} levels deep; the limit is {max}")]
    TooDeep { region: String, depth: usize, max: usize },
    #[error("the layout has {count} nodes; the limit is {max}")]
    TooManyNodes { count: usize, max: usize },
    #[error("layout.json defines {count} regions; the limit is {max}")]
    TooManyRegions { count: usize, max: usize },
    #[error("component ref \"{reference}\" is invalid: {reason}")]
    InvalidRef { reference: String, reason: String },
    #[error("component ref \"{reference}\" is not a registered component")]
    UnknownRef { reference: String },
    #[error("prop \"{key}\" is not allowed: it names a handler, a sink or an internal")]
    ForbiddenProp { key: String },
    #[error("prop \"{key}\" must be a string, number or boolean")]
    NonPrimitiveProp { key: String },
    #[error("prop \"{key}\" is longer than {max} characters")]
    PropTooLong { key: String, max: usize },
    #[error("a node carries {count} props; the limit is {max}")]
    TooManyProps { count: usize, max: usize },
    #[error("visibleWhen \"{expr}\" is not a single comparison of the form state.name === 'value'")]
    InvalidVisibleWhen { expr: String },
    #[error("field \"{field}\" is invalid: {reason}")]
    InvalidValue { field: String, reason: String },
    #[error("composite components reference each other in a cycle: {}", .0.join(" -> "))]
    CircularReference(Vec<String>),
    #[error("expanding the composite components would render more than {max} nodes")]
    ExpansionTooLarge { max: usize },
    #[error("expanding the composite components would nest more than {max} levels deep")]
    ExpansionTooDeep { max: usize },
    #[error("composite \"{component}\" uses the placeholder {{{{{param}}}}} which is not in its params")]
    UndeclaredParam { component: String, param: String },
    #[error("composite name \"{0}\" is invalid: letters, digits, '-' and '_' only, 1-64 characters")]
    InvalidComponentName(String),
    #[error("composite \"{component}\" has an invalid param name \"{param}\"")]
    InvalidParamName { component: String, param: String },
    #[error("components.json defines {count} composites; the limit is {max}")]
    TooManyComposites { count: usize, max: usize },
}

impl LayoutValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MalformedJson { .. } => "layoutMalformed",
            Self::TooDeep { .. } => "layoutTooDeep",
            Self::TooManyNodes { .. } => "layoutTooManyNodes",
            Self::TooManyRegions { .. } => "layoutTooManyRegions",
            Self::InvalidRef { .. } => "layoutInvalidRef",
            Self::UnknownRef { .. } => "layoutUnknownRef",
            Self::ForbiddenProp { .. } => "layoutForbiddenProp",
            Self::NonPrimitiveProp { .. } => "layoutNonPrimitiveProp",
            Self::PropTooLong { .. } => "layoutPropTooLong",
            Self::TooManyProps { .. } => "layoutTooManyProps",
            Self::InvalidVisibleWhen { .. } => "layoutInvalidVisibleWhen",
            Self::InvalidValue { .. } => "layoutInvalidValue",
            Self::CircularReference(_) => "layoutCircularReference",
            Self::ExpansionTooLarge { .. } => "layoutExpansionTooLarge",
            Self::ExpansionTooDeep { .. } => "layoutExpansionTooDeep",
            Self::UndeclaredParam { .. } => "layoutUndeclaredParam",
            Self::InvalidComponentName(_) => "layoutInvalidComponentName",
            Self::InvalidParamName { .. } => "layoutInvalidParamName",
            Self::TooManyComposites { .. } => "layoutTooManyComposites",
        }
    }
}

type LResult<T> = Result<T, LayoutValidationError>;

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
fn is_plain_css_value(v: &str, max: usize) -> bool {
    !v.is_empty()
        && v.len() <= max
        && v.chars().all(|c| c.is_ascii_alphanumeric() || " %.,-/()+*".contains(c))
        && !v.to_ascii_lowercase().contains("url(")
        && !v.to_ascii_lowercase().contains("expression(")
}

fn check_props(props: &Map<String, Value>) -> LResult<()> {
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

/* --------------------------------------------------------------- visibleWhen */

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

/* ------------------------------------------------------------ structure */

struct Walk<'a> {
    components: &'a ComponentMap,
    allow: &'a RefAllowList,
    /// `None` while walking layout.json; `Some(def)` while walking a composite template, whose
    /// placeholders must be declared.
    params: Option<(&'a str, &'a [String])>,
    literal_nodes: usize,
}

impl Walk<'_> {
    fn node(&mut self, node: &LayoutNode, depth: usize, region: &str) -> LResult<()> {
        if depth > MAX_DEPTH {
            return Err(LayoutValidationError::TooDeep { region: region.to_string(), depth, max: MAX_DEPTH });
        }
        self.literal_nodes += 1;
        if self.literal_nodes > MAX_NODES {
            return Err(LayoutValidationError::TooManyNodes { count: self.literal_nodes, max: MAX_NODES });
        }
        match node {
            LayoutNode::Container { gap, align, justify, grid_template, children, direction } => {
                if let Some(g) = gap {
                    if !g.is_finite() || *g < 0.0 || *g > MAX_GAP {
                        return Err(LayoutValidationError::InvalidValue { field: "gap".into(), reason: format!("must be 0-{MAX_GAP}") });
                    }
                }
                if let Some(a) = align {
                    if !ALIGN_VALUES.contains(&a.as_str()) {
                        return Err(LayoutValidationError::InvalidValue { field: "align".into(), reason: format!("\"{a}\" is not one of {}", ALIGN_VALUES.join(", ")) });
                    }
                }
                if let Some(j) = justify {
                    if !JUSTIFY_VALUES.contains(&j.as_str()) {
                        return Err(LayoutValidationError::InvalidValue { field: "justify".into(), reason: format!("\"{j}\" is not one of {}", JUSTIFY_VALUES.join(", ")) });
                    }
                }
                if let Some(g) = grid_template {
                    if *direction != Direction::Grid {
                        return Err(LayoutValidationError::InvalidValue { field: "gridTemplate".into(), reason: "only a grid container may set it".into() });
                    }
                    if !is_plain_css_value(g, MAX_GRID_TEMPLATE_LEN) {
                        return Err(LayoutValidationError::InvalidValue { field: "gridTemplate".into(), reason: "must be a plain grid track list".into() });
                    }
                }
                for child in children {
                    self.node(child, depth + 1, region)?;
                }
            }
            LayoutNode::Component { reference, props, visible_when, size, children } => {
                let (prefix, key) = split_ref(reference)?;
                match prefix {
                    REF_PREFIX_CUSTOM => {
                        if !self.components.contains_key(key) {
                            return Err(LayoutValidationError::UnknownRef { reference: reference.clone() });
                        }
                    }
                    _ => {
                        if !self.allow.contains(reference) {
                            return Err(LayoutValidationError::UnknownRef { reference: reference.clone() });
                        }
                    }
                }
                if let Some(p) = props {
                    check_props(p)?;
                    if let Some((name, params)) = self.params {
                        for v in p.values() {
                            if let Value::String(s) = v {
                                for ph in placeholders(s) {
                                    if !params.iter().any(|d| d == &ph) {
                                        return Err(LayoutValidationError::UndeclaredParam { component: name.to_string(), param: ph });
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(expr) = visible_when {
                    if parse_visible_when(expr).is_none() {
                        return Err(LayoutValidationError::InvalidVisibleWhen { expr: expr.clone() });
                    }
                }
                if let Some(s) = size {
                    if let Some(f) = s.flex {
                        if !f.is_finite() || f < 0.0 || f > MAX_FLEX {
                            return Err(LayoutValidationError::InvalidValue { field: "size.flex".into(), reason: format!("must be 0-{MAX_FLEX}") });
                        }
                    }
                    for (field, v) in [("size.width", &s.width), ("size.height", &s.height)] {
                        if let Some(v) = v {
                            if !is_plain_css_value(v, MAX_SIZE_LEN) {
                                return Err(LayoutValidationError::InvalidValue { field: field.into(), reason: "must be a plain CSS length".into() });
                            }
                        }
                    }
                }
                for child in children {
                    self.node(child, depth + 1, region)?;
                }
            }
        }
        Ok(())
    }
}

/* ------------------------------------------------------------- expansion */

/// Counts rendered nodes with composites inlined, adding as it walks and failing the instant the
/// running total passes the cap. `sizes` memoises finished composites so a diamond-shaped graph
/// (A uses B and C, both use D) costs one walk of D rather than two — but a memoised size is still
/// added through the same capped counter, so the cap is checked on every addition either way.
struct Expander<'a> {
    components: &'a ComponentMap,
    total: usize,
    sizes: HashMap<String, (usize, usize)>, // name -> (nodes, depth)
    stack: Vec<String>,
}

impl Expander<'_> {
    fn add(&mut self, n: usize) -> LResult<()> {
        self.total = self.total.saturating_add(n);
        if self.total > MAX_EXPANDED_NODES {
            return Err(LayoutValidationError::ExpansionTooLarge { max: MAX_EXPANDED_NODES });
        }
        Ok(())
    }

    /// Returns (nodes, depth) of the subtree rooted at `node`, having added its nodes to the total.
    fn node(&mut self, node: &LayoutNode, depth: usize) -> LResult<(usize, usize)> {
        if depth > MAX_EXPANDED_DEPTH {
            return Err(LayoutValidationError::ExpansionTooDeep { max: MAX_EXPANDED_DEPTH });
        }
        self.add(1)?;
        match node {
            LayoutNode::Container { children, .. } => {
                let mut nodes = 1;
                let mut deepest = depth;
                for c in children {
                    let (n, d) = self.node(c, depth + 1)?;
                    nodes += n;
                    deepest = deepest.max(d);
                }
                Ok((nodes, deepest))
            }
            LayoutNode::Component { reference, children, .. } => {
                let (mut nodes, mut deepest) = match reference.strip_prefix(REF_PREFIX_CUSTOM) {
                    Some(name) => {
                        let (n, d) = self.composite(name, depth)?;
                        (1 + n, d)
                    }
                    None => (1, depth),
                };
                for c in children {
                    let (n, d) = self.node(c, depth + 1)?;
                    nodes += n;
                    deepest = deepest.max(d);
                }
                Ok((nodes, deepest))
            }
        }
    }

    /// Nodes and depth of a composite's template placed at `depth`, added to the total.
    fn composite(&mut self, name: &str, depth: usize) -> LResult<(usize, usize)> {
        if let Some(&(n, rel_depth)) = self.sizes.get(name) {
            self.add(n)?;
            let abs = depth + rel_depth;
            if abs > MAX_EXPANDED_DEPTH {
                return Err(LayoutValidationError::ExpansionTooDeep { max: MAX_EXPANDED_DEPTH });
            }
            return Ok((n, abs));
        }
        if let Some(at) = self.stack.iter().position(|s| s == name) {
            let mut cycle: Vec<String> = self.stack[at..].to_vec();
            cycle.push(name.to_string());
            return Err(LayoutValidationError::CircularReference(cycle));
        }
        let Some(def) = self.components.get(name) else {
            return Err(LayoutValidationError::UnknownRef { reference: format!("{REF_PREFIX_CUSTOM}{name}") });
        };
        self.stack.push(name.to_string());
        let (n, deepest) = self.node(&def.template, depth + 1)?;
        self.stack.pop();
        self.sizes.insert(name.to_string(), (n, deepest - depth));
        Ok((n, deepest))
    }
}

/* ---------------------------------------------------------------- public */

/// Parse components.json. `None` for an absent file.
pub fn parse_components(raw: &str) -> LResult<ComponentMap> {
    serde_json::from_str::<ComponentMap>(raw)
        .map_err(|e| LayoutValidationError::MalformedJson { file: "components.json".into(), message: e.to_string() })
}

/// Check the composite graph: names, params, template structure, placeholders, cycles and the
/// expanded size of every composite on its own.
pub fn validate_components(components: &ComponentMap, allow: &RefAllowList) -> LResult<()> {
    if components.len() > MAX_COMPOSITES {
        return Err(LayoutValidationError::TooManyComposites { count: components.len(), max: MAX_COMPOSITES });
    }
    // Deterministic order, so the first error reported is the same on every run.
    let mut names: Vec<&String> = components.keys().collect();
    names.sort();
    for name in &names {
        if !is_composite_name(name) {
            return Err(LayoutValidationError::InvalidComponentName((*name).clone()));
        }
        let def = &components[*name];
        if def.params.len() > MAX_PARAMS {
            return Err(LayoutValidationError::InvalidParamName { component: (*name).clone(), param: format!("more than {MAX_PARAMS} params") });
        }
        let mut seen = HashSet::new();
        for p in &def.params {
            if !is_param_name(p) || !seen.insert(p) {
                return Err(LayoutValidationError::InvalidParamName { component: (*name).clone(), param: p.clone() });
            }
        }
        let mut walk = Walk { components, allow, params: Some((name, &def.params)), literal_nodes: 0 };
        walk.node(&def.template, 1, name)?;
    }
    // Cycles first — reported by name, which is what an author needs — then sizes. One expander
    // for all: the memo makes the whole pass linear in the number of template nodes, and a
    // composite that is too large on its own fails here before any layout places it.
    for name in &names {
        let mut ex = Expander { components, total: 0, sizes: HashMap::new(), stack: Vec::new() };
        ex.composite(name, 0)?;
    }
    Ok(())
}

/// Parse and check layout.json against the (already validated) composites and the app's registry.
pub fn validate_layout(raw: &str, components: &ComponentMap, allow: &RefAllowList) -> LResult<LayoutTree> {
    let tree: LayoutTree = serde_json::from_str(raw)
        .map_err(|e| LayoutValidationError::MalformedJson { file: "layout.json".into(), message: e.to_string() })?;
    if tree.regions.len() > MAX_REGIONS {
        return Err(LayoutValidationError::TooManyRegions { count: tree.regions.len(), max: MAX_REGIONS });
    }
    let mut walk = Walk { components, allow, params: None, literal_nodes: 0 };
    for (region, node) in &tree.regions {
        if !is_composite_name(region) {
            return Err(LayoutValidationError::InvalidValue { field: "regions".into(), reason: format!("\"{region}\" is not a valid region name") });
        }
        walk.node(node, 1, region)?;
    }
    for node in tree.regions.values() {
        let mut ex = Expander { components, total: 0, sizes: HashMap::new(), stack: Vec::new() };
        ex.node(node, 1)?;
    }
    Ok(tree)
}

/// Both files together, as the install pipeline runs them: components first (so a cycle is
/// reported as a cycle, not as an unknown ref), then the layout against them.
pub fn validate_package_layout(layout: Option<&str>, components: Option<&str>, allow: &RefAllowList) -> LResult<(Option<LayoutTree>, ComponentMap)> {
    let map = match components {
        Some(raw) => {
            let map = parse_components(raw)?;
            validate_components(&map, allow)?;
            map
        }
        None => ComponentMap::new(),
    };
    let tree = match layout {
        Some(raw) => Some(validate_layout(raw, &map, allow)?),
        None => None,
    };
    Ok((tree, map))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allow() -> RefAllowList {
        RefAllowList::new(["app:greeting", "app:brandMark", "primitive:box", "primitive:text", "primitive:icon", "primitive:progressRing"])
    }

    fn component(reference: &str, props: &str) -> String {
        format!(r#"{{"type":"component","ref":"{reference}","props":{props}}}"#)
    }

    fn nest(depth: usize, leaf: &str) -> String {
        let mut s = leaf.to_string();
        for _ in 0..depth {
            s = format!(r#"{{"type":"container","direction":"column","children":[{s}]}}"#);
        }
        s
    }

    fn layout(region: &str, node: &str) -> String {
        format!(r#"{{"version":1,"regions":{{"{region}":{node}}}}}"#)
    }

    #[test]
    fn accepts_a_reasonable_layout() {
        let node = r#"{"type":"container","direction":"grid","gridTemplate":"repeat(2, minmax(0, 1fr))","gap":8,"align":"center","children":[
            {"type":"component","ref":"primitive:text","props":{"content":"Hello","fontSize":14},"size":{"flex":1,"width":"50%"}},
            {"type":"component","ref":"app:greeting","visibleWhen":"state.theme === 'dark'"},
            {"type":"component","ref":"primitive:box","props":{"padding":12,"backdropBlur":true}}
        ]}"#;
        let tree = validate_layout(&layout("greeting", node), &ComponentMap::new(), &allow()).expect("valid");
        assert_eq!(tree.regions.len(), 1);
    }

    #[test]
    fn component_children_count_toward_depth_and_nodes() {
        let boxed = r#"{"type":"component","ref":"primitive:box","props":{"padding":8},"children":[
            {"type":"component","ref":"primitive:text","props":{"content":"in a box"}}
        ]}"#;
        let tree = validate_layout(&layout("r", boxed), &ComponentMap::new(), &allow()).expect("box with children");
        assert_eq!(tree.regions.len(), 1);
        // A chain of boxes nests like a chain of containers.
        let mut s = component("primitive:text", "{}");
        for _ in 0..MAX_DEPTH + 2 {
            s = format!(r#"{{"type":"component","ref":"primitive:box","children":[{s}]}}"#);
        }
        assert!(matches!(validate_layout(&layout("r", &s), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::TooDeep { .. }));
        // And expansion counts them: a composite whose box holds 30 texts, placed 100 times.
        let texts: Vec<String> = (0..30).map(|_| component("primitive:text", "{}")).collect();
        let comps = format!(r#"{{"c":{{"params":[],"template":{{"type":"component","ref":"primitive:box","children":[{}]}}}}}}"#, texts.join(","));
        let map = composites(&comps);
        validate_components(&map, &allow()).unwrap();
        let placements: Vec<String> = (0..100).map(|_| component("custom:c", "{}")).collect();
        let node = format!(r#"{{"type":"container","direction":"row","children":[{}]}}"#, placements.join(","));
        assert!(matches!(validate_layout(&layout("r", &node), &map, &allow()).unwrap_err(), LayoutValidationError::ExpansionTooLarge { .. }));
    }

    #[test]
    fn rejects_unknown_type_and_unknown_node_keys() {
        let bad = r#"{"type":"script","src":"x"}"#;
        assert!(matches!(validate_layout(&layout("r", bad), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::MalformedJson { .. }));
        let bad = r#"{"type":"component","ref":"primitive:box","onClick":"alert(1)"}"#;
        assert!(matches!(validate_layout(&layout("r", bad), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::MalformedJson { .. }));
    }

    #[test]
    fn depth_limit() {
        let ok = nest(MAX_DEPTH - 1, &component("primitive:box", "{}"));
        assert!(validate_layout(&layout("r", &ok), &ComponentMap::new(), &allow()).is_ok());
        let too_deep = nest(MAX_DEPTH + 5, &component("primitive:box", "{}"));
        let err = validate_layout(&layout("r", &too_deep), &ComponentMap::new(), &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::TooDeep { .. }), "{err}");
    }

    #[test]
    fn node_count_limit() {
        let children: Vec<String> = (0..MAX_NODES + 10).map(|_| r#"{"type":"container","direction":"row","children":[]}"#.to_string()).collect();
        let flat = format!(r#"{{"type":"container","direction":"row","children":[{}]}}"#, children.join(","));
        let err = validate_layout(&layout("r", &flat), &ComponentMap::new(), &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::TooManyNodes { .. }), "{err}");
        // Counted across regions, not per region.
        let half: Vec<String> = (0..MAX_NODES / 2).map(|_| component("primitive:box", "{}")).collect();
        let region = format!(r#"{{"type":"container","direction":"row","children":[{}]}}"#, half.join(","));
        let two = format!(r#"{{"regions":{{"a":{region},"b":{region}}}}}"#);
        assert!(matches!(validate_layout(&two, &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::TooManyNodes { .. }));
    }

    #[test]
    fn refs_must_be_registered_or_defined() {
        for (reference, expect_unknown) in [("app:weatherCard", true), ("primitive:iframe", true), ("custom:nope", true), ("app:greeting", false)] {
            let r = validate_layout(&layout("r", &component(reference, "{}")), &ComponentMap::new(), &allow());
            assert_eq!(matches!(r, Err(LayoutValidationError::UnknownRef { .. })), expect_unknown, "{reference}");
        }
        for bad in ["greeting", "APP:greeting", "app:", "app:a b", "custom:../x", "script:alert"] {
            let r = validate_layout(&layout("r", &component(bad, "{}")), &ComponentMap::new(), &allow());
            assert!(matches!(r, Err(LayoutValidationError::InvalidRef { .. })), "{bad}: {r:?}");
        }
    }

    #[test]
    fn props_must_be_primitive_and_safe() {
        let ok = component("primitive:text", r#"{"content":"hi","fontSize":12,"bold":true,"data-x":"y"}"#);
        assert!(validate_layout(&layout("r", &ok), &ComponentMap::new(), &allow()).is_ok());
        for (props, variant) in [
            (r#"{"onClick":"x"}"#, "forbidden"),
            (r#"{"onclick":"x"}"#, "forbidden"),
            (r#"{"onLoad":true}"#, "forbidden"),
            (r#"{"eval":"x"}"#, "forbidden"),
            (r#"{"__proto__":"x"}"#, "forbidden"),
            (r#"{"dangerouslySetInnerHTML":"x"}"#, "forbidden"),
            (r#"{"href":"https://x"}"#, "forbidden"),
            (r#"{"style":"color:red"}"#, "forbidden"),
            (r#"{"nested":{"a":1}}"#, "nonprimitive"),
            (r#"{"list":[1]}"#, "nonprimitive"),
            (r#"{"nil":null}"#, "nonprimitive"),
        ] {
            let err = validate_layout(&layout("r", &component("primitive:box", props)), &ComponentMap::new(), &allow()).unwrap_err();
            match variant {
                "forbidden" => assert!(matches!(err, LayoutValidationError::ForbiddenProp { .. }), "{props}: {err}"),
                _ => assert!(matches!(err, LayoutValidationError::NonPrimitiveProp { .. }), "{props}: {err}"),
            }
        }
        let long = format!(r#"{{"content":"{}"}}"#, "x".repeat(MAX_STRING_LEN + 1));
        assert!(matches!(validate_layout(&layout("r", &component("primitive:text", &long)), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::PropTooLong { .. }));
        let many: Vec<String> = (0..MAX_PROPS + 1).map(|i| format!("\"p{i}\":1")).collect();
        let many = format!("{{{}}}", many.join(","));
        assert!(matches!(validate_layout(&layout("r", &component("primitive:text", &many)), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::TooManyProps { .. }));
    }

    #[test]
    fn container_values_are_bounded() {
        let bad_align = r#"{"type":"container","direction":"row","align":"url(x)","children":[]}"#;
        assert!(matches!(validate_layout(&layout("r", bad_align), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::InvalidValue { .. }));
        let bad_gap = r#"{"type":"container","direction":"row","gap":-1,"children":[]}"#;
        assert!(matches!(validate_layout(&layout("r", bad_gap), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::InvalidValue { .. }));
        let template_on_row = r#"{"type":"container","direction":"row","gridTemplate":"1fr 1fr","children":[]}"#;
        assert!(matches!(validate_layout(&layout("r", template_on_row), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::InvalidValue { .. }));
        let bad_template = r#"{"type":"container","direction":"grid","gridTemplate":"1fr; background: url(x)","children":[]}"#;
        assert!(matches!(validate_layout(&layout("r", bad_template), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::InvalidValue { .. }));
        let bad_width = r#"{"type":"component","ref":"primitive:box","size":{"width":"100px\" onload=\"x"}}"#;
        assert!(matches!(validate_layout(&layout("r", bad_width), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::InvalidValue { .. }));
        let bad_size_key = r#"{"type":"component","ref":"primitive:box","size":{"onClick":"x"}}"#;
        assert!(matches!(validate_layout(&layout("r", bad_size_key), &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::MalformedJson { .. }));
    }

    #[test]
    fn visible_when_grammar() {
        for ok in ["state.theme === 'dark'", "state.a.b !== \"x\"", "state.count > 3", "state.flag == true", "state.x != null", "state.flag", "!state.flag", " state.n <= 2.5 "] {
            assert!(parse_visible_when(ok).is_some(), "{ok}");
        }
        for bad in [
            "", "theme === 'dark'", "state.a === 'x' && state.b", "state.a || state.b", "state.fn() === 1", "eval('x')",
            "state.a === 'it''s'", "state.a === 'x' + 'y'", "state['a'] === 1", "!state.a === 1", "state.a ==== 1",
            "state === 'x'", "state.a === undefined", "state.a === {}", "window.location", "state.a.b.c.d.e.f.g === 1",
        ] {
            assert!(parse_visible_when(bad).is_none(), "{bad}");
        }
        let c = parse_visible_when("state.theme === 'dark'").unwrap();
        assert_eq!(c.path, ["theme"]);
        assert_eq!(c.op.as_deref(), Some("==="));
        assert_eq!(c.literal, Some(Literal::Str("dark".into())));
        let err = validate_layout(&layout("r", r#"{"type":"component","ref":"primitive:box","visibleWhen":"state.a && state.b"}"#), &ComponentMap::new(), &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::InvalidVisibleWhen { .. }));
    }

    fn composites(json: &str) -> ComponentMap {
        parse_components(json).expect("components parse")
    }

    #[test]
    fn composites_with_params_and_nesting_pass() {
        let map = composites(r#"{
            "energyCard": {"params":["title","value"],"template":{"type":"container","direction":"column","children":[
                {"type":"component","ref":"primitive:text","props":{"content":"{{title}}"}},
                {"type":"component","ref":"primitive:progressRing","props":{"value":"{{ value }}"}}
            ]}},
            "twoCards": {"params":["a","b"],"template":{"type":"container","direction":"row","children":[
                {"type":"component","ref":"custom:energyCard","props":{"title":"{{a}}","value":50}},
                {"type":"component","ref":"custom:energyCard","props":{"title":"{{b}}","value":80}}
            ]}}
        }"#);
        validate_components(&map, &allow()).expect("valid composites");
        let node = component("custom:twoCards", r#"{"a":"Solar","b":"Wind"}"#);
        validate_layout(&layout("r", &node), &map, &allow()).expect("layout using composites");
    }

    #[test]
    fn undeclared_placeholder_fails() {
        let map = composites(r#"{"c":{"params":["title"],"template":{"type":"component","ref":"primitive:text","props":{"content":"{{subtitle}}"}}}}"#);
        let err = validate_components(&map, &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::UndeclaredParam { ref component, ref param } if component == "c" && param == "subtitle"), "{err}");
        // A placeholder in layout.json (not in a template) is ordinary text; nothing declares params there.
        let node = component("primitive:text", r#"{"content":"{{anything}}"}"#);
        assert!(validate_layout(&layout("r", &node), &ComponentMap::new(), &allow()).is_ok());
    }

    #[test]
    fn circular_references_are_named() {
        let map = composites(r#"{
            "a":{"params":[],"template":{"type":"component","ref":"custom:b"}},
            "b":{"params":[],"template":{"type":"component","ref":"custom:c"}},
            "c":{"params":[],"template":{"type":"component","ref":"custom:a"}}
        }"#);
        let err = validate_components(&map, &allow()).unwrap_err();
        match err {
            LayoutValidationError::CircularReference(names) => assert_eq!(names, ["a", "b", "c", "a"]),
            other => panic!("expected a cycle, got {other}"),
        }
        let self_ref = composites(r#"{"a":{"params":[],"template":{"type":"component","ref":"custom:a"}}}"#);
        assert!(matches!(validate_components(&self_ref, &allow()).unwrap_err(), LayoutValidationError::CircularReference(_)));
    }

    #[test]
    fn expansion_blow_up_is_caught_without_expanding() {
        // Ten layers, each referencing the previous ten times: 10^10 nodes, no cycle.
        let mut defs = vec![r#""l0":{"params":[],"template":{"type":"component","ref":"primitive:box"}}"#.to_string()];
        for i in 1..10 {
            let children: Vec<String> = (0..10).map(|_| format!(r#"{{"type":"component","ref":"custom:l{}"}}"#, i - 1)).collect();
            defs.push(format!(r#""l{i}":{{"params":[],"template":{{"type":"container","direction":"row","children":[{}]}}}}"#, children.join(",")));
        }
        let map = composites(&format!("{{{}}}", defs.join(",")));
        let started = std::time::Instant::now();
        let err = validate_components(&map, &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::ExpansionTooLarge { .. }), "{err}");
        assert!(started.elapsed().as_millis() < 500, "the cap must trip before any real expansion: took {:?}", started.elapsed());

        // A diamond that stays small passes, and its size is counted once per placement.
        let map = composites(r#"{
            "d":{"params":[],"template":{"type":"component","ref":"primitive:box"}},
            "b":{"params":[],"template":{"type":"container","direction":"row","children":[{"type":"component","ref":"custom:d"},{"type":"component","ref":"custom:d"}]}},
            "a":{"params":[],"template":{"type":"container","direction":"row","children":[{"type":"component","ref":"custom:b"},{"type":"component","ref":"custom:b"}]}}
        }"#);
        validate_components(&map, &allow()).expect("small diamond");
        // Placing a composite many times in a layout still counts each placement.
        let children: Vec<String> = (0..300).map(|_| component("custom:a", "{}")).collect();
        let node = format!(r#"{{"type":"container","direction":"row","children":[{}]}}"#, children.join(","));
        let err = validate_layout(&layout("r", &node), &map, &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::ExpansionTooLarge { .. }), "{err}");
    }

    #[test]
    fn expansion_depth_is_bounded() {
        let mut defs = vec![r#""l0":{"params":[],"template":{"type":"component","ref":"primitive:box"}}"#.to_string()];
        for i in 1..12 {
            defs.push(format!(r#""l{i}":{{"params":[],"template":{{"type":"container","direction":"row","children":[{{"type":"container","direction":"row","children":[{{"type":"container","direction":"row","children":[{{"type":"component","ref":"custom:l{}"}}]}}]}}]}}}}"#, i - 1));
        }
        let map = composites(&format!("{{{}}}", defs.join(",")));
        let err = validate_components(&map, &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::ExpansionTooDeep { .. }), "{err}");
    }

    #[test]
    fn composite_names_and_params_are_checked() {
        let map = composites(r#"{"bad name":{"params":[],"template":{"type":"component","ref":"primitive:box"}}}"#);
        assert!(matches!(validate_components(&map, &allow()).unwrap_err(), LayoutValidationError::InvalidComponentName(_)));
        for proto in ["__proto__", "constructor", "prototype"] {
            let map = composites(&format!(r#"{{"{proto}":{{"params":[],"template":{{"type":"component","ref":"primitive:box"}}}}}}"#));
            assert!(matches!(validate_components(&map, &allow()).unwrap_err(), LayoutValidationError::InvalidComponentName(_)), "{proto}");
            let tree = format!(r#"{{"regions":{{"{proto}":{}}}}}"#, component("primitive:box", "{}"));
            assert!(matches!(validate_layout(&tree, &ComponentMap::new(), &allow()).unwrap_err(), LayoutValidationError::InvalidValue { .. }), "{proto}");
        }
        let map = composites(r#"{"c":{"params":["1x"],"template":{"type":"component","ref":"primitive:box"}}}"#);
        assert!(matches!(validate_components(&map, &allow()).unwrap_err(), LayoutValidationError::InvalidParamName { .. }));
        let map = composites(r#"{"c":{"params":["a","a"],"template":{"type":"component","ref":"primitive:box"}}}"#);
        assert!(matches!(validate_components(&map, &allow()).unwrap_err(), LayoutValidationError::InvalidParamName { .. }));
        // A template's own refs are checked against the registry too.
        let map = composites(r#"{"c":{"params":[],"template":{"type":"component","ref":"app:nope"}}}"#);
        assert!(matches!(validate_components(&map, &allow()).unwrap_err(), LayoutValidationError::UnknownRef { .. }));
        assert!(matches!(parse_components("[]").unwrap_err(), LayoutValidationError::MalformedJson { .. }));
    }

    #[test]
    fn placeholders_are_found() {
        assert_eq!(placeholders("{{a}} and {{ b }} and {{c"), ["a", "b"]);
        assert!(placeholders("plain").is_empty());
    }

    #[test]
    fn package_level_helper_orders_components_before_layout() {
        let layout_json = layout("r", &component("custom:x", "{}"));
        let comps = r#"{"x":{"params":[],"template":{"type":"component","ref":"custom:x"}}}"#;
        let err = validate_package_layout(Some(&layout_json), Some(comps), &allow()).unwrap_err();
        assert!(matches!(err, LayoutValidationError::CircularReference(_)));
        let (tree, map) = validate_package_layout(Some(&layout("r", &component("primitive:box", "{}"))), None, &allow()).unwrap();
        assert!(tree.is_some() && map.is_empty());
    }
}
