//! Long-lived background services (spec §10, TODO §5) — the `bgProcs` half of `sandbox/native.mjs`.
//!
//! A dev server, a watcher, a `tail -f`: started, deliberately not waited for, killed later by pid. The
//! foreground path in `lib.rs` cannot serve these, because everything it does is organised around
//! having a result to return.
//!
//! ## What lives here and what deliberately does not
//!
//! This owns the process: spawning it into its own group, reading its output, noticing when it exits,
//! killing it, and listing what is running. It does **not** decide when a service is "ready", what its
//! URL is, or what to tell the model about it. Those stay in `native.mjs`, and the split is not
//! arbitrary — readiness is a regex over output and a URL is another one, both written in JavaScript
//! and both feeding strings a model reads. Re-expressing them in Rust's regex dialect would risk a
//! silent behaviour change in the exact place this migration promises none, so the host reads the
//! output through `peek` and applies its own patterns unchanged.
//!
//! ## The buffer keeps the END, not the beginning
//!
//! The opposite of the foreground cap, and deliberately so. A finished command's first 10 MB is the
//! interesting part — that is where the compiler error is. A service that has been running for an hour
//! is the other way round: what matters is what it said most recently, which is why the JS
//! implementation keeps the trailing 64 KB and this does too.
//!
//! ## Why the readers are never detached
//!
//! Keeping the pipes drained is not optional. A service that keeps printing will fill the OS pipe
//! buffer and then *block on write* — the process stops making progress, and it looks like a hang in
//! the service rather than a missing reader here. The JS implementation documents having made exactly
//! this mistake and reverted it; the readers here run for the life of the process for the same reason.
//!
//! ## Killing by pid rather than by handle
//!
//! The reaper task owns the `Child` and nothing else may touch it — a `std::sync::Mutex` cannot be held
//! across the `await` on `wait()`, and sharing the handle any other way would race the reap. So `stop`
//! signals the process *group* by pid, which is what `stopProcess` in the JS implementation does and
//! what the `stop_service` tool's pid argument already means.

use crate::console::decode_console;
use crate::{kill_pid, spawn_command, ProcessRequest};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;

/// Trailing bytes retained per service. Mirrors the 64 KB cap in `startBackground`.
pub const BACKGROUND_TAIL_BYTES: usize = 64 * 1024;

/// How many finished services keep their output available to a late `peek`.
///
/// A service that ends between two of the host's polls must still be able to report what it printed.
/// The JS implementation gets this for free — the buffer belongs to the caller and outlives the child
/// — and losing it here cost a real behaviour change that the parity harness caught: a one-off command
/// mistaken for a long-running one reported "(no output yet)" instead of its output.
///
/// Bounded because it is a convenience, not a record. The exit event carries the same output to the
/// one caller that must not miss it.
pub const RECENTLY_EXITED_KEPT: usize = 32;

/// How a background process ended, as reported to the host.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Exited {
    pub pid: u32,
    /// `None` when the process was killed by a signal, matching Node's `code`.
    pub code: Option<i32>,
    /// Signal name on unix, `None` otherwise — again Node's shape.
    pub signal: Option<String>,
    /// The decoded trailing output. The host applies its own `tailOf` clipping to this, so the
    /// truncation notice a model sees is written in exactly one place.
    pub output: String,
    pub command: String,
}

/// One running service. The `Child` is not here — see the module header.
struct Entry {
    command: String,
    buffer: Arc<Mutex<Vec<u8>>>,
}

/// Shared between the registry and the reaper task each `start` spawns.
///
/// The reaper retires the entry itself rather than leaving that to the caller, which is what makes
/// "gone from the listing before the exit event is pushed" an invariant of this module instead of
/// something every call site has to remember.
struct Inner {
    entries: Mutex<HashMap<u32, Entry>>,
    /// Finished services, newest last. See `RECENTLY_EXITED_KEPT`.
    recent: Mutex<VecDeque<(u32, String)>>,
}

/// The set of running background services.
///
/// Keyed by pid because that is what the whole surface above it is keyed by: the `stop_service` tool
/// takes a pid, the renderer's service indicator displays one, and the user sees it.
pub struct BackgroundRegistry {
    inner: Arc<Inner>,
}

impl Default for BackgroundRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl BackgroundRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                entries: Mutex::new(HashMap::new()),
                recent: Mutex::new(VecDeque::new()),
            }),
        }
    }

    /// Start a service and return its pid.
    ///
    /// Returns the spawn error's message rather than a typed error: the caller's only use for it is to
    /// put it in front of the model, and `native.mjs` already words that ("Background startup failed").
    ///
    /// `on_exit` fires exactly once, from the task that reaps the child. It is how the host learns of
    /// an exit it is no longer polling for — a `notify` job's whole purpose — so it fires on every
    /// path, including a kill this registry performed itself.
    pub fn start<F>(&self, command: &str, cwd: Option<PathBuf>, on_exit: F) -> Result<u32, String>
    where
        F: FnOnce(Exited) + Send + 'static,
    {
        let mut req = ProcessRequest::new(command);
        if let Some(dir) = cwd {
            req = req.in_dir(dir);
        }
        // No cap and no deadline: this is a process that is supposed to outlive the call. The trailing
        // buffer below is the only bound, and it bounds memory rather than the process.
        req.max_buffer = None;
        req.timeout = None;

        let mut child = spawn_command(&req).map_err(|e| e.to_string())?;
        let pid = child
            .id()
            .ok_or_else(|| "the process exited before it could be registered".to_owned())?;

        let buffer = Arc::new(Mutex::new(Vec::new()));
        // Handles kept, not detached: the reaper waits on them briefly after the process exits. See the
        // drain below for why.
        let mut readers = Vec::new();
        if let Some(out) = child.stdout.take() {
            readers.push(tokio::spawn(read_into_tail(out, Arc::clone(&buffer))));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(tokio::spawn(read_into_tail(err, Arc::clone(&buffer))));
        }

        self.inner
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pid, Entry { command: command.to_owned(), buffer: Arc::clone(&buffer) });

        // The reaper owns the child, which is what makes every service awaited by construction — so
        // none of them can become a zombie, the failure mode the JS path has no defence against.
        let command_owned = command.to_owned();
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            let status = child.wait().await;
            let (code, signal) = match status {
                Ok(s) => (s.code(), signal_name(&s)),
                Err(_) => (None, None),
            };
            // Drain before reading, not just wait.
            //
            // `wait()` returning does not mean the readers have consumed what the process wrote — they
            // are separate tasks, and on a busy runtime they may not have been scheduled yet. Reading
            // the buffer straight after the wait therefore loses the output of anything short-lived,
            // which is precisely the `notify` case: an install that finishes and reports nothing about
            // whether it worked. The foreground path in `run` already takes exit-plus-a-drain-window
            // for the same reason; this is that window.
            //
            // Bounded, because a grandchild the service detached can hold the pipe open indefinitely.
            for reader in readers {
                let _ = tokio::time::timeout(crate::DRAIN_AFTER_EXIT, reader).await;
            }
            let output = {
                let bytes = buffer.lock().unwrap_or_else(|e| e.into_inner());
                decode_console(&bytes)
            };
            // Retired before the callback fires, so a host acting on the event cannot see the
            // service still listed — and its output stays readable for a poll that arrives late.
            inner.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
            {
                let mut recent = inner.recent.lock().unwrap_or_else(|e| e.into_inner());
                recent.push_back((pid, output.clone()));
                while recent.len() > RECENTLY_EXITED_KEPT {
                    recent.pop_front();
                }
            }
            on_exit(Exited { pid, code, signal, output, command: command_owned });
        });

        Ok(pid)
    }

    /// What a service has printed, and whether it is still running.
    ///
    /// `None` means this pid is not one of ours and never was. A service that has *finished* answers
    /// `Some((false, output))` for as long as it is in the recently-exited ring — which is what lets a
    /// caller polling every 300 ms still report the output of something that ran for 50 ms.
    pub fn peek(&self, pid: u32) -> Option<(bool, String)> {
        {
            let entries = self.inner.entries.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = entries.get(&pid) {
                let bytes = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
                return Some((true, decode_console(&bytes)));
            }
        }
        let recent = self.inner.recent.lock().unwrap_or_else(|e| e.into_inner());
        recent.iter().find(|(p, _)| *p == pid).map(|(_, out)| (false, out.clone()))
    }

    /// Everything still running, as `(pid, command)`.
    pub fn list(&self) -> Vec<(u32, String)> {
        let entries = self.inner.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<(u32, String)> =
            entries.iter().map(|(pid, e)| (*pid, e.command.clone())).collect();
        // Sorted so a listing is stable between calls; a HashMap's order is not.
        out.sort_by_key(|(pid, _)| *pid);
        out
    }

    /// Stop one service and its whole tree. `false` means it was not ours.
    ///
    /// The entry stays until the reaper removes it. Dropping it here would discard the registry's
    /// record of a process that is still, for a moment, alive — and the host would lose the exit event
    /// that says how it ended.
    pub fn stop(&self, pid: u32) -> bool {
        let known = self.inner.entries.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&pid);
        if known {
            kill_pid(pid, false);
        }
        known
    }

    /// Stop everything. Used on app quit, where the alternative is services outliving the app.
    pub fn stop_all(&self) -> usize {
        let pids: Vec<u32> = self.list().into_iter().map(|(pid, _)| pid).collect();
        pids.iter().filter(|pid| self.stop(**pid)).count()
    }

    pub fn len(&self) -> usize {
        self.inner.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Read a stream forever, keeping only the trailing `BACKGROUND_TAIL_BYTES`.
///
/// Both streams append to one buffer, interleaved as they arrive, because that is what the JS
/// implementation does — a dev server writes its address to one of the two and which one is not
/// predictable, so the host's readiness scrape has to see both in one place.
async fn read_into_tail<R>(mut stream: R, sink: Arc<Mutex<Vec<u8>>>)
where
    R: AsyncReadExt + Unpin,
{
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf).await {
            // EOF: the process closed this stream, usually because it exited.
            Ok(0) => return,
            Ok(n) => {
                let mut out = sink.lock().unwrap_or_else(|e| e.into_inner());
                out.extend_from_slice(&buf[..n]);
                if out.len() > BACKGROUND_TAIL_BYTES {
                    let excess = out.len() - BACKGROUND_TAIL_BYTES;
                    out.drain(..excess);
                }
            }
            // A broken pipe is how a killed process's stream ends. Keep what was read.
            Err(_) => return,
        }
    }
}

/// The signal that killed a process, spelled as Node spells it.
#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|s| match s {
        1 => "SIGHUP".to_owned(),
        2 => "SIGINT".to_owned(),
        9 => "SIGKILL".to_owned(),
        15 => "SIGTERM".to_owned(),
        other => format!("SIG{other}"),
    })
}

#[cfg(not(unix))]
fn signal_name(_status: &std::process::ExitStatus) -> Option<String> {
    // Windows has no signals; Node reports `null` here too.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    /// A command that runs until it is killed, spelled for whichever shell the platform uses.
    fn forever() -> &'static str {
        if cfg!(windows) { "ping -n 100000 127.0.0.1 > nul" } else { "sleep 600" }
    }

    #[tokio::test]
    async fn a_service_is_registered_and_listed() {
        let reg = BackgroundRegistry::new();
        let pid = reg.start(forever(), None, |_| {}).expect("start");
        assert_eq!(reg.len(), 1);
        assert_eq!(reg.list()[0].0, pid);
        reg.stop_all();
    }

    #[tokio::test]
    async fn output_is_readable_while_the_service_runs() {
        let reg = BackgroundRegistry::new();
        let cmd = if cfg!(windows) {
            "echo hello-from-service && ping -n 100000 127.0.0.1 > nul"
        } else {
            "echo hello-from-service && sleep 600"
        };
        let pid = reg.start(cmd, None, |_| {}).expect("start");
        // The readiness scrape upstream polls; so does this, for the same reason.
        for _ in 0..50 {
            if reg.peek(pid).map(|(_, out)| out).unwrap_or_default().contains("hello-from-service") {
                reg.stop_all();
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        reg.stop_all();
        panic!("service output never became visible through peek");
    }

    #[tokio::test]
    async fn exiting_fires_the_callback_with_the_code_and_output() {
        let reg = BackgroundRegistry::new();
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        reg.start("echo bye && exit 7", None, move |e| {
            if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = tx.send(e);
            }
        })
        .expect("start");

        let exited = tokio::time::timeout(Duration::from_secs(10), rx).await.expect("exit event").unwrap();
        assert_eq!(exited.code, Some(7));
        assert!(exited.output.contains("bye"), "the exit event carries what it printed: {:?}", exited.output);
    }

    /// The event has to fire for a kill too, or a stopped service would never be cleared from the
    /// host's registry and the UI would keep showing it as running.
    #[tokio::test]
    async fn stopping_a_service_also_fires_the_exit_callback() {
        let reg = BackgroundRegistry::new();
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let pid = reg
            .start(forever(), None, move |e| {
                if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(e);
                }
            })
            .expect("start");

        assert!(reg.stop(pid), "a registered pid reports as stopped");
        let exited = tokio::time::timeout(Duration::from_secs(10), rx).await.expect("exit event").unwrap();
        assert_eq!(exited.pid, pid);
    }

    /// Caught by the A/B harness, not by reasoning: a command that finishes inside the caller's first
    /// poll interval used to report "(no output yet)" because its entry was already gone. The JS path
    /// has no such gap — the buffer belongs to the caller and outlives the child — so this is what
    /// keeps a one-off command mistaken for a service from losing everything it printed.
    #[tokio::test]
    async fn a_finished_service_can_still_be_read_by_a_late_poll() {
        let reg = BackgroundRegistry::new();
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let pid = reg
            .start("echo it-printed-this", None, move |e| {
                if let Some(tx) = tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(e);
                }
            })
            .expect("start");
        tokio::time::timeout(Duration::from_secs(10), rx).await.expect("exit event").unwrap();

        let (alive, output) = reg.peek(pid).expect("a finished service still answers");
        assert!(!alive, "it has ended, and the caller has to be told so");
        assert!(output.contains("it-printed-this"), "and what it printed survives: {output:?}");
        // It is finished, so it is neither listed nor stoppable.
        assert!(reg.list().is_empty());
        assert!(!reg.stop(pid));
    }

    #[tokio::test]
    async fn stopping_an_unknown_pid_is_refused_rather_than_signalling_a_stranger() {
        let reg = BackgroundRegistry::new();
        // The pid space is shared with every other process on the machine. Signalling one this
        // registry never started is the difference between stopping a dev server and stopping
        // something of the user's.
        assert!(!reg.stop(999_999));
        assert!(reg.peek(999_999).is_none());
    }

    #[tokio::test]
    async fn the_buffer_keeps_the_end_not_the_beginning() {
        let sink = Arc::new(Mutex::new(Vec::new()));
        let big = vec![b'a'; BACKGROUND_TAIL_BYTES + 1000];
        read_into_tail(&big[..], Arc::clone(&sink)).await;
        {
            let mut out = sink.lock().unwrap();
            out.clear();
            out.extend_from_slice(&big);
            let excess = out.len() - BACKGROUND_TAIL_BYTES;
            out.drain(..excess);
        }
        // Then a marker at the very end must survive, while the beginning is gone.
        read_into_tail(&b"THE-END"[..], Arc::clone(&sink)).await;
        let out = sink.lock().unwrap();
        assert_eq!(out.len(), BACKGROUND_TAIL_BYTES);
        assert!(out.ends_with(b"THE-END"), "the most recent output is what a running service is asked for");
    }
}
