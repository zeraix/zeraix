//! Newline-delimited JSON transport over stdio.
//!
//! Reading and writing are split so the runtime can reply to a later request before an earlier one has
//! finished — which is the whole point of having a scheduler. The writer is behind a mutex because
//! several tasks complete concurrently and a half-written line would corrupt the stream for everything
//! after it.

use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdin, Stdout};
use tokio::sync::Mutex;

/// Anything that can carry the protocol. A trait so tests can drive the server over pipes and a later
/// stage can add a socket transport without touching the server loop.
pub trait Transport: Send + Sync + 'static {
    /// Write one framed message.
    fn send(&self, line: String) -> impl std::future::Future<Output = std::io::Result<()>> + Send;
}

/// The production transport: stdin for requests, stdout for replies.
pub struct StdioTransport {
    reader: Mutex<BufReader<Stdin>>,
    writer: Arc<Mutex<Stdout>>,
}

impl Default for StdioTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl StdioTransport {
    pub fn new() -> Self {
        Self {
            reader: Mutex::new(BufReader::new(tokio::io::stdin())),
            writer: Arc::new(Mutex::new(tokio::io::stdout())),
        }
    }

    /// Read the next line. `Ok(None)` means the host closed the pipe — the normal shutdown path when
    /// Electron exits, and the reason the server treats EOF as "stop", not as an error.
    pub async fn recv(&self) -> std::io::Result<Option<String>> {
        let mut guard = self.reader.lock().await;
        let mut line = String::new();
        let n = guard.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        Ok(Some(line))
    }

    /// A cloneable handle for tasks that need to reply after the request loop has moved on.
    pub fn sender(&self) -> StdioSender {
        StdioSender { writer: Arc::clone(&self.writer) }
    }
}

#[derive(Clone)]
pub struct StdioSender {
    writer: Arc<Mutex<Stdout>>,
}

impl Transport for StdioSender {
    async fn send(&self, line: String) -> std::io::Result<()> {
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes()).await?;
        w.write_all(b"\n").await?;
        // Flushed per message: the host is blocked awaiting this reply, so buffering it would look
        // exactly like a hung tool.
        w.flush().await
    }
}
