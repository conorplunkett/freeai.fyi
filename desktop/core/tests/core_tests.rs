use overlay_core::campaign::{select_campaign, Campaign, CampaignStatus};
use overlay_core::events::{Event, EventType, WindowState};
use overlay_core::frequency::{day_key, FrequencyCaps, MIN_REPEAT_INTERVAL_MS};
use overlay_core::impression::{ImpressionTracker, Signals, TrackerOutput, QUALIFY_MS};
use overlay_core::queue::{EventQueue, Transport};

fn good_signals() -> Signals {
    Signals {
        signed_in: true,
        claude_focused: true,
        claude_generating: true,
        overlay_visible: true,
        overlay_covered: false,
        screen_locked: false,
        display_asleep: false,
        ads_paused: false,
    }
}

fn tick_through(
    t: &mut ImpressionTracker,
    start: u64,
    end: u64,
    step: u64,
    s: Signals,
) -> Vec<TrackerOutput> {
    (start..=end)
        .step_by(step as usize)
        .map(|now| t.tick(now, s))
        .collect()
}

// ---- impression state machine ----

#[test]
fn five_continuous_seconds_yields_exactly_one_impression() {
    let mut t = ImpressionTracker::new();
    let outs = tick_through(&mut t, 0, 7_000, 500, good_signals());
    let qualified: Vec<_> = outs
        .iter()
        .filter(|o| matches!(o, TrackerOutput::QualifiedImpression { .. }))
        .collect();
    assert_eq!(qualified.len(), 1, "exactly one qualified impression");
    if let TrackerOutput::QualifiedImpression { visible_ms } = qualified[0] {
        assert!(*visible_ms >= QUALIFY_MS);
    }
    // Further ticks never double-count.
    assert_eq!(t.tick(8_000, good_signals()), TrackerOutput::AlreadyCounted);
}

#[test]
fn losing_focus_resets_the_clock() {
    let mut t = ImpressionTracker::new();
    tick_through(&mut t, 0, 4_000, 500, good_signals()); // 4s accrued
    let mut unfocused = good_signals();
    unfocused.claude_focused = false;
    assert_eq!(t.tick(4_500, unfocused), TrackerOutput::Reset);
    // Needs a full fresh 5s after refocus.
    let outs = tick_through(&mut t, 5_000, 10_000, 500, good_signals());
    assert!(matches!(
        outs[..outs.len() - 1]
            .iter()
            .find(|o| matches!(o, TrackerOutput::QualifiedImpression { .. })),
        None
    ));
    assert!(matches!(
        outs.last().unwrap(),
        TrackerOutput::QualifiedImpression { .. }
    ));
}

#[test]
fn screen_lock_cover_pause_and_sleep_all_block_qualification() {
    for breaker in ["lock", "cover", "pause", "sleep", "signed_out", "hidden"] {
        let mut t = ImpressionTracker::new();
        let mut s = good_signals();
        match breaker {
            "lock" => s.screen_locked = true,
            "cover" => s.overlay_covered = true,
            "pause" => s.ads_paused = true,
            "sleep" => s.display_asleep = true,
            "signed_out" => s.signed_in = false,
            _ => s.overlay_visible = false,
        }
        let outs = tick_through(&mut t, 0, 10_000, 500, s);
        assert!(
            !outs
                .iter()
                .any(|o| matches!(o, TrackerOutput::QualifiedImpression { .. })),
            "{breaker} must block impressions"
        );
    }
}

#[test]
fn clock_gap_from_system_sleep_does_not_count_as_continuous() {
    let mut t = ImpressionTracker::new();
    tick_through(&mut t, 0, 3_000, 500, good_signals());
    // 4-second gap (laptop lid closed without a lock signal).
    match t.tick(7_000, good_signals()) {
        TrackerOutput::Accruing { visible_ms } => assert_eq!(visible_ms, 0),
        o => panic!("expected reset accrual, got {o:?}"),
    }
}

// ---- frequency caps ----

#[test]
fn repeat_interval_and_daily_earnings_cap() {
    let mut caps = FrequencyCaps::new(day_key(0, 0));
    assert!(caps.allows_impression("c1", 0));
    caps.record_impression("c1", 0, 10);
    assert!(!caps.allows_impression("c1", MIN_REPEAT_INTERVAL_MS - 1));
    assert!(caps.allows_impression("c1", MIN_REPEAT_INTERVAL_MS));

    // Earn up to the daily cap (100c) and get blocked.
    let mut now = MIN_REPEAT_INTERVAL_MS;
    for _ in 0..9 {
        assert!(caps.allows_impression("c1", now));
        caps.record_impression("c1", now, 10);
        now += MIN_REPEAT_INTERVAL_MS;
    }
    assert!(
        !caps.allows_impression("c1", now),
        "daily earnings cap reached"
    );
    assert_eq!(caps.impressions_today("c1"), 10);

    // New day clears counters but not the repeat-interval throttle.
    let last = now - MIN_REPEAT_INTERVAL_MS; // time of the final recorded impression
    caps.roll_day(day_key(0, 0) + 1);
    assert_eq!(caps.impressions_today("c1"), 0);
    assert!(!caps.allows_impression("c1", last + MIN_REPEAT_INTERVAL_MS - 1));
    assert!(caps.allows_impression("c1", last + MIN_REPEAT_INTERVAL_MS));
}

// ---- campaign eligibility & selection ----

fn campaign(id: &str, cpm: i64) -> Campaign {
    Campaign {
        id: id.into(),
        sponsor_name: "Linear".into(),
        icon_url: None,
        message: "Plan your next sprint faster".into(),
        destination_url: "https://linear.app".into(),
        category: "dev-tools".into(),
        countries: vec!["US".into()],
        budget_remaining_cents: 10_000,
        cpm_cents: cpm,
        cpc_cents: None,
        start_ms: 0,
        end_ms: u64::MAX,
        frequency_cap_per_day: 5,
        status: CampaignStatus::Active,
    }
}

#[test]
fn eligibility_filters_status_dates_budget_country_caps_and_message_length() {
    let base = campaign("a", 500);
    assert!(base.is_eligible(1, "US", 0));
    assert!(!base.is_eligible(1, "FR", 0), "country");
    assert!(!base.is_eligible(1, "US", 5), "freq cap");

    let mut c = base.clone();
    c.status = CampaignStatus::Paused;
    assert!(!c.is_eligible(1, "US", 0), "paused");

    let mut c = base.clone();
    c.end_ms = 1;
    assert!(!c.is_eligible(1, "US", 0), "ended");

    let mut c = base.clone();
    c.budget_remaining_cents = 0;
    assert!(!c.is_eligible(1, "US", 0), "budget");

    let mut c = base.clone();
    c.message = "x".repeat(61);
    assert!(c.validate().is_err());
    assert!(!c.is_eligible(1, "US", 0), "overlong message");

    let mut c = base.clone();
    c.destination_url = "http://insecure.example".into();
    assert!(c.validate().is_err(), "non-https url");
}

#[test]
fn selection_prefers_highest_cpm_among_eligible() {
    let cs = vec![
        campaign("low", 200),
        campaign("high", 900),
        campaign("capped", 1_500),
    ];
    let pick = select_campaign(&cs, 1, "US", |id| if id == "capped" { 5 } else { 0 });
    assert_eq!(pick.unwrap().id, "high");
}

// ---- event queue ----

struct FlakyTransport {
    fail_first: u32,
    sent: Vec<Event>,
}
impl Transport for FlakyTransport {
    fn send(&mut self, batch: &[Event]) -> Result<(), String> {
        if self.fail_first > 0 {
            self.fail_first -= 1;
            return Err("503".into());
        }
        self.sent.extend_from_slice(batch);
        Ok(())
    }
}

fn event() -> Event {
    Event {
        user_id: "u1".into(),
        device_id: "d1".into(),
        campaign_id: "c1".into(),
        event_type: EventType::Impression,
        timestamp_ms: 123,
        visibility_ms: 5_000,
        window_state: WindowState::FocusedGenerating,
        clicked: false,
    }
}

#[test]
fn queue_retries_with_backoff_and_preserves_order() {
    let mut q = EventQueue::new();
    q.enqueue(event());
    q.enqueue(Event {
        event_type: EventType::Click,
        clicked: true,
        ..event()
    });

    let mut t = FlakyTransport {
        fail_first: 2,
        sent: vec![],
    };
    assert_eq!(q.flush(0, &mut t), 0); // fail 1 → backoff
    assert_eq!(q.flush(1_000, &mut t), 0, "still backing off, no attempt");
    assert_eq!(t.fail_first, 1, "backoff suppressed the second attempt");
    assert_eq!(q.flush(5_000, &mut t), 0); // fail 2
    assert_eq!(q.flush(60_000, &mut t), 2); // success
    assert!(q.is_empty());
    assert_eq!(t.sent[0].event_type, EventType::Impression);
    assert_eq!(t.sent[1].event_type, EventType::Click);
}

#[test]
fn queue_survives_restart_via_snapshot() {
    let mut q = EventQueue::new();
    q.enqueue(event());
    let json = q.snapshot_json();
    let restored = EventQueue::restore_json(&json).unwrap();
    assert_eq!(restored.len(), 1);
}

// ---- privacy contract ----

#[test]
fn event_payload_contains_only_allowed_keys() {
    let json = serde_json::to_value(event()).unwrap();
    let obj = json.as_object().unwrap();
    let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    for k in &keys {
        assert!(
            Event::ALLOWED_KEYS.contains(k),
            "forbidden key in payload: {k}"
        );
    }
    assert_eq!(keys.len(), Event::ALLOWED_KEYS.len());
    // And unknown fields (e.g. someone trying to add prompt text) are rejected.
    let tampered = r#"{"user_id":"u","device_id":"d","campaign_id":"c","event_type":"impression","timestamp_ms":1,"visibility_ms":1,"window_state":"focused_idle","clicked":false,"prompt_text":"secret"}"#;
    assert!(serde_json::from_str::<Event>(tampered).is_err());
}
