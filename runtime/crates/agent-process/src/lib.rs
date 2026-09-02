//! Process Runtime (spec §10, TODO §5).
//!
//! Replaces `electron/tools/sandbox/native.mjs`. Its observable behaviour is reproduced deliberately —
//! the decoded output, the exit-code shape, the truncation, the `killed`/`canceled` distinction — because
//! all of it reaches the model as a tool result. What changes is underneath.
//!
//! ## The four failures this exists to fix
//!
//! 1. **A stopped command that keeps running.** Node's `signal` support on `exec` rejects the promise
//!    but leaves the child alive, so a cancelled `npm install` carried on writing to `node_modules`
//!    while the UI said it had stopped. The JS implementation already works around this with an explicit
//!    tree-kill; here it is the only path there is.
//! 2. **No resource limits.** The native path has none: a runaway build can take the desktop with it.
//!    See `limits.rs`, including an honest account of what is actually enforceable unprivileged.
//! 3. **Zombies and orphans.** Nothing reaps a child nobody awaited. Here every child is awaited by
//!    construction — a `Child` that is dropped without `wait` is the only way to leak one, and the
//!    background registry exists so detached processes still have someone waiting on them.
//! 4. **Buffered-then-capped output.** The JS path accumulates the whole stream and truncates at the
//!    end, so a command printing 500 MB costs 500 MB of renderer memory before being cut to 10.
//!    Reading stops at the cap here instead.
//!
//! ## Process groups are load-bearing
//!
//! The child is spawned in **its own process group**, and the kill targets the group, not the pid. The
//! command runs under a shell and the work worth stopping is almost always the shell's descendants —
//! `npm install` is node spawning node, `cargo build` is cargo spawning rustc. Killing only the shell
//! leaves those running with nobody waiting on them, which looks exactly like the bug being fixed.
//!
//! The group must be a *new* one: a child sharing this process's group would mean `killpg` takes down
//! the runtime itself.

pub mod background;
pub mod console;
/// Kernel-enforced ownership of spawned trees; see the module header for what `kill_tree` cannot do.
mod job;
pub mod limits;

pub use background::{BackgroundRegistry, Exited};
pub use console::{decode_console, tail_of};
pub use limits::{LimitsApplied, ResourceLimits};

use agent_core::CancellationToken;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// How long a stopped command is given to exit on SIGTERM before it is killed outright.
/// Mirrors `KILL_GRACE_MS` in native.mjs.
pub const KILL_GRACE: Duration = Duration::from_millis(2000);

/// How long to keep draining pipes after the process has exited.
///
/// Pipes are inherited, so a grandchild the command deliberately detached can hold them open after the
/// shell is gone. Waiting forever for that is its own hang; the JS implementation takes exit plus a
/// short drain window, and so does this.
pub const DRAIN_AFTER_EXIT: Duration = Duration::from_millis(1000);

/// Default output cap per stream. Mirrors `CMD_MAX_BUFFER`.
pub const DEFAULT_MAX_BUFFER: usize = 10 * 1024 * 1024;

/// A hook run in the child between `fork` and `exec`.
///
/// The escape hatch for confinement mechanisms that must be applied *by the child to itself* —
/// Landlock is the motivating case: its restrictions are inherited and irrevocable, so applying them in
/// the parent would confine the runtime for the rest of its life. `agent-sandbox` supplies one; nothing
/// else should need to.
///
/// # Safety
/// Runs post-fork in a single-threaded child, so only async-signal-safe work is really permissible.
/// See the note at the `pre_exec` call site.
#[cfg(unix)]
pub type PreExecHook = std::sync::Arc<dyn Fn() -> std::io::Result<()> + Send + Sync>;

/// What to run.
#[derive(Clone)]
pub struct ProcessRequest {
    /// Shell command line, run through `/bin/sh -c` (or `cmd /C` on Windows).
    pub command: String,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    /// Wall-clock ceiling. `None` means only cancellation can stop it.
    pub timeout: Option<Duration>,
    /// Per-stream byte cap.
    pub max_buffer: Option<usize>,
    pub limits: ResourceLimits,
    /// Extra confinement applied by the child to itself. See `PreExecHook`.
    #[cfg(unix)]
    pub pre_exec_hook: Option<PreExecHook>,
}

// Hand-written because a hook is not `Debug`. Its presence is reported, since "was this command
// confined?" is exactly what a reader of a log line wants to know.
impl std::fmt::Debug for ProcessRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut d = f.debug_struct("ProcessRequest");
        d.field("command", &self.command)
            .field("cwd", &self.cwd)
            .field("env", &self.env)
            .field("timeout", &self.timeout)
            .field("max_buffer", &self.max_buffer)
            .field("limits", &self.limits);
        #[cfg(unix)]
        d.field("pre_exec_hook", &self.pre_exec_hook.is_some());
        d.finish()
    }
}

impl ProcessRequest {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            cwd: None,
            env: Vec::new(),
            timeout: None,
            max_buffer: Some(DEFAULT_MAX_BUFFER),
            limits: ResourceLimits::default(),
            #[cfg(unix)]
            pre_exec_hook: None,
        }
    }

    pub fn in_dir(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
    pub fn with_timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }
    pub fn with_max_buffer(mut self, n: usize) -> Self {
        self.max_buffer = Some(n);
        self
    }
    pub fn with_limits(mut self, l: ResourceLimits) -> Self {
        self.limits = l;
        self
    }
    pub fn with_env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.env.push((k.into(), v.into()));
        self
    }
}

/// How a process ended.
///
/// `Unknown` is the `"?"` the JS implementation returns — a process killed by a signal, or one that
/// never started. Kept as a distinct variant rather than a magic number so a caller cannot mistake it
/// for a real exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(untagged)]
pub enum ExitCode {
    Code(i32),
    #[serde(serialize_with = "serialize_unknown")]
    Unknown,
}

fn serialize_unknown<S: serde::Serializer>(s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str("?")
}

impl std::fmt::Display for ExitCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExitCode::Code(c) => write!(f, "{c}"),
            ExitCode::Unknown => f.write_str("?"),
        }
    }
}

/// The result of a foreground run. Never an error: a failed command is a *result*, and the output it
/// produced before failing is usually the most useful part of it.
#[derive(Debug, Clone)]
pub struct ProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub code: ExitCode,
    /// The timeout fired.
    pub killed: bool,
    /// The caller cancelled.
    pub canceled: bool,
    /// Whether either stream hit its cap.
    pub truncated: bool,
    /// What actually enforced the requested limits, if anything.
    pub limits: LimitsApplied,
}

impl ProcessResult {
    pub fn success(&self) -> bool {
        self.code == ExitCode::Code(0) && !self.killed && !self.canceled
    }
}

/// Spawn a command in its own process group with piped output.
///
/// Shared with `background`, so a service and a foreground command are started the same way — same
/// shell, same process group, same piping. A background service that spawned differently would drift
/// from the foreground path exactly where it is hardest to notice.
pub(crate) fn spawn_command(req: &ProcessRequest) -> std::io::Result<Child> {
    #[cfg(windows)]
    let mut cmd = {
        // Reproduce what Node's `spawn(cmd, { shell: true })` builds, argument for argument. Node
        // resolves the shell from %ComSpec%, passes `/d /s /c`, wraps the command in one pair of
        // quotes, and sets `windowsVerbatimArguments` so the command line is handed to CreateProcess
        // untouched (see normalizeSpawnArguments in node/lib/internal/child_process.js).
        //
        // Every part of that is load-bearing, and `cmd /C <command>` — what this used to do — matches
        // none of it:
        //
        // - **`/d`** disables the AutoRun command in
        //   `HKCU\Software\Microsoft\Command Processor\AutoRun`. Without it, every command the agent
        //   runs would additionally execute whatever that key holds, on machines where it is set (Anaconda
        //   and some corporate images set it). The JS path suppresses it; a divergence here would be a
        //   command that behaves differently depending on a registry key nobody thinks to check.
        // - **`/s` plus one enclosing quote pair** selects cmd.exe's simple quote rule: strip the first
        //   and last quote, run the rest verbatim. Without `/s`, cmd re-parses the quotes, and a command
        //   containing them (`git commit -m "x"`) is split differently.
        // - **`raw_arg`** is what keeps std from escaping the argument for a C runtime that cmd.exe is
        //   not. std would produce `cmd /C "git commit -m \"x\""`; cmd.exe reads `\"` as a literal quote.
        //
        // Untestable from the development environment (Linux/WSL), so it is compile-checked against
        // the msvc target and proven by the parity job, which runs on windows-latest for exactly this
        // class of bug — see .github/workflows/ci.yml.
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned());
        let mut c = Command::new(shell);
        c.arg("/d").arg("/s").arg("/c");
        c.raw_arg(format!("\"{}\"", req.command));
        c
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(&req.command);
        c
    };

    if let Some(dir) = &req.cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in &req.env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Reaped by `wait` in every path below; this is a backstop for a panic between spawn and wait.
    cmd.kill_on_drop(true);

    #[cfg(unix)]
    {
        // `process_group` and `pre_exec` are inherent on tokio's Command on unix — the std
        // `CommandExt` trait is deliberately not imported.
        // Its own group, so the whole-tree kill cannot reach the runtime — see the module header.
        cmd.process_group(0);

        let limits = req.limits;
        let hook = req.pre_exec_hook.clone();
        if !limits.is_empty() || hook.is_some() {
            // SAFETY: `pre_exec` runs between fork and exec, where only async-signal-safe work is
            // strictly permitted. `apply_rlimits` performs bare `setrlimit` syscalls and nothing else.
            // A caller-supplied hook may allocate (the Landlock ruleset builder does); that is sound
            // here only because the child is single-threaded at this point, which is the condition that
            // makes post-fork allocation dangerous in the first place. Documented rather than hidden.
            unsafe {
                cmd.pre_exec(move || {
                    if !limits.is_empty() {
                        limits::apply_rlimits(&limits)?;
                    }
                    if let Some(h) = &hook {
                        h()?;
                    }
                    Ok(())
                });
            }
        }
    }

    let child = cmd.spawn()?;
    // Adopted immediately after spawn, before anything is awaited. On Windows this is what stops the
    // tree outliving an abrupt death of the runtime; elsewhere it is a no-op. See `job`.
    //
    // There is a race in principle -- the shell could fork between `CreateProcess` and the assignment,
    // and that grandchild would not be a job member. In practice the shell has not finished parsing its
    // command line by then, and closing the window properly would need `CREATE_SUSPENDED`, which neither
    // std nor tokio exposes a thread handle for. Documented rather than papered over.
    job::adopt(&child);
    Ok(child)
}

/// Kill a process group, falling back to the single pid.
///
/// The group may already be gone (a normal exit racing the kill), which is not an error worth
/// reporting — the caller's intent was "make sure it is not running", and it is not.
pub(crate) fn kill_tree(child: &Child, force: bool) {
    let Some(pid) = child.id() else { return };
    kill_pid(pid, force);
}

/// Kill a process group by pid.
///
/// Split out from `kill_tree` for the background registry, which has no `Child` to hand: the reaper
/// task owns it, and a service is stopped by the pid the user sees. This is the same mechanism
/// `stopProcess` uses in the JS implementation, for the same reason.
pub(crate) fn kill_pid(pid: u32, force: bool) {

    #[cfg(unix)]
    {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        let sig = if force { Signal::SIGKILL } else { Signal::SIGTERM };
        let group = Pid::from_raw(pid as i32);
        if killpg(group, sig).is_err() {
            // No group, or it exited between the check and the signal: fall back so a command that
            // never forked is still stopped.
            let _ = nix::sys::signal::kill(group, sig);
        }
    }

    #[cfg(windows)]
    {
        // Windows has no process groups usable here; taskkill walks the tree by pid. `force` is
        // ignored because /F is the only mode taskkill offers for a tree.
        let _ = force;
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// Read a stream up to `cap` bytes into a shared buffer, then stop reading.
///
/// Two decisions here, and the second was a bug before a test caught it.
///
/// **Stop reading at the cap** rather than draining and discarding. The JS implementation keeps
/// consuming the pipe and throws the bytes away, so a command printing gigabytes still costs the time
/// to move them all.
///
/// **Append into a buffer the caller owns**, rather than returning one at the end. The reader can be
/// abandoned — a grandchild the command detached keeps the pipe open after the shell exits, so the
/// read never reaches EOF and the drain window expires. Owning the buffer inside the task meant that
/// on expiry everything read so far was thrown away, losing the output of a command that had in fact
/// completed and printed its result. Sharing it means an abandoned reader still leaves its bytes
/// behind, which is the "whatever it printed before it was cut off is still returned" property.
///
/// Returns whether the cap was reached.
async fn read_capped<R>(mut stream: R, cap: usize, sink: Arc<Mutex<Vec<u8>>>) -> bool
where
    R: AsyncReadExt + Unpin,
{
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) => return false,
            Ok(n) => {
                let mut out = sink.lock().unwrap_or_else(|e| e.into_inner());
                let room = cap.saturating_sub(out.len());
                if room == 0 {
                    return true;
                }
                out.extend_from_slice(&buf[..n.min(room)]);
                if out.len() >= cap {
                    return true;
                }
            }
            // A broken pipe is how a killed process's stream ends; keep what was read.
            Err(_) => return false,
        }
    }
}

/// Run a command to completion.
///
/// Never returns an error. A command that could not even be spawned reports the reason on `stderr` with
/// an `Unknown` exit code, exactly as the JS implementation does — the model needs to read what went
/// wrong, not receive an exception nobody catches.
pub async fn run(req: ProcessRequest, cancel: &CancellationToken) -> ProcessResult {
    let cap = req.max_buffer.unwrap_or(usize::MAX);

    // Nothing has been started, so there is nothing to kill and no output to report.
    if cancel.is_cancelled() {
        return ProcessResult {
            stdout: String::new(),
            stderr: String::new(),
            code: ExitCode::Unknown,
            killed: false,
            canceled: true,
            truncated: false,
            limits: LimitsApplied::None,
        };
    }

    let (_cgroup, applied) = limits::prepare(&req.limits, &format!("p{}", std::process::id()));

    let mut child = match spawn_command(&req) {
        Ok(c) => c,
        Err(e) => {
            limits::cleanup(&applied);
            return ProcessResult {
                stdout: String::new(),
                stderr: e.to_string(),
                code: ExitCode::Unknown,
                killed: false,
                canceled: false,
                truncated: false,
                limits: applied,
            };
        }
    };

    if let Some(pid) = child.id() {
        limits::attach(&applied, pid);
    }

    // Taken before any await so the readers own the pipes for the whole run. The buffers are shared
    // with the readers so an abandoned reader's bytes survive — see `read_capped`.
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    let mut out_task = child
        .stdout
        .take()
        .map(|s| tokio::spawn(read_capped(s, cap, Arc::clone(&out_buf))));
    let mut err_task = child
        .stderr
        .take()
        .map(|s| tokio::spawn(read_capped(s, cap, Arc::clone(&err_buf))));

    let mut killed = false;
    let mut canceled = false;
    let mut stopped = false;
    let mut status: Option<std::process::ExitStatus> = None;

    // Wait for the process, racing cancellation and the deadline.
    {
        let deadline = async {
            match req.timeout {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            biased;
            r = child.wait() => status = r.ok(),
            _ = cancel.cancelled() => { canceled = true; stopped = true; }
            _ = deadline => { killed = true; stopped = true; }
        }
    }

    // Stopped rather than finished: SIGTERM, grace window, then SIGKILL. The exit status is still
    // wanted afterwards, and a process that ignores TERM must not be able to hang the turn.
    if stopped {
        kill_tree(&child, false);
        status = match tokio::time::timeout(KILL_GRACE, child.wait()).await {
            Ok(r) => r.ok(),
            Err(_) => {
                tracing::debug!("process ignored SIGTERM; escalating to SIGKILL");
                kill_tree(&child, true);
                child.wait().await.ok()
            }
        };
    }

    // The process is gone. Drain whatever is still in flight, but do not wait forever on a pipe a
    // detached grandchild is holding open.
    async fn drain(
        task: Option<tokio::task::JoinHandle<bool>>,
        buf: &Arc<Mutex<Vec<u8>>>,
    ) -> (Vec<u8>, bool) {
        let cut = match task {
            Some(t) => match tokio::time::timeout(DRAIN_AFTER_EXIT, &mut { t }).await {
                Ok(Ok(cut)) => cut,
                // The window expired, or the reader panicked. Either way the bytes already read are
                // still in the shared buffer; the stream is simply reported as incomplete.
                _ => true,
            },
            None => false,
        };
        let bytes = buf.lock().unwrap_or_else(|e| e.into_inner()).clone();
        (bytes, cut)
    }
    let (out_bytes, out_cut) = drain(out_task.take(), &out_buf).await;
    let (err_bytes, err_cut) = drain(err_task.take(), &err_buf).await;

    limits::cleanup(&applied);

    let code = match status {
        Some(s) => match s.code() {
            Some(c) => ExitCode::Code(c),
            // Killed by a signal: no exit code exists.
            None => ExitCode::Unknown,
        },
        None => ExitCode::Unknown,
    };

    ProcessResult {
        stdout: decode_console(&out_bytes),
        stderr: decode_console(&err_bytes),
        code,
        killed,
        canceled,
        truncated: out_cut || err_cut,
        limits: applied,
    }
}
