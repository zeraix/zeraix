//! Tests for `layout.rs`, kept out of the source file (declared there as `mod tests`).

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
