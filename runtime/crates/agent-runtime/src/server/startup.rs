//! Building a runtime: with durable state or without, and recovering what the last one left in its journal.

use super::*;

impl Default for Server {
    fn default() -> Self {
        Self::new()
    }
}

impl Server {
    /// A runtime with no durable state. Used by the tests and the parity harness, which have nowhere to write
    /// and nothing to recover.
    pub fn new() -> Self {
        Self::build(Journal::disabled(), RecoveryPlan::default())
    }

    /// A runtime that journals its task lifecycle under `state_dir`, recovering from whatever is there.
    ///
    /// Replay happens before the scheduler starts, so the plan describes the *previous* run only and cannot
    /// be polluted by this one's first submissions. The journal is then rotated: the old file is kept for
    /// diagnosis under a timestamped name, and this run starts a clean one. Without the rotation every
    /// restart would re-report the same interrupted tasks forever, since nothing in this process can settle
    /// a task whose body died with the last one.
    pub async fn with_state_dir(state_dir: impl AsRef<std::path::Path>) -> Self {
        let path = state_dir.as_ref().join("tasks.jsonl");
        let recovered = match agent_journal::replay(&path).await {
            Ok(plan) => plan,
            Err(e) => {
                // A journal that cannot be read must not stop the runtime from starting: that would turn one
                // bad file into a runtime that never boots again.
                tracing::error!(error = %e, "could not read the task journal; starting without recovery");
                RecoveryPlan::default()
            }
        };
        if !recovered.is_empty() || recovered.torn_tail || recovered.corrupt_lines > 0 {
            tracing::warn!(
                resumable = recovered.resumable.len(),
                interrupted = recovered.interrupted.len(),
                torn_tail = recovered.torn_tail,
                corrupt_lines = recovered.corrupt_lines,
                "recovered unfinished work from a previous run"
            );
        }
        if let Err(e) = Journal::rotate(&path).await {
            tracing::error!(error = %e, "could not rotate the task journal");
        }
        let journal = match Journal::open(&path).await {
            Ok(journal) => journal,
            Err(e) => {
                tracing::error!(error = %e, "could not open the task journal; continuing without durability");
                Journal::disabled()
            }
        };
        Self::build(journal, recovered)
    }

    fn build(journal: Journal, recovered: RecoveryPlan) -> Self {
        let mut registry = ToolRegistry::new();
        agent_tools::tools::register_builtin(&mut registry);
        let bus = EventBus::new(agent_events::DEFAULT_CAPACITY);
        Self {
            registry: Arc::new(registry),
            file_cache: Arc::new(FileListCache::new()),
            inflight: Arc::new(DashMap::new()),
            early_cancels: Arc::new(Mutex::new(VecDeque::new())),
            root_cancel: CancellationToken::new(),
            initialized: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            background: Arc::new(BackgroundRegistry::new()),
            mcp: Arc::new(McpManager::new()),
            events: Arc::new(OnceLock::new()),
            host_calls: Arc::new(DashMap::new()),
            next_host_id: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            subagents: Arc::new(DashMap::new()),
            bus: bus.clone(),
            scheduler: Arc::new(Scheduler::start_journalled(
                ResourceManager::new(Limits::default()),
                bus,
                journal,
            )),
            metrics: Arc::new(agent_audit::MetricsCollector::new()),
            permissions: Arc::new(SessionPermissions::default()),
            recovered: Arc::new(recovered),
        }
    }
}
