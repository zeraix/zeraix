//! Tool Runtime (spec §7).
//!
//! One `Tool` trait, one registry, and the execution wrapper that applies schema validation, timeouts
//! and cancellation uniformly — so that no individual tool has to remember to do any of it, and none
//! of them is allowed to skip it.
//!
//! ## Parity is the Stage 1 contract
//!
//! The tools here replace handlers in `electron/tools/aiToolkit.mjs`, and they replace them *behind an
//! existing seam* (`runTool`) that the whole app already funnels through. Their output is therefore not
//! free to be nicer: a model reads these strings, and the app's context-compression layer parses some
//! of them (`contextCompress.ts` keys on `read_file`'s line-span notes). Every byte of formatting here
//! mirrors the JS handler on purpose, including the truncation notices, which were written the way they
//! were for reasons documented at their original site.
//!
//! Where an exact match is impossible without reimplementing a JS or ICU behaviour, the divergence is
//! named in a comment at the site and covered by the A/B harness rather than left to be discovered.

pub mod glob;
pub mod nodeerr;
pub mod registry;
pub mod schema;
pub mod text;
pub mod tool;
pub mod tools;
pub mod walk;
pub mod workspace;

pub use registry::ToolRegistry;
pub use schema::{validate, ValidationMode, Violation};
pub use tool::{ExecutionMode, RiskLevel, Tool, ToolContext, ToolMetadata, ToolOutput};

/// Read cap for a single file. Mirrors `MAX_READ_BYTES` in aiToolkit.mjs.
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// Lines returned by `read_file` when no explicit limit is given. Mirrors `READ_DEFAULT_MAX_LINES`.
///
/// This constant is load-bearing beyond this crate: `contextCompress.ts` mirrors it again in the
/// renderer to compute read spans for stale-read dedup, with a comment saying it cannot be shared
/// across the process boundary. When the context runtime migrates (decision D4), that third copy
/// collapses into this one.
pub const READ_DEFAULT_MAX_LINES: usize = 2000;
/// Per-call character ceiling for `read_file`; a line cap cannot bound a minified single-line file.
pub const READ_MAX_CHARS: usize = 200_000;
/// `search_*` result cap.
pub const MAX_MATCHES: usize = 200;
/// `list_directory` result cap. A bare listing is cheaper per row than a search hit, so it runs higher.
pub const MAX_ENTRIES: usize = 300;
/// `search_in_files` per-line echo cap.
pub const MAX_LINE_LEN: usize = 400;

/// Directories the file walk never descends into. Mirrors `SKIP_DIRS` in aiToolkit.mjs.
///
/// Note what this is *not*: it is not gitignore-aware. Replacing it with a gitignore-respecting walk
/// would be a behaviour change disguised as a performance win — files the model can currently find
/// would silently stop being findable. Any such change belongs in its own commit, with its own
/// argument.
pub const SKIP_DIRS: &[&str] = &[".git", "node_modules", ".next", "dist", "Zeraix"];
