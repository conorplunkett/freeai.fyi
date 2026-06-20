// Interim Swift port of overlay-core's ImpressionTracker + event queue glue.
//
// The canonical, unit-tested implementation lives in ../../core (Rust). The
// plan is to link overlay-core as a staticlib through a C header (cbindgen)
// and delete most of this file; until that wiring exists, this port mirrors
// the same rules so the shell is runnable end-to-end:
//   * impression qualifies after 5 *continuous* seconds of eligible visibility
//   * any broken condition resets the clock
//   * tick gaps > 2s (sleep/clock jump) reset the clock
//   * one impression max per armed display

import Foundation

struct Signals {
    var signedIn, assistantFocused, assistantGenerating, overlayVisible: Bool
    var overlayCovered, screenLocked, displayAsleep, adsPaused: Bool

    var qualifies: Bool {
        signedIn && assistantFocused && overlayVisible
            && !overlayCovered && !screenLocked && !displayAsleep && !adsPaused
    }
}

final class ImpressionEngine {
    static let qualifyMs: UInt64 = 5_000
    static let maxTickGapMs: UInt64 = 2_000

    private var accruedMs: UInt64 = 0
    private var lastTickMs: UInt64?
    private var counted = false

    /// Re-arm for a fresh display (new campaign rotated in, or overlay re-shown).
    func rearm() {
        accruedMs = 0
        lastTickMs = nil
        counted = false
    }

    /// Calls `onQualified` exactly once per armed display, with the accrued
    /// visibility in ms, when 5 continuous eligible seconds are reached.
    func tick(signals: Signals,
              nowMs: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000),
              onQualified: (UInt64) -> Void) {
        guard signals.qualifies, !counted else {
            accruedMs = 0
            lastTickMs = nil
            return
        }
        if let last = lastTickMs {
            let delta = nowMs &- last
            accruedMs = delta > Self.maxTickGapMs ? 0 : accruedMs + delta
        }
        lastTickMs = nowMs

        if accruedMs >= Self.qualifyMs {
            counted = true
            onQualified(accruedMs)
        }
    }
}
