//! Stage 9: security and edge-case acceptance for the whole install pipeline.
//!
//! Every scenario builds its package by code (tests/common/mod.rs), runs the real
//! `install_skin_package`, and asserts two things: the rejection is the *right* one, and nothing
//! was written under the skins directory — a failed install must be entirely side-effect-free.
//! The composite-expansion scenario also asserts wall-clock time, because there the validation
//! itself is the attack surface: a check that expands 10^10 nodes before comparing against the cap
//! hangs the process as surely as rendering them would.

mod common;

use std::fs;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Instant;

use common::*;
use skin_engine::extract::{InstallOptions, SkinInstallError, install_skin_package, MAX_FILE_BYTES, MAX_TOTAL_BYTES};
use skin_engine::layout::{LayoutValidationError, MAX_DEPTH, MAX_EXPANDED_NODES, MAX_NODES};
use skin_engine::manifest::SkinValidationError;
use skin_engine::store::SkinStore;
use skin_engine::DEFAULT_SKIN_ID;

fn opts() -> InstallOptions {
    InstallOptions { allowed_refs: allowed_refs(), app_version: Some("2.0.0".into()), sidebar: sidebar_registry() }
}

/// Install and expect a rejection, then prove the skins directory is untouched.
fn expect_rejected(sb: &Sandbox, pkg: &str) -> SkinInstallError {
    let before = sb.skins_contents();
    let err = install_skin_package(pkg, &sb.skins(), &opts()).expect_err("the package must be rejected");
    let after = sb.skins_contents();
    assert_eq!(before, after, "a rejected install wrote into the skins directory: {err}");
    assert!(!sb.skins_dir().join("probe-skin.tmp").exists(), "a temp directory was left behind");
    assert!(!sb.skins_dir().join("probe-skin").exists(), "a half-installed directory was left behind");
    err
}

#[test]
fn baseline_a_good_package_installs() {
    let sb = Sandbox::new();
    let pkg = sb.pkg("good.skinpkg", &good_entries());
    let out = install_skin_package(&pkg, &sb.skins(), &opts()).expect("baseline install");
    assert_eq!(out.manifest.id, "probe-skin");
    assert!(sb.skins_dir().join("probe-skin").join("tokens.css").is_file());
}

/* ------------------------------------------------------- package-level attacks */

#[test]
fn zip_slip_entry_is_rejected() {
    let sb = Sandbox::new();
    let pkg = sb.pkg("slip.skinpkg", &with_extra(entry("../../../etc/passwd.css", "root:x")));
    let err = expect_rejected(&sb, &pkg);
    assert!(matches!(err, SkinInstallError::PathTraversal(ref p) if p == "../../../etc/passwd.css"), "{err}");
    // Nothing escaped upward either.
    assert!(!sb.root.path().join("etc").exists());
    for evil in ["/etc/passwd.css", "assets/../../up.png", "..\\win.png", "C:/x.png"] {
        let pkg = sb.pkg("slip2.skinpkg", &with_extra(entry(evil, "x")));
        assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::PathTraversal(_)), "{evil}");
    }
}

#[test]
fn executable_entries_fail_the_whole_install() {
    let sb = Sandbox::new();
    for (name, detail) in [("install.sh", "install.sh (.sh)"), ("bin/helper.exe", "bin/helper.exe (.exe)"), ("assets/x.js", "assets/x.js (.js)"), ("assets/x.html", "assets/x.html (.html)")] {
        let pkg = sb.pkg("exec.skinpkg", &with_extra(entry(name, "#!/bin/sh\n")));
        let err = expect_rejected(&sb, &pkg);
        assert!(matches!(err, SkinInstallError::DisallowedFileType(_)), "{name}: {err}");
        assert_eq!(err.detail().as_deref(), Some(detail), "the detail must name the file so the UI can say which one");
    }
}

#[test]
fn missing_manifest_is_rejected() {
    let sb = Sandbox::new();
    let pkg = sb.pkg("nomanifest.skinpkg", &[entry("tokens.css", TOKENS), entry("assets/a.png", "x")]);
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::MissingManifest));
    // A manifest under a folder is not at the root.
    let pkg = sb.pkg("nested.skinpkg", &[entry("skin/manifest.json", MANIFEST), entry("skin/tokens.css", TOKENS)]);
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::MissingManifest));
}

#[test]
fn non_semver_version_is_rejected() {
    let sb = Sandbox::new();
    let pkg = sb.pkg("badver.skinpkg", &with_manifest(&MANIFEST.replace("1.0.0", "1.0")));
    let err = expect_rejected(&sb, &pkg);
    assert!(matches!(err, SkinInstallError::InvalidManifest(SkinValidationError::InvalidVersion(ref v)) if v == "1.0"), "{err}");
    assert_eq!(err.code(), "manifestInvalidVersion");
}

#[test]
fn id_with_path_separator_is_rejected() {
    let sb = Sandbox::new();
    for bad in ["../evil", "evil/../../x", "..", "a/b", "C:\\evil", "evil\\x"] {
        let manifest = MANIFEST.replace("probe-skin", &bad.replace('\\', "\\\\"));
        let pkg = sb.pkg("badid.skinpkg", &with_manifest(&manifest));
        let err = expect_rejected(&sb, &pkg);
        assert!(matches!(err, SkinInstallError::InvalidManifest(SkinValidationError::InvalidId(_))), "{bad}: {err}");
    }
    assert!(!sb.root.path().join("evil").exists());
}

#[test]
fn zip_bomb_is_refused_from_metadata_before_inflating() {
    let sb = Sandbox::new();
    // Highly compressible filler: 9 MB of zeros per entry deflates to ~9 KB. Six of them declare
    // 54 MB — past the 50 MB total — while the archive on disk is well under 100 KB.
    let filler = vec![0u8; 9 * 1024 * 1024];
    let mut entries = good_entries();
    for i in 0..6 {
        entries.push(entry(&format!("assets/filler{i}.png"), filler.clone()));
    }
    let pkg = sb.pkg("bomb.skinpkg", &entries);
    let on_disk = fs::metadata(&pkg).unwrap().len();
    assert!(on_disk < 200 * 1024, "the bomb should be small on disk: {on_disk} bytes");
    let started = Instant::now();
    let err = expect_rejected(&sb, &pkg);
    assert!(matches!(err, SkinInstallError::SizeLimit(_)), "{err}");
    assert!(started.elapsed().as_secs() < 5, "refusal must come from the central directory, not from inflating 54 MB");

    // A single entry past the per-file cap, likewise.
    let one = vec![0u8; (MAX_FILE_BYTES + 1) as usize];
    let pkg = sb.pkg("bigone.skinpkg", &with_extra(entry("assets/big.png", one)));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::SizeLimit(_)));
    assert!(MAX_TOTAL_BYTES > MAX_FILE_BYTES);
}

/* ------------------------------------------------------- layout-level attacks */

#[test]
fn layout_nesting_over_the_limit_is_rejected() {
    let sb = Sandbox::new();
    let deep = nested(MAX_DEPTH + 5, &component("primitive:box"));
    let pkg = sb.pkg("deep.skinpkg", &with_layout(&layout_json("greeting", &deep), None));
    let err = expect_rejected(&sb, &pkg);
    assert!(matches!(err, SkinInstallError::InvalidLayout(LayoutValidationError::TooDeep { .. })), "{err}");
    // Right at the limit is fine.
    let ok = nested(MAX_DEPTH - 1, &component("primitive:box"));
    let pkg = sb.pkg("deepok.skinpkg", &with_layout(&layout_json("greeting", &ok), None));
    install_skin_package(&pkg, &sb.skins(), &opts()).expect("depth at the limit installs");
}

#[test]
fn layout_with_over_500_nodes_is_rejected() {
    let sb = Sandbox::new();
    let pkg = sb.pkg("flat.skinpkg", &with_layout(&layout_json("greeting", &flat(1000)), None));
    let err = expect_rejected(&sb, &pkg);
    assert!(matches!(err, SkinInstallError::InvalidLayout(LayoutValidationError::TooManyNodes { count, max }) if count > MAX_NODES && max == MAX_NODES), "{err}");
}

#[test]
fn unregistered_component_ref_is_rejected() {
    let sb = Sandbox::new();
    for reference in ["app:weatherCard", "primitive:iframe", "custom:notDefined"] {
        let pkg = sb.pkg("ref.skinpkg", &with_layout(&layout_json("greeting", &component(reference)), None));
        let err = expect_rejected(&sb, &pkg);
        assert!(matches!(err, SkinInstallError::InvalidLayout(LayoutValidationError::UnknownRef { .. })), "{reference}: {err}");
    }
    let pkg = sb.pkg("ref2.skinpkg", &with_layout(&layout_json("greeting", &component("javascript:alert(1)")), None));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::InvalidLayout(LayoutValidationError::InvalidRef { .. })));
}

#[test]
fn callback_looking_prop_is_rejected() {
    let sb = Sandbox::new();
    let node = r#"{"type":"component","ref":"primitive:box","props":{"padding":8,"onClick":"fetch('https://evil.example')"}}"#;
    let pkg = sb.pkg("onclick.skinpkg", &with_layout(&layout_json("greeting", node), None));
    let err = expect_rejected(&sb, &pkg);
    assert!(matches!(err, SkinInstallError::InvalidLayout(LayoutValidationError::ForbiddenProp { ref key }) if key == "onClick"), "{err}");
    // As a node-level key it is refused by the schema itself.
    let node = r#"{"type":"component","ref":"primitive:box","onClick":"x"}"#;
    let pkg = sb.pkg("onclick2.skinpkg", &with_layout(&layout_json("greeting", node), None));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::InvalidLayout(LayoutValidationError::MalformedJson { .. })));
    // And inside a composite template.
    let comps = r#"{"c":{"params":[],"template":{"type":"component","ref":"primitive:box","props":{"onload":"x"}}}}"#;
    let pkg = sb.pkg("onclick3.skinpkg", &with_layout(&layout_json("greeting", &component("custom:c")), Some(comps)));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::InvalidLayout(LayoutValidationError::ForbiddenProp { .. })));
}

#[test]
fn circular_composites_are_rejected_and_named() {
    let sb = Sandbox::new();
    let comps = r#"{
        "a":{"params":[],"template":{"type":"container","direction":"row","children":[{"type":"component","ref":"custom:b"}]}},
        "b":{"params":[],"template":{"type":"component","ref":"custom:a"}}
    }"#;
    let pkg = sb.pkg("cycle.skinpkg", &with_layout(&layout_json("greeting", &component("custom:a")), Some(comps)));
    let err = expect_rejected(&sb, &pkg);
    match err {
        SkinInstallError::InvalidLayout(LayoutValidationError::CircularReference(names)) => assert_eq!(names, ["a", "b", "a"]),
        other => panic!("expected a named cycle, got {other}"),
    }
}

#[test]
fn exponential_composite_expansion_is_caught_before_expanding() {
    let sb = Sandbox::new();
    // 10 layers × fanout 10 = 10^10 expanded nodes, no cycle, ~3 KB of JSON.
    let comps = exponential_components(10, 10);
    assert!(comps.len() < 8 * 1024);
    let pkg = sb.pkg("expo.skinpkg", &with_layout(&layout_json("greeting", &component("custom:l9")), Some(&comps)));
    let started = Instant::now();
    let err = expect_rejected(&sb, &pkg);
    let took = started.elapsed();
    assert!(matches!(err, SkinInstallError::InvalidLayout(LayoutValidationError::ExpansionTooLarge { max }) if max == MAX_EXPANDED_NODES), "{err}");
    // 10^10 nodes at even a nanosecond each is ten seconds; the cap trips after ~2000.
    assert!(took.as_millis() < 1000, "validation took {took:?} — it expanded instead of counting");
}

#[test]
fn undeclared_placeholder_in_composite_is_rejected() {
    let sb = Sandbox::new();
    let comps = r#"{"card":{"params":["title"],"template":{"type":"component","ref":"primitive:text","props":{"content":"{{title}} {{secret}}"}}}}"#;
    let pkg = sb.pkg("param.skinpkg", &with_layout(&layout_json("greeting", &component("custom:card")), Some(comps)));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::InvalidLayout(LayoutValidationError::UndeclaredParam { .. })));
}

/* --------------------------------------------------------- stylesheet attacks */

#[test]
fn stylesheets_that_reach_outside_the_package_are_rejected() {
    let sb = Sandbox::new();
    for css in [
        "@import url(https://tracker.example/a.css);",
        ".x { background: url(https://tracker.example/px.gif) }",
        ".x { background: url(file:///etc/passwd) }",
        ".x { width: expression(alert(1)) }",
        "@font-face { src: url(assets/../manifest.json) }",
    ] {
        let pkg = sb.pkg("css.skinpkg", &[entry("manifest.json", MANIFEST), entry("tokens.css", css)]);
        let err = expect_rejected(&sb, &pkg);
        assert!(matches!(err, SkinInstallError::InvalidStylesheet { .. }), "{css}: {err}");
    }
    let pkg = sb.pkg("svg.skinpkg", &with_extra(entry("assets/a.svg", r#"<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('https://x')"/>"#)));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::InvalidSvg { .. }));
}

/* ---------------------------------------------------------- store concurrency */

#[test]
fn concurrent_set_active_leaves_a_whole_state_file() {
    let sb = Sandbox::new();
    for i in 0..4 {
        let manifest = MANIFEST.replace("probe-skin", &format!("skin-{i}"));
        let pkg = sb.pkg(&format!("s{i}.skinpkg"), &with_manifest(&manifest));
        install_skin_package(&pkg, &sb.skins(), &opts()).unwrap();
    }
    let barrier = Arc::new(Barrier::new(4));
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let (state, skins, barrier) = (sb.state(), sb.skins(), barrier.clone());
            thread::spawn(move || {
                barrier.wait();
                for _ in 0..25 {
                    SkinStore::set_active_skin(&state, &skins, &format!("skin-{i}")).unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let raw = fs::read_to_string(sb.state()).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).expect("state file is whole JSON after interleaved writes");
    let active = v["active"].as_str().unwrap();
    assert!(active.starts_with("skin-"), "{raw}");
    let stray: Vec<_> = fs::read_dir(sb.root.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect();
    assert!(stray.is_empty(), "temp files left: {stray:?}");

    // Two calls in quick succession, in order: the last one is what the file says.
    SkinStore::set_active_skin(&sb.state(), &sb.skins(), "skin-1").unwrap();
    SkinStore::set_active_skin(&sb.state(), &sb.skins(), "skin-2").unwrap();
    assert_eq!(SkinStore::get_active_skin(&sb.state()).as_deref(), Some("skin-2"));
    SkinStore::delete_skin(&sb.skins(), &sb.state(), "skin-2").unwrap();
    assert_eq!(SkinStore::get_active_skin(&sb.state()), None);
    SkinStore::set_active_skin(&sb.state(), &sb.skins(), DEFAULT_SKIN_ID).unwrap();
}

/* ---------------------------------------------------------- reinstall safety */

#[test]
fn a_rejected_reinstall_leaves_the_installed_version_intact() {
    let sb = Sandbox::new();
    let pkg = sb.pkg("v1.skinpkg", &good_entries());
    install_skin_package(&pkg, &sb.skins(), &opts()).unwrap();
    let tokens_before = fs::read_to_string(sb.skins_dir().join("probe-skin").join("tokens.css")).unwrap();
    let bad = sb.pkg("v2.skinpkg", &with_extra(entry("payload.exe", "MZ")));
    let err = install_skin_package(&bad, &sb.skins(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::DisallowedFileType(_)));
    assert_eq!(fs::read_to_string(sb.skins_dir().join("probe-skin").join("tokens.css")).unwrap(), tokens_before);
    assert!(!sb.skins_dir().join("probe-skin.tmp").exists());
}

/* ------------------------------------------------------- zip-tool metadata */

#[test]
fn os_metadata_from_zip_tools_is_skipped_not_extracted() {
    let sb = Sandbox::new();
    let mut entries = good_entries();
    // What macOS Finder's "Compress" and Windows Explorer leave in an archive.
    entries.push(entry("__MACOSX/._tokens.css", vec![0u8, 5, 22, 7, 0, 2, 0, 0, 0xff, 0xfe]));
    entries.push(entry("__MACOSX/assets/._bg.png", vec![0u8, 5, 22, 7]));
    entries.push(entry(".DS_Store", vec![0u8, 0, 0, 1, 66, 117, 100, 49]));
    entries.push(entry("assets/.DS_Store", vec![0u8, 1]));
    entries.push(entry("._manifest.json", vec![0u8, 5, 22, 7]));
    entries.push(entry("Thumbs.db", vec![0u8; 16]));
    entries.push(entry("assets/desktop.ini", "[.ShellClassInfo]"));
    let pkg = sb.pkg("finder.skinpkg", &entries);
    let out = install_skin_package(&pkg, &sb.skins(), &opts()).expect("zip-tool metadata does not block an install");
    assert_eq!(out.files.len(), 3, "only the package's own files are extracted: {:?}", out.files);
    let dir = sb.skins_dir().join("probe-skin");
    for junk in ["__MACOSX", ".DS_Store", "assets/.DS_Store", "._manifest.json", "Thumbs.db", "assets/desktop.ini"] {
        assert!(!dir.join(junk).exists(), "{junk} was written");
    }

    // Skipping is decided after the path check: a metadata name cannot smuggle a traversal.
    let sb = Sandbox::new();
    for evil in ["__MACOSX/../../evil.css", "../__MACOSX/x.css", "._/../../evil.css"] {
        let pkg = sb.pkg("finder-evil.skinpkg", &with_extra(entry(evil, "x")));
        assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::PathTraversal(_)), "{evil}");
    }
    // And the hard rule still holds for everything that is not metadata.
    let pkg = sb.pkg("finder-exe.skinpkg", &with_extra(entry("assets/._ok.png/../run.exe", "MZ")));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::PathTraversal(_)));
    let pkg = sb.pkg("notes.skinpkg", &with_extra(entry("DS_Store", "x")));
    assert!(matches!(expect_rejected(&sb, &pkg), SkinInstallError::DisallowedFileType(_)));
}

/* ---------------------------------------------------------------- sidebar.json */

#[test]
fn a_valid_sidebar_installs() {
    let sb = Sandbox::new();
    let sidebar = r#"{
        "brand": { "logo": "assets/bg.png", "height": 20 },
        "nav": { "order": ["library", "new-chat"], "items": { "new-chat": { "icon": "icon:sparkles", "label": { "default": "Chat", "zh": "对话" } } } },
        "sections": { "projects": { "hidden": true } },
        "menu": { "settings": { "icon": "assets/bg.png", "label": "Preferences" } }
    }"#;
    let pkg = sb.pkg("sidebar.skinpkg", &with_extra(entry("sidebar.json", sidebar)));
    let out = install_skin_package(&pkg, &sb.skins(), &opts()).expect("a valid sidebar installs");
    assert!(out.has_sidebar);
    assert!(sb.skins_dir().join("probe-skin").join("sidebar.json").is_file());
}

#[test]
fn a_bad_sidebar_rejects_the_whole_package_and_writes_nothing() {
    for (sidebar, code) in [
        (r#"{"brand":{"logo":"assets/missing.svg"}}"#, "sidebarMissingAsset"),
        (r#"{"nav":{"items":{"new-chat":{"icon":"assets/../manifest.json"}}}}"#, "sidebarInvalidIcon"),
        (r#"{"nav":{"items":{"new-chat":{"icon":"../../../etc/passwd.svg"}}}}"#, "sidebarInvalidIcon"),
        (r#"{"nav":{"items":{"new-chat":{"icon":"https://tracker.example/pixel.svg"}}}}"#, "sidebarInvalidIcon"),
        (r#"{"nav":{"items":{"new-chat":{"icon":"icon:not-a-real-icon"}}}}"#, "sidebarInvalidIcon"),
        (r#"{"nav":{"items":{"weather":{"label":"x"}}}}"#, "sidebarUnknownId"),
        (r#"{"menu":{"settings":{"hidden":true}}}"#, "sidebarNotAllowed"),
        (r#"{"controls":{"expand":{"hidden":true}}}"#, "sidebarNotAllowed"),
        (r#"{"nav":{"items":{"new-chat":{"onClick":"alert(1)"}}}}"#, "sidebarMalformed"),
        (r#"{"sections":{"projects":{"label":{"__proto__":"x"}}}}"#, "sidebarInvalidValue"),
    ] {
        let sb = Sandbox::new();
        let pkg = sb.pkg("sidebar-bad.skinpkg", &with_extra(entry("sidebar.json", sidebar)));
        let err = expect_rejected(&sb, &pkg);
        assert!(matches!(err, SkinInstallError::InvalidSidebar(_)), "{sidebar}: {err}");
        assert_eq!(err.code(), code, "{sidebar}: {err}");
        assert!(err.detail().is_some_and(|d| d.contains("sidebar.json")), "the detail names the file: {err}");
    }
}
