//! Resource quotas (spec §16).
//!
//! The failure this exists to prevent is a specific one, and it is not hypothetical: a model that
//! plans badly fans out into a hundred sub-agents, a thousand tool calls, or a hundred Python
//! processes, and takes the user's desktop down with it. The current runtime's only defences are
//! `MAX_PARALLEL_SUBAGENTS = 3` and `MAX_SUBAGENTS_PER_TURN = 12`, both enforced by a scheduler
//! instance created *per turn* — so two conversations get three each, and nothing bounds the total.
//!
//! Quotas here are therefore **process-global and shared**, which is the whole difference. A permit is
//! an RAII guard: it is released when dropped, including when the task holding it panics or is
//! cancelled mid-await. There is no code path that forgets to give a permit back, because there is no
//! code path that gives one back explicitly.

use agent_core::{Result, RuntimeError};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// What a permit is being taken for. Each class has its own budget, because they exhaust different
/// things — model spend, CPU, file descriptors, host memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceClass {
    /// Top-level agent runs.
    Agent,
    /// Delegated sub-agents. Each is an independent model loop, so this is a spend control as much as
    /// a CPU one.
    SubAgent,
    /// Tool invocations.
    Tool,
    /// Spawned host processes.
    Process,
    /// In-flight MCP requests.
    Mcp,
}

impl ResourceClass {
    pub const ALL: [ResourceClass; 5] = [
        ResourceClass::Agent,
        ResourceClass::SubAgent,
        ResourceClass::Tool,
        ResourceClass::Process,
        ResourceClass::Mcp,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ResourceClass::Agent => "agent",
            ResourceClass::SubAgent => "sub_agent",
            ResourceClass::Tool => "tool",
            ResourceClass::Process => "process",
            ResourceClass::Mcp => "mcp",
        }
    }
}

/// Concurrency ceilings. Defaults follow spec §16.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub agents: usize,
    pub sub_agents: usize,
    pub tools: usize,
    pub processes: usize,
    pub mcp_requests: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { agents: 4, sub_agents: 4, tools: 16, processes: 8, mcp_requests: 16 }
    }
}

impl Limits {
    fn for_class(&self, class: ResourceClass) -> usize {
        match class {
            ResourceClass::Agent => self.agents,
            ResourceClass::SubAgent => self.sub_agents,
            ResourceClass::Tool => self.tools,
            ResourceClass::Process => self.processes,
            ResourceClass::Mcp => self.mcp_requests,
        }
    }
}

/// A held slot. Dropping it returns the slot, so cancellation and panics cannot leak capacity.
#[derive(Debug)]
pub struct Permit {
    class: ResourceClass,
    _inner: OwnedSemaphorePermit,
}

impl Permit {
    pub fn class(&self) -> ResourceClass {
        self.class
    }
}

/// The process-wide quota manager.
#[derive(Debug, Clone)]
pub struct ResourceManager {
    limits: Limits,
    agent: Arc<Semaphore>,
    sub_agent: Arc<Semaphore>,
    tool: Arc<Semaphore>,
    process: Arc<Semaphore>,
    mcp: Arc<Semaphore>,
}

impl ResourceManager {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            agent: Arc::new(Semaphore::new(limits.agents)),
            sub_agent: Arc::new(Semaphore::new(limits.sub_agents)),
            tool: Arc::new(Semaphore::new(limits.tools)),
            process: Arc::new(Semaphore::new(limits.processes)),
            mcp: Arc::new(Semaphore::new(limits.mcp_requests)),
        }
    }

    fn semaphore(&self, class: ResourceClass) -> &Arc<Semaphore> {
        match class {
            ResourceClass::Agent => &self.agent,
            ResourceClass::SubAgent => &self.sub_agent,
            ResourceClass::Tool => &self.tool,
            ResourceClass::Process => &self.process,
            ResourceClass::Mcp => &self.mcp,
        }
    }

    /// Wait for a slot. Suspends rather than spinning — spec §24 rules out polling loops.
    pub async fn acquire(&self, class: ResourceClass) -> Result<Permit> {
        let sem = Arc::clone(self.semaphore(class));
        let permit = sem.acquire_owned().await.map_err(|_| {
            RuntimeError::new(
                "resource.closed",
                agent_core::ErrorClass::Internal,
                "the resource manager is shutting down",
            )
        })?;
        Ok(Permit { class, _inner: permit })
    }

    /// Take a slot only if one is free right now.
    pub fn try_acquire(&self, class: ResourceClass) -> Result<Permit> {
        let sem = Arc::clone(self.semaphore(class));
        match sem.try_acquire_owned() {
            Ok(permit) => Ok(Permit { class, _inner: permit }),
            Err(_) => Err(RuntimeError::retryable(
                "resource.exhausted",
                format!(
                    "no {} slots available ({} in use of {})",
                    class.as_str(),
                    self.in_use(class),
                    self.limits.for_class(class)
                ),
            )),
        }
    }

    /// Wait for a slot, but not forever.
    ///
    /// Classed `Retryable`, unlike a cancellation: nothing was interrupted, the queue was simply too
    /// long, and trying again later is the correct response.
    pub async fn acquire_timeout(&self, class: ResourceClass, within: Duration) -> Result<Permit> {
        match tokio::time::timeout(within, self.acquire(class)).await {
            Ok(r) => r,
            Err(_) => Err(RuntimeError::retryable(
                "resource.exhausted",
                format!("timed out waiting for a {} slot", class.as_str()),
            )),
        }
    }

    pub fn available(&self, class: ResourceClass) -> usize {
        self.semaphore(class).available_permits()
    }

    pub fn in_use(&self, class: ResourceClass) -> usize {
        self.limits.for_class(class) - self.available(class)
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// A snapshot for `runtime.status`, so "why is nothing progressing?" is answerable.
    pub fn usage(&self) -> Vec<(ResourceClass, usize, usize)> {
        ResourceClass::ALL
            .iter()
            .map(|&c| (c, self.in_use(c), self.limits.for_class(c)))
            .collect()
    }
}

impl Default for ResourceManager {
    fn default() -> Self {
        Self::new(Limits::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small() -> ResourceManager {
        ResourceManager::new(Limits { agents: 1, sub_agents: 2, tools: 2, processes: 1, mcp_requests: 1 })
    }

    #[tokio::test]
    async fn permits_are_returned_on_drop() {
        let rm = small();
        assert_eq!(rm.available(ResourceClass::Tool), 2);
        {
            let _a = rm.acquire(ResourceClass::Tool).await.unwrap();
            let _b = rm.acquire(ResourceClass::Tool).await.unwrap();
            assert_eq!(rm.available(ResourceClass::Tool), 0);
            assert!(rm.try_acquire(ResourceClass::Tool).is_err());
        }
        assert_eq!(rm.available(ResourceClass::Tool), 2);
    }

    #[tokio::test]
    async fn exhaustion_is_retryable_not_fatal() {
        let rm = small();
        let _held = rm.acquire(ResourceClass::Process).await.unwrap();
        let err = rm.try_acquire(ResourceClass::Process).unwrap_err();
        assert_eq!(err.code, "resource.exhausted");
        assert!(err.class.is_retryable(), "a full queue is a wait, not a failure");
    }

    #[tokio::test]
    async fn classes_have_independent_budgets() {
        let rm = small();
        let _p = rm.acquire(ResourceClass::Process).await.unwrap();
        // Processes are exhausted; tools must be unaffected.
        assert!(rm.try_acquire(ResourceClass::Process).is_err());
        assert!(rm.try_acquire(ResourceClass::Tool).is_ok());
    }

    #[tokio::test]
    async fn a_permit_held_by_a_cancelled_task_is_released() {
        let rm = small();
        let rm2 = rm.clone();
        let handle = tokio::spawn(async move {
            let _permit = rm2.acquire(ResourceClass::Agent).await.unwrap();
            std::future::pending::<()>().await;
        });
        // Let the task take the only agent slot.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(rm.available(ResourceClass::Agent), 0);

        handle.abort();
        let _ = handle.await;
        // RAII, not bookkeeping: an aborted task cannot forget to give the slot back.
        assert_eq!(rm.available(ResourceClass::Agent), 1);
    }

    #[tokio::test]
    async fn acquire_timeout_gives_up_rather_than_hanging() {
        let rm = small();
        let _held = rm.acquire(ResourceClass::Agent).await.unwrap();
        let err = rm
            .acquire_timeout(ResourceClass::Agent, Duration::from_millis(30))
            .await
            .unwrap_err();
        assert_eq!(err.code, "resource.exhausted");
    }
}
