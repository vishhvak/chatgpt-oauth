// swift-tools-version: 5.9

import PackageDescription

// Standalone so the library package stays exactly as consumers (and the vendored iOS copy) see it:
// an executable target inside ../../Package.swift would add an implicit public product to it.
let package = Package(
    name: "ChatGPTOAuthVerify",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "../..")],
    targets: [
        .executableTarget(
            name: "Verify",
            // Package identity for a path dependency is the directory name, so "swift", not the
            // declared package name.
            dependencies: [.product(name: "ChatGPTOAuth", package: "swift")],
            swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]
        )
    ]
)
