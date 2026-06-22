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
    // Sparkle only runs when it's actually configured: a real (non-placeholder)
    // SUPublicEDKey + https feed in the app bundle's Info.plist. Running via
    // `swift run` there's no bundled Info.plist, and the shipped placeholder key
    // isn't valid yet — in both cases starting the updater throws "the updater
    // failed to start", so we skip it and hide the menu item until it's set up.
    static var sparkleConfigured: Bool {
        guard let info = Bundle.main.infoDictionary,
              let feed = info["SUFeedURL"] as? String, feed.hasPrefix("https://"),
              let key = info["SUPublicEDKey"] as? String,
              !key.isEmpty, !key.hasPrefix("AAAA") else { return false }
        return true
    }
    private let updaterController: SPUStandardUpdaterController? =
        AppDelegate.sparkleConfigured
            ? SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
            : nil

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
        showSetupOnFirstLaunch()

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

        // Track the focused app and apply its saved card height. The menu bar
        // steals focus when open, so `lastTargetID` is what the slider edits.
        if let target = state.target { lastTargetID = target.id }
        overlay.verticalLift = lift(forAppID: state.target?.id ?? lastTargetID)

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
        // Live slider so users place the card where it suits their window
        // (everyone runs the assistant full-width, so the right height varies).
        menu.addItem(makeOffsetMenuItem())
        let redeem = NSMenuItem(title: "Redeem credits…", action: #selector(openRedeem), keyEquivalent: "")
        redeem.target = self
        menu.addItem(redeem)
        let setup = NSMenuItem(title: "Setup", action: #selector(showSetup), keyEquivalent: "")
        setup.target = self
        menu.addItem(setup)
        // Only offer updates when Sparkle is actually configured — otherwise it
        // throws "the updater failed to start".
        if let updaterController {
            let updates = NSMenuItem(title: "Check for Updates…",
                                     action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)),
                                     keyEquivalent: "")
            updates.target = updaterController
            menu.addItem(updates)
        }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu
        refreshAccessibilityState()
    }

    // Brand "F$" wordmark for the menu bar, rendered once per state: a hollow
    // wireframe outline of the app-icon chip (tools/gen-icons.py) as a
    // monochrome template image, so the menu bar tints it (white on dark, dark
    // on light) rather than the filled coral.
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

    /// Draws the FreeAI "F$" menu-bar mark as a hollow wireframe: a stroked
    /// rounded-rect chip (the app-icon silhouette) with the monospace "F$"
    /// inside. Returned as a template image — drawn in opaque black and tinted
    /// by the menu bar, so it shows white on the usual dark bar and dark on a
    /// light one, never coloured. When `warning` is set (Accessibility not
    /// granted) a small dot is badged top-right, replacing the old "⚠" glyph.
    private static func makeStatusIcon(warning: Bool) -> NSImage {
        let height: CGFloat = 16
        let font = NSFont.monospacedSystemFont(ofSize: 9, weight: .bold)
        let text = "F$" as NSString
        // Template images are masked by alpha and tinted by the system, so the
        // ink colour itself is irrelevant — draw in opaque black.
        let ink = NSColor.black
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink]
        let textSize = text.size(withAttributes: attrs)
        let padX: CGFloat = 4
        let width = ceil(textSize.width) + padX * 2

        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
            let lineWidth: CGFloat = 1
            let radius = height * 0.26 // matches the app-icon corner ratio
            let box = rect.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
            let path = NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
            path.lineWidth = lineWidth
            ink.setStroke()
            path.stroke() // hollow outline — no fill
            text.draw(at: NSPoint(x: padX, y: (height - textSize.height) / 2), withAttributes: attrs)
            if warning {
                let d: CGFloat = 4
                let dot = NSRect(x: rect.maxX - d - 0.5, y: rect.maxY - d - 0.5, width: d, height: d)
                ink.setFill()
                NSBezierPath(ovalIn: dot).fill()
            }
            return true
        }
        image.isTemplate = true
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

    @objc private func openRedeem() {
        NSWorkspace.shared.open(URL(string: "https://freeai.fyi/redeem")!)
    }

    // MARK: sponsor-card height offset (per-app user setting)

    /// Default lift (points above the composer) for an app with no saved value.
    static let defaultLift: CGFloat = 160
    /// Last assistant detected as focused — the app the height slider edits, and
    /// whose saved height the card uses. The menu bar steals focus while open,
    /// so we can't read the active app live; this is the remembered one.
    private var lastTargetID: String?
    private weak var offsetSlider: NSSlider?
    private weak var offsetLabel: NSTextField?

    private func liftKey(_ id: String) -> String { "cardLift.\(id)" }

    /// Saved card height for an app id, or the default.
    private func lift(forAppID id: String?) -> CGFloat {
        guard let id else { return Self.defaultLift }
        return CGFloat(UserDefaults.standard.object(forKey: liftKey(id)) as? Double ?? Double(Self.defaultLift))
    }

    private func displayName(forAppID id: String?) -> String {
        AssistantTarget.all.first { $0.id == id }?.displayName ?? AssistantTarget.claude.displayName
    }

    /// A per-app label + slider embedded in the menu so the height is adjustable
    /// live. Edits the last-focused app's value; the label names which app.
    private func makeOffsetMenuItem() -> NSMenuItem {
        let width: CGFloat = 230
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 46))
        let label = NSTextField(labelWithString: "Card height")
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 14, y: 26, width: width - 28, height: 16)
        let slider = NSSlider(value: Double(Self.defaultLift), minValue: 0, maxValue: 500,
                              target: self, action: #selector(cardLiftChanged(_:)))
        slider.isContinuous = true
        slider.frame = NSRect(x: 14, y: 4, width: width - 28, height: 20)
        container.addSubview(label)
        container.addSubview(slider)
        offsetSlider = slider
        offsetLabel = label
        let item = NSMenuItem()
        item.view = container
        return item
    }

    /// Sync the slider + label to the app being edited (focus, hence the app,
    /// may have changed since the menu last opened).
    private func refreshOffsetControl() {
        offsetSlider?.doubleValue = Double(lift(forAppID: lastTargetID))
        offsetLabel?.stringValue = "\(displayName(forAppID: lastTargetID)) card height"
    }

    @objc private func cardLiftChanged(_ sender: NSSlider) {
        let id = lastTargetID ?? AssistantTarget.claude.id
        UserDefaults.standard.set(sender.doubleValue, forKey: liftKey(id))
        // The slider only ever edits the last-focused app, so apply live.
        overlay.verticalLift = CGFloat(sender.doubleValue)
        repositionOverlay()
    }

    /// Re-anchor the visible card immediately (e.g. after the slider moves)
    /// using the last known geometry, so the change is seen without waiting for
    /// the next poll.
    private func repositionOverlay() {
        guard overlay.isShown, let bounds = lastShownBounds else { return }
        overlay.show(over: bounds, composer: lastComposerBounds, star: lastStarBounds)
    }

    // MARK: setup tutorial

    private var setupWindow: NSWindow?

    private func showSetupOnFirstLaunch() {
        guard !demoMode, !UserDefaults.standard.bool(forKey: "didOnboard") else { return }
        UserDefaults.standard.set(true, forKey: "didOnboard")
        showSetup()
    }

    @objc private func showSetup() {
        if let w = setupWindow {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 320),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Setup"
        w.isReleasedWhenClosed = false
        w.center()

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 320))
        let heading = NSTextField(labelWithString: "Earn Claude credits while you work")
        heading.font = .systemFont(ofSize: 16, weight: .bold)
        heading.frame = NSRect(x: 28, y: 268, width: 384, height: 24)

        let steps = NSTextField(wrappingLabelWithString: """
        1.  Keep FreeAI running — it lives in your menu bar (the F$ icon).

        2.  Open your preferred app — ChatGPT or Claude — and grant \
        Accessibility access if prompted (System Settings ▸ Privacy & \
        Security ▸ Accessibility).

        3.  Start a response, then open the menu bar F$ icon and drag \
        “Card height” until the sponsor card overlaps the app’s thinking \
        icon. Each app remembers its own height.

        4.  Done — the card appears only while the assistant is generating, \
        and your credits build automatically.
        """)
        steps.font = .systemFont(ofSize: 13)
        steps.frame = NSRect(x: 28, y: 64, width: 384, height: 196)

        let done = NSButton(title: "Got it", target: self, action: #selector(closeSetup))
        done.bezelStyle = .rounded
        done.keyEquivalent = "\r"
        done.frame = NSRect(x: 440 - 28 - 96, y: 18, width: 96, height: 32)

        content.addSubview(heading)
        content.addSubview(steps)
        content.addSubview(done)
        w.contentView = content
        setupWindow = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func closeSetup() {
        setupWindow?.close()
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
        refreshOffsetControl()
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
