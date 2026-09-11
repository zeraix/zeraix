//! Installed packages and the active-skin state file.
//!
//! Layout on disk, all under a directory the app owns:
//!
//! ```text
//! <skins_dir>/<id>/manifest.json      one directory per installed package (see extract.rs)
//! <skins_dir>/<id>/tokens.css
//! <state_path>                        {"active": "<id>"} — which skin is on
//! ```
//!
//! Listing re-validates every manifest, because the directory is user-writable and a hand edit is
//! untrusted input; one broken package is skipped with a warning rather than breaking the list.
//! The state file is written through a temp file and a rename, so a crash mid-write leaves the old
//! state, never a truncated file; writes are also serialised in-process, so two calls landing on
//! the thread pool at once cannot interleave.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::manifest::{SkinManifest, is_safe_relative_path, is_valid_skin_id, validate_manifest};
use crate::{DEFAULT_SKIN_ID, is_builtin_id};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SkinStoreError {
    #[error("skin id \"{0}\" is invalid")]
    InvalidId(String),
    #[error("path \"{0}\" is not a text file inside the package")]
    InvalidPath(String),
    #[error("skin \"{0}\" is not installed")]
    NotFound(String),
    #[error("skin \"{id}\" has an invalid manifest: {reason}")]
    InvalidManifest { id: String, reason: String },
    #[error("filesystem error: {0}")]
    Io(String),
}

impl SkinStoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId(_) => "invalidId",
            Self::InvalidPath(_) => "invalidPath",
            Self::NotFound(_) => "notFound",
            Self::InvalidManifest { .. } => "manifestInvalid",
            Self::Io(_) => "io",
        }
    }

    pub fn detail(&self) -> Option<String> {
        match self {
            Self::InvalidId(id) | Self::NotFound(id) | Self::InvalidPath(id) => Some(id.clone()),
            Self::InvalidManifest { id, reason } => Some(format!("{id}: {reason}")),
            Self::Io(e) => Some(e.clone()),
        }
    }
}

impl From<std::io::Error> for SkinStoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ActiveState {
    active: String,
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write `text` to `path` through a sibling temp file and a rename. The rename is the commit.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), SkinStoreError> {
    write_atomic_bytes(path, text.as_bytes())
}

/// Bytes form of [`write_atomic`]: the package template the settings page saves is a zip.
pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), SkinStoreError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tmp = path.with_file_name(format!("{name}.{}.{seq}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(Into::into)
}

pub struct SkinStore;

impl SkinStore {
    fn dir_of(skins_dir: &str, id: &str) -> Result<PathBuf, SkinStoreError> {
        if !is_valid_skin_id(id) {
            return Err(SkinStoreError::InvalidId(id.to_string()));
        }
        Ok(Path::new(skins_dir).join(id))
    }

    /// The validated manifest of one installed package. The directory name is the id: a manifest
    /// claiming another id does not get to become that skin.
    pub fn read_manifest(skins_dir: &str, id: &str) -> Result<SkinManifest, SkinStoreError> {
        let dir = Self::dir_of(skins_dir, id)?;
        let path = dir.join(crate::extract::MANIFEST_FILE);
        if !dir.is_dir() || !path.is_file() {
            return Err(SkinStoreError::NotFound(id.to_string()));
        }
        let raw = fs::read_to_string(&path)?;
        let manifest = validate_manifest(&raw).map_err(|e| SkinStoreError::InvalidManifest { id: id.to_string(), reason: e.to_string() })?;
        if manifest.id != id {
            return Err(SkinStoreError::InvalidManifest { id: id.to_string(), reason: format!("manifest id \"{}\" does not match its directory", manifest.id) });
        }
        Ok(manifest)
    }

    /// Every installed package with a valid manifest, sorted by name. Broken ones are skipped with
    /// a warning on stderr — where the Electron main process's log goes.
    pub fn list_skins(skins_dir: &str) -> Vec<SkinManifest> {
        let Ok(entries) = fs::read_dir(skins_dir) else { return Vec::new() };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            if !entry.path().is_dir() || !is_valid_skin_id(&name) {
                continue;
            }
            match Self::read_manifest(skins_dir, &name) {
                Ok(m) => out.push(m),
                Err(e) => eprintln!("[skin-engine] skipping {name}: {e}"),
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// The active skin id, or `None` for the default / a missing or unreadable state file.
    pub fn get_active_skin(state_path: &str) -> Option<String> {
        let raw = fs::read_to_string(state_path).ok()?;
        let state: ActiveState = serde_json::from_str(&raw).ok()?;
        let id = state.active;
        if id == DEFAULT_SKIN_ID || !(is_valid_skin_id(&id) || is_builtin_id(&id)) {
            return None;
        }
        Some(id)
    }

    /// Persist the choice. A package id must name an installed, valid package; the default and
    /// `builtin-*` presets have no directory and are always accepted.
    pub fn set_active_skin(state_path: &str, skins_dir: &str, skin_id: &str) -> Result<(), SkinStoreError> {
        if !is_builtin_id(skin_id) {
            Self::read_manifest(skins_dir, skin_id)?;
        }
        let text = serde_json::to_string(&ActiveState { active: skin_id.to_string() }).map_err(|e| SkinStoreError::Io(e.to_string()))?;
        write_atomic(Path::new(state_path), &text)
    }

    /// The text of one `.json` / `.css` file inside an installed package, or `None` when the package
    /// has no such file (most skins ship no layout.json).
    ///
    /// This is how the renderer reads layout.json, components.json and tokens.css for a preview:
    /// Chromium refuses `fetch()` to a custom scheme from another origin whatever the handler
    /// answers, so `skin://` only serves what element loads need (the stylesheet, images) and the
    /// JSON comes over IPC through here. Same path rules as the protocol: a plain relative path,
    /// inside the package directory, a regular file, and small.
    pub fn read_text(skins_dir: &str, id: &str, rel: &str) -> Result<Option<String>, SkinStoreError> {
        let dir = Self::dir_of(skins_dir, id)?;
        let ext = rel.rsplit('/').next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase());
        if !is_safe_relative_path(rel) || !matches!(ext.as_deref(), Some("json") | Some("css")) {
            return Err(SkinStoreError::InvalidPath(rel.to_string()));
        }
        if !dir.is_dir() {
            return Err(SkinStoreError::NotFound(id.to_string()));
        }
        let path = dir.join(rel);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };
        if !meta.is_file() {
            return Ok(None);
        }
        if meta.len() > crate::extract::MAX_TEXT_BYTES {
            return Err(SkinStoreError::Io(format!("{rel} is larger than {} bytes", crate::extract::MAX_TEXT_BYTES)));
        }
        let text = fs::read_to_string(&path)?;
        Ok(Some(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text)))
    }

    /// Remove a package; if it was active, fall back to the default first so no window ever points
    /// at a directory that is mid-deletion.
    pub fn delete_skin(skins_dir: &str, state_path: &str, skin_id: &str) -> Result<(), SkinStoreError> {
        let dir = Self::dir_of(skins_dir, skin_id)?;
        if !dir.is_dir() {
            return Err(SkinStoreError::NotFound(skin_id.to_string()));
        }
        if Self::get_active_skin(state_path).as_deref() == Some(skin_id) {
            Self::set_active_skin(state_path, skins_dir, DEFAULT_SKIN_ID)?;
        }
        fs::remove_dir_all(&dir)?;
        // A stale temp directory from an interrupted reinstall goes with it.
        let _ = fs::remove_dir_all(Path::new(skins_dir).join(format!("{skin_id}{}", crate::extract::TMP_SUFFIX)));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn manifest(id: &str, name: &str) -> String {
        format!(r#"{{"id":"{id}","name":"{name}","description":"","author":"","version":"1.0.0","created_at":"2026-09-11"}}"#)
    }

    fn install(skins: &Path, id: &str, name: &str) {
        let dir = skins.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest(id, name)).unwrap();
        fs::write(dir.join("tokens.css"), ":root{}").unwrap();
    }

    #[test]
    fn lists_valid_packages_and_skips_broken_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let skins = tmp.path().join("skins");
        install(&skins, "zeta", "Zeta");
        install(&skins, "alpha", "Alpha");
        // Broken: bad JSON, a manifest whose id disagrees with its folder, a file, a temp dir.
        fs::create_dir_all(skins.join("broken")).unwrap();
        fs::write(skins.join("broken").join("manifest.json"), "{").unwrap();
        fs::create_dir_all(skins.join("liar")).unwrap();
        fs::write(skins.join("liar").join("manifest.json"), manifest("alpha", "Liar")).unwrap();
        fs::write(skins.join("stray.txt"), "x").unwrap();
        fs::create_dir_all(skins.join("alpha.tmp")).unwrap();
        fs::create_dir_all(skins.join("Not-Kebab")).unwrap();
        let ids: Vec<String> = SkinStore::list_skins(skins.to_str().unwrap()).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["alpha", "zeta"]);
        assert!(SkinStore::list_skins(tmp.path().join("nope").to_str().unwrap()).is_empty());
    }

    #[test]
    fn active_state_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let skins = tmp.path().join("skins");
        let state = tmp.path().join("active.json");
        let (s, k) = (state.to_str().unwrap(), skins.to_str().unwrap());
        install(&skins, "alpha", "Alpha");
        assert_eq!(SkinStore::get_active_skin(s), None);
        SkinStore::set_active_skin(s, k, "alpha").unwrap();
        assert_eq!(SkinStore::get_active_skin(s).as_deref(), Some("alpha"));
        SkinStore::set_active_skin(s, k, "builtin-midnight").unwrap();
        assert_eq!(SkinStore::get_active_skin(s).as_deref(), Some("builtin-midnight"));
        SkinStore::set_active_skin(s, k, DEFAULT_SKIN_ID).unwrap();
        assert_eq!(SkinStore::get_active_skin(s), None);
        // No temp files left beside the state file.
        let names: Vec<String> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn set_active_refuses_unknown_invalid_and_broken() {
        let tmp = tempfile::tempdir().unwrap();
        let skins = tmp.path().join("skins");
        let state = tmp.path().join("active.json");
        let (s, k) = (state.to_str().unwrap(), skins.to_str().unwrap());
        assert!(matches!(SkinStore::set_active_skin(s, k, "ghost").unwrap_err(), SkinStoreError::NotFound(_)));
        assert!(matches!(SkinStore::set_active_skin(s, k, "../x").unwrap_err(), SkinStoreError::InvalidId(_)));
        assert!(matches!(SkinStore::set_active_skin(s, k, "current").unwrap_err(), SkinStoreError::InvalidId(_)));
        fs::create_dir_all(skins.join("broken")).unwrap();
        fs::write(skins.join("broken").join("manifest.json"), "nope").unwrap();
        assert!(matches!(SkinStore::set_active_skin(s, k, "broken").unwrap_err(), SkinStoreError::InvalidManifest { .. }));
        assert!(!state.exists(), "a refused set must not create the state file");
    }

    #[test]
    fn corrupt_or_foreign_state_reads_as_default() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("active.json");
        let s = state.to_str().unwrap();
        fs::write(&state, "{ not json").unwrap();
        assert_eq!(SkinStore::get_active_skin(s), None);
        fs::write(&state, r#"{"active":"../../etc"}"#).unwrap();
        assert_eq!(SkinStore::get_active_skin(s), None);
        fs::write(&state, r#"{"active":"current"}"#).unwrap();
        assert_eq!(SkinStore::get_active_skin(s), None);
        fs::write(&state, r#"{"active":"fine-id"}"#).unwrap();
        assert_eq!(SkinStore::get_active_skin(s).as_deref(), Some("fine-id"));
    }

    #[test]
    fn delete_removes_and_falls_back_to_default() {
        let tmp = tempfile::tempdir().unwrap();
        let skins = tmp.path().join("skins");
        let state = tmp.path().join("active.json");
        let (s, k) = (state.to_str().unwrap(), skins.to_str().unwrap());
        install(&skins, "alpha", "Alpha");
        install(&skins, "beta", "Beta");
        fs::create_dir_all(skins.join("alpha.tmp")).unwrap();
        SkinStore::set_active_skin(s, k, "alpha").unwrap();
        SkinStore::delete_skin(k, s, "alpha").unwrap();
        assert!(!skins.join("alpha").exists());
        assert!(!skins.join("alpha.tmp").exists());
        assert_eq!(SkinStore::get_active_skin(s), None);
        // Deleting a non-active one leaves the state alone.
        SkinStore::set_active_skin(s, k, "beta").unwrap();
        install(&skins, "gamma", "Gamma");
        SkinStore::delete_skin(k, s, "gamma").unwrap();
        assert_eq!(SkinStore::get_active_skin(s).as_deref(), Some("beta"));
        assert!(matches!(SkinStore::delete_skin(k, s, "gamma").unwrap_err(), SkinStoreError::NotFound(_)));
        assert!(matches!(SkinStore::delete_skin(k, s, "../etc").unwrap_err(), SkinStoreError::InvalidId(_)));
    }

    #[test]
    fn read_text_serves_package_text_files_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let skins = tmp.path().join("skins");
        let k = skins.to_str().unwrap();
        install(&skins, "alpha", "Alpha");
        fs::write(skins.join("alpha").join("layout.json"), "\u{feff}{\"regions\":{}}").unwrap();
        fs::create_dir_all(skins.join("alpha").join("assets")).unwrap();
        fs::write(skins.join("alpha").join("assets").join("a.png"), "png").unwrap();
        fs::create_dir_all(skins.join("alpha").join("dir.json")).unwrap();
        fs::write(skins.join("outside.json"), "{}").unwrap();
        assert_eq!(SkinStore::read_text(k, "alpha", "layout.json").unwrap().as_deref(), Some("{\"regions\":{}}"), "BOM stripped");
        assert_eq!(SkinStore::read_text(k, "alpha", "tokens.css").unwrap().as_deref(), Some(":root{}"));
        assert_eq!(SkinStore::read_text(k, "alpha", "components.json").unwrap(), None, "absent is None, not an error");
        assert_eq!(SkinStore::read_text(k, "alpha", "dir.json").unwrap(), None, "a directory reads as absent");
        for bad in ["../outside.json", "/outside.json", "assets/a.png", "assets", "manifest", "a\\b.json", "assets/../../outside.json"] {
            assert!(matches!(SkinStore::read_text(k, "alpha", bad).unwrap_err(), SkinStoreError::InvalidPath(_)), "{bad}");
        }
        assert!(matches!(SkinStore::read_text(k, "ghost", "layout.json").unwrap_err(), SkinStoreError::NotFound(_)));
        assert!(matches!(SkinStore::read_text(k, "../alpha", "layout.json").unwrap_err(), SkinStoreError::InvalidId(_)));
        assert!(matches!(SkinStore::read_text(k, "builtin-midnight", "layout.json").unwrap_err(), SkinStoreError::InvalidId(_)));
    }

    #[test]
    fn write_atomic_bytes_round_trips_binary_and_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("nested").join("template.zip");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        write_atomic_bytes(&out, &bytes).unwrap();
        assert_eq!(fs::read(&out).unwrap(), bytes);
        write_atomic_bytes(&out, b"PK\x05\x06").unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"PK\x05\x06");
        let names: Vec<String> = fs::read_dir(out.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["template.zip"]);
    }

    #[test]
    fn concurrent_writes_never_corrupt_and_sequential_last_call_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let skins = tmp.path().join("skins");
        let state = tmp.path().join("active.json");
        for i in 0..8 {
            install(&skins, &format!("skin-{i}"), &format!("Skin {i}"));
        }
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let (s, k) = (state.to_str().unwrap().to_string(), skins.to_str().unwrap().to_string());
                thread::spawn(move || {
                    for _ in 0..20 {
                        SkinStore::set_active_skin(&s, &k, &format!("skin-{i}")).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let raw = fs::read_to_string(&state).unwrap();
        let parsed: ActiveState = serde_json::from_str(&raw).expect("the state file is always whole JSON");
        assert!(parsed.active.starts_with("skin-"));
        let leftovers: Vec<String> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        let (s, k) = (state.to_str().unwrap(), skins.to_str().unwrap());
        SkinStore::set_active_skin(s, k, "skin-1").unwrap();
        SkinStore::set_active_skin(s, k, "skin-2").unwrap();
        assert_eq!(SkinStore::get_active_skin(s).as_deref(), Some("skin-2"));
    }
}
