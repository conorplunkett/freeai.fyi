//! The qualified-impression state machine.
//!
//! PRD rule: an impression counts only after the sponsor card has been visible
//! for 5 *continuous* seconds while the user is signed in, Claude Desktop is
//! focused, the overlay is visible/uncovered, the screen is unlocked, and the
//! user hasn't paused ads. Any break resets the clock to zero.

use crate::events::WindowState;

pub const QUALIFY_MS: u64 = 5_000;

/// Snapshot of platform signals, supplied by the macOS shell on every tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signals {
    pub signed_in: bool,
    pub claude_focused: bool,
    pub claude_generating: bool,
    pub overlay_visible: bool,
    /// True when another window covers the overlay (occlusion check).
    pub overlay_covered: bool,
    pub screen_locked: bool,
    pub display_asleep: bool,
    pub ads_paused: bool,
}

impl Signals {
    fn qualifies(&self) -> bool {
        self.signed_in
            && self.claude_focused
            && self.overlay_visible
            && !self.overlay_covered
            && !self.screen_locked
            && !self.display_asleep
            && !self.ads_paused
    }

    pub fn window_state(&self) -> WindowState {
        match (
            self.overlay_visible,
            self.claude_focused,
            self.claude_generating,
        ) {
            (false, _, _) => WindowState::Hidden,
            (_, false, _) => WindowState::Unfocused,
            (_, true, true) => WindowState::FocusedGenerating,
            (_, true, false) => WindowState::FocusedIdle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackerOutput {
    /// Keep counting; nothing to report.
    Accruing { visible_ms: u64 },
    /// Clock reset because a qualifying condition broke.
    Reset,
    /// 5 continuous seconds reached — emit exactly one impression event.
    QualifiedImpression { visible_ms: u64 },
    /// Already qualified for this display; nothing more until re-armed.
    AlreadyCounted,
}

/// Tracks one on-screen display of one campaign. Re-arm (`reset`) when a new
/// campaign rotates in or the overlay is re-shown after being hidden.
#[derive(Debug, Default)]
pub struct ImpressionTracker {
    accrued_ms: u64,
    last_tick_ms: Option<u64>,
    counted: bool,
}

impl ImpressionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Re-arm for a fresh display of a (possibly new) campaign.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn tick(&mut self, now_ms: u64, signals: Signals) -> TrackerOutput {
        if !signals.qualifies() {
            let was_accruing = self.accrued_ms > 0 || self.last_tick_ms.is_some();
            self.accrued_ms = 0;
            self.last_tick_ms = None;
            return if was_accruing && !self.counted {
                TrackerOutput::Reset
            } else if self.counted {
                TrackerOutput::AlreadyCounted
            } else {
                TrackerOutput::Accruing { visible_ms: 0 }
            };
        }

        if self.counted {
            return TrackerOutput::AlreadyCounted;
        }

        if let Some(last) = self.last_tick_ms {
            // Guard against clock jumps / sleep: a gap longer than 2s means we
            // weren't actually continuously visible.
            let delta = now_ms.saturating_sub(last);
            if delta > 2_000 {
                self.accrued_ms = 0;
            } else {
                self.accrued_ms += delta;
            }
        }
        self.last_tick_ms = Some(now_ms);

        if self.accrued_ms >= QUALIFY_MS {
            self.counted = true;
            TrackerOutput::QualifiedImpression {
                visible_ms: self.accrued_ms,
            }
        } else {
            TrackerOutput::Accruing {
                visible_ms: self.accrued_ms,
            }
        }
    }
}
