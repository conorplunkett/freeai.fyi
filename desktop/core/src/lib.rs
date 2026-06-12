//! overlay-core: the testable brain of the macOS sponsor overlay.
//!
//! The Mac app shell (SwiftPM package in ../macos) feeds platform signals in
//! (Claude focused? overlay visible? screen locked?) and renders whatever this
//! crate decides. No platform code lives here, so all impression/cap/privacy
//! rules are unit-tested on any OS.

pub mod campaign;
pub mod events;
pub mod frequency;
pub mod impression;
pub mod queue;

pub use campaign::{select_campaign, Campaign, CampaignStatus};
pub use events::{Event, EventType, WindowState};
pub use frequency::FrequencyCaps;
pub use impression::{ImpressionTracker, Signals, TrackerOutput};
pub use queue::EventQueue;
