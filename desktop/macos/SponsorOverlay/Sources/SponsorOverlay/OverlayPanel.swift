// The sponsor card: a small, non-activating floating panel that sits exactly
// on Claude's thinking-star row while it generates (composer, then window
// bottom, as fallbacks) — the native twin of the Chrome extension's inline
// `.bb-bar` (same palette, same pill, same chip/line). On ChatGPT, which has
// no thinking star, it anchors above the composer (then the window bottom).
// It never takes key focus, so typing in the assistant is unaffected.

import AppKit

struct SponsorCard {
    var campaignID: String
    var sponsorName: String
    var message: String // ≤60 chars, validated by overlay-core
    var destinationURL: URL
}

final class OverlayPanelController {
    static let height: CGFloat = 34
    static let maxWidth: CGFloat = 560
    /// Gap between the card's bottom edge and the composer's top edge.
    static let anchorGap: CGFloat = 14
    /// Fallback when no composer geometry is available: distance from the
    /// bottom of the assistant window (the extension's fixed pill uses 96px too).
    static let bottomInset: CGFloat = 96

    // Overlay palette — mirror of the --ov-* design tokens in the repo-root
    // theme.css (the single source of truth for color). Native Swift can't read
    // theme.css, so these are mirrored by hand: when an --ov-* token changes,
    // update the matching member here in the same commit (AGENTS.md ▸ Design
    // System). Each line is tagged with its canonical token name.
    private enum Palette {
        static let barBackground = NSColor(red: 20/255, green: 23/255, blue: 28/255, alpha: 0.92) // --ov-bar-bg
        static let barBorder = NSColor(white: 1, alpha: 0.05)                                     // --ov-bar-border
        static let dots = NSColor(red: 139/255, green: 148/255, blue: 164/255, alpha: 1)          // --ov-dots     #8b94a4
        static let chipBackground = NSColor(red: 1, green: 213/255, blue: 74/255, alpha: 1)       // --ov-chip-bg  #ffd54a
        static let chipText = NSColor(red: 27/255, green: 30/255, blue: 37/255, alpha: 1)         // --ov-chip-ink #1b1e25
        static let line = NSColor(red: 241/255, green: 243/255, blue: 247/255, alpha: 1)          // --ov-line     #f1f3f7
    }

    // Layout metrics mirroring the extension bar (padding 14, gap 9, 18px chip).
    private static let padX: CGFloat = 14
    private static let gap: CGFloat = 9
    private static let chipSize: CGFloat = 18
    private static let dismissSize: CGFloat = 18

    private var panel: NSPanel?
    private(set) var card: SponsorCard?
    /// Content-fitted width, recomputed whenever the card changes.
    private(set) var panelWidth: CGFloat = 360
    var onClick: ((SponsorCard) -> Void)?
    var onDismiss: ((SponsorCard) -> Void)?

    var isShown: Bool { panel?.isVisible ?? false }

    /// Occlusion check feeding overlay-core's `overlay_covered` signal.
    var isCovered: Bool {
        guard let panel, panel.isVisible else { return false }
        return !panel.occlusionState.contains(.visible)
    }

    func setCard(_ newCard: SponsorCard) {
        card = newCard
        if let panel { configureContent(of: panel) }
    }

    /// Positions the pill on the thinking star when its frame is known:
    /// left edge on the star, vertically centered with it, so the card sits
    /// exactly on the star row and tracks it. Without a star it anchors
    /// left-aligned with the composer, `anchorGap` above it; without composer
    /// geometry it falls back to bottom-center of the window.
    func show(over appBounds: CGRect, composer: CGRect? = nil, star: CGRect? = nil) {
        guard card != nil else { return }
        let panel = self.panel ?? makePanel()
        self.panel = panel

        let width = panelWidth
        var x: CGFloat
        let axTop: CGFloat // card's top edge in AX (top-left-origin) coordinates
        if let star, appBounds.intersects(star) {
            x = star.minX
            axTop = star.midY - Self.height / 2
        } else if let composer, composer.minY > appBounds.minY {
            x = composer.minX
            axTop = composer.minY - Self.anchorGap - Self.height
        } else {
            x = appBounds.midX - width / 2
            axTop = appBounds.maxY - Self.bottomInset - Self.height
        }
        // Keep the pill inside the assistant window horizontally.
        let lower = appBounds.minX + 16
        let upper = max(lower, appBounds.maxX - width - 16)
        x = min(max(x, lower), upper)

        // AX coordinates are top-left-origin; AppKit is bottom-left. Convert.
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        let y = screenH - (axTop + Self.height)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: Self.height), display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: Self.height),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        configureContent(of: panel)
        return panel
    }

    private func configureContent(of panel: NSPanel) {
        guard let card else { return }
        let h = Self.height
        let lineFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)

        let lineText = "\(card.sponsorName) · \(card.message)"
        var lineW = ceil(lineText.size(withAttributes: [.font: lineFont]).width)

        // Everything except the (ellipsizable) line is fixed width.
        let fixed = Self.padX + Self.chipSize + Self.gap + Self.gap
                  + Self.dismissSize + Self.padX
        lineW = min(lineW, Self.maxWidth - fixed)
        let width = fixed + lineW
        panelWidth = width
        panel.setContentSize(NSSize(width: width, height: h))

        let root = NSView(frame: NSRect(x: 0, y: 0, width: width, height: h))
        root.wantsLayer = true
        root.layer?.backgroundColor = Palette.barBackground.cgColor
        root.layer?.cornerRadius = h / 2
        root.layer?.borderWidth = 1
        root.layer?.borderColor = Palette.barBorder.cgColor

        var x = Self.padX
        let chip = NSTextField(labelWithString: String(card.sponsorName.prefix(1)).uppercased())
        chip.font = .systemFont(ofSize: 11, weight: .heavy)
        chip.textColor = Palette.chipText
        chip.alignment = .center
        chip.wantsLayer = true
        chip.layer?.backgroundColor = Palette.chipBackground.cgColor
        chip.layer?.cornerRadius = 5
        chip.frame = NSRect(x: x, y: (h - Self.chipSize) / 2, width: Self.chipSize, height: Self.chipSize)
        x += Self.chipSize + Self.gap

        let line = NSTextField(labelWithString: lineText)
        line.font = lineFont
        line.textColor = Palette.line
        line.lineBreakMode = .byTruncatingTail
        line.frame = NSRect(x: x, y: (h - 17) / 2, width: lineW, height: 17)
        x += lineW + Self.gap

        let dismiss = NSButton(title: "×", target: self, action: #selector(dismissTapped))
        dismiss.isBordered = false
        dismiss.contentTintColor = Palette.dots
        dismiss.frame = NSRect(x: x, y: (h - Self.dismissSize) / 2,
                               width: Self.dismissSize, height: Self.dismissSize)

        // Whole bar is the click target (like the extension); × stays separate.
        for view in [chip, line] {
            view.addGestureRecognizer(
                NSClickGestureRecognizer(target: self, action: #selector(cardTapped)))
        }

        root.addSubview(chip)
        root.addSubview(line)
        root.addSubview(dismiss)
        panel.contentView = root
    }

    @objc private func cardTapped() {
        // Opening is the click handler's job: it routes through the server's
        // single-use tracking URL (or the plain URL in demo mode). Opening
        // here too would double-open the destination.
        guard let card else { return }
        onClick?(card)
    }

    @objc private func dismissTapped() {
        hide()
        if let card { onDismiss?(card) }
    }
}
