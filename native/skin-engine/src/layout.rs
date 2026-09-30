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

mod checks;
mod validate;
mod visible_when;

pub use checks::{is_composite_name, is_param_name, placeholders, split_ref};
pub use validate::{parse_components, validate_components, validate_layout, validate_package_layout};
pub use visible_when::{Condition, Literal, parse_visible_when};

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

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
