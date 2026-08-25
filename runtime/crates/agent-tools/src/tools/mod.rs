//! The Stage 1 tool set: the five read-only filesystem and search tools.
//!
//! Chosen because they are the leaves of the dependency graph — no consent implications, no process
//! spawning, no state mutation — so if Stage 1 is wrong, nothing is damaged. They are also where the
//! JS runtime's cancellation gap is widest: `search_in_files` and `search_files` walk the whole tree
//! and never look at the abort signal, so Stop does not reach them at all today.

pub mod file_info;
pub mod list_directory;
pub mod read_file;
pub mod search_files;
pub mod search_in_files;

use crate::registry::ToolRegistry;
use std::sync::Arc;

/// Register every Stage 1 tool.
pub fn register_builtin(registry: &mut ToolRegistry) {
    registry.register(Arc::new(read_file::ReadFile));
    registry.register(Arc::new(list_directory::ListDirectory));
    registry.register(Arc::new(file_info::FileInfo));
    registry.register(Arc::new(search_files::SearchFiles));
    registry.register(Arc::new(search_in_files::SearchInFiles));
}
