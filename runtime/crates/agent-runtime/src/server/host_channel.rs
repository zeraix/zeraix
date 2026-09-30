//! The channel the runtime asks its host through — consent, questions, tools it does not serve, delegations.

use super::*;

/// Removes a pending host call when its future ends, however it ends.
struct PendingGuard {
    calls: Arc<DashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.calls.remove(&self.id);
    }
}

/// The runtime's end of the runtime→host direction.
///
/// Split out of `Server` so a task that outlives a request — a delegation body, and later a consent
/// prompt — can hold one without holding the whole server.
#[derive(Clone)]
pub struct HostChannel {
    sender: Arc<OnceLock<StdioSender>>,
    calls: Arc<DashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    next_id: Arc<std::sync::atomic::AtomicU64>,
}

impl HostChannel {
    /// Ask the host to do something, and wait for its answer.
    ///
    /// Errors rather than panics on every path a caller cannot control: no transport yet, a host that
    /// never answers, a host that answers with an error. A sub-agent whose body cannot be dispatched is
    /// a failed delegation, not a dead runtime.
    pub async fn ask(
        &self,
        method: &'static str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let Some(tx) = self.sender.get().cloned() else {
            return Err("the runtime has no connection to its host".to_owned());
        };
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        // Registered BEFORE the send, not after. The host can answer in the same breath as it reads,
        // and a reply arriving before this entry existed would be discarded as one nobody is waiting
        // for — leaving the caller to time out on work that had already been done. The same ordering
        // rule that the process-exit and MCP-state races both came down to.
        self.calls.insert(id, reply_tx);
        // Removes the entry however this future ends, including being DROPPED — which is exactly what
        // happens to a cancelled delegation, since the supervisor aborts its task. Without this, every
        // cancelled sub-agent would leave a sender behind waiting for a reply that never comes.
        let _cleanup = PendingGuard { calls: Arc::clone(&self.calls), id };

        let line = match serde_json::to_string(&HostRequest { id, method, params }) {
            Ok(line) => line,
            Err(e) => return Err(format!("could not encode a request to the host: {e}")),
        };
        if let Err(e) = tx.send(line).await {
            return Err(format!("could not reach the host: {e}"));
        }

        match tokio::time::timeout(timeout, reply_rx).await {
            Ok(Ok(result)) => result,
            // The sender was dropped, which only happens if the entry was removed by a shutdown.
            Ok(Err(_)) => Err("the host connection closed before answering".to_owned()),
            // The guard removes the entry, so a late reply is discarded rather than settling a
            // caller that gave up.
            Err(_) => Err(format!("the host did not answer {method} within {timeout:?}")),
        }
    }
}

impl Server {
    /// A handle to the runtime→host direction, for tasks that outlive a request.    /// A handle to the runtime→host direction, for tasks that outlive a request.
    pub(super) fn host_channel(&self) -> HostChannel {
        HostChannel {
            sender: Arc::clone(&self.events),
            calls: Arc::clone(&self.host_calls),
            next_id: Arc::clone(&self.next_host_id),
        }
    }
}
