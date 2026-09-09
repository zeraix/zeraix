//! Working-directory resolution and containment (mirrors `resolveInside` / `rel` in aiToolkit.mjs).
//!
//! ## Why the workdir is a parameter here and a module global there
//!
//! `aiToolkit.mjs` keeps `WORKDIR` as process-global state mutated over IPC by `setWorkingDir`, so the
//! whole main process has exactly one working directory shared by every conversation and every
//! sub-agent (see `agent-runtime-current-architecture.md` §11.4). A `Workspace` value passed per call
//! removes that global, which is what lets two conversations run against different projects at once —
//! and it costs nothing to do now, whereas retrofitting it later would touch every tool.
//!
//! ## Containment is lexical, on purpose
//!
//! `path.resolve` in Node does not touch the filesystem, so neither does this. Resolving symlinks would
//! be *stricter* — and would also silently break a workspace that is itself reached through a symlink,
//! which is the common case on macOS (`/tmp` → `/private/tmp`) and for anyone whose project lives under
//! a linked directory. Matching the JS behaviour keeps the boundary predictable; the sandbox
//! (spec §21) is where a hard isolation boundary belongs, not here.

use agent_core::{Result, RuntimeError};
use std::path::{Component, Path, PathBuf};

/// A resolved working directory. Every path a tool touches is resolved against one of these.
///
/// ## Two roots, not one
///
/// The workspace is read-write. The ASSET root — the media library, at `<storePath>/media` — is readable
/// and never writable, and is reached either by absolute path or through the `/assets` alias the sandbox
/// mounts it at. `test/asset-root.test.mjs` states the contract it exists for: the model "may read an asset
/// — that is how it composes a clip from footage it generated earlier — and may never alter one".
///
/// This mirrors `resolvePath` in `electron/tools/paths.mjs`, and did not always: when `read_file` and
/// `write_file` moved into this crate they left the second root behind in JavaScript, so reading anything in
/// the media library started failing as "path escapes the working directory" while `asset-root.test.mjs`
/// stayed green — it tests the JS function, which by then was no longer on the path the tools took.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
    /// The read-only second root. `None` is a single-root guard, exactly as before one was configured.
    assets: Option<PathBuf>,
}

impl Workspace {
    /// Adopt a directory as the workspace root, normalising it lexically.
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self { root: normalize(root.as_ref()), assets: None }
    }

    /// Adopt the read-only asset root. An empty path clears it, so the host can send `""` for "not configured"
    /// without the caller having to special-case it.
    pub fn with_assets(mut self, dir: impl AsRef<Path>) -> Self {
        let d = dir.as_ref();
        self.assets = if d.as_os_str().is_empty() { None } else { Some(normalize(d)) };
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn assets(&self) -> Option<&Path> {
        self.assets.as_deref()
    }

    /// Resolve a model-supplied path for READING: the workspace, or the asset root if one is configured.
    ///
    /// `/workspace` and `/workspace/...` are accepted as aliases for the root, matching
    /// `WORKSPACE_ALIAS` in the JS implementation — models reach for that path because the sandbox
    /// mounts the project there. `/assets/...` is the same arrangement for the media library.
    pub fn resolve(&self, p: &str) -> Result<PathBuf> {
        self.resolve_inner(p, false)
    }

    /// Resolve a model-supplied path for WRITING: the workspace only.
    ///
    /// Split from `resolve` rather than taking a flag, so every mutating tool has to name itself at the call
    /// site. The JS twin took `{ write }` defaulting to false for the same reason it matters here: a mutating
    /// caller that forgets gets its write refused as an out-of-bounds read, never the other way round.
    pub fn resolve_write(&self, p: &str) -> Result<PathBuf> {
        self.resolve_inner(p, true)
    }

    fn resolve_inner(&self, p: &str, write: bool) -> Result<PathBuf> {
        // The alias resolves against the asset root FIRST and never falls through to the workspace: `/assets/x`
        // names one specific place, and quietly resolving it somewhere else would hand back a path the caller
        // did not ask for. Unconfigured, it is simply not a valid location.
        if let Some(rest) = strip_alias(p, "/assets") {
            let Some(assets) = self.assets.as_deref() else {
                return Err(RuntimeError::denied(
                    "tool.no_asset_root",
                    format!("no asset folder is configured: {p}"),
                ));
            };
            let abs = normalize(&assets.join(rest));
            if !abs.starts_with(assets) {
                return Err(RuntimeError::denied(
                    "tool.path_escapes_workspace",
                    format!("path escapes the asset folder: {p}"),
                ));
            }
            if write {
                return Err(Self::read_only(p));
            }
            return Ok(abs);
        }

        let stripped = strip_workspace_alias(p);
        let candidate = Path::new(stripped);
        let abs = if candidate.is_absolute() {
            normalize(candidate)
        } else {
            normalize(&self.root.join(candidate))
        };
        if abs.starts_with(&self.root) {
            return Ok(abs);
        }
        // An absolute path may legitimately name the asset folder — that is how a model refers to something it
        // was handed the full path of. Reads pass; a write is refused BY NAME, so the reason is actionable
        // instead of looking like the path was simply wrong.
        if let Some(assets) = self.assets.as_deref() {
            if abs.starts_with(assets) {
                if write {
                    return Err(Self::read_only(p));
                }
                return Ok(abs);
            }
        }
        Err(RuntimeError::denied(
            "tool.path_escapes_workspace",
            format!("path escapes the working directory: {p}"),
        ))
    }

    fn read_only(p: &str) -> RuntimeError {
        RuntimeError::denied("tool.asset_read_only", format!("the asset folder is read-only: {p}"))
    }

    /// Display form: the path relative to the root, with `/` separators. `.` for the root itself.
    ///
    /// Forward slashes on every platform because this string is read by a model and echoed back in
    /// later tool calls; a Windows backslash would come back needing escaping and would not match the
    /// paths in the same conversation's `search_*` output.
    pub fn rel(&self, abs: &Path) -> String {
        // An asset is named by its alias rather than by a path relative to a root it is not under. Stripping
        // the workspace prefix from it fails, and the fallback would render `/data/media/clip.mp4` as the
        // bare `data/media/clip.mp4` — a string that looks relative, and that resolves back to somewhere
        // inside the workspace if the model echoes it into the next call.
        if let Some(assets) = self.assets.as_deref() {
            if let Ok(r) = abs.strip_prefix(assets) {
                let s = join_components(r);
                return if s.is_empty() { "/assets".to_owned() } else { format!("/assets/{s}") };
            }
        }
        let r = abs.strip_prefix(&self.root).unwrap_or(abs);
        let s = join_components(r);
        if s.is_empty() { ".".to_owned() } else { s }
    }
}

/// A path's `Normal` components joined with `/`, the display form every tool result uses.
fn join_components(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `<alias>` and `<alias>/<rest>` both name the aliased root; `<alias>XYZ` is a different path and is not
/// matched. Mirrors the `^/assets(?:/(.*))?$` form of the JS regexes.
fn strip_alias<'a>(p: &'a str, alias: &str) -> Option<&'a str> {
    let rest = p.strip_prefix(alias)?;
    match rest.strip_prefix('/') {
        Some(inner) => Some(inner),
        None if rest.is_empty() => Some(""),
        None => None,
    }
}

/// `/workspace` and `/workspace/<rest>` both mean "the root". Anything else passes through untouched.
fn strip_workspace_alias(p: &str) -> &str {
    let rest = match p.strip_prefix("/workspace") {
        Some(r) => r,
        None => return p,
    };
    match rest.strip_prefix('/') {
        Some(inner) => inner,
        // Exactly "/workspace" (or "/workspaceXYZ", which is a different path entirely).
        None if rest.is_empty() => "",
        None => p,
    }
}

/// Lexical normalisation: resolve `.` and `..` without consulting the filesystem, as `path.resolve`
/// does. `..` at or above the root is clamped rather than escaping, which keeps this total.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    // Nothing to pop: keep the component so a relative path stays relative rather than
                    // silently becoming the root.
                    if !out.has_root() {
                        out.push("..");
                    }
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> Workspace {
        Workspace::new("/home/u/proj")
    }

    #[test]
    fn resolves_relative_paths() {
        assert_eq!(ws().resolve("src/main.rs").unwrap(), PathBuf::from("/home/u/proj/src/main.rs"));
    }

    #[test]
    fn collapses_dot_segments() {
        assert_eq!(ws().resolve("src/../README.md").unwrap(), PathBuf::from("/home/u/proj/README.md"));
    }

    #[test]
    fn refuses_escapes() {
        for bad in ["../secrets", "/etc/passwd", "src/../../outside"] {
            let e = ws().resolve(bad).unwrap_err();
            assert_eq!(e.code, "tool.path_escapes_workspace", "{bad} should be refused");
        }
    }

    #[test]
    fn accepts_the_workspace_alias() {
        assert_eq!(ws().resolve("/workspace").unwrap(), PathBuf::from("/home/u/proj"));
        assert_eq!(ws().resolve("/workspace/a/b").unwrap(), PathBuf::from("/home/u/proj/a/b"));
    }

    // ── The asset root ──────────────────────────────────────────────────────────────────────────────
    //
    // The same contract test/asset-root.test.mjs pins for the JS twin: the model may READ an asset — that is
    // how it composes a clip from footage it generated earlier — and may never alter one. These live here
    // because the JS function is no longer on the path the file tools take.

    const ASSETS: &str = "/data/media";

    fn ws_assets() -> Workspace {
        Workspace::new("/home/u/proj").with_assets(ASSETS)
    }

    #[test]
    fn an_asset_resolves_by_absolute_path_and_through_the_alias() {
        let w = ws_assets();
        assert_eq!(w.resolve("/data/media/clip.mp4").unwrap(), PathBuf::from("/data/media/clip.mp4"));
        assert_eq!(w.resolve("/assets/clip.mp4").unwrap(), PathBuf::from("/data/media/clip.mp4"));
        assert_eq!(w.resolve("/assets").unwrap(), PathBuf::from("/data/media"));
    }

    #[test]
    fn writing_to_an_asset_is_refused_by_alias_and_by_absolute_path() {
        let w = ws_assets();
        for bad in ["/assets/clip.mp4", "/data/media/clip.mp4", "/assets/index.json"] {
            let e = w.resolve_write(bad).unwrap_err();
            assert_eq!(e.code, "tool.asset_read_only", "{bad}");
            // Refused BY NAME, so the reason is actionable instead of looking like a bad path.
            assert!(e.message.contains("read-only"), "{}", e.message);
        }
        // ...and the same paths still read.
        assert!(w.resolve("/assets/index.json").is_ok());
    }

    #[test]
    fn traversal_out_of_the_asset_alias_is_refused() {
        let w = ws_assets();
        for bad in ["/assets/../media-secrets/key.txt", "/assets/../../etc/passwd"] {
            let e = w.resolve(bad).unwrap_err();
            assert_eq!(e.code, "tool.path_escapes_workspace", "{bad}");
        }
    }

    #[test]
    fn a_sibling_sharing_the_asset_folders_name_prefix_is_not_inside_it() {
        // The failure a string-prefix check produces: /data/media-secrets startsWith /data/media.
        let e = ws_assets().resolve("/data/media-secrets/key.txt").unwrap_err();
        assert_eq!(e.code, "tool.path_escapes_workspace");
    }

    #[test]
    fn the_workspace_still_wins_for_everything_that_is_not_an_asset() {
        let w = ws_assets();
        assert_eq!(w.resolve_write("src/main.rs").unwrap(), PathBuf::from("/home/u/proj/src/main.rs"));
        assert_eq!(w.resolve("/workspace/src/main.rs").unwrap(), PathBuf::from("/home/u/proj/src/main.rs"));
    }

    #[test]
    fn an_asset_is_named_by_its_alias_rather_than_a_misleading_relative_path() {
        // The fallback would render this as `data/media/clip.mp4`, which looks relative and would resolve
        // back inside the workspace if the model echoed it into its next call.
        let w = ws_assets();
        assert_eq!(w.rel(Path::new("/data/media/clip.mp4")), "/assets/clip.mp4");
        assert_eq!(w.rel(Path::new("/data/media")), "/assets");
        assert_eq!(w.rel(Path::new("/home/u/proj/src/main.rs")), "src/main.rs");
    }

    #[test]
    fn without_an_asset_folder_the_guard_is_single_root_exactly_as_before() {
        let w = ws();
        assert_eq!(w.assets(), None);
        assert_eq!(w.resolve("/assets/clip.mp4").unwrap_err().code, "tool.no_asset_root");
        assert_eq!(w.resolve("/data/media/clip.mp4").unwrap_err().code, "tool.path_escapes_workspace");
        // An empty asset path means "not configured" rather than "the filesystem root".
        assert_eq!(Workspace::new("/home/u/proj").with_assets("").assets(), None);
    }

    #[test]
    fn the_alias_does_not_match_a_longer_name_that_merely_starts_with_it() {
        // "/assetsXYZ" is a different path entirely, and must not be read as the asset root.
        let e = ws_assets().resolve("/assetsXYZ/clip.mp4").unwrap_err();
        assert_eq!(e.code, "tool.path_escapes_workspace");
    }

    #[test]
    fn rel_uses_forward_slashes_and_dot_for_root() {
        let w = ws();
        assert_eq!(w.rel(Path::new("/home/u/proj")), ".");
        assert_eq!(w.rel(Path::new("/home/u/proj/a/b.txt")), "a/b.txt");
    }

    #[test]
    fn root_itself_is_inside() {
        assert!(ws().resolve(".").is_ok());
    }
}
