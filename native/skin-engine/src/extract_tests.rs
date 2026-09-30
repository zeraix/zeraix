//! Tests for `extract.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;
use std::io::Write;
use zip::write::SimpleFileOptions;

pub(crate) const MANIFEST: &str = r#"{"id":"test-skin","name":"Test","description":"d","author":"a","version":"1.0.0","created_at":"2026-09-11"}"#;
pub(crate) const TOKENS: &str = ":root[data-skin-package] { --primary: #0af; }";

/// Build a zip from (name, bytes) pairs. Deflate for everything, which is what real tools emit.
pub(crate) fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            if name.ends_with('/') {
                w.add_directory(name.trim_end_matches('/'), opts).unwrap();
            } else {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
        }
        w.finish().unwrap();
    }
    cursor.into_inner()
}

pub(crate) fn write_pkg(dir: &Path, name: &str, entries: &[(&str, &[u8])]) -> String {
    let p = dir.join(name);
    fs::write(&p, build_zip(entries)).unwrap();
    p.to_str().unwrap().to_string()
}

fn opts() -> InstallOptions {
    InstallOptions { allowed_refs: vec!["primitive:box".into(), "app:greeting".into()], app_version: Some("2.0.0".into()), ..Default::default() }
}

fn good_entries() -> Vec<(&'static str, &'static [u8])> {
    vec![(MANIFEST_FILE, MANIFEST.as_bytes()), (TOKENS_FILE, TOKENS.as_bytes()), ("assets/", b""), ("assets/bg.png", b"\x89PNG\r\n\x1a\nfake")]
}

#[test]
fn installs_a_good_package_atomically() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let pkg = write_pkg(tmp.path(), "good.skinpkg", &good_entries());
    let out = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).expect("install");
    assert_eq!(out.manifest.id, "test-skin");
    assert_eq!(out.dir, skins.join("test-skin"));
    assert!(skins.join("test-skin").join("assets").join("bg.png").is_file());
    assert!(skins.join("test-skin").join(MANIFEST_FILE).is_file());
    assert!(!skins.join("test-skin.tmp").exists());
    assert_eq!(out.files.len(), 3);
    assert!(!out.has_layout);
    // Reinstalling replaces the directory and leaves no `.old` behind.
    let pkg2 = write_pkg(tmp.path(), "good2.skinpkg", &[(MANIFEST_FILE, MANIFEST.as_bytes()), (TOKENS_FILE, b"/* v2 */")]);
    install_skin_package(&pkg2, skins.to_str().unwrap(), &opts()).expect("reinstall");
    assert!(!skins.join("test-skin").join("assets").exists());
    let names: Vec<String> = fs::read_dir(&skins).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["test-skin"]);
}

#[test]
fn rejects_zip_slip() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    for evil in ["../../../etc/passwd.css", "/etc/passwd.css", "assets/../../x.png", "..\\x.png", "C:/x.png"] {
        let mut entries = good_entries();
        entries.push((evil, b"x"));
        let pkg = write_pkg(tmp.path(), "slip.skinpkg", &entries);
        let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
        assert!(matches!(err, SkinInstallError::PathTraversal(_)), "{evil}: {err}");
        assert!(!skins.exists() || fs::read_dir(&skins).unwrap().next().is_none());
    }
}

#[test]
fn rejects_disallowed_extensions_hard() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    for (name, expect) in [("tools/run.exe", "tools/run.exe (.exe)"), ("run.sh", "run.sh (.sh)"), ("README", "README (no extension)"), ("a.PNG.js", "a.PNG.js (.js)")] {
        let mut entries = good_entries();
        entries.push((name, b"x"));
        let pkg = write_pkg(tmp.path(), "ext.skinpkg", &entries);
        let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
        assert!(matches!(err, SkinInstallError::DisallowedFileType(ref d) if d == expect), "{name}: {err}");
        assert_eq!(err.code(), "disallowedFileType");
        assert_eq!(err.detail().as_deref(), Some(expect));
    }
    assert!(!skins.exists());
    // Uppercase extensions are fine.
    let mut entries = good_entries();
    entries.push(("assets/Logo.PNG", b"x"));
    let pkg = write_pkg(tmp.path(), "upper.skinpkg", &entries);
    install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).expect("uppercase extension");
}

#[test]
fn rejects_oversized_entries_and_totals_from_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let big = vec![0u8; (MAX_FILE_BYTES + 1) as usize];
    let mut entries = good_entries();
    entries.push(("assets/big.png", &big));
    let pkg = write_pkg(tmp.path(), "big.skinpkg", &entries);
    let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::SizeLimit(_)), "{err}");
    assert!(!skins.exists());

    // Six 9 MB files: each under the per-file cap, together over the total.
    let chunk = vec![0u8; 9 * 1024 * 1024];
    let names = ["assets/a.png", "assets/b.png", "assets/c.png", "assets/d.png", "assets/e.png", "assets/f.png"];
    let mut entries = good_entries();
    for n in names {
        entries.push((n, &chunk));
    }
    let pkg = write_pkg(tmp.path(), "bomb.skinpkg", &entries);
    let started = std::time::Instant::now();
    let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::SizeLimit(_)), "{err}");
    assert!(started.elapsed().as_secs() < 5, "the total must be refused from metadata, not by inflating");
    assert!(!skins.exists());
}

#[test]
fn rejects_missing_manifest_missing_tokens_and_nested_root() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let pkg = write_pkg(tmp.path(), "nomanifest.skinpkg", &[(TOKENS_FILE, TOKENS.as_bytes())]);
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::MissingManifest));
    let pkg = write_pkg(tmp.path(), "nested.skinpkg", &[("my-skin/manifest.json", MANIFEST.as_bytes()), ("my-skin/tokens.css", TOKENS.as_bytes())]);
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::MissingManifest));
    let pkg = write_pkg(tmp.path(), "notokens.skinpkg", &[(MANIFEST_FILE, MANIFEST.as_bytes())]);
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::MissingTokens));
    assert!(!skins.exists());
}

#[test]
fn rejects_bad_manifest_reserved_id_and_incompatible_versions() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let bad = MANIFEST.replace("1.0.0", "one");
    let pkg = write_pkg(tmp.path(), "badver.skinpkg", &[(MANIFEST_FILE, bad.as_bytes()), (TOKENS_FILE, TOKENS.as_bytes())]);
    let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::InvalidManifest(SkinValidationError::InvalidVersion(_))), "{err}");
    assert_eq!(err.code(), "manifestInvalidVersion");

    let bad = MANIFEST.replace("test-skin", "../evil");
    let pkg = write_pkg(tmp.path(), "badid.skinpkg", &[(MANIFEST_FILE, bad.as_bytes()), (TOKENS_FILE, TOKENS.as_bytes())]);
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::InvalidManifest(SkinValidationError::InvalidId(_))));

    let bad = MANIFEST.replace("test-skin", "current");
    let pkg = write_pkg(tmp.path(), "reserved.skinpkg", &[(MANIFEST_FILE, bad.as_bytes()), (TOKENS_FILE, TOKENS.as_bytes())]);
    // Reserved ids are refused by the manifest validator already; the install error wraps it.
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::InvalidManifest(SkinValidationError::InvalidId(_))));

    let bad = MANIFEST.replace("\"version\":\"1.0.0\"", "\"version\":\"1.0.0\",\"min_app_version\":\"9.0.0\"");
    let pkg = write_pkg(tmp.path(), "incompat.skinpkg", &[(MANIFEST_FILE, bad.as_bytes()), (TOKENS_FILE, TOKENS.as_bytes())]);
    let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::Incompatible { .. }), "{err}");
    assert!(!skins.exists());
}

#[test]
fn rejects_remote_css_and_scripted_svg() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let pkg = write_pkg(tmp.path(), "css.skinpkg", &[(MANIFEST_FILE, MANIFEST.as_bytes()), (TOKENS_FILE, b"@import url(https://x.example/a.css);")]);
    let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::InvalidStylesheet { .. }), "{err}");
    let mut entries = good_entries();
    entries.push(("assets/extra.css", b".x{background:url(https://x.example/p.gif)}"));
    let pkg = write_pkg(tmp.path(), "css2.skinpkg", &entries);
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::InvalidStylesheet { .. }));
    let mut entries = good_entries();
    entries.push(("assets/logo.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"));
    let pkg = write_pkg(tmp.path(), "svg.skinpkg", &entries);
    assert!(matches!(install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err(), SkinInstallError::InvalidSvg { .. }));
    assert!(!skins.exists());
}

#[test]
fn validates_layout_and_components_at_install_time() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let layout = br#"{"regions":{"greeting":{"type":"component","ref":"custom:card","props":{"title":"Hi"}}}}"#;
    let comps = br#"{"card":{"params":["title"],"template":{"type":"container","direction":"column","children":[{"type":"component","ref":"primitive:box","props":{"label":"{{title}}"}}]}}}"#;
    let mut entries = good_entries();
    entries.push((LAYOUT_FILE, layout));
    entries.push((COMPONENTS_FILE, comps));
    let pkg = write_pkg(tmp.path(), "layout.skinpkg", &entries);
    let out = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).expect("layout install");
    assert!(out.has_layout && out.has_components);
    assert_eq!(out.regions, ["greeting"]);

    let bad_layout = br#"{"regions":{"greeting":{"type":"component","ref":"app:weatherCard"}}}"#;
    let mut entries = good_entries();
    entries.push((LAYOUT_FILE, bad_layout));
    let pkg = write_pkg(tmp.path(), "badlayout.skinpkg", &entries);
    let err = install_skin_package(&pkg, skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::InvalidLayout(LayoutValidationError::UnknownRef { .. })), "{err}");
    assert_eq!(err.code(), "layoutUnknownRef");
    // The earlier good install is untouched by the failed one.
    assert!(skins.join("test-skin").join(LAYOUT_FILE).is_file());
    assert!(!skins.join("test-skin.tmp").exists());
}

#[test]
fn a_lying_size_header_is_caught_while_writing() {
    // Build a valid zip, then patch the central directory's uncompressed size of tokens.css
    // down to 1 byte. The scan trusts it; the write pass must not.
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let body = b"/* padding padding padding padding padding padding */".to_vec();
    let mut bytes = build_zip(&[(MANIFEST_FILE, MANIFEST.as_bytes()), (TOKENS_FILE, &body)]);
    // Central directory file header signature 0x02014b50; uncompressed size is at offset 24.
    let sig = [0x50, 0x4b, 0x01, 0x02];
    let mut at = 0;
    let mut patched = false;
    while let Some(pos) = bytes[at..].windows(4).position(|w| w == sig) {
        let start = at + pos;
        let name_len = u16::from_le_bytes([bytes[start + 28], bytes[start + 29]]) as usize;
        let name = &bytes[start + 46..start + 46 + name_len];
        if name == TOKENS_FILE.as_bytes() {
            bytes[start + 24..start + 28].copy_from_slice(&1u32.to_le_bytes());
            patched = true;
        }
        at = start + 4;
    }
    assert!(patched);
    let p = tmp.path().join("lying.skinpkg");
    fs::write(&p, &bytes).unwrap();
    let err = install_skin_package(p.to_str().unwrap(), skins.to_str().unwrap(), &opts()).unwrap_err();
    // Rejected — as a size or a corrupt-archive error depending on how the reader reports the
    // mismatch — and nothing is left behind either way.
    assert!(matches!(err, SkinInstallError::SizeLimit(_) | SkinInstallError::CorruptArchive(_)), "{err}");
    assert!(!skins.join("test-skin").exists());
    assert!(!skins.join("test-skin.tmp").exists());
}

#[test]
fn unreadable_and_corrupt_sources() {
    let tmp = tempfile::tempdir().unwrap();
    let skins = tmp.path().join("skins");
    let err = install_skin_package(tmp.path().join("missing.skinpkg").to_str().unwrap(), skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::Unreadable(_)));
    let p = tmp.path().join("garbage.skinpkg");
    fs::write(&p, b"this is not a zip").unwrap();
    let err = install_skin_package(p.to_str().unwrap(), skins.to_str().unwrap(), &opts()).unwrap_err();
    assert!(matches!(err, SkinInstallError::CorruptArchive(_)));
    assert_eq!(err.code(), "packageCorrupt");
}
