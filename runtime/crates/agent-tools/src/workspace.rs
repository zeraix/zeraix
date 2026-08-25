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
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// Adopt a directory as the workspace root, normalising it lexically.
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self { root: normalize(root.as_ref()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a model-supplied path inside the workspace, refusing anything that escapes it.
    ///
    /// `/workspace` and `/workspace/...` are accepted as aliases for the root, matching
    /// `WORKSPACE_ALIAS` in the JS implementation — models reach for that path because the sandbox
    /// mounts the project there.
    pub fn resolve(&self, p: &str) -> Result<PathBuf> {
        let stripped = strip_workspace_alias(p);
        let candidate = Path::new(stripped);
        let abs = if candidate.is_absolute() {
            normalize(candidate)
        } else {
            normalize(&self.root.join(candidate))
        };
        if !abs.starts_with(&self.root) {
            return Err(RuntimeError::denied(
                "tool.path_escapes_workspace",
                format!("path escapes the working directory: {p}"),
            ));
        }
        Ok(abs)
    }

    /// Display form: the path relative to the root, with `/` separators. `.` for the root itself.
    ///
    /// Forward slashes on every platform because this string is read by a model and echoed back in
    /// later tool calls; a Windows backslash would come back needing escaping and would not match the
    /// paths in the same conversation's `search_*` output.
    pub fn rel(&self, abs: &Path) -> String {
        let r = abs.strip_prefix(&self.root).unwrap_or(abs);
        let s: Vec<String> = r
            .components()
            .filter_map(|c| match c {
                Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        if s.is_empty() { ".".to_owned() } else { s.join("/") }
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
