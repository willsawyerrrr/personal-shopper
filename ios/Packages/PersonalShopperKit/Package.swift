// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PersonalShopperKit",
    platforms: [.iOS(.v18)],
    products: [.library(name: "PersonalShopperKit", targets: ["PersonalShopperKit"])],
    targets: [
        .target(name: "PersonalShopperKit"),
        .testTarget(name: "PersonalShopperKitTests", dependencies: ["PersonalShopperKit"]),
    ]
)
