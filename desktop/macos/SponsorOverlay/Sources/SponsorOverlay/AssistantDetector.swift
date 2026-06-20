// Detects a supported AI desktop app's focus, window bounds, and a local-only
// "generating" heuristic via the Accessibility API. Two apps are supported:
// Claude Desktop and the ChatGPT (OpenAI) desktop app — both are Electron/
// Chromium shells, so the same AX-tree walk works for either; only a few
// per-app selectors differ (see `AssistantTarget`).
//
// Privacy constraint: we read UI element *roles and attributes needed for
// geometry/state*, never text content of messages. No screenshots leave the
// machine; Screen Recording is a later, optional fallback and is not used here.

import AppKit
import ApplicationServices

/// Per-app knobs for the otherwise-shared detector. Everything that differs
/// between Claude and ChatGPT lives here so the scan logic stays generic.
struct AssistantTarget {
    /// Stable short id (also used in logs/probe output).
    let id: String
    /// Human-facing name for menus / probe dumps.
    let displayName: String
    /// macOS bundle identifier. Verify with `osascript -e 'id of app "…"'`.
    let bundleID: String
    /// Lowercased substrings that identify the prompt composer's placeholder
    /// (the AXTextArea's description). First match wins; matched only on a
    /// text-area role so ordinary labels can't be mistaken for the composer.
    let composerHints: [String]
    /// Claude renders an animated "thinking star" while it generates, which the
    /// card anchors to. ChatGPT has no such element, so for it generation is
    /// detected by the Stop button alone and the card anchors to the composer.
    let hasThinkingStar: Bool

    // Verified on Claude Desktop: `osascript -e 'id of app "Claude"'`.
    static let claude = AssistantTarget(
        id: "claude",
        displayName: "Claude",
        bundleID: "com.anthropic.claudefordesktop",
        composerHints: ["prompt"], // "Write your prompt to Claude" (probe-verified)
        hasThinkingStar: true)

    // ChatGPT desktop app bundle id (`osascript -e 'id of app "ChatGPT"'`).
    // The composer is a contenteditable that AX exposes as a text area whose
    // description is the placeholder ("Ask anything" / "Message ChatGPT").
    static let chatgpt = AssistantTarget(
        id: "chatgpt",
        displayName: "ChatGPT",
        bundleID: "com.openai.chat",
        composerHints: ["ask anything", "message chatgpt", "send a message", "message"],
        hasThinkingStar: false)

    /// Probed in order; the first one that is frontmost wins.
    static let all = [claude, chatgpt]
}

struct AssistantState {
    var running = false
    var focused = false
    var generating = false
    var minimized = false
    var windowBounds: CGRect?
    /// Which assistant the state describes (nil when none is frontmost).
    var target: AssistantTarget?
    /// Frame of the focused app's prompt composer (AXTextArea), used to anchor
    /// the sponsor card just above it. Geometry only — content is never read.
    var composerBounds: CGRect?
    /// Frame of the animated thinking star (Claude only; the spark shown while
    /// it generates). When present the card anchors to it; composer is fallback.
    var starBounds: CGRect?
}

final class AssistantDetector {
    /// Electron/Chromium apps only build the AX tree inside their AXWebArea
    /// when an assistive client asks for it. Setting AXManualAccessibility on
    /// the app element is the documented Electron switch; without it the web
    /// contents (and the Stop button) are invisible to us. Harmless on a
    /// non-Electron app.
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

    func currentState() -> AssistantState {
        var state = AssistantState()
        cachedWindow = nil
        cachedStar = nil

        // The overlay only ever shows over the app the user is actively using,
        // so detection keys on the frontmost supported assistant. `running` is
        // set if any is merely open (for menu/diagnostic use).
        var focused: (app: NSRunningApplication, target: AssistantTarget)?
        for target in AssistantTarget.all {
            guard let app = NSRunningApplication
                .runningApplications(withBundleIdentifier: target.bundleID).first else { continue }
            state.running = true
            if app.isActive { focused = (app, target); break }
        }
        guard let (app, target) = focused else { return state }
        state.focused = true
        state.target = target

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        enableElectronAccessibility(axApp, pid: app.processIdentifier)
        guard let window = focusedWindow(of: axApp) else { return state }
        state.minimized = isMinimized(window)
        state.windowBounds = frame(of: window)

        var scan = TreeScan(wantStar: target.hasThinkingStar)
        scanTree(window, depth: 0, into: &scan, target: target)
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
    /// full scan re-resolves everything. ChatGPT has no star, so its
    /// fast-follow is a no-op and the 500ms full poll drives positioning.
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
    /// the thinking star (Claude only). Same privacy rule throughout —
    /// structural attributes only (role/title/description/DOM class names),
    /// never message text. Web content nests deep inside the AXWebArea, hence
    /// the generous depth.
    private struct TreeScan {
        var composer: AXUIElement?
        var hasStopButton = false
        var star: AXUIElement?
        /// False for apps without a thinking star (ChatGPT), so the scan can
        /// short-circuit once the composer + Stop button are found.
        var wantStar = true
        var isComplete: Bool {
            composer != nil && hasStopButton && (!wantStar || star != nil)
        }
    }

    private func scanTree(_ element: AXUIElement, depth: Int, into scan: inout TreeScan, target: AssistantTarget) {
        guard depth < Self.maxScanDepth, !scan.isComplete else { return }

        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        let role = roleRef as? String

        // Composer: the AXTextArea whose placeholder description matches one of
        // the target's hints (Claude: "prompt"; ChatGPT: "ask anything" / …).
        if scan.composer == nil, role == kAXTextAreaRole as String {
            var v: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &v)
            if let s = (v as? String)?.lowercased(),
               target.composerHints.contains(where: { s.contains($0) }) {
                scan.composer = element
            }
        }

        // Stop button: match loosely ("Stop response", "Stop generating",
        // "Stop streaming", localized variants keep the verb) but require it on
        // a button so plain message text can never trip it. This is the primary
        // generating signal for ChatGPT, which has no thinking star.
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

        if scan.wantStar, scan.star == nil, isThinkingStar(element) {
            scan.star = element
        }

        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else {
            return
        }
        for child in children {
            scanTree(child, depth: depth + 1, into: &scan, target: target)
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

    /// Dumps every labeled element / button in the focused assistant's window
    /// plus the generating verdict. Diagnostic only — prints locally, sends
    /// nothing.
    func probeDump() {
        var focused: (app: NSRunningApplication, target: AssistantTarget)?
        for target in AssistantTarget.all {
            if let app = NSRunningApplication
                .runningApplications(withBundleIdentifier: target.bundleID).first, app.isActive {
                focused = (app, target)
                break
            }
        }
        guard let (app, target) = focused else {
            print("probe: no supported assistant is frontmost (open & focus Claude or ChatGPT Desktop)")
            return
        }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        enableElectronAccessibility(axApp, pid: app.processIdentifier)
        guard let window = focusedWindow(of: axApp) else {
            print("probe: no focused \(target.displayName) window (is Accessibility granted? is the app frontmost?)")
            return
        }
        print("probe: --- focused \(target.displayName) window, labeled elements ---")
        dump(window, depth: 0)
        var scan = TreeScan(wantStar: target.hasThinkingStar)
        scanTree(window, depth: 0, into: &scan, target: target)
        let starFrame = scan.star.flatMap(frame(of:)).map { "\($0)" }
            ?? (target.hasThinkingStar ? "not found" : "n/a")
        print("probe: app=\(target.displayName) generating=\(scan.hasStopButton || scan.star != nil) stopButton=\(scan.hasStopButton) composer=\(scan.composer != nil) star=\(starFrame)")
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
        // against a new build shows what to update in isThinkingStar.
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
