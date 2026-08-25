//! Transport abstraction for MCP connections.
//!
//! A trait rather than a concrete stdio/HTTP implementation, for two reasons. The supervisor's
//! interesting behaviour — reconnection, heartbeats, backpressure, degradation — is entirely
//! transport-independent, and it is exactly the behaviour that is hard to test against a real server:
//! "the server stops answering pings", "the response is 400 MB", "the child process dies mid-call" are
//! all trivial to inject through a fake and awkward to arrange for real.
//!
//! The real implementations arrive with the wiring stage, where they replace `@modelcontextprotocol/sdk`
//! usage in `electron/mcp/client.mjs`.

use serde_json::Value;
use std::sync::Arc;

/// Why a transport operation failed.
///
/// The distinction that matters is `Closed` versus everything else: a closed pipe means the child is
/// gone and the connection must be rebuilt, whereas a timeout or a protocol error leaves the connection
/// usable and only this call failed. Collapsing them is how a single slow call ends up tearing down a
/// working server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// The connection is gone. Reconnect.
    Closed(String),
    /// This call did not answer in time. The connection may still be fine.
    Timeout,
    /// The server answered, but not with something meaningful.
    Protocol(String),
    /// I/O failure while talking to the server.
    Io(String),
    /// The response exceeded the size cap and was refused rather than read into memory.
    TooLarge { bytes: usize, cap: usize },
}

impl TransportError {
    /// Whether this error means the connection itself is unusable.
    pub fn is_fatal(&self) -> bool {
        matches!(self, TransportError::Closed(_) | TransportError::Io(_))
    }

    pub fn describe(&self) -> String {
        match self {
            TransportError::Closed(why) => format!("the connection closed ({why})"),
            TransportError::Timeout => "the server did not respond in time".to_owned(),
            TransportError::Protocol(m) => format!("protocol error: {m}"),
            TransportError::Io(m) => format!("I/O error: {m}"),
            TransportError::TooLarge { bytes, cap } => {
                format!("the response was {bytes} bytes, over the {cap}-byte cap, and was discarded")
            }
        }
    }
}

/// How a server is reached. Determines whether pooling makes sense.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// A child process over stdin/stdout. One process, one pipe pair — pooling would mean spawning
    /// several servers, which is a different thing and rarely what anyone wants.
    Stdio,
    /// A remote endpoint. Concurrent connections are cheap and pooling is worthwhile.
    Http,
}

/// One live connection to an MCP server.
#[async_trait::async_trait]
pub trait McpTransport: Send + Sync + 'static {
    /// Issue a JSON-RPC request and await its result.
    async fn request(&self, method: &str, params: Value) -> Result<Value, TransportError>;

    /// Cheap liveness probe (MCP `ping`).
    async fn ping(&self) -> Result<(), TransportError>;

    /// Shut the connection down. Must be idempotent.
    async fn close(&self);

    fn kind(&self) -> TransportKind;
}

/// Builds connections. Called again on every reconnect, so it must be reusable.
#[async_trait::async_trait]
pub trait TransportFactory: Send + Sync + 'static {
    async fn connect(&self) -> Result<Arc<dyn McpTransport>, TransportError>;
    fn kind(&self) -> TransportKind;
}
