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
}
