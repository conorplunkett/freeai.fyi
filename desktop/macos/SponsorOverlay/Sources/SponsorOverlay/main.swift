// FreeAI Sponsor Overlay — menu bar shell.
//
// The shell is intentionally dumb: read platform signals (Claude focused?
// generating? screen locked?), let the decision logic (a port of
// ../../core's tested rules) decide when an impression qualifies, render the
// card, queue events. It never injects code into Claude, never modifies
// Claude's files, never reads conversation content.
//
// Demo mode for local testing without a server or Claude Desktop:
//   FREEAI_DEMO=1 swift run SponsorOverlay
// In demo mode any frontmost app counts as "Claude generating", a seeded
// campaign is shown, and qualified impressions/clicks are logged to the
// console instead of POSTed.

import AppKit
import Sparkle

final class AppDelegate: NSObject, NSApplicationDelegate {
    // Reads SUFeedURL / SUPublicEDKey from Info.plist and manages background
    // update checks; wired to the "Check for Updates…" menu item below.
    private let updaterController = SPUStandardUpdaterController(
        startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)

    private let demoMode = ProcessInfo.processInfo.environment["FREEAI_DEMO"] == "1"
    // FREEAI_PROBE=1: every 2s, dump the labeled elements of Claude's focused
    // window and the generating verdict. Run it, trigger a generation in
    // Claude, and read the terminal. Diagnostic only; nothing leaves the Mac.
    private let probeMode = ProcessInfo.processInfo.environment["FREEAI_PROBE"] == "1"

    private let detector = ClaudeDetector()
    private let overlay = OverlayPanelController()
    private let engine = ImpressionEngine()
    private let store = EventStore()
    private let client = BackendClient(baseURL: BackendClient.configuredBaseURL)

    private var statusItem: NSStatusItem!
    private var balanceItem: NSMenuItem!
    private var accessibilityItem: NSMenuItem!
    private var pollTimer: Timer?
    private var adsPaused = false
    /// Last Claude bounds the overlay was positioned over, for move/resize
    /// deduplication (spec `lastBounds`).
    private var lastShownBounds: CGRect?

    private var credentials: DeviceCredentials?
    private var ads: [Ad] = []
    private var currentAd: Ad?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpMenuBar()
        requestAccessibilityIfNeeded()

        if probeMode {
            print("probe: dumping Claude's AX tree every 2s — focus Claude and start a generation (Ctrl+C to quit)")
            Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.detector.probeDump()
            }
            return
        }

        bootstrap()

        overlay.onClick = { [weak self] card in self?.handleClick(campaignId: card.campaignID) }
        overlay.onDismiss = { [weak self] _ in
            self?.adsPaused = true // dismiss pauses until next generation burst
            DispatchQueue.main.asyncAfter(deadline: .now() + 300) { self?.adsPaused = false }
        }

        // 500ms signal poll; AX notifications can replace most of this later.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    // MARK: bootstrap (device registration + campaign sync)

    private func bootstrap() {
        if demoMode {
            ads = [Ad(id: "demo-1", brand: "Linear", line: "Plan your next sprint faster",
                      url: "https://linear.app", cat: "dev-tools")]
            rotateAd()
            NSLog("[freeai] DEMO MODE: overlay follows any focused window; events log locally")
            return
        }
        // Device credentials persist across launches (Keychain is the TODO;
        // UserDefaults for the rough-out).
        if let data = UserDefaults.standard.data(forKey: "deviceCredentials"),
           let creds = try? JSONDecoder().decode(DeviceCredentials.self, from: data) {
            credentials = creds
            didSignIn()
        } else {
            client.registerDevice { [weak self] creds in
                DispatchQueue.main.async {
                    guard let self, let creds else { return }
                    self.credentials = creds
                    if let data = try? JSONEncoder().encode(creds) {
                        UserDefaults.standard.set(data, forKey: "deviceCredentials")
                    }
                    self.didSignIn()
                }
            }
        }
    }

    private func didSignIn() {
        refreshAds()
        refreshBalance()
        Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.refreshAds()
            self?.refreshBalance()
        }
    }

    private func refreshAds() {
        client.fetchAds { [weak self] ads in
            DispatchQueue.main.async {
                self?.ads = ads
                if self?.currentAd == nil { self?.rotateAd() }
            }
        }
    }

    private func refreshBalance() {
        guard let credentials else { return }
        client.earnings(credentials: credentials) { [weak self] e in
            DispatchQueue.main.async {
                if let e { self?.balanceItem.title = String(format: "Balance: $%.2f", e.balanceUsd) }
            }
        }
    }

    private func rotateAd() {
        currentAd = ads.randomElement()
        if let ad = currentAd, let url = URL(string: ad.url) {
            overlay.setCard(SponsorCard(campaignID: ad.id, sponsorName: ad.brand,
                                        message: ad.line, destinationURL: url))
        }
        engine.rearm()
    }

    // MARK: per-tick pipeline

    private func tick() {
        refreshAccessibilityState()
        var state = detector.currentState()
        if demoMode {
            // Pretend the frontmost window is Claude mid-generation.
            state.running = true
            state.focused = NSApp.isActive || NSWorkspace.shared.frontmostApplication != nil
            state.generating = true
            if state.windowBounds == nil, let screen = NSScreen.main {
                let f = screen.visibleFrame
                state.windowBounds = CGRect(x: f.midX - 400, y: 120, width: 800, height: f.height - 240)
            }
        }

        let signedIn = demoMode || credentials != nil
        let signals = Signals(
            signedIn: signedIn,
            claudeFocused: state.focused,
            claudeGenerating: state.generating,
            overlayVisible: overlay.isShown,
            overlayCovered: overlay.isCovered,
            screenLocked: SystemState.isScreenLocked,
            displayAsleep: SystemState.isDisplayAsleep,
            adsPaused: adsPaused
        )

        // Spec trackability gates: Claude must be focused, not minimized, and
        // its window large enough to be worth following.
        let usableBounds = state.windowBounds.map(Self.isUsableBounds) ?? false
        let shouldShow = state.focused && state.generating && !state.minimized
            && usableBounds && !adsPaused && currentAd != nil
        if shouldShow, let bounds = state.windowBounds {
            // Only re-position on a real move/resize; otherwise we'd setFrame
            // every tick. Always (re)show when the panel is currently hidden.
            if !overlay.isShown || !Self.boundsEqual(lastShownBounds, bounds) {
                overlay.show(over: bounds)
                lastShownBounds = bounds
            }
        } else {
            if overlay.isShown { rotateAd() } // hidden -> next show re-arms with a fresh ad
            overlay.hide()
            lastShownBounds = nil
        }

        engine.tick(signals: signals) { [weak self] visibilityMs in
            self?.handleQualifiedImpression(visibilityMs: visibilityMs)
        }

        if let credentials { store.flush(client: client, credentials: credentials) }
    }

    // MARK: spec window-trackability gates

    /// Spec `isUsableBounds`: a Claude window smaller than this is treated as
    /// not trackable, so the overlay hides rather than clinging to a sliver.
    static func isUsableBounds(_ b: CGRect) -> Bool {
        b.width >= 360 && b.height >= 300
    }

    /// Spec `boundsEqual`: dedupe so we only reposition on real geometry changes.
    static func boundsEqual(_ a: CGRect?, _ b: CGRect) -> Bool {
        guard let a else { return false }
        return a == b
    }

    private func handleQualifiedImpression(visibilityMs: UInt64) {
        guard let ad = currentAd else { return }
        if demoMode {
            NSLog("[freeai] qualified impression: campaign=%@ visible=%dms", ad.id, Int(visibilityMs))
            return
        }
        store.recordImpression(campaignId: ad.id)
    }

    private func handleClick(campaignId: String) {
        guard let ad = currentAd, ad.id == campaignId else { return }
        if demoMode {
            NSLog("[freeai] click: campaign=%@", campaignId)
            NSWorkspace.shared.open(ad.destinationURLOrFallback)
            return
        }
        guard let credentials else { return }
        // Server-issued single-use tracking URL; falls back to the plain URL
        // (uncredited) if the intent call fails.
        client.clickIntent(credentials: credentials, campaignId: campaignId) { url in
            DispatchQueue.main.async {
                NSWorkspace.shared.open(url ?? ad.destinationURLOrFallback)
            }
        }
        store.recordClick(campaignId: campaignId)
    }

    // MARK: menu bar

    private func setUpMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "₿"
        let menu = NSMenu()
        menu.delegate = self   // refresh the Accessibility row each time it opens
        balanceItem = NSMenuItem(title: demoMode ? "Demo mode" : "Balance: —", action: nil, keyEquivalent: "")
        menu.addItem(balanceItem)
        // Shown only while Accessibility is not granted — the overlay can't see
        // Claude's window without it, so this is the #1 "nothing happens" fix.
        accessibilityItem = NSMenuItem(title: "⚠ Enable Accessibility access…",
                                       action: #selector(openAccessibilitySettings), keyEquivalent: "")
        accessibilityItem.target = self
        menu.addItem(accessibilityItem)
        let pause = NSMenuItem(title: "Pause sponsor messages", action: #selector(togglePause(_:)), keyEquivalent: "p")
        pause.target = self
        menu.addItem(pause)
        let dash = NSMenuItem(title: "Why am I seeing this?", action: #selector(openPrivacy), keyEquivalent: "")
        dash.target = self
        menu.addItem(dash)
        let updates = NSMenuItem(title: "Check for Updates…",
                                 action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
                                 keyEquivalent: "")
        updates.target = updaterController
        menu.addItem(updates)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
        refreshAccessibilityState()
    }

    /// Reflects Accessibility-permission state in the menu (row visibility) and
    /// the status icon (⚠ vs ₿) so the user notices before wondering why nothing
    /// shows. Cheap to call; runs on each tick and whenever the menu opens.
    private func refreshAccessibilityState() {
        let trusted = demoMode || AXIsProcessTrusted()
        accessibilityItem?.isHidden = trusted
        statusItem?.button?.title = trusted ? "₿" : "⚠"
    }

    @objc private func openAccessibilitySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)
    }

    @objc private func togglePause(_ item: NSMenuItem) {
        adsPaused.toggle()
        item.title = adsPaused ? "Resume sponsor messages" : "Pause sponsor messages"
    }

    @objc private func openPrivacy() {
        NSWorkspace.shared.open(URL(string: "https://freeai.fyi/privacy.html")!)
    }

    private func requestAccessibilityIfNeeded() {
        guard !demoMode else { return }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
}

extension AppDelegate: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        refreshAccessibilityState()
    }
}

extension Ad {
    var destinationURLOrFallback: URL {
        URL(string: url) ?? URL(string: "https://freeai.fyi")!
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
