//! Campaign model and local eligibility filtering. Campaigns are created
//! manually by an admin for MVP and synced down to the client; the client
//! still re-checks eligibility before every display.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignStatus {
    Active,
    Paused,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Campaign {
    pub id: String,
    pub sponsor_name: String,
    pub icon_url: Option<String>,
    /// Max 60 chars, enforced by `validate`.
    pub message: String,
    pub destination_url: String,
    pub category: String,
    pub countries: Vec<String>,
    /// Remaining budget in cents.
    pub budget_remaining_cents: i64,
    /// Price per 1000 impressions, cents.
    pub cpm_cents: i64,
    pub cpc_cents: Option<i64>,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Max impressions per user per day.
    pub frequency_cap_per_day: u32,
    pub status: CampaignStatus,
}

pub const MAX_MESSAGE_LEN: usize = 60;

impl Campaign {
    pub fn validate(&self) -> Result<(), String> {
        if self.message.chars().count() > MAX_MESSAGE_LEN {
            return Err(format!("message exceeds {MAX_MESSAGE_LEN} chars"));
        }
        if !self.destination_url.starts_with("https://") {
            return Err("destination_url must be https".into());
        }
        Ok(())
    }

    /// Cost of one impression in cents (CPM / 1000), rounded up so we never
    /// serve past budget.
    pub fn impression_cost_cents(&self) -> i64 {
        (self.cpm_cents + 999) / 1000
    }

    pub fn is_eligible(&self, now_ms: u64, country: &str, impressions_today: u32) -> bool {
        self.status == CampaignStatus::Active
            && self.validate().is_ok()
            && now_ms >= self.start_ms
            && now_ms < self.end_ms
            && self.budget_remaining_cents >= self.impression_cost_cents()
            && (self.countries.is_empty() || self.countries.iter().any(|c| c == country))
            && impressions_today < self.frequency_cap_per_day
    }
}

/// Pick the next campaign to show: eligible campaigns only, highest CPM first
/// (simple MVP ranking; auction comes later). `impressions_today` is looked up
/// per campaign by the caller-supplied closure so the cap store stays separate.
pub fn select_campaign<'a>(
    campaigns: &'a [Campaign],
    now_ms: u64,
    country: &str,
    impressions_today: impl Fn(&str) -> u32,
) -> Option<&'a Campaign> {
    campaigns
        .iter()
        .filter(|c| c.is_eligible(now_ms, country, impressions_today(&c.id)))
        .max_by_key(|c| c.cpm_cents)
}
