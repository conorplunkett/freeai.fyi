// FreeAI Sponsor Overlay — menu bar shell.
//
// The shell is intentionally dumb: read platform signals (a supported
// assistant — Claude or ChatGPT Desktop — focused? generating? screen
// locked?), let the decision logic (a port of ../../core's tested rules)
// decide when an impression qualifies, render the card, queue events. It never
// injects code into the assistant, never modifies its files, never reads
// conversation content.
//
// Demo mode for local testing without a server or a supported assistant:
//   FREEAI_DEMO=1 swift run SponsorOverlay
// In demo mode any frontmost app counts as "assistant generating", a seeded
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
    // FREEAI_PROBE=1: every 2s, dump the labeled elements of the focused
    // assistant's window and the generating verdict. Run it, trigger a
    // generation in Claude or ChatGPT, and read the terminal. Diagnostic only;
    // nothing leaves the Mac.
    private let probeMode = ProcessInfo.processInfo.environment["FREEAI_PROBE"] == "1"

    private let detector = AssistantDetector()
    private let overlay = OverlayPanelController()
    private let engine = ImpressionEngine()
    private let store = EventStore()
    private let client = BackendClient(baseURL: BackendClient.configuredBaseURL)

    private var statusItem: NSStatusItem!
    private var balanceItem: NSMenuItem!
    private var accessibilityItem: NSMenuItem!
    private var pollTimer: Timer?
    private var adsPaused = false
    /// Last assistant-window bounds the overlay was positioned over, for
    /// move/resize deduplication (spec `lastBounds`).
    private var lastShownBounds: CGRect?
    /// Composer frame at last positioning — the card re-anchors when the
    /// composer moves within an unchanged window (e.g. sidebar resize).
    private var lastComposerBounds: CGRect?
    /// Thinking-star frame at last positioning — the card sticks to the star,
    /// so it must re-anchor whenever the star moves (streaming pushes it down,
    /// scrolling moves it anywhere).
    private var lastStarBounds: CGRect?
    private var tickCount = 0

    private var credentials: DeviceCredentials?
    private var ads: [Ad] = []
    private var currentAd: Ad?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpMenuBar()
        requestAccessibilityIfNeeded()

        if probeMode {
            print("probe: dumping the focused assistant's AX tree every 2s — focus Claude or ChatGPT and start a generation (Ctrl+C to quit)")
            Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                self?.detector.probeDump()
            }
            return
        }

        bootstrap()

        overlay.onClick = { [weak self] card in self?.handleClick(campaignId: card.campaignID) }

        // 100ms loop. Every 5th tick is the full signal poll (500ms, as
        // before): AX tree scan, show/hide decision, impression engine. The
        // ticks in between only re-read the cached star frame (two AX calls)
        // so the card visibly sticks to the star through streaming and
        // scrolling. AX notifications can replace most of this later.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.tickCount += 1
            if self.tickCount % 5 == 1 {
                self.tick()
            } else {
                self.fastFollow()
            }
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
            // Pretend the frontmost window is an assistant mid-generation.
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
            assistantFocused: state.focused,
            assistantGenerating: state.generating,
            overlayVisible: overlay.isShown,
            overlayCovered: overlay.isCovered,
            screenLocked: SystemState.isScreenLocked,
            displayAsleep: SystemState.isDisplayAsleep,
            adsPaused: adsPaused
        )

        // Spec trackability gates: the assistant must be focused, not
        // minimized, and its window large enough to be worth following.
        let usableBounds = state.windowBounds.map(Self.isUsableBounds) ?? false
        let shouldShow = state.focused && state.generating && !state.minimized
            && usableBounds && !adsPaused && currentAd != nil
        if shouldShow, let bounds = state.windowBounds {
            // Only re-position on a real move/resize (of the window, the
            // composer, or the star); otherwise we'd setFrame every tick.
            // Always (re)show when the panel is currently hidden.
            if !overlay.isShown || !Self.boundsEqual(lastShownBounds, bounds)
                || lastComposerBounds != state.composerBounds
                || lastStarBounds != state.starBounds {
                overlay.show(over: bounds, composer: state.composerBounds, star: state.starBounds)
                lastShownBounds = bounds
                lastComposerBounds = state.composerBounds
                lastStarBounds = state.starBounds
            }
        } else {
            if overlay.isShown { rotateAd() } // hidden -> next show re-arms with a fresh ad
            overlay.hide()
            lastShownBounds = nil
            lastComposerBounds = nil
            lastStarBounds = nil
        }

        engine.tick(signals: signals) { [weak self] visibilityMs in
            self?.handleQualifiedImpression(visibilityMs: visibilityMs)
        }

        if let credentials { store.flush(client: client, credentials: credentials) }
    }

    /// Between full polls: re-anchor onto the star using only the cached AX
    /// elements (two frame reads — no tree walk). Show/hide decisions stay
    /// with `tick()`; if the star vanished mid-interval the card simply holds
    /// its last position for <500ms until the full poll hides or re-anchors it.
    private func fastFollow() {
        guard !demoMode, overlay.isShown else { return }
        guard let (windowBounds, starBounds) = detector.fastStarUpdate(),
              Self.isUsableBounds(windowBounds) else { return }
        if !Self.boundsEqual(lastShownBounds, windowBounds) || lastStarBounds != starBounds {
            overlay.show(over: windowBounds, composer: lastComposerBounds, star: starBounds)
            lastShownBounds = windowBounds
            lastStarBounds = starBounds
        }
    }

    // MARK: spec window-trackability gates

    /// Spec `isUsableBounds`: an assistant window smaller than this is treated
    /// as not trackable, so the overlay hides rather than clinging to a sliver.
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
        statusItem.button?.imagePosition = .imageOnly // brand icon set in refreshAccessibilityState
        let menu = NSMenu()
        menu.delegate = self   // refresh the Accessibility row each time it opens
        balanceItem = NSMenuItem(title: demoMode ? "Demo mode" : "Balance: —", action: nil, keyEquivalent: "")
        menu.addItem(balanceItem)
        // Shown only while Accessibility is not granted — the overlay can't see
        // the assistant's window without it, so this is the #1 "nothing
        // happens" fix.
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

    // Brand "F$" wordmark for the menu bar, rendered once per state. Matches
    // the design-system app icon (tools/gen-icons.py): white monospace "F$" on
    // the vertical coral accent gradient.
    private lazy var statusIconNormal = Self.makeStatusIcon(warning: false)
    private lazy var statusIconWarning = Self.makeStatusIcon(warning: true)
    /// Last permission state reflected in the menu-bar icon, so we only swap the
    /// image when it actually changes (refresh runs every tick / on menu open).
    private var iconTrusted: Bool?

    /// Reflects Accessibility-permission state in the menu (row visibility) and
    /// the status icon (the brand "F$" mark, badged amber when access is
    /// missing) so the user notices before wondering why nothing shows. Cheap to
    /// call; runs on each tick and whenever the menu opens.
    private func refreshAccessibilityState() {
        let trusted = demoMode || AXIsProcessTrusted()
        accessibilityItem?.isHidden = trusted
        if iconTrusted != trusted, let button = statusItem?.button {
            button.image = trusted ? statusIconNormal : statusIconWarning
            iconTrusted = trusted
        }
    }

    /// Draws the FreeAI "F$" menu-bar mark. Colors mirror theme.css
    /// --accent-grad-a / --accent-grad-b (the palette source of truth); keep
    /// them in sync by hand, like OverlayPanel's palette. Not a template image —
    /// the coral is the brand, so it stays coral on light and dark menu bars.
    /// When `warning` is set (Accessibility not granted) a small amber dot is
    /// badged top-right, replacing the old "⚠" glyph.
    private static func makeStatusIcon(warning: Bool) -> NSImage {
        let gradTop = NSColor(red: 0xe0/255.0, green: 0x8a/255.0, blue: 0x6a/255.0, alpha: 1) // --accent-grad-a #e08a6a
        let gradBot = NSColor(red: 0xcf/255.0, green: 0x6b/255.0, blue: 0x4a/255.0, alpha: 1) // --accent-grad-b #cf6b4a
        let height: CGFloat = 16
        let font = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)
        let text = "F$" as NSString
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
        let textSize = text.size(withAttributes: attrs)
        let padX: CGFloat = 4
        let width = ceil(textSize.width) + padX * 2

        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
            let radius = height * 0.26 // matches the app-icon corner ratio
            let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            // AppKit y-up: angle -90 points down, so the starting color (grad-a)
            // sits at the top — same top→bottom coral gradient as the app icon.
            NSGradient(starting: gradTop, ending: gradBot)?.draw(in: path, angle: -90)
            text.draw(at: NSPoint(x: padX, y: (height - textSize.height) / 2), withAttributes: attrs)
            if warning {
                let d: CGFloat = 5
                let dot = NSRect(x: rect.maxX - d - 0.5, y: rect.maxY - d - 0.5, width: d, height: d)
                NSColor(red: 1, green: 0xd5/255.0, blue: 0x4a/255.0, alpha: 1).setFill() // --ov-chip-bg #ffd54a
                NSBezierPath(ovalIn: dot).fill()
            }
            return true
        }
        image.isTemplate = false
        return image
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
