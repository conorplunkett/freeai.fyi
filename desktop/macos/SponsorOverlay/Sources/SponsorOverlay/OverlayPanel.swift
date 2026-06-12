// The sponsor card: a small, non-activating floating panel positioned at the
// bottom center of the Claude window, above the composer. It never takes key
// focus, so typing in Claude is unaffected.

import AppKit

struct SponsorCard {
    var campaignID: String
    var sponsorName: String
    var message: String // ≤60 chars, validated by overlay-core
    var destinationURL: URL
}

final class OverlayPanelController {
    static let height: CGFloat = 40
    static let width: CGFloat = 360
    /// Keeps the card clear of Claude's composer/input area.
    static let bottomInset: CGFloat = 88

    private var panel: NSPanel?
    private(set) var card: SponsorCard?
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

    func show(over claudeBounds: CGRect) {
        guard card != nil else { return }
        let panel = self.panel ?? makePanel()
        self.panel = panel

        // AX coordinates are top-left-origin; AppKit is bottom-left. Convert.
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        let x = claudeBounds.midX - Self.width / 2
        let y = screenH - claudeBounds.maxY + Self.bottomInset
        panel.setFrame(NSRect(x: x, y: y, width: Self.width, height: Self.height), display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.width, height: Self.height),
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
        let root = NSView(frame: panel.contentLayoutRect)
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor(white: 0.12, alpha: 0.92).cgColor
        root.layer?.cornerRadius = 10

        let label = NSTextField(labelWithString: "Sponsored by \(card.sponsorName) · \(card.message)")
        label.font = .systemFont(ofSize: 12)
        label.textColor = .white
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 12, y: 0, width: Self.width - 56, height: Self.height)

        let dismiss = NSButton(title: "×", target: self, action: #selector(dismissTapped))
        dismiss.isBordered = false
        dismiss.contentTintColor = .lightGray
        dismiss.frame = NSRect(x: Self.width - 32, y: (Self.height - 24) / 2, width: 24, height: 24)

        let click = NSClickGestureRecognizer(target: self, action: #selector(cardTapped))
        label.addGestureRecognizer(click)

        root.addSubview(label)
        root.addSubview(dismiss)
        panel.contentView = root
    }

    @objc private func cardTapped() {
        guard let card else { return }
        NSWorkspace.shared.open(card.destinationURL)
        onClick?(card)
    }

    @objc private func dismissTapped() {
        hide()
        if let card { onDismiss?(card) }
    }
}
