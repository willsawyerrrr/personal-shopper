// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "PersonalShopperKit",
    platforms: [.iOS(.v27)],
    products: [.library(name: "PersonalShopperKit", targets: ["PersonalShopperKit"])],
    targets: [
        .target(name: "PersonalShopperKit", resources: [.copy("Resources/passkey-authenticator.js")]),
        .testTarget(name: "PersonalShopperKitTests", dependencies: ["PersonalShopperKit"]),
    ]
)
