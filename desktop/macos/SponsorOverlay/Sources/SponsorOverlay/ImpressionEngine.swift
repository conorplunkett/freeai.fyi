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
    var signedIn, claudeFocused, claudeGenerating, overlayVisible: Bool
    var overlayCovered, screenLocked, displayAsleep, adsPaused: Bool

    var qualifies: Bool {
        signedIn && claudeFocused && overlayVisible
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

    func tick(signals: Signals, windowState: ClaudeState, nowMs: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)) {
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
            emitImpression(visibilityMs: accruedMs, generating: windowState.generating)
        }
    }

    private func emitImpression(visibilityMs: UInt64, generating: Bool) {
        // TODO(milestone 3): enqueue to the persisted retry queue and POST to
        // the events API. Payload is restricted to overlay-core's allowed key
        // set — see core/src/events.rs.
        NSLog("qualified impression: visible=\(visibilityMs)ms generating=\(generating)")
    }
}
