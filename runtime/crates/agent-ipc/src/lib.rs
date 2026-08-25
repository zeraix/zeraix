//! The Electron ↔ Runtime protocol (spec §18).
//!
//! ## Shape
//!
//! Newline-delimited JSON over stdio. One JSON document per line, requests carry an `id`, notifications
//! do not. `serde_json` never emits a raw newline inside a compact document, so a line break is an
//! unambiguous frame boundary and no length prefix is needed.
//!
//! stdout is the protocol channel and **nothing else may write to it**. Diagnostics go to stderr; the
//! binary installs a `tracing` subscriber pointed there for exactly this reason. A stray `println!`
//! corrupts the stream, which is why there are none.
//!
//! ## Versioning
//!
//! `PROTOCOL_VERSION` is negotiated by `runtime.initialize` before any other method is served. Spec §18
//! requires this so that upgrading the runtime cannot crash the host: a host that speaks an
//! incompatible version is told so in a structured reply and can fall back to the JS path rather than
//! failing mid-turn.
//!
//! Compatibility rule: **minor versions add, major versions break.** A host may call a runtime whose
//! minor version is greater than its own — unknown response fields are ignored — but a major mismatch
//! is refused.
//!
//! ## What Stage 1 uses, and what is reserved
//!
//! Stage 1 needs only `runtime.initialize`, `tool.list`, `tool.call`, `tool.cancel`,
//! `workspace.invalidate` and `runtime.shutdown`. The `conversation.*` and `agent.*` namespaces are
//! reserved here rather than invented later, because decision D4 has the runtime *deriving* execution
//! context from conversation messages the host sends it. Reserving the namespace now costs nothing;
//! adding it after hosts ship would be a protocol break.

pub mod protocol;
pub mod transport;

pub use protocol::{
    ErrorBody, InitializeParams, InitializeResult, Request, Response, ResponseBody, ToolCallParams,
    ToolCallResult, ToolDescriptor, PROTOCOL_VERSION,
};
pub use transport::{StdioTransport, Transport};
