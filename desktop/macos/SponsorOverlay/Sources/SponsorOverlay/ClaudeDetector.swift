// Detects Claude Desktop focus, window bounds, and a local-only "generating"
// heuristic via the Accessibility API. Privacy constraint: we read UI element
// *roles and attributes needed for geometry/state*, never text content of
// messages. No screenshots leave the machine; Screen Recording is a later,
// optional fallback and is not used here.

import AppKit
import ApplicationServices

struct ClaudeState {
    var running = false
    var focused = false
    var generating = false
    var windowBounds: CGRect?
}

final class ClaudeDetector {
    // Verify against the shipping app: `osascript -e 'id of app "Claude"'`.
    static let bundleID = "com.anthropic.claudefordesktop"

    private var lastFrontmostChange = Date.distantPast

    func currentState() -> ClaudeState {
        var state = ClaudeState()
        guard let app = NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.bundleID).first else {
            return state
        }
        state.running = true
        state.focused = app.isActive
        guard state.focused else { return state }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let window = focusedWindow(of: axApp) else { return state }
        state.windowBounds = frame(of: window)
        state.generating = looksGenerating(window: window)
        return state
    }

    private func focusedWindow(of axApp: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &value)
        guard err == .success else { return nil }
        return (value as! AXUIElement)
    }

    private func frame(of window: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success else {
            return nil
        }
        var pos = CGPoint.zero, size = CGSize.zero
        AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        return CGRect(origin: pos, size: size)
    }

    /// Generation heuristic, local-only and intentionally conservative.
    /// Claude Desktop (Electron) exposes a limited AX tree; the most reliable
    /// structural signal observed so far is the presence of a "Stop" /
    /// "Stop response" button while streaming. We walk the tree looking for an
    /// AXButton whose AXDescription/AXTitle matches, capped in depth so the
    /// scan stays cheap. TODO(milestone 2): validate against current Claude
    /// builds and add the recent-user-action fallback from the PRD.
    private func looksGenerating(window: AXUIElement) -> Bool {
        return containsStopButton(window, depth: 0)
    }

    private let stopTitles: Set<String> = ["stop", "stop response", "stop generating"]

    private func containsStopButton(_ element: AXUIElement, depth: Int) -> Bool {
        guard depth < 8 else { return false }
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        if (roleRef as? String) == kAXButtonRole as String {
            for attr in [kAXTitleAttribute, kAXDescriptionAttribute] {
                var v: CFTypeRef?
                AXUIElementCopyAttributeValue(element, attr as CFString, &v)
                if let s = v as? String, stopTitles.contains(s.lowercased()) {
                    return true
                }
            }
        }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else {
            return false
        }
        return children.contains { containsStopButton($0, depth: depth + 1) }
    }
}

enum SystemState {
    static var isScreenLocked: Bool {
        let info = CGSessionCopyCurrentDictionary() as? [String: Any]
        return (info?["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }

    static var isDisplayAsleep: Bool {
        CGDisplayIsAsleep(CGMainDisplayID()) != 0
    }
}

/// Placeholder auth session until Supabase auth lands (Milestone 1).
final class Session {
    static let shared = Session()
    var isSignedIn = false
    var userID: String?
    var deviceID = ProcessInfo.processInfo.globallyUniqueString
}
