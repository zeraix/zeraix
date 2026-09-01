//! The ready queue: priority first, FIFO within a priority.
//!
//! `BinaryHeap` alone would not give the second half — heap order among equal keys is unspecified, so
//! two `Normal` tasks could come back in either order and a queue that looked fair would quietly
//! reorder work. Pairing the priority with a monotonic sequence number makes ties break by arrival,
//! which is what "FIFO" in spec §6 actually asks for.
//!
//! The sequence is inverted in the comparison (`Reverse`) because a *lower* sequence means *earlier*,
//! and `BinaryHeap` is a max-heap.

use crate::task::Priority;
use agent_core::TaskId;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

#[derive(PartialEq, Eq)]
struct Slot {
    priority: Priority,
    seq: Reverse<u64>,
    id: TaskId,
}

impl Ord for Slot {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.priority.cmp(&other.priority).then_with(|| self.seq.cmp(&other.seq))
    }
}

impl PartialOrd for Slot {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

pub struct ReadyQueue {
    heap: BinaryHeap<Slot>,
    next_seq: u64,
}

impl ReadyQueue {
    pub fn new() -> Self {
        Self { heap: BinaryHeap::new(), next_seq: 0 }
    }

    pub fn push(&mut self, id: TaskId, priority: Priority) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.heap.push(Slot { priority, seq: Reverse(seq), id });
    }

    pub fn pop(&mut self) -> Option<TaskId> {
        self.heap.pop().map(|s| s.id)
    }

    pub fn drain(&mut self) -> impl Iterator<Item = TaskId> + '_ {
        std::mem::take(&mut self.heap).into_iter().map(|s| s.id)
    }

    /// Take one task out of the queue, wherever it sits. Returns whether it was there.
    ///
    /// Rebuilds the heap rather than reaching into it, because `BinaryHeap` has no removal by value and a
    /// heap edited in place is a heap whose invariant nobody can check. Rebuilding preserves arrival order,
    /// which matters: the sequence numbers are what make ties FIFO, and they are carried through unchanged.
    ///
    /// Linear in the queue's length, which is the right cost for an operation a person performs — pausing is
    /// a click, not something the scheduler does in a loop.
    pub fn remove(&mut self, id: &TaskId) -> bool {
        let before = self.heap.len();
        let kept: Vec<Slot> = std::mem::take(&mut self.heap).into_iter().filter(|s| &s.id != id).collect();
        self.heap = kept.into_iter().collect();
        self.heap.len() != before
    }

    /// Queue depth. Not used by the driver — exposed for `runtime.status`, so "why is nothing
    /// progressing?" can distinguish an empty queue from a starved one.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.heap.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_priority_comes_first() {
        let mut q = ReadyQueue::new();
        q.push(TaskId::from_host("low"), Priority::Background);
        q.push(TaskId::from_host("crit"), Priority::Critical);
        q.push(TaskId::from_host("norm"), Priority::Normal);
        assert_eq!(q.pop().unwrap().as_str(), "crit");
        assert_eq!(q.pop().unwrap().as_str(), "norm");
        assert_eq!(q.pop().unwrap().as_str(), "low");
    }

    #[test]
    fn equal_priority_is_fifo() {
        let mut q = ReadyQueue::new();
        for i in 0..8 {
            q.push(TaskId::from_host(format!("t{i}")), Priority::Normal);
        }
        // The property a bare BinaryHeap would silently violate.
        for i in 0..8 {
            assert_eq!(q.pop().unwrap().as_str(), format!("t{i}"));
        }
    }

    #[test]
    fn a_late_critical_task_overtakes_queued_normal_work() {
        let mut q = ReadyQueue::new();
        q.push(TaskId::from_host("a"), Priority::Normal);
        q.push(TaskId::from_host("b"), Priority::Normal);
        q.push(TaskId::from_host("urgent"), Priority::Critical);
        assert_eq!(q.pop().unwrap().as_str(), "urgent");
        assert_eq!(q.pop().unwrap().as_str(), "a");
    }

    #[test]
    fn drain_empties_the_queue() {
        let mut q = ReadyQueue::new();
        q.push(TaskId::from_host("a"), Priority::Normal);
        q.push(TaskId::from_host("b"), Priority::High);
        assert_eq!(q.drain().count(), 2);
        assert!(q.is_empty());
        assert_eq!(q.len(), 0);
    }

    fn pause_id(n: &str) -> TaskId {
        TaskId::from_host(n)
    }

    #[test]
    fn removing_a_task_leaves_the_rest_in_arrival_order() {
        let mut q = ReadyQueue::new();
        q.push(pause_id("a"), Priority::Normal);
        q.push(pause_id("b"), Priority::Normal);
        q.push(pause_id("c"), Priority::Normal);

        assert!(q.remove(&pause_id("b")));
        assert_eq!(q.pop(), Some(pause_id("a")));
        assert_eq!(q.pop(), Some(pause_id("c")), "FIFO within a priority must survive a removal");
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn removing_a_task_that_is_not_queued_reports_it() {
        let mut q = ReadyQueue::new();
        q.push(pause_id("a"), Priority::Normal);
        assert!(!q.remove(&pause_id("zzz")));
        assert_eq!(q.pop(), Some(pause_id("a")));
    }

    #[test]
    fn removal_does_not_disturb_priority_order() {
        let mut q = ReadyQueue::new();
        q.push(pause_id("low"), Priority::Background);
        q.push(pause_id("high"), Priority::Critical);
        q.push(pause_id("mid"), Priority::Normal);
        assert!(q.remove(&pause_id("mid")));
        assert_eq!(q.pop(), Some(pause_id("high")));
        assert_eq!(q.pop(), Some(pause_id("low")));
    }
}
