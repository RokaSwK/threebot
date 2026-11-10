// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ThreebotMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ThreebotMac", targets: ["ThreebotMac"])],
    targets: [.executableTarget(name: "ThreebotMac")]
)
