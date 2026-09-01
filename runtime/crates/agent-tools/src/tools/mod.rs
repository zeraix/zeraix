//! The built-in tool set.
//!
//! The five read-only filesystem and search tools came first, chosen because they are the leaves of the
//! dependency graph — no consent implications, no process spawning, no state mutation — so if that stage was
//! wrong, nothing was damaged. They are also where the JS runtime's cancellation gap is widest:
//! `search_in_files` and `search_files` walk the whole tree and never look at the abort signal, so Stop does
//! not reach them at all today.
//!
//! `write_file` and `edit_file` came later and deliberately: a tool that can overwrite a file needs a
//! capability check to exist before it is reachable, and that arrived with `agent-dispatch`.

pub mod edit_file;
pub mod file_info;
pub mod list_directory;
pub mod read_file;
pub mod search_files;
pub mod search_in_files;
pub mod write_file;

use crate::registry::ToolRegistry;
use std::sync::Arc;

/// Register every built-in tool.
pub fn register_builtin(registry: &mut ToolRegistry) {
    registry.register(Arc::new(read_file::ReadFile));
    registry.register(Arc::new(list_directory::ListDirectory));
    registry.register(Arc::new(file_info::FileInfo));
    registry.register(Arc::new(search_files::SearchFiles));
    registry.register(Arc::new(search_in_files::SearchInFiles));
    // Mutating, and registered last on purpose: they were held until `agent-dispatch` existed to check a
    // capability before running one.
    registry.register(Arc::new(write_file::WriteFile));
    registry.register(Arc::new(edit_file::EditFile));
}
