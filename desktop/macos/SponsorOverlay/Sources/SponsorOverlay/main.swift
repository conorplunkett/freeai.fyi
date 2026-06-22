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
import ServiceManagement
import Sparkle
import WebKit

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
                guard let self, let e else { return }
                self.balanceItem.attributedTitle = Self.balanceTitle(amountUsd: e.balanceUsd)
            }
        }
    }

    /// "Balance: $X.XX" with the dollar amount in bold.
    private static func balanceTitle(amountUsd: Double) -> NSAttributedString {
        let base = NSFont.menuFont(ofSize: 0)
        let bold = NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask)
        let s = NSMutableAttributedString(string: "Balance: ", attributes: [.font: base])
        s.append(NSAttributedString(string: String(format: "$%.2f", amountUsd), attributes: [.font: bold]))
        return s
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
        overlay.horizontalShift = shift(forAppID: state.target?.id ?? lastTargetID)

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
        // Paused means no earnings: ignore clicks too. The card fades out over
        // ~2s after a pause, so without this a click in that window would still
        // be credited.
        guard !adsPaused else { return }
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
        // Live slider + lock checkbox so users place the card where it suits
        // their window (everyone runs the assistant full-width, so the right
        // height varies). Both live in one custom view, so interacting with
        // them doesn't dismiss the menu.
        menu.addItem(makeOffsetMenuItem())
        let redeem = NSMenuItem(title: "Redeem", action: #selector(openRedeem), keyEquivalent: "")
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
    private weak var lockCheckbox: NSButton?
    private weak var positionSlider: NSSlider?

    private func liftKey(_ id: String) -> String { "cardLift.\(id)" }
    private func lockKey(_ id: String) -> String { "lockToPrompt.\(id)" }
    private func shiftKey(_ id: String) -> String { "cardShift.\(id)" }

    /// Saved left/right shift for an app id in points (+right / -left), 0 default.
    private func shift(forAppID id: String?) -> CGFloat {
        guard let id else { return 0 }
        return CGFloat(UserDefaults.standard.double(forKey: shiftKey(id)))
    }

    /// "Lock to above prompt": pin the card at the minimum height (just above
    /// the chat box) and ignore the saved slider value.
    private func isLocked(_ id: String?) -> Bool {
        guard let id else { return false }
        return UserDefaults.standard.bool(forKey: lockKey(id))
    }

    /// Effective card height for an app id: 0 when locked to the prompt, else
    /// the saved value (or the default).
    private func lift(forAppID id: String?) -> CGFloat {
        guard let id else { return Self.defaultLift }
        if UserDefaults.standard.bool(forKey: lockKey(id)) { return 0 }
        return CGFloat(UserDefaults.standard.object(forKey: liftKey(id)) as? Double ?? Double(Self.defaultLift))
    }

    private func displayName(forAppID id: String?) -> String {
        AssistantTarget.all.first { $0.id == id }?.displayName ?? AssistantTarget.claude.displayName
    }

    /// A per-app height slider, lock checkbox and left/right position slider, all
    /// embedded in one custom view so interacting with them doesn't dismiss the
    /// menu. Edits the last-focused app's values; the label names which app.
    private func makeOffsetMenuItem() -> NSMenuItem {
        let width: CGFloat = 240
        let lx: CGFloat = 14
        let lw = width - 28
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 120))

        let heightLabel = NSTextField(labelWithString: "Card height")
        heightLabel.font = .systemFont(ofSize: 12)
        heightLabel.textColor = .secondaryLabelColor
        heightLabel.frame = NSRect(x: lx, y: 98, width: lw, height: 16)
        // Max lift = tallest screen, so dragging fully right always reaches the
        // top of even a full-height window (the top-clamp in OverlayPanel.show
        // stops it overshooting). A fixed cap only reached part-way up.
        let maxLift = Double(NSScreen.screens.map(\.frame.height).max() ?? 1400)
        let heightSlider = NSSlider(value: Double(Self.defaultLift), minValue: 0, maxValue: maxLift,
                                    target: self, action: #selector(cardLiftChanged(_:)))
        heightSlider.isContinuous = true
        heightSlider.frame = NSRect(x: lx, y: 76, width: lw, height: 20)
        // Checkbox lives in the same custom view so toggling it does NOT dismiss
        // the menu (a control inside a view-based item handles its own click).
        let lock = NSButton(checkboxWithTitle: "Lock height above prompt",
                            target: self, action: #selector(lockCheckboxToggled(_:)))
        lock.font = .systemFont(ofSize: 12)
        lock.frame = NSRect(x: 12, y: 50, width: width - 24, height: 20)

        let posLabel = NSTextField(labelWithString: "Card position")
        posLabel.font = .systemFont(ofSize: 12)
        posLabel.textColor = .secondaryLabelColor
        posLabel.frame = NSRect(x: lx, y: 28, width: lw, height: 16)
        // Symmetric around 0 so the default (current anchor position) is the
        // centre — the clamp in OverlayPanel.show keeps it inside the window.
        let maxShift = Double((NSScreen.screens.map(\.frame.width).max() ?? 1600) / 2)
        let posSlider = NSSlider(value: 0, minValue: -maxShift, maxValue: maxShift,
                                 target: self, action: #selector(cardShiftChanged(_:)))
        posSlider.isContinuous = true
        posSlider.frame = NSRect(x: lx, y: 6, width: lw, height: 20)

        for v in [heightLabel, heightSlider, lock, posLabel, posSlider] { container.addSubview(v) }
        offsetSlider = heightSlider
        offsetLabel = heightLabel
        lockCheckbox = lock
        positionSlider = posSlider
        let item = NSMenuItem()
        item.view = container
        return item
    }

    /// Sync the slider, label and lock checkbox to the app being edited (focus,
    /// hence the app, may have changed since the menu last opened). The label
    /// text is constant per app — only the checkbox state changes on lock — so
    /// nothing reflows when toggling.
    private func refreshOffsetControl() {
        let name = displayName(forAppID: lastTargetID)
        let locked = isLocked(lastTargetID)
        offsetSlider?.doubleValue = Double(lift(forAppID: lastTargetID))
        offsetSlider?.toolTip = locked ? "Locked just above the prompt — move to unlock" : nil
        offsetLabel?.stringValue = "\(name) card height"
        lockCheckbox?.state = locked ? .on : .off
        positionSlider?.doubleValue = Double(shift(forAppID: lastTargetID))
    }

    @objc private func cardLiftChanged(_ sender: NSSlider) {
        let id = lastTargetID ?? AssistantTarget.claude.id
        // Moving the slider means a custom height — release the lock.
        if isLocked(id) { UserDefaults.standard.set(false, forKey: lockKey(id)) }
        UserDefaults.standard.set(sender.doubleValue, forKey: liftKey(id))
        overlay.verticalLift = CGFloat(sender.doubleValue)
        repositionOverlay()
        refreshOffsetControl()
    }

    @objc private func cardShiftChanged(_ sender: NSSlider) {
        let id = lastTargetID ?? AssistantTarget.claude.id
        UserDefaults.standard.set(sender.doubleValue, forKey: shiftKey(id))
        overlay.horizontalShift = CGFloat(sender.doubleValue)
        repositionOverlay()
    }

    /// Toggle "Lock to above prompt" for the last-focused app. The checkbox is a
    /// view-based control, so the menu stays open.
    @objc private func lockCheckboxToggled(_ sender: NSButton) {
        let id = lastTargetID ?? AssistantTarget.claude.id
        UserDefaults.standard.set(sender.state == .on, forKey: lockKey(id))
        refreshOffsetControl()
        overlay.verticalLift = lift(forAppID: id)
        repositionOverlay()
    }

    /// Re-anchor the visible card immediately (e.g. after the slider moves)
    /// using the last known geometry, so the change is seen without waiting for
    /// the next poll.
    private func repositionOverlay() {
        guard overlay.isShown, let bounds = lastShownBounds else { return }
        overlay.show(over: bounds, composer: lastComposerBounds, star: lastStarBounds)
    }

    // MARK: setup / onboarding window
    //
    // The 5-step onboarding (Welcome → How it works → Grant access → Save
    // credits → All set) is the Claude Design handoff, rendered pixel-for-pixel
    // in a WKWebView from the bundled Resources/onboarding/* assets. The web UI
    // is wired to real app state through a JS↔Swift bridge: it opens the
    // Accessibility pane, reflects the live permission, toggles launch-at-login,
    // opens web sign-in, and closes the window — see userContentController(_:didReceive:).

    private var setupWindow: NSWindow?
    private weak var setupWebView: WKWebView?
    /// Polls real Accessibility permission while onboarding is open so the
    /// "Grant access" step flips to "Granted" (and unlocks Continue) the moment
    /// the user toggles FreeAI on in System Settings.
    private var permissionPollTimer: Timer?
    private let onboardingMessage = "freeai"   // JS message-handler name

    private func showSetupOnFirstLaunch() {
        guard !demoMode, !UserDefaults.standard.bool(forKey: "didOnboard") else { return }
        UserDefaults.standard.set(true, forKey: "didOnboard")
        showSetup()
    }

    @objc private func showSetup() {
        if let w = setupWindow {
            startPermissionPoll()
            pushLaunchState()   // re-sync in case it changed since last opened
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard let index = onboardingIndexURL() else {
            // Resource bundle missing (e.g. an old packaging that didn't copy it):
            // fall back to the plain text setup window so onboarding still works.
            showSetupFallback()
            return
        }

        let contentSize = NSSize(width: 780, height: 608)
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: onboardingMessage)
        config.userContentController = controller

        let webView = WKWebView(frame: NSRect(origin: .zero, size: contentSize), configuration: config)
        webView.navigationDelegate = self
        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())

        let w = NSWindow(contentRect: NSRect(origin: .zero, size: contentSize),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Set up FreeAI"
        w.isReleasedWhenClosed = false
        w.contentView = webView
        w.delegate = self
        w.center()

        setupWindow = w
        setupWebView = webView
        startPermissionPoll()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func closeSetup() {
        setupWindow?.close()
    }

    /// URL of the bundled onboarding entry point. `Bundle.module` resolves this
    /// in `swift run` and in the packaged .app once bundle.sh has copied the
    /// generated resource bundle into Contents/Resources.
    private func onboardingIndexURL() -> URL? {
        guard let dir = Bundle.module.url(forResource: "onboarding", withExtension: nil) else { return nil }
        let index = dir.appendingPathComponent("index.html")
        return FileManager.default.fileExists(atPath: index.path) ? index : nil
    }

    private func evalOnboardingJS(_ js: String) {
        setupWebView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: onboarding ↔ app bridge

    private func startPermissionPoll() {
        permissionPollTimer?.invalidate()
        pushPermissionState()
        permissionPollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.pushPermissionState()
        }
    }

    private func stopPermissionPoll() {
        permissionPollTimer?.invalidate()
        permissionPollTimer = nil
    }

    /// Push the live Accessibility permission to the onboarding UI. The JS side
    /// ignores no-op repeats, so polling every second is cheap.
    private func pushPermissionState() {
        let granted = demoMode || AXIsProcessTrusted()
        evalOnboardingJS("window.freeaiBridge && window.freeaiBridge.setPermission('\(granted ? "ok" : "off")')")
    }

    private func pushLaunchState() {
        evalOnboardingJS("window.freeaiBridge && window.freeaiBridge.setLaunchState(\(launchAtLoginEnabled() ? "true" : "false"))")
    }

    // MARK: launch at login (SMAppService, macOS 13+)

    private func launchAtLoginEnabled() -> Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        guard #available(macOS 13.0, *) else { return }
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        } catch {
            // Registration fails for a loose `swift run` binary (no app bundle);
            // it works for the packaged .app. Log and re-sync the real state.
            NSLog("[freeai] launch-at-login \(enabled ? "register" : "unregister") failed: \(error.localizedDescription)")
        }
    }

    /// Open FreeAI's real web sign-in so the device can be linked to an account
    /// (credits already accrue to the anonymous device until then).
    private func openWebSignin(email: String?, google: Bool) {
        var comps = URLComponents(string: "https://freeai.fyi/redeem")!
        var items: [URLQueryItem] = []
        if let email, !email.isEmpty { items.append(URLQueryItem(name: "email", value: email)) }
        if google { items.append(URLQueryItem(name: "provider", value: "google")) }
        if !items.isEmpty { comps.queryItems = items }
        if let url = comps.url { NSWorkspace.shared.open(url) }
    }

    // MARK: fallback setup window (only if the web assets are unavailable)

    private func showSetupFallback() {
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

// Onboarding web UI → app. The bundled onboarding.js posts {action, …} messages;
// each maps to a real app action. Unknown actions are ignored.
extension AppDelegate: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        guard message.name == onboardingMessage,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "openSettings":
            openAccessibilitySettings()
        case "setLaunchAtLogin":
            setLaunchAtLogin(body["on"] as? Bool ?? false)
            pushLaunchState()   // re-sync the toggle to the real registration state
        case "signinEmail":
            openWebSignin(email: body["email"] as? String, google: false)
        case "signinGoogle":
            openWebSignin(email: nil, google: true)
        case "finish":
            closeSetup()
        default:
            break
        }
    }
}

extension AppDelegate: WKNavigationDelegate {
    // Once the onboarding has loaded, seed it with the real permission +
    // launch-at-login state so its first paint matches reality.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushPermissionState()
        pushLaunchState()
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === setupWindow { stopPermissionPoll() }
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
