//! Local event queue with retry. Events are appended locally and drained to
//! the server in order; failed sends stay queued with exponential backoff.

use crate::events::Event;

/// Abstracts the network so the queue is testable offline. Return Ok(()) on a
/// 2xx, Err on anything retryable.
pub trait Transport {
    fn send(&mut self, batch: &[Event]) -> Result<(), String>;
}

pub const MAX_BATCH: usize = 50;
pub const BASE_BACKOFF_MS: u64 = 2_000;
pub const MAX_BACKOFF_MS: u64 = 5 * 60_000;

#[derive(Debug, Default)]
pub struct EventQueue {
    pending: Vec<Event>,
    consecutive_failures: u32,
    next_attempt_ms: u64,
}

impl EventQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enqueue(&mut self, event: Event) {
        self.pending.push(event);
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Serialize for persistence across app restarts.
    pub fn snapshot_json(&self) -> String {
        serde_json::to_string(&self.pending).expect("events serialize")
    }

    pub fn restore_json(json: &str) -> Result<Self, String> {
        let pending: Vec<Event> = serde_json::from_str(json).map_err(|e| e.to_string())?;
        Ok(Self {
            pending,
            ..Default::default()
        })
    }

    /// Attempt to flush up to MAX_BATCH events. No-op while backing off.
    /// Returns the number of events successfully sent.
    pub fn flush(&mut self, now_ms: u64, transport: &mut impl Transport) -> usize {
        if self.pending.is_empty() || now_ms < self.next_attempt_ms {
            return 0;
        }
        let n = self.pending.len().min(MAX_BATCH);
        match transport.send(&self.pending[..n]) {
            Ok(()) => {
                self.pending.drain(..n);
                self.consecutive_failures = 0;
                self.next_attempt_ms = 0;
                n
            }
            Err(_) => {
                self.consecutive_failures += 1;
                let backoff = BASE_BACKOFF_MS
                    .saturating_mul(1u64 << self.consecutive_failures.min(8))
                    .min(MAX_BACKOFF_MS);
                self.next_attempt_ms = now_ms + backoff;
                0
            }
        }
    }
}
