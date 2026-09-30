//! Durable task state — what survives a runtime that stopped without being asked to.
//!
//! TODO §10.3 (task recovery) and §15 ("Context State can be persisted"). This crate exists because of a
//! decision recorded in TODO §0.2: **fail-open is being removed**. Today a sidecar crash falls back to the JS
//! handlers, so nothing is lost and nothing needs recovering. Once that fallback is gone, a crash has to be
//! *survivable* instead — and `Scheduler::snapshot()` is a `HashMap` in a driver task, which dies with it.
//!
//! ## The rule that shapes everything here
//!
//! **Work that may already have had side effects is never silently re-run.**
//!
//! This is the same rule `electron/tools/rustRuntime.mjs` reached for its fallback, and for the same reason:
//! re-running `npm install`, `git push` or `rm -rf build` because the runtime died halfway through is a
//! second execution of something the user asked for once. So recovery does not produce "the tasks to resume".
//! It produces two lists, split by whether the task had begun:
//!
//! | Journal shows | Meaning | [`RecoveryPlan`] |
//! |---|---|---|
//! | submitted, never started | queued when the process died; nothing ran | `resumable` |
//! | started, never settled | the body was running; side effects are possible | `interrupted` |
//! | settled | finished, one way or another | neither — it is done |
//!
//! `interrupted` is deliberately not actionable by this crate. Whether such a task may be retried is a
//! question about what it *was* — a read is safe to repeat and a deploy is not — and the answer lives with
//! the caller that submitted it.
//!
//! ## Why an append-only journal rather than a snapshot file
//!
//! A snapshot has to be rewritten in place, and a process that dies mid-rewrite leaves a file that is neither
//! the old state nor the new one. An append-only log cannot lose what it already wrote: a crash can only ever
//! tear the *last* line, and [`replay`] discards a trailing partial record and keeps everything before it.
//! That property is the whole reason for the format, and it is tested directly.
//!
//! ## Where the fsync goes, and why only there
//!
//! Flushing every record would put a disk round-trip in the scheduler's driver loop, which must never block —
//! it is what keeps Stop responsive. Flushing nothing would defeat the purpose. The asymmetry that resolves it
//! comes from which direction each loss is wrong in:
//!
//!  - **Losing a `Started` record is dangerous.** Replay would see a task that was only ever queued and offer
//!    it as `resumable`, and the caller would run a command that had already begun.
//!  - **Losing a `Settled` record is harmless.** Replay reports a finished task as `interrupted`, the caller
//!    investigates, and nothing runs twice.
//!
//! So `Started` is written through [`Journal::record_durable`], which returns only once the bytes are on the
//! disk, and everything else through [`Journal::record`], which does not wait. The durable write is issued
//! from the *task* rather than from the driver, so the wait costs that task's startup and not the loop's
//! responsiveness — see `agent-scheduler`'s `spawn`.

use std::path::{Path, PathBuf};

use agent_core::{ErrorClass, Result, RuntimeError, TaskState};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot};

/// One line of the journal.
///
/// `seq` is assigned by the writer and is monotonic, so replay can report a gap rather than merely be wrong
/// about one. `at_ms` is wall-clock, for the audit trail; nothing in recovery depends on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub seq: u64,
    pub at_ms: u64,
    #[serde(flatten)]
    pub event: JournalEvent,
    /// Chain link over every entry so far (TODO §12 Audit Integrity).
    ///
    /// `chain(previous_link, this_entry)`. Editing a line, deleting one, or reordering two makes every link
    /// after it disagree, so [`replay`] can say *where* the trail stopped being trustworthy rather than only
    /// that something is wrong.
    ///
    /// ## What this is and is not
    ///
    /// It is **tamper-evident, not tamper-proof**, and the distinction is not a detail. The hash is
    /// FNV-1a — fast, keyless, and not cryptographic — so it detects truncation, reordering, accidental
    /// corruption and casual editing. It does **not** stop someone who can write to this file: they can
    /// recompute every link after their change and the chain will verify.
    ///
    /// Making it resistant to that needs a keyed MAC whose key is not stored beside the log, and *where that
    /// key lives* is a product decision rather than a coding one — see TODO §0.2 F8. Claiming cryptographic
    /// integrity here without it would be worse than claiming nothing.
    #[serde(default)]
    pub link: u64,
}

/// The task lifecycle, as far as durability cares about it.
///
/// Not every scheduler event is here. Retries and dependency edges are reconstructable from what is, and a
/// journal that records everything is a journal that costs more than the crash it insures against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum JournalEvent {
    /// Accepted by the scheduler and queued. Nothing has run.
    Submitted {
        task: String,
        label: String,
        priority: String,
        resource: String,
        parent: Option<String>,
    },
    /// An attempt is about to begin. Written durably: everything after this point may have side effects.
    Started { task: String, attempt: u32 },
    /// The task reached a terminal state.
    Settled { task: String, state: TaskState, detail: Option<String> },
    /// The runtime shut down on purpose. Its absence at the end of a journal is what identifies a crash.
    ShutDown,
}

/// A handle to the journal writer. Cheap to clone; every clone writes to the same file in order.
#[derive(Clone)]
pub struct Journal {
    tx: mpsc::UnboundedSender<Msg>,
}

enum Msg {
    Write { event: JournalEvent, ack: Option<oneshot::Sender<Result<()>>> },
    Flush { ack: oneshot::Sender<Result<()>> },
}

/// One link of the integrity chain: the previous link folded together with this entry's content.
///
/// FNV-1a over the entry's stable fields. `at_ms` is included because a record moved in time is a record that
/// has been altered, even if nothing else about it changed.
fn chain(previous: u64, seq: u64, at_ms: u64, event: &JournalEvent) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
    };
    eat(&previous.to_le_bytes());
    eat(&seq.to_le_bytes());
    eat(&at_ms.to_le_bytes());
    eat(serde_json::to_string(event).unwrap_or_default().as_bytes());
    h
}

/// A journal that discards everything, for callers that have not opted into durability.
///
/// Provided so the scheduler has one code path rather than an `Option` threaded through every transition — a
/// branch at each write site is a branch that can be forgotten at one of them.
impl Journal {
    pub fn disabled() -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Msg>();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                // Acks still resolve, so a caller awaiting a durable write is never left hanging just
                // because durability is off.
                match msg {
                    Msg::Write { ack: Some(ack), .. } => {
                        let _ = ack.send(Ok(()));
                    }
                    Msg::Flush { ack } => {
                        let _ = ack.send(Ok(()));
                    }
                    Msg::Write { ack: None, .. } => {}
                }
            }
        });
        Self { tx }
    }

    /// Open (or create) a journal at `path`, appending to whatever is already there.
    ///
    /// Appending rather than truncating is what makes a second crash survivable: the run that recovers from
    /// one crash is itself journalled into the same file, so the history is not reset by the act of reading
    /// it. Call [`Journal::rotate`] to start a fresh one once recovery has been dealt with.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| io_error("create the journal directory", &path, e))?;
        }
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|e| io_error("open the journal", &path, e))?;

        // Both continue from what is already on disk, so a journal reopened after a crash extends its chain
        // rather than starting a second one that would look like tampering at the seam.
        let (start_seq, start_link) = resume_point(&path).await;
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(writer(file, rx, start_seq, start_link));
        Ok(Self { tx })
    }

    /// Record an event without waiting for it to reach the disk.
    ///
    /// Ordering is still preserved — one writer, one channel — so a `Settled` written this way can never
    /// overtake the `Started` that preceded it.
    pub fn record(&self, event: JournalEvent) {
        let _ = self.tx.send(Msg::Write { event, ack: None });
    }

    /// Record an event and return only once it is durable.
    ///
    /// Use this before doing anything the journal's reader must not be allowed to miss. It costs a disk
    /// round-trip, so it is for `Started` and little else.
    pub async fn record_durable(&self, event: JournalEvent) -> Result<()> {
        let (ack, rx) = oneshot::channel();
        self.tx.send(Msg::Write { event, ack: Some(ack) }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())?
    }

    /// Flush everything written so far.
    pub async fn flush(&self) -> Result<()> {
        let (ack, rx) = oneshot::channel();
        self.tx.send(Msg::Flush { ack }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())?
    }

    /// Mark a clean shutdown and flush.
    ///
    /// The record itself is what lets replay tell "stopped on purpose" from "died": a journal whose last line
    /// is `ShutDown` had nothing interrupted, however many tasks were mid-flight when the process began
    /// stopping.
    pub async fn shut_down(&self) -> Result<()> {
        self.record_durable(JournalEvent::ShutDown).await
    }

    /// Move the current journal aside, so the next run starts a fresh one.
    ///
    /// Called once a [`RecoveryPlan`] has been acted on. Keeping the old file rather than deleting it means a
    /// recovery that itself goes wrong is still diagnosable.
    pub async fn rotate(path: impl AsRef<Path>) -> Result<Option<PathBuf>> {
        let path = path.as_ref();
        if tokio::fs::metadata(path).await.is_err() {
            return Ok(None);
        }
        let stamp = now_ms();
        let to = path.with_extension(format!("{stamp}.jsonl"));
        tokio::fs::rename(path, &to).await.map_err(|e| io_error("rotate the journal", path, e))?;
        Ok(Some(to))
    }
}

/// The single writer. Owns the file; nothing else touches it.
async fn writer(
    mut file: tokio::fs::File,
    mut rx: mpsc::UnboundedReceiver<Msg>,
    mut seq: u64,
    mut link: u64,
) {
    while let Some(msg) = rx.recv().await {
        match msg {
            Msg::Write { event, ack } => {
                let at_ms = now_ms();
                link = chain(link, seq, at_ms, &event);
                let entry = JournalEntry { seq, at_ms, event, link };
                seq += 1;
                let mut line = match serde_json::to_string(&entry) {
                    Ok(line) => line,
                    Err(e) => {
                        // A record that cannot be serialised is a bug, not a disk problem. Log it and keep
                        // the journal usable rather than tearing down the runtime's durability entirely.
                        tracing::error!(error = %e, "journal entry could not be serialised");
                        if let Some(ack) = ack {
                            let _ = ack.send(Err(RuntimeError::internal("journal entry is not serialisable")));
                        }
                        continue;
                    }
                };
                line.push('\n');

                let mut result = file.write_all(line.as_bytes()).await.map_err(|e| {
                    io_error("write to the journal", Path::new("<journal>"), e)
                });
                // Only a durable write pays for the sync; see the module header for why that asymmetry is
                // safe in exactly one direction.
                if result.is_ok() && ack.is_some() {
                    result = sync(&mut file).await;
                }
                if let Err(e) = &result {
                    tracing::error!(error = %e, "journal write failed");
                }
                if let Some(ack) = ack {
                    let _ = ack.send(result);
                }
            }
            Msg::Flush { ack } => {
                let result = match file.flush().await {
                    Ok(()) => sync(&mut file).await,
                    Err(e) => Err(io_error("flush the journal", Path::new("<journal>"), e)),
                };
                let _ = ack.send(result);
            }
        }
    }
    // The channel closed: every handle is gone, so flush what is left rather than losing the tail.
    let _ = file.flush().await;
    let _ = file.sync_data().await;
}

async fn sync(file: &mut tokio::fs::File) -> Result<()> {
    file.flush().await.map_err(|e| io_error("flush the journal", Path::new("<journal>"), e))?;
    file.sync_data().await.map_err(|e| io_error("sync the journal", Path::new("<journal>"), e))
}

/// What one task looked like when the journal ended.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecoveredTask {
    pub id: String,
    pub label: String,
    pub priority: String,
    pub resource: String,
    pub parent: Option<String>,
    /// How many attempts had begun. 0 means it never ran.
    pub attempts: u32,
}

/// What a previous run left behind.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RecoveryPlan {
    /// Queued and never started. Nothing ran, so these are safe to submit again as they were.
    pub resumable: Vec<RecoveredTask>,
    /// An attempt had begun and never reported. **May have had side effects** — never re-run one of these
    /// without deciding, per task, whether repeating it is safe.
    pub interrupted: Vec<RecoveredTask>,
    /// The journal ended with a clean shutdown record, so nothing was actually interrupted.
    pub clean_shutdown: bool,
    /// A trailing partial line was discarded — the signature of a process killed mid-write.
    pub torn_tail: bool,
    /// Lines that were complete but unreadable. Non-zero means the file was damaged beyond a torn tail.
    pub corrupt_lines: u64,
    /// The `seq` of the first entry whose chain link did not match (TODO §12 Audit Integrity).
    ///
    /// `Some` means the trail was altered, reordered or had a line removed at or before that point, and
    /// everything from there on should be treated as unreliable. `None` means every link verified — which is
    /// evidence of integrity, not proof of it; see [`JournalEntry::link`].
    pub integrity_broken_at: Option<u64>,
}

impl RecoveryPlan {
    /// Is there anything for a caller to do?
    pub fn is_empty(&self) -> bool {
        self.resumable.is_empty() && self.interrupted.is_empty()
    }
}

/// Read a journal and work out what a previous run left unfinished.
///
/// Never fails on a damaged file. A journal is read at startup, and refusing to start because the crash log
/// is itself malformed would turn one bad run into a runtime that cannot boot — so damage is *reported*
/// (`torn_tail`, `corrupt_lines`) and the readable part is used.
pub async fn replay(path: impl AsRef<Path>) -> Result<RecoveryPlan> {
    let path = path.as_ref();
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        // No journal is the ordinary first-run case, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RecoveryPlan::default()),
        Err(e) => return Err(io_error("read the journal", path, e)),
    };
    Ok(replay_str(&text))
}

/// The pure part of [`replay`], so the interesting cases can be tested without a filesystem.
pub fn replay_str(text: &str) -> RecoveryPlan {
    let mut plan = RecoveryPlan::default();
    // Insertion-ordered, so recovery is offered in the order the tasks were submitted rather than in whatever
    // order a hash map happens to yield. A caller resubmitting them should not have the order changed under it.
    let mut order: Vec<String> = Vec::new();
    let mut live: std::collections::HashMap<String, (RecoveredTask, bool)> = std::collections::HashMap::new();
    let mut expected_link: u64 = 0;

    // A file that does not end in a newline had its last line cut short by whatever stopped the process.
    let ends_cleanly = text.is_empty() || text.ends_with('\n');
    let mut lines: Vec<&str> = text.lines().collect();
    if !ends_cleanly && !lines.is_empty() {
        lines.pop();
        plan.torn_tail = true;
    }

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let entry: JournalEntry = match serde_json::from_str(line) {
            Ok(entry) => entry,
            Err(_) => {
                plan.corrupt_lines += 1;
                continue;
            }
        };
        // Verify the chain before trusting the entry. Reported rather than fatal: a tampered journal is
        // exactly when someone most needs to see what it still says, and refusing to read it would destroy the
        // evidence along with the trust.
        expected_link = chain(expected_link, entry.seq, entry.at_ms, &entry.event);
        if entry.link != expected_link && plan.integrity_broken_at.is_none() {
            plan.integrity_broken_at = Some(entry.seq);
            // Continue from what the file claims, so ONE altered line does not report every later line as
            // broken too — the first break is the informative one.
            expected_link = entry.link;
        }

        // Any record after a shutdown means the runtime came back up and kept going.
        if !matches!(entry.event, JournalEvent::ShutDown) {
            plan.clean_shutdown = false;
        }
        match entry.event {
            JournalEvent::Submitted { task, label, priority, resource, parent } => {
                if !live.contains_key(&task) {
                    order.push(task.clone());
                }
                live.insert(
                    task.clone(),
                    (RecoveredTask { id: task, label, priority, resource, parent, attempts: 0 }, false),
                );
            }
            JournalEvent::Started { task, attempt } => {
                if let Some((rec, started)) = live.get_mut(&task) {
                    *started = true;
                    rec.attempts = rec.attempts.max(attempt);
                }
            }
            JournalEvent::Settled { task, .. } => {
                live.remove(&task);
            }
            JournalEvent::ShutDown => plan.clean_shutdown = true,
        }
    }

    for id in order {
        if let Some((rec, started)) = live.remove(&id) {
            if started {
                plan.interrupted.push(rec);
            } else {
                plan.resumable.push(rec);
            }
        }
    }
    plan
}

/// Where the next entry's `seq` and chain link should continue from, so both survive a restart.
///
/// Best-effort: an unreadable journal restarts both, which costs a gap in the audit trail and nothing else. It
/// must not prevent the runtime from opening a journal.
async fn resume_point(path: &Path) -> (u64, u64) {
    let Ok(text) = tokio::fs::read_to_string(path).await else { return (0, 0) };
    text.lines()
        .rev()
        .find_map(|l| serde_json::from_str::<JournalEntry>(l).ok())
        .map(|e| (e.seq + 1, e.link))
        .unwrap_or((0, 0))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn io_error(what: &str, path: &Path, e: std::io::Error) -> RuntimeError {
    RuntimeError::new("journal.io", ErrorClass::Internal, format!("could not {what} at {}", path.display()))
        .with_cause(e)
}

fn writer_gone() -> RuntimeError {
    RuntimeError::new("journal.stopped", ErrorClass::Internal, "the journal writer is no longer running")
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "lib_integrity_tests.rs"]
mod integrity_tests;
