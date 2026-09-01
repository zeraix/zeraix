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

/// Read `--state-dir <path>` (or `--state-dir=<path>`) from the command line.
fn state_dir_arg() -> Option<std::path::PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    for (i, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--state-dir=") {
            return Some(value.into());
        }
        if arg == "--state-dir" {
            return args.get(i + 1).map(Into::into);
        }
    }
    None
}

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

    // `--state-dir <path>`: where the task journal lives, so an interrupted run can be reported at the next
    // handshake. Supplied by the host because only it knows the app's user-data directory. Absent — the
    // parity harness, a manual run — the runtime works exactly as before, with no durability and nothing to
    // recover.
    let state_dir = state_dir_arg();

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let result = runtime.block_on(async {
        tracing::info!(version = server::RUNTIME_VERSION, state_dir = ?state_dir, "agent runtime starting");
        let server = Arc::new(match &state_dir {
            Some(dir) => server::Server::with_state_dir(dir).await,
            None => server::Server::new(),
        });
        let result = server.run(StdioTransport::new()).await;
        tracing::info!("agent runtime stopped");
        result
    });

    // Do not wait for the blocking pool at all.
    //
    // Dropping a runtime waits for it, and on Windows that can be forever: tokio wraps child stdio in
    // `Blocking` there — Windows pipes cannot be polled, so a read runs on the blocking pool and, once
    // started, cannot be cancelled. A background service whose grandchild outlived the kill still holds its
    // stdout, so the read never returns and the process never exits.
    //
    // The first fix was `shutdown_timeout(2s)`, which bounded that. Measurement showed it did not merely bound
    // the bad case — it cost two seconds on EVERY exit (`scripts/runtime-bench.mjs shutdown` reported a p50 of
    // 2008ms, which is the constant, not a coincidence). The reason is `tokio::io::stdin()`: it is also a
    // blocking read, and after `runtime.shutdown` the host has not closed the pipe, so it never returns and the
    // full grace period elapses on a perfectly clean stop. Two seconds on every quit reads to the user as a
    // hang, which is the failure that timeout existed to prevent.
    //
    // Not waiting is safe because there is nothing left to wait FOR: the transport writes and flushes per
    // message, and `run` has already stopped the background services and shut the scheduler down. The only
    // task still alive is the stdin read, and its result is a request nobody will answer.
    runtime.shutdown_background();
    result
}
