//! Observability (spec §22, TODO §9).
//!
//! ## Derived from the event stream, not sprinkled through call sites
//!
//! The four measurements §9 asks for — scheduling latency, tool execution duration, MCP connection
//! status, cancellation propagation latency — are all *relationships between two events*. Instrumenting
//! them at their call sites would mean threading a clock and a metrics handle through the scheduler, the
//! tool registry and the MCP supervisor, and every new measurement would mean touching all of them
//! again.
//!
//! The event bus already carries what is needed, with timestamps and a monotonic sequence. So this
//! subscribes and derives. The cost is that a metric is only as good as the events it is built from —
//! which is why `TaskCancelRequested` was added rather than inferring the request time from when the
//! task settled, since that would have measured zero by construction.
//!
//! ## Percentiles, not averages
//!
//! A mean hides exactly the case worth finding. "Cancellation usually propagates in 2 ms" is not the
//! question; "how long does Stop take when it is slow" is, and only a tail answers that. Samples are
//! kept in a bounded ring and sorted on demand — for the volumes involved (hundreds of tasks per turn)
//! that is cheaper than maintaining a histogram, and exact rather than bucketed.

use agent_events::{Event, EventKind};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Samples retained per metric. Enough for a long turn; bounded so a soak run cannot grow without end.
pub const MAX_SAMPLES: usize = 4096;

/// A bounded sample set with exact percentiles.
#[derive(Debug, Default, Clone)]
pub struct Samples {
    values: Vec<u64>,
    /// Total observed, including samples dropped once the ring filled.
    count: u64,
}

impl Samples {
    pub fn record(&mut self, v: u64) {
        self.count += 1;
        if self.values.len() < MAX_SAMPLES {
            self.values.push(v);
        } else {
            // Keep the oldest window rather than evicting randomly: a metric that silently reshapes
            // itself under load is worse than one that stops sampling and says how many it saw.
        }
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// `q` in 0.0..=1.0. `None` when nothing was sampled.
    ///
    /// Nearest-rank on `(n-1) * q`, rounded — so for 1..=100, `p50` is 51 rather than 50.5. Stated
    /// because percentile definitions differ and a reader comparing these numbers against another tool's
    /// needs to know which one this is; no interpolation, so every value reported is one that was
    /// actually observed.
    pub fn percentile(&self, q: f64) -> Option<u64> {
        if self.values.is_empty() {
            return None;
        }
        let mut sorted = self.values.clone();
        sorted.sort_unstable();
        let idx = ((sorted.len() - 1) as f64 * q.clamp(0.0, 1.0)).round() as usize;
        Some(sorted[idx])
    }

    pub fn max(&self) -> Option<u64> {
        self.values.iter().copied().max()
    }

    pub fn mean(&self) -> Option<u64> {
        if self.values.is_empty() {
            return None;
        }
        Some(self.values.iter().sum::<u64>() / self.values.len() as u64)
    }

    pub fn summary(&self) -> MetricSummary {
        MetricSummary {
            count: self.count,
            p50: self.percentile(0.5),
            p95: self.percentile(0.95),
            p99: self.percentile(0.99),
            max: self.max(),
            mean: self.mean(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MetricSummary {
    pub count: u64,
    pub p50: Option<u64>,
    pub p95: Option<u64>,
    pub p99: Option<u64>,
    pub max: Option<u64>,
    pub mean: Option<u64>,
}

/// Everything the collector knows, in milliseconds.
#[derive(Debug, Clone, Serialize)]
pub struct MetricsSnapshot {
    /// Submit → start. How long work waits for a slot.
    pub scheduling_latency_ms: MetricSummary,
    /// Start → settle, for tasks that completed.
    pub task_duration_ms: MetricSummary,
    /// Cancel requested → task settled. What Stop actually costs.
    pub cancellation_latency_ms: MetricSummary,
    /// Tool call duration, by tool name.
    pub tool_duration_ms: Vec<(String, MetricSummary)>,
    pub tasks_completed: u64,
    pub tasks_failed: u64,
    pub tasks_cancelled: u64,
    pub tasks_timed_out: u64,
    /// Permission decisions, so "what was refused" is answerable.
    pub permissions_denied: u64,
}

#[derive(Default)]
struct Inner {
    submitted_at: HashMap<String, u64>,
    cancel_requested_at: HashMap<String, u64>,
    scheduling: Samples,
    duration: Samples,
    cancellation: Samples,
    tools: HashMap<String, Samples>,
    completed: u64,
    failed: u64,
    cancelled: u64,
    timed_out: u64,
    denied: u64,
}

/// Subscribes to the event bus and derives metrics from it.
#[derive(Clone, Default)]
pub struct MetricsCollector {
    inner: Arc<Mutex<Inner>>,
}

impl MetricsCollector {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Fold one event in. Public so a caller can drive it synchronously in a test.
    pub fn observe(&self, event: &Event) {
        let mut inner = self.lock();
        match &event.kind {
            EventKind::TaskSubmitted { task, .. } => {
                inner.submitted_at.insert(task.to_string(), event.at_ms);
            }
            EventKind::TaskStarted { task } => {
                if let Some(at) = inner.submitted_at.get(&task.to_string()).copied() {
                    inner.scheduling.record(event.at_ms.saturating_sub(at));
                }
            }
            EventKind::TaskCompleted { task, duration_ms } => {
                inner.duration.record(*duration_ms);
                inner.completed += 1;
                let key = task.to_string();
                inner.submitted_at.remove(&key);
                inner.cancel_requested_at.remove(&key);
            }
            EventKind::TaskFailed { task, .. } => {
                inner.failed += 1;
                let key = task.to_string();
                inner.submitted_at.remove(&key);
                inner.cancel_requested_at.remove(&key);
            }
            EventKind::TaskCancelRequested { task } => {
                inner.cancel_requested_at.insert(task.to_string(), event.at_ms);
            }
            EventKind::TaskCancelled { task } => {
                inner.cancelled += 1;
                let key = task.to_string();
                // Only measurable when a request was seen: a task cancelled by its parent's token
                // never had one of its own, and recording zero for it would flatter the tail.
                if let Some(at) = inner.cancel_requested_at.remove(&key) {
                    inner.cancellation.record(event.at_ms.saturating_sub(at));
                }
                inner.submitted_at.remove(&key);
            }
            EventKind::TaskTimedOut { task, .. } => {
                inner.timed_out += 1;
                inner.submitted_at.remove(&task.to_string());
            }
            EventKind::ToolCompleted { name, duration_ms, .. } => {
                inner.tools.entry(name.clone()).or_default().record(*duration_ms);
            }
            EventKind::PermissionDecided { granted, .. } if !*granted => {
                inner.denied += 1;
            }
            _ => {}
        }
    }

    /// Consume the bus until it closes. Spawn this once at startup.
    pub fn attach(&self, bus: &agent_events::EventBus) -> tokio::task::JoinHandle<()> {
        let mut rx = bus.subscribe();
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => me.observe(&event),
                    // A lagged collector has missed events. Counting the gap matters more than the
                    // samples: a metric built from a partial stream must not look authoritative.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(missed = n, "metrics collector lagged; samples are incomplete");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        })
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        let inner = self.lock();
        let mut tools: Vec<(String, MetricSummary)> =
            inner.tools.iter().map(|(k, v)| (k.clone(), v.summary())).collect();
        tools.sort_by(|a, b| a.0.cmp(&b.0));
        MetricsSnapshot {
            scheduling_latency_ms: inner.scheduling.summary(),
            task_duration_ms: inner.duration.summary(),
            cancellation_latency_ms: inner.cancellation.summary(),
            tool_duration_ms: tools,
            tasks_completed: inner.completed,
            tasks_failed: inner.failed,
            tasks_cancelled: inner.cancelled,
            tasks_timed_out: inner.timed_out,
            permissions_denied: inner.denied,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_core::{CallId, TaskId};
    use agent_events::EventBus;

    fn ev(seq: u64, at_ms: u64, kind: EventKind) -> Event {
        Event { seq, at_ms, kind }
    }

    #[test]
    fn percentiles_are_exact_and_ordered() {
        let mut s = Samples::default();
        for v in 1..=100 {
            s.record(v);
        }
        // Nearest-rank: index = round(99 * 0.5) = 50, so sorted[50] == 51. Every reported value is one
        // that was actually observed, which interpolation would not guarantee.
        assert_eq!(s.percentile(0.5), Some(51));
        assert_eq!(s.percentile(0.99), Some(99));
        assert_eq!(s.percentile(0.0), Some(1));
        assert_eq!(s.percentile(1.0), Some(100));
        assert_eq!(s.max(), Some(100));
        assert_eq!(s.count(), 100);
    }

    #[test]
    fn an_empty_metric_reports_nothing_rather_than_zero() {
        // Zero would read as "instant", which is the opposite of "never measured".
        let s = Samples::default();
        assert_eq!(s.percentile(0.5), None);
        assert_eq!(s.mean(), None);
    }

    #[test]
    fn scheduling_latency_is_submit_to_start() {
        let c = MetricsCollector::new();
        let t = TaskId::from_host("t1");
        c.observe(&ev(0, 1000, EventKind::TaskSubmitted { task: t.clone(), parent: None, priority: "normal".into() }));
        c.observe(&ev(1, 1120, EventKind::TaskStarted { task: t }));
        assert_eq!(c.snapshot().scheduling_latency_ms.p50, Some(120));
    }

    #[test]
    fn cancellation_latency_measures_request_to_settle() {
        let c = MetricsCollector::new();
        let t = TaskId::from_host("t1");
        c.observe(&ev(0, 1000, EventKind::TaskSubmitted { task: t.clone(), parent: None, priority: "normal".into() }));
        c.observe(&ev(1, 1010, EventKind::TaskStarted { task: t.clone() }));
        c.observe(&ev(2, 2000, EventKind::TaskCancelRequested { task: t.clone() }));
        c.observe(&ev(3, 2045, EventKind::TaskCancelled { task: t }));
        let snap = c.snapshot();
        assert_eq!(snap.cancellation_latency_ms.p50, Some(45));
        assert_eq!(snap.tasks_cancelled, 1);
    }

    #[test]
    fn a_task_cancelled_without_its_own_request_is_not_sampled_as_instant() {
        // A child cancelled by its parent's token never had a request of its own. Recording 0 would
        // flatter the tail, which is the one number this metric exists to expose.
        let c = MetricsCollector::new();
        let t = TaskId::from_host("child");
        c.observe(&ev(0, 5000, EventKind::TaskCancelled { task: t }));
        let snap = c.snapshot();
        assert_eq!(snap.tasks_cancelled, 1);
        assert_eq!(snap.cancellation_latency_ms.count, 0, "an unmeasurable cancellation was sampled");
    }

    #[test]
    fn tool_durations_are_kept_per_tool() {
        let c = MetricsCollector::new();
        for (name, ms) in [("read_file", 3u64), ("search_in_files", 900), ("read_file", 5)] {
            c.observe(&ev(0, 0, EventKind::ToolCompleted {
                call: CallId::from_host("c"),
                name: name.into(),
                ok: true,
                duration_ms: ms,
            }));
        }
        let snap = c.snapshot();
        let by = |n: &str| snap.tool_duration_ms.iter().find(|(k, _)| k == n).unwrap().1.clone();
        assert_eq!(by("read_file").count, 2);
        assert_eq!(by("search_in_files").p50, Some(900));
    }

    #[test]
    fn denied_permissions_are_counted_and_grants_are_not() {
        let c = MetricsCollector::new();
        for granted in [true, false, false] {
            c.observe(&ev(0, 0, EventKind::PermissionDecided {
                call: CallId::from_host("c"),
                capability: "filesystem.write".into(),
                granted,
            }));
        }
        assert_eq!(c.snapshot().permissions_denied, 2);
    }

    #[tokio::test]
    async fn attaching_to_the_bus_collects_live_events() {
        let bus = EventBus::new(64);
        let c = MetricsCollector::new();
        let _h = c.attach(&bus);

        let t = TaskId::from_host("t1");
        bus.publish(EventKind::TaskSubmitted { task: t.clone(), parent: None, priority: "high".into() });
        bus.publish(EventKind::TaskStarted { task: t.clone() });
        bus.publish(EventKind::TaskCompleted { task: t, duration_ms: 42 });

        // Let the collector task drain.
        for _ in 0..50 {
            if c.snapshot().tasks_completed == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let snap = c.snapshot();
        assert_eq!(snap.tasks_completed, 1);
        assert_eq!(snap.task_duration_ms.p50, Some(42));
    }
}
