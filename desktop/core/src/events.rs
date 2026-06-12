//! Event payloads sent to the server.
//!
//! Privacy contract (from the PRD): the server receives ONLY user id, device
//! id, campaign id, event type, timestamp, visibility duration, window-state
//! metadata, and whether the sponsor was clicked. Never prompts, responses,
//! screenshots, file names, or clipboard content. `deny_unknown_fields` plus
//! the schema test in tests/privacy.rs keep this enforceable.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Impression,
    Click,
    Dismiss,
}

/// Coarse window state at event time. Metadata only — never window contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    FocusedGenerating,
    FocusedIdle,
    Unfocused,
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub user_id: String,
    pub device_id: String,
    pub campaign_id: String,
    pub event_type: EventType,
    /// Unix epoch milliseconds.
    pub timestamp_ms: u64,
    /// Continuous visibility accrued when the event fired.
    pub visibility_ms: u64,
    pub window_state: WindowState,
    pub clicked: bool,
}

impl Event {
    /// The only keys an event is ever allowed to serialize. Used by tests and
    /// by the queue as a belt-and-braces guard before anything leaves the box.
    pub const ALLOWED_KEYS: [&'static str; 8] = [
        "user_id",
        "device_id",
        "campaign_id",
        "event_type",
        "timestamp_ms",
        "visibility_ms",
        "window_state",
        "clicked",
    ];
}
