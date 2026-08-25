//! The workspace file walk and its cache (mirrors `walkFiles` / `walkFilesCached` in aiToolkit.mjs).
//!
//! ## Traversal order is part of the contract
//!
//! `search_files` and `search_in_files` both truncate at `MAX_MATCHES`. Which matches survive the cut
//! therefore depends on the order files are visited in, so a "better" traversal — parallel,
//! gitignore-aware — would change tool output for any query that hits the cap. This walk reproduces the
//! JS one exactly: a depth-first pre-order traversal, recursing into a directory the moment it is
//! encountered rather than after the current level is finished.
//!
//! **Entries are sorted by name bytes, and that is not cosmetic.** `fs.readdir` in Node looks like it
//! returns raw filesystem order, and it does not: libuv implements it with `scandir()` sorted by a
//! `strcmp` comparator, so Node hands back a byte-sorted list on every platform. Rust's `read_dir`
//! really does return raw order — ext4 hash order, which is neither sorted nor stable across trees.
//! Walking without sorting therefore produced a *correct set* of matches in a *different order*, which
//! is invisible until a query hits the cap and then silently returns a different 200 files.
//!
//! This was not caught by reasoning about it; the A/B harness caught it on its first run, which is the
//! argument for comparing whole outputs rather than spot-checking. `strcmp` is a byte comparison, not a
//! collation, so this is locale-independent and does not need `locale_compare` — unlike
//! `list_directory`, which sorts its own output with `localeCompare` and genuinely does need it.
//!
//! ## Symlinks are skipped
//!
//! The JS walk tests `isDirectory()` then `isFile()` on a `Dirent`, neither of which is true for a
//! symlink, so links are silently omitted from the file list. `DirEntry::file_type` in Rust is
//! likewise non-following, so the same set is produced. This is inherited behaviour, not a decision
//! taken here — a walk that followed links would need cycle detection before it could be turned on.

use crate::SKIP_DIRS;
use agent_core::CancellationToken;
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Cached file lists, keyed by workspace root.
///
/// The JS cache is a single `{ workdir, files }` slot, so switching directories evicts the previous
/// project's list. Keying by root instead lets two conversations on two projects both stay warm — the
/// same reasoning as making the workspace a parameter rather than a global.
#[derive(Debug, Default)]
pub struct FileListCache {
    entries: DashMap<PathBuf, Arc<Vec<PathBuf>>>,
}

impl FileListCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached list for `root`, walking the tree if it is not cached.
    ///
    /// Content is deliberately not cached — only the list of paths — so a file whose *contents*
    /// changed is always searched afresh. Only creation, deletion and renaming need invalidation.
    pub fn get_or_walk(&self, root: &Path, cancel: &CancellationToken) -> Arc<Vec<PathBuf>> {
        if let Some(hit) = self.entries.get(root) {
            return Arc::clone(hit.value());
        }
        let files = Arc::new(walk_files(root, cancel));
        // A cancelled walk is partial; caching it would poison every later search with a truncated
        // list that looks authoritative.
        if !cancel.is_cancelled() {
            self.entries.insert(root.to_path_buf(), Arc::clone(&files));
        }
        files
    }

    /// Drop the cached list for one workspace. Called when a tool creates, deletes or renames a file.
    pub fn invalidate(&self, root: &Path) {
        self.entries.remove(root);
    }

    /// Drop every cached list.
    pub fn invalidate_all(&self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Depth-first pre-order walk, skipping `SKIP_DIRS` and symlinks. Unreadable directories are skipped
/// silently, exactly as the JS `try/catch` around `readdir` does.
pub fn walk_files(root: &Path, cancel: &CancellationToken) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_into(root, cancel, &mut out);
    out
}

fn walk_into(dir: &Path, cancel: &CancellationToken, out: &mut Vec<PathBuf>) {
    if cancel.is_cancelled() {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    // Materialised and sorted before descending: see the module header. `as_encoded_bytes` gives the
    // platform's own encoding, which is what `strcmp` compares in libuv.
    let mut entries: Vec<std::fs::DirEntry> = entries.flatten().collect();
    entries.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));

    for entry in entries {
        if cancel.is_cancelled() {
            return;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            let name = entry.file_name();
            if SKIP_DIRS.iter().any(|s| std::ffi::OsStr::new(s) == name) {
                continue;
            }
            walk_into(&path, cancel, out);
        } else if ft.is_file() {
            out.push(path);
        }
        // Symlinks and other node types fall through unrecorded — see the module header.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn skips_configured_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        touch(&root.join("keep.txt"));
        touch(&root.join("node_modules/pkg/index.js"));
        touch(&root.join(".git/config"));
        touch(&root.join("src/deep/a.rs"));

        let files = walk_files(root, &CancellationToken::new());
        let names: Vec<String> = files.iter().map(|p| p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")).collect();

        assert!(names.contains(&"keep.txt".to_string()));
        assert!(names.contains(&"src/deep/a.rs".to_string()));
        assert!(!names.iter().any(|n| n.contains("node_modules")));
        assert!(!names.iter().any(|n| n.contains(".git")));
    }

    #[test]
    fn cache_returns_same_allocation_until_invalidated() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("a.txt"));
        let cache = FileListCache::new();
        let cancel = CancellationToken::new();

        let first = cache.get_or_walk(tmp.path(), &cancel);
        let second = cache.get_or_walk(tmp.path(), &cancel);
        assert!(Arc::ptr_eq(&first, &second), "second call should hit the cache");

        cache.invalidate(tmp.path());
        let third = cache.get_or_walk(tmp.path(), &cancel);
        assert!(!Arc::ptr_eq(&first, &third), "invalidation should force a re-walk");
    }

    #[test]
    fn cancelled_walk_is_not_cached() {
        let tmp = tempfile::tempdir().unwrap();
        touch(&tmp.path().join("a.txt"));
        let cache = FileListCache::new();
        let cancel = CancellationToken::new();
        cancel.cancel();

        cache.get_or_walk(tmp.path(), &cancel);
        assert!(cache.is_empty(), "a partial walk must not be cached");
    }
}
