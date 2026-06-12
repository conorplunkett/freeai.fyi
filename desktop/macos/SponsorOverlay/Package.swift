// swift-tools-version: 5.9
// macOS shell for the FreeAI sponsor overlay. Build on a Mac:
//   swift build && swift run SponsorOverlay
// Ship builds need code signing + Accessibility entitlement prompts (see ../../README.md).
import PackageDescription

let package = Package(
    name: "SponsorOverlay",
    platforms: [.macOS(.v13)],
    dependencies: [
        // Auto-update. SPM pulls Sparkle as a prebuilt xcframework; bundle.sh
        // embeds + signs it into the .app (see packaging/bundle.sh).
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "SponsorOverlay",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/SponsorOverlay"
        )
    ]
)
