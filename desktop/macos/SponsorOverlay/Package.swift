// swift-tools-version: 5.9
// macOS shell for the FreeAI sponsor overlay. Build on a Mac:
//   swift build && swift run SponsorOverlay
// Ship builds need code signing + Accessibility entitlement prompts (see ../../README.md).
import PackageDescription

let package = Package(
    name: "SponsorOverlay",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SponsorOverlay",
            path: "Sources/SponsorOverlay"
        )
    ]
)
