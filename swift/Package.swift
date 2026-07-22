// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ChatGPTOAuth",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "ChatGPTOAuth", targets: ["ChatGPTOAuth"]),
        .library(name: "ChatGPTOAuthUI", targets: ["ChatGPTOAuthUI"]),
    ],
    targets: [
        .target(
            name: "ChatGPTOAuth",
            swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]
        ),
        .target(
            name: "ChatGPTOAuthUI",
            dependencies: ["ChatGPTOAuth"],
            swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]
        ),
        .testTarget(
            name: "ChatGPTOAuthTests",
            dependencies: ["ChatGPTOAuth"],
            swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]
        ),
    ]
)
