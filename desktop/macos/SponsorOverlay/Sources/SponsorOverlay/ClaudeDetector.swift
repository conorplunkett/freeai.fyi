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
    // Verified on Claude Desktop: `osascript -e 'id of app "Claude"'`.
    static let bundleID = "com.anthropic.claudefordesktop"

    /// Electron/Chromium apps only build the AX tree inside their AXWebArea
    /// when an assistive client asks for it. Setting AXManualAccessibility on
    /// the app element is the documented Electron switch; without it the web
    /// contents (and the Stop button) are invisible to us.
    private var enabledForPid: pid_t?

    private func enableElectronAccessibility(_ axApp: AXUIElement, pid: pid_t) {
        guard enabledForPid != pid else { return }
        AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        enabledForPid = pid
    }

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
        enableElectronAccessibility(axApp, pid: app.processIdentifier)
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

    /// Generation heuristic, local-only and intentionally conservative: the
    /// presence of a "Stop …" button while streaming. We only read structural
    /// attributes (role/title/description) of buttons — never message text.
    /// Web content nests deep inside the AXWebArea, hence the generous depth.
    private func looksGenerating(window: AXUIElement) -> Bool {
        return containsStopButton(window, depth: 0)
    }

    static let maxScanDepth = 30

    private func containsStopButton(_ element: AXUIElement, depth: Int) -> Bool {
        guard depth < Self.maxScanDepth else { return false }
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        if (roleRef as? String) == kAXButtonRole as String {
            for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
                var v: CFTypeRef?
                AXUIElementCopyAttributeValue(element, attr as CFString, &v)
                // Match loosely ("Stop response", "Stop generating", localized
                // variants keep the verb) but require it on a button so plain
                // message text can never trip it.
                if let s = (v as? String)?.lowercased(), s.contains("stop") {
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

    // MARK: probe mode (FREEAI_PROBE=1)

    /// Dumps every labeled element / button in Claude's focused window plus
    /// the generating verdict. Diagnostic only — prints locally, sends nothing.
    func probeDump() {
        guard let app = NSRunningApplication
            .runningApplications(withBundleIdentifier: Self.bundleID).first else {
            print("probe: Claude Desktop is not running")
            return
        }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        enableElectronAccessibility(axApp, pid: app.processIdentifier)
        guard let window = focusedWindow(of: axApp) else {
            print("probe: no focused Claude window (is Accessibility granted? is Claude frontmost?)")
            return
        }
        print("probe: --- focused Claude window, labeled elements ---")
        dump(window, depth: 0)
        print("probe: generating=\(looksGenerating(window: window))")
    }

    private func dump(_ element: AXUIElement, depth: Int) {
        guard depth < Self.maxScanDepth else { return }
        var roleRef: CFTypeRef?, titleRef: CFTypeRef?, descRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
        AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descRef)
        let role = roleRef as? String ?? "?"
        let title = titleRef as? String ?? ""
        let desc = descRef as? String ?? ""
        // Only print signal: buttons, and anything with a label.
        if role == kAXButtonRole as String || !title.isEmpty || !desc.isEmpty {
            print("probe: \(String(repeating: " ", count: min(depth, 12)))\(role) title=\"\(title)\" desc=\"\(desc)\"")
        }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else { return }
        for child in children { dump(child, depth: depth + 1) }
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
