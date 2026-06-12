// Betterbacks Sponsor Overlay — menu bar shell (Milestone 1 + 2 rough-out).
//
// Responsibilities of this shell, by design, are dumb: read platform signals,
// hand them to the decision logic (overlay-core, ../../core — to be linked as
// a staticlib via cbindgen; an interim Swift port lives in ImpressionEngine),
// and render/position the overlay panel. It never reads Claude content,
// injects code, or touches Claude's files.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let detector = ClaudeDetector()
    private let overlay = OverlayPanelController()
    private let engine = ImpressionEngine()
    private var pollTimer: Timer?
    private var adsPaused = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpMenuBar()
        requestAccessibilityIfNeeded()
        // Signal poll. AX notifications will replace most polling later; 500ms
        // matches the tick granularity overlay-core's tests assume.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func tick() {
        let state = detector.currentState()
        let signals = Signals(
            signedIn: Session.shared.isSignedIn,
            claudeFocused: state.focused,
            claudeGenerating: state.generating,
            overlayVisible: overlay.isShown,
            overlayCovered: overlay.isCovered,
            screenLocked: SystemState.isScreenLocked,
            displayAsleep: SystemState.isDisplayAsleep,
            adsPaused: adsPaused
        )

        // MVP display rule: show the overlay only while Claude is focused and
        // appears to be generating (PRD fallback: focused + recent activity).
        if state.focused && state.generating && !adsPaused, let bounds = state.windowBounds {
            overlay.show(over: bounds)
        } else {
            overlay.hide()
            engine.rearm()
        }

        engine.tick(signals: signals, windowState: state)
    }

    private func setUpMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "₿"
        let menu = NSMenu()
        menu.addItem(withTitle: "Balance: —", action: nil, keyEquivalent: "")
        let pause = NSMenuItem(title: "Pause sponsor messages", action: #selector(togglePause), keyEquivalent: "p")
        pause.target = self
        menu.addItem(pause)
        menu.addItem(withTitle: "Open dashboard…", action: #selector(openDashboard), keyEquivalent: "d")
        menu.items.last?.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    @objc private func togglePause(_ item: NSMenuItem) {
        adsPaused.toggle()
        item.title = adsPaused ? "Resume sponsor messages" : "Pause sponsor messages"
    }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(URL(string: "https://betterbacks.ai/dashboard")!)
    }

    private func requestAccessibilityIfNeeded() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
