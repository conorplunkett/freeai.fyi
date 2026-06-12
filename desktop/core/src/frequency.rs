//! Local frequency caps and basic fraud throttles. These run client-side as a
//! first line; the server re-validates everything.

use std::collections::HashMap;

/// Per-day counters keyed by campaign id. Day boundaries use the local
/// calendar day derived from epoch ms by the caller (`day_key`).
#[derive(Debug, Default)]
pub struct FrequencyCaps {
    day_key: u64,
    impressions: HashMap<String, u32>,
    earnings_cents: HashMap<String, i64>,
    last_impression_ms: HashMap<String, u64>,
}

/// Minimum spacing between two paid impressions of the same campaign.
pub const MIN_REPEAT_INTERVAL_MS: u64 = 60_000;
/// Hard cap on what one user can earn from one campaign in one day (cents).
pub const MAX_DAILY_EARNINGS_PER_CAMPAIGN_CENTS: i64 = 100;

impl FrequencyCaps {
    pub fn new(day_key: u64) -> Self {
        Self {
            day_key,
            ..Default::default()
        }
    }

    /// Roll counters when the calendar day changes.
    pub fn roll_day(&mut self, day_key: u64) {
        if day_key != self.day_key {
            self.day_key = day_key;
            self.impressions.clear();
            self.earnings_cents.clear();
            // last_impression_ms intentionally survives the day roll so the
            // repeat-interval throttle can't be reset at midnight.
        }
    }

    pub fn impressions_today(&self, campaign_id: &str) -> u32 {
        *self.impressions.get(campaign_id).unwrap_or(&0)
    }

    /// Whether a new impression for this campaign may be *paid* right now.
    pub fn allows_impression(&self, campaign_id: &str, now_ms: u64) -> bool {
        if let Some(&last) = self.last_impression_ms.get(campaign_id) {
            if now_ms.saturating_sub(last) < MIN_REPEAT_INTERVAL_MS {
                return false;
            }
        }
        *self.earnings_cents.get(campaign_id).unwrap_or(&0) < MAX_DAILY_EARNINGS_PER_CAMPAIGN_CENTS
    }

    pub fn record_impression(&mut self, campaign_id: &str, now_ms: u64, earned_cents: i64) {
        *self.impressions.entry(campaign_id.to_string()).or_insert(0) += 1;
        *self
            .earnings_cents
            .entry(campaign_id.to_string())
            .or_insert(0) += earned_cents;
        self.last_impression_ms
            .insert(campaign_id.to_string(), now_ms);
    }
}

/// Local calendar day key from epoch ms and a UTC offset in minutes.
pub fn day_key(epoch_ms: u64, utc_offset_minutes: i32) -> u64 {
    let shifted = (epoch_ms as i64) + (utc_offset_minutes as i64) * 60_000;
    (shifted.max(0) as u64) / 86_400_000
}
