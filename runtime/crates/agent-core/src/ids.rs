//! Identifiers.
//!
//! Every one of these exists so a trace can be reconstructed after the fact (spec §22): given a
//! `TaskId` you can find its agents, given an `AgentId` its tool calls, given a `CallId` the process or
//! MCP request it spawned. They are newtypes rather than bare strings because mixing them up is
//! otherwise a silent, type-checkable bug.

use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Mint a fresh id.
            pub fn new() -> Self {
                Self(format!("{}{}", $prefix, Uuid::new_v4().simple()))
            }

            /// Adopt an id issued elsewhere (the host, a replayed journal) verbatim.
            ///
            /// No prefix is imposed: the host's `callId` is its own handle for a call it wants to be
            /// able to cancel, and rewriting it here would break the association it depends on.
            pub fn from_host(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_owned())
            }
        }
    };
}

string_id!(
    /// A unit of work submitted to the runtime. The root of a trace.
    TaskId,
    "task_"
);
string_id!(
    /// One agent instance. A task has at least one; a delegation adds children.
    AgentId,
    "agent_"
);
string_id!(
    /// One tool invocation. Minted by the host when it wants to be able to cancel the call.
    CallId,
    "call_"
);
