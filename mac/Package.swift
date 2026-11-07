// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Sleep",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "SleepCore"), // pure: state + schedule math, unit tested
    .executableTarget(name: "Sleep", dependencies: ["SleepCore"]),
    .testTarget(name: "SleepCoreTests", dependencies: ["SleepCore"]),
  ]
)
