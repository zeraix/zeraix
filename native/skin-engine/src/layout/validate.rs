//! The two tree walks and the public entry points that run them: `Walk` checks the literal
//! structure of layout.json and of every composite template, and `Expander` counts nodes and depth
//! with composites inlined, failing the moment a cap is passed.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::checks::{check_props, is_composite_name, is_param_name, is_plain_css_value, placeholders, split_ref};
use super::visible_when::parse_visible_when;
use super::{
    ALIGN_VALUES, ComponentMap, Direction, JUSTIFY_VALUES, LResult, LayoutNode, LayoutTree, LayoutValidationError, MAX_COMPOSITES,
    MAX_DEPTH, MAX_EXPANDED_DEPTH, MAX_EXPANDED_NODES, MAX_FLEX, MAX_GAP, MAX_GRID_TEMPLATE_LEN, MAX_NODES, MAX_PARAMS, MAX_REGIONS,
    MAX_SIZE_LEN, REF_PREFIX_CUSTOM, RefAllowList,
};

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
