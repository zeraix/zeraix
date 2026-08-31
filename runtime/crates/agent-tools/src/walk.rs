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
//! **Entry order must match `fs.readdir`, and it is platform-specific.** The JS walk this mirrors
//! (`walkFiles` in aiToolkit.mjs) does not sort at all — it iterates `fs.readdir` output verbatim — so
//! whatever order libuv hands Node is the order that must come out of here. Getting it wrong is
//! invisible until a query hits the match cap and then silently returns a different 200 files.
//!
//! On **POSIX**, libuv implements `fs.readdir` with `scandir()` under a `strcmp` comparator, so Node
//! returns a byte-sorted list while Rust's `read_dir` returns raw order — ext4 hash order, neither
//! sorted nor stable across trees. Hence the sort below. `strcmp` is a byte comparison, not a
//! collation, so it is locale-independent and does not need `locale_compare` — unlike
//! `list_directory`, which sorts its own output with `localeCompare` and genuinely does need it.
//!
//! On **Windows** that is not true, and assuming it was is what this code got wrong. libuv has no
//! `scandir()` there: it reads the directory through `NtQueryDirectoryFile` and applies no comparator
//! of its own, so Node returns the order NTFS supplies — case-insensitive, not byte-ordered. Sorting
//! by bytes therefore *introduced* a divergence rather than removing one, putting `README.md` ahead of
//! `crlf.txt` where Node on NTFS never does. Rust's `read_dir` reads that same directory index through
//! the same OS facility, so on Windows the two already agree and the correct action is to leave the
//! order alone.
//!
//! Neither half of this was caught by reasoning about it. The A/B harness caught the POSIX case on its
//! first run and the Windows case the first time it was run on Windows — which is the argument both for
//! comparing whole outputs rather than spot-checking, and for running the comparison on every platform
//! that ships (see .github/workflows/ci.yml).
//!
//! ## Symlinks are skipped
//!
//! The JS walk tests `isDirectory()` then `isFile()` on a `Dirent`, neither of which is true for a
//! symlink, so links are silently omitted from the file list. `DirEntry::file_type` in Rust is
//! likewise non-following, so the same set is produced. This is inherited behaviour, not a decision
//! taken here — a walk that followed links would need cycle detection before it could be turned on.

use crate::SKIP_DIRS;

/// Whether the platform hands Rust and Node the same directory order without help.
///
/// True on Windows: both read the NTFS directory index through the same OS facility, so there is
/// nothing to reconcile and sorting is what breaks parity. False on POSIX, where libuv byte-sorts
/// via `scandir()` and Rust's `read_dir` does not. See the module header.
const WINDOWS_READDIR_ORDER_ALREADY_MATCHES: bool = cfg!(windows);
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
    // Materialised before descending so the order can be fixed up; see the module header for why the
    // fix-up is POSIX-only. `as_encoded_bytes` gives the platform's own encoding, which is what
    // `strcmp` compares in libuv. On Windows the OS already hands both runtimes the same order, and
    // sorting here is precisely what broke parity — so the sort is compiled out rather than replaced
    // by a different comparator, because there is no comparator to reproduce.
    let mut entries: Vec<std::fs::DirEntry> = entries.flatten().collect();
    // `cfg!` rather than `#[cfg]`: this is a one-line difference between platforms, and a `#[cfg]`
    // block would mean the branch that does NOT apply to the host is never compiled here -- so a
    // mistake in the POSIX ordering would first surface on a macOS CI runner, which is a slow and
    // confusing place to learn about it. `cfg!` is a compile-time constant, so both arms are
    // type-checked everywhere and the optimiser drops the dead one.
    if !WINDOWS_READDIR_ORDER_ALREADY_MATCHES {
        entries.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));
    }

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
