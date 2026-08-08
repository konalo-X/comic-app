// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ComicApp",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ComicApp", targets: ["ComicApp"])
    ],
    dependencies: [
        .package(url: "https://github.com/stephencelis/SQLite.swift.git", from: "0.15.3"),
        .package(url: "https://github.com/scinfu/SwiftSoup.git", from: "2.7.4"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19"),
        .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.10.2"),
    ],
    targets: [
        .executableTarget(
            name: "ComicApp",
            dependencies: [
                .product(name: "SQLite", package: "SQLite.swift"),
                .product(name: "SwiftSoup", package: "SwiftSoup"),
                .product(name: "ZIPFoundation", package: "ZIPFoundation"),
                .product(name: "Alamofire", package: "Alamofire"),
            ],
            path: "Sources/ComicApp",
            resources: [.process("../../Resources")],
            linkerSettings: [
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("CFNetwork")
            ]
        ),
        .testTarget(
            name: "ComicAppTests",
            dependencies: ["ComicApp"],
            path: "Tests/ComicAppTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)