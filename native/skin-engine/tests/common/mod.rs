//! Package generators for the security suite. Every malicious archive here is built by code, not
//! checked in as a binary: a fixture nobody can read is a fixture nobody reviews.

#![allow(dead_code)]

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub const MANIFEST: &str = r#"{"id":"probe-skin","name":"Probe","description":"security fixture","author":"tests","version":"1.0.0","created_at":"2026-09-11T00:00:00Z"}"#;
pub const TOKENS: &str = ":root[data-skin-package] { --primary: #0af; --background: #101418; }";

/// The refs the app registers, as the install pipeline receives them.
pub fn allowed_refs() -> Vec<String> {
    ["app:greeting", "app:brandMark", "primitive:box", "primitive:text", "primitive:icon", "primitive:progressRing", "primitive:spacer"]
        .into_iter()
        .map(String::from)
        .collect()
}

/// The sidebar ids and icon names, as electron/skins/layoutRefs.mjs hands them to the installer.
pub fn sidebar_registry() -> skin_engine::sidebar::SidebarRegistry {
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect();
    skin_engine::sidebar::SidebarRegistry {
        nav_items: v(&["new-chat", "skills", "automation", "models", "plugins", "library"]),
        sections: v(&["projects"]),
        controls: v(&["collapse", "expand", "pin", "userMenu"]),
        menu: v(&["settings", "help", "language", "theme", "wallet", "logout", "signIn"]),
        icons: v(&["sparkles", "folder", "settings", "zap"]),
    }
}

pub struct Entry {
    pub name: String,
    pub data: Vec<u8>,
}

pub fn entry(name: &str, data: impl Into<Vec<u8>>) -> Entry {
    Entry { name: name.to_string(), data: data.into() }
}

/// A well-formed package: manifest, tokens, one asset.
pub fn good_entries() -> Vec<Entry> {
    vec![entry("manifest.json", MANIFEST), entry("tokens.css", TOKENS), entry("assets/bg.png", b"\x89PNG\r\n\x1a\n....".to_vec())]
}

pub fn build_zip(entries: &[Entry]) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut w = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for e in entries {
            w.start_file(&e.name, opts).expect("start entry");
            w.write_all(&e.data).expect("write entry");
        }
        w.finish().expect("finish zip");
    }
    cursor.into_inner()
}

pub fn write_pkg(dir: &Path, name: &str, entries: &[Entry]) -> String {
    let p = dir.join(name);
    fs::write(&p, build_zip(entries)).expect("write package");
    p.to_string_lossy().into_owned()
}

/// A package with one extra entry on top of the good ones.
pub fn with_extra(extra: Entry) -> Vec<Entry> {
    let mut e = good_entries();
    e.push(extra);
    e
}

/// A package whose manifest is replaced.
pub fn with_manifest(manifest: &str) -> Vec<Entry> {
    vec![entry("manifest.json", manifest), entry("tokens.css", TOKENS)]
}

/// A package carrying a layout.json (and optionally components.json).
pub fn with_layout(layout: &str, components: Option<&str>) -> Vec<Entry> {
    let mut e = good_entries();
    e.push(entry("layout.json", layout));
    if let Some(c) = components {
        e.push(entry("components.json", c));
    }
    e
}

/* -------------------------------------------------------- layout generators */

pub fn component(reference: &str) -> String {
    format!(r#"{{"type":"component","ref":"{reference}"}}"#)
}

/// A container nested `depth` times around `leaf`.
pub fn nested(depth: usize, leaf: &str) -> String {
    let mut s = leaf.to_string();
    for _ in 0..depth {
        s = format!(r#"{{"type":"container","direction":"column","children":[{s}]}}"#);
    }
    s
}

/// One row holding `n` empty containers.
pub fn flat(n: usize) -> String {
    let children: Vec<String> = (0..n).map(|_| r#"{"type":"container","direction":"row","children":[]}"#.to_string()).collect();
    format!(r#"{{"type":"container","direction":"row","children":[{}]}}"#, children.join(","))
}

pub fn layout_json(region: &str, node: &str) -> String {
    format!(r#"{{"version":1,"regions":{{"{region}":{node}}}}}"#)
}

/// components.json with `layers` composites, each referencing the previous one `fanout` times:
/// fanout^layers expanded nodes from a few kilobytes of JSON.
pub fn exponential_components(layers: usize, fanout: usize) -> String {
    let mut defs = vec![r#""l0":{"params":[],"template":{"type":"component","ref":"primitive:box"}}"#.to_string()];
    for i in 1..layers {
        let children: Vec<String> = (0..fanout).map(|_| format!(r#"{{"type":"component","ref":"custom:l{}"}}"#, i - 1)).collect();
        defs.push(format!(r#""l{i}":{{"params":[],"template":{{"type":"container","direction":"row","children":[{}]}}}}"#, children.join(",")));
    }
    format!("{{{}}}", defs.join(","))
}

/* --------------------------------------------------------------- helpers */

pub struct Sandbox {
    pub root: tempfile::TempDir,
}

impl Sandbox {
    pub fn new() -> Self {
        Self { root: tempfile::tempdir().expect("tempdir") }
    }
    pub fn skins_dir(&self) -> PathBuf {
        self.root.path().join("skin-packages")
    }
    pub fn skins(&self) -> String {
        self.skins_dir().to_string_lossy().into_owned()
    }
    pub fn state(&self) -> String {
        self.root.path().join("skin-packages-active.json").to_string_lossy().into_owned()
    }
    pub fn pkg(&self, name: &str, entries: &[Entry]) -> String {
        write_pkg(self.root.path(), name, entries)
    }
    /// Every path under the skins dir, for the "nothing was written" assertion.
    pub fn skins_contents(&self) -> Vec<String> {
        let mut out = Vec::new();
        fn walk(dir: &Path, out: &mut Vec<String>) {
            let Ok(rd) = fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                out.push(p.to_string_lossy().into_owned());
                if p.is_dir() {
                    walk(&p, out);
                }
            }
        }
        walk(&self.skins_dir(), &mut out);
        out
    }
}
