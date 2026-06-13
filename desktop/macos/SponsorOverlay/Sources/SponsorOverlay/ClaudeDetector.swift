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
    var minimized = false
    var windowBounds: CGRect?
    /// Frame of Claude's prompt composer (AXTextArea), used to anchor the
    /// sponsor card just above it. Geometry only — content is never read.
    var composerBounds: CGRect?
    /// Frame of the animated thinking star (the spark shown while Claude
    /// generates). When present the card anchors to it; composer is fallback.
    var starBounds: CGRect?
}

final class ClaudeDetector {
    // Verified on Claude Desktop: `osascript -e 'id of app "Claude"'`.
    static let bundleID = "com.anthropic.claudefordesktop"

    /// Electron/Chromium apps only build the AX tree inside their AXWebArea
    /// when an assistive client asks for it. Setting AXManualAccessibility on
    /// the app element is the documented Electron switch; without it the web
    /// contents (and the Stop button) are invisible to us.
    private var enabledForPid: pid_t?

    /// AX elements cached by the last full scan so the fast-follow loop can
    /// re-read just their frames (two cheap AX calls) instead of re-walking
    /// the whole Electron tree at 10Hz.
    private var cachedWindow: AXUIElement?
    private var cachedStar: AXUIElement?

    private func enableElectronAccessibility(_ axApp: AXUIElement, pid: pid_t) {
        guard enabledForPid != pid else { return }
        AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        enabledForPid = pid
    }

    func currentState() -> ClaudeState {
        var state = ClaudeState()
        cachedWindow = nil
        cachedStar = nil
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
        state.minimized = isMinimized(window)
        state.windowBounds = frame(of: window)

        var scan = TreeScan()
        scanTree(window, depth: 0, into: &scan)
        state.composerBounds = scan.composer.flatMap(frame(of:))
        state.starBounds = scan.star.flatMap(frame(of:))
        state.generating = scan.hasStopButton || scan.star != nil
        cachedWindow = window
        cachedStar = scan.star
        return state
    }

    /// Cheap between-scan refresh for the fast-follow loop: re-reads only the
    /// frames of the cached window and star. Returns nil once either element
    /// is gone (the star node is removed when generation ends) — the next
    /// full scan re-resolves everything.
    func fastStarUpdate() -> (window: CGRect, star: CGRect)? {
        guard let window = cachedWindow, let star = cachedStar,
              let windowFrame = frame(of: window), let starFrame = frame(of: star) else {
            cachedStar = nil
            return nil
        }
        return (windowFrame, starFrame)
    }

    private func focusedWindow(of axApp: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &value)
        guard err == .success else { return nil }
        return (value as! AXUIElement)
    }

    /// A minimized window is reported by AX with `AXMinimized == true`; we hide
    /// the overlay in that case rather than tracking an off-screen sliver.
    private func isMinimized(_ window: AXUIElement) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &value) == .success else {
            return false
        }
        return (value as? Bool) ?? false
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

    static let maxScanDepth = 30

    /// One walk of the focused window's AX tree collects everything we anchor
    /// or gate on: the composer, the Stop button (generating heuristic), and
    /// the thinking star. Same privacy rule throughout — structural attributes
    /// only (role/title/description/DOM class names), never message text.
    /// Web content nests deep inside the AXWebArea, hence the generous depth.
    private struct TreeScan {
        var composer: AXUIElement?
        var hasStopButton = false
        var star: AXUIElement?
        var isComplete: Bool { composer != nil && hasStopButton && star != nil }
    }

    private func scanTree(_ element: AXUIElement, depth: Int, into scan: inout TreeScan) {
        guard depth < Self.maxScanDepth, !scan.isComplete else { return }

        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        let role = roleRef as? String

        // Composer: the AXTextArea whose placeholder description mentions
        // "prompt" (probe-verified: "Write your prompt to Claude").
        if scan.composer == nil, role == kAXTextAreaRole as String {
            var v: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &v)
            if let s = (v as? String)?.lowercased(), s.contains("prompt") {
                scan.composer = element
            }
        }

        // Stop button: match loosely ("Stop response", "Stop generating",
        // localized variants keep the verb) but require it on a button so
        // plain message text can never trip it.
        if !scan.hasStopButton, role == kAXButtonRole as String {
            for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
                var v: CFTypeRef?
                AXUIElementCopyAttributeValue(element, attr as CFString, &v)
                if let s = (v as? String)?.lowercased(), s.contains("stop") {
                    scan.hasStopButton = true
                    break
                }
            }
        }

        if scan.star == nil, isThinkingStar(element) {
            scan.star = element
        }

        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else {
            return
        }
        for child in children {
            scanTree(child, depth: depth + 1, into: &scan)
            if scan.isComplete { return }
        }
    }

    /// The thinking star is matched by its DOM class: Chromium (and therefore
    /// Electron) mirrors an element's class attribute into the AXDOMClassList
    /// accessibility attribute. `.epitaxy-spark-working` is the same selector
    /// the Chrome extension keys on (chrome-extension/src/content.js); the
    /// prefix match keeps minor suffix renames working.
    private func isThinkingStar(_ element: AXUIElement) -> Bool {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, "AXDOMClassList" as CFString, &v) == .success,
              let classes = v as? [String] else { return false }
        return classes.contains { $0.hasPrefix("epitaxy-spark") || $0.contains("spark-working") }
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
        var scan = TreeScan()
        scanTree(window, depth: 0, into: &scan)
        let starFrame = scan.star.flatMap(frame(of:)).map { "\($0)" } ?? "not found"
        print("probe: generating=\(scan.hasStopButton || scan.star != nil) star=\(starFrame)")
    }

    private func dump(_ element: AXUIElement, depth: Int) {
        guard depth < Self.maxScanDepth else { return }
        var roleRef: CFTypeRef?, titleRef: CFTypeRef?, descRef: CFTypeRef?, classRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
        AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descRef)
        AXUIElementCopyAttributeValue(element, "AXDOMClassList" as CFString, &classRef)
        let role = roleRef as? String ?? "?"
        let title = titleRef as? String ?? ""
        let desc = descRef as? String ?? ""
        // DOM classes are how the star is matched — print them so a probe run
        // against a new Claude build shows what to update in isThinkingStar.
        // Every div has classes, so they only force a line when star-like.
        let classes = (classRef as? [String])?.joined(separator: ".") ?? ""
        let starLike = classes.contains("spark") || classes.contains("thinking")
        if role == kAXButtonRole as String || !title.isEmpty || !desc.isEmpty || starLike {
            let suffix = classes.isEmpty ? "" : " class=\"\(classes)\""
            print("probe: \(String(repeating: " ", count: min(depth, 12)))\(role) title=\"\(title)\" desc=\"\(desc)\"\(suffix)")
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
