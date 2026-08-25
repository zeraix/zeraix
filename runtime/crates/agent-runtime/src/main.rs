//! `zeraix-agent-runtime` — the Rust Agent Runtime sidecar.
//!
//! Spawned by the Electron main process, speaks newline-delimited JSON over stdio (see `agent-ipc`).
//! Runs as a separate process rather than a native addon so that a crash here costs one restart of the
//! sidecar instead of taking down Electron and every open conversation — and so that this binary can be
//! built, tested and benchmarked without an Electron toolchain at all.
//!
//! **stdout belongs to the protocol.** All diagnostics go to stderr.

mod server;

use agent_ipc::transport::StdioTransport;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

fn main() -> anyhow::Result<()> {
    // Explicitly to stderr: a log line on stdout would be parsed as a protocol frame and corrupt the
    // stream for everything after it.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(EnvFilter::try_from_env("ZERAIX_RUNTIME_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    // `--version` is answered without starting the runtime: the host uses it as a cheap health check
    // before deciding whether to route any tools here at all.
    if std::env::args().any(|a| a == "--version") {
        println!("{}", server::RUNTIME_VERSION);
        return Ok(());
    }

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async {
        tracing::info!(version = server::RUNTIME_VERSION, "agent runtime starting");
        let server = Arc::new(server::Server::new());
        let result = server.run(StdioTransport::new()).await;
        tracing::info!("agent runtime stopped");
        result
    })
}
