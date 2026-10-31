// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ChatHandNative",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../vendor/PermissionFlow")
    ],
    targets: [
        .executableTarget(
            name: "ChatHandShell",
            dependencies: [
                .product(name: "PermissionFlow", package: "permissionflow"),
                .product(name: "PermissionFlowScreenRecordingStatus", package: "permissionflow")
            ],
            path: ".",
            exclude: ["SQLiteDescriptorVFS.c", "ProcessCompatibility.c", "DocumentReader.swift", "Info.plist", "UpgradeControl.swift", "BrowserHost.swift", "ArtifactFileAccess.swift", "tests"],
            sources: [
                "BuildVersion.swift",
                "BackendRecovery.swift",
                "ChatHandUninstall.swift",
                "ChatHandUninstallRevoke.swift",
                "ProcessOwnership.swift",
                "InstanceLifecycle.swift",
                "StartupMigration.swift",
                "NativeTermination.swift",
                "LocalText.swift",
                "RuntimeDescriptor.swift",
                "NativePageBootstrap.swift",
                "RehearsalPageObserver.swift",
                "RehearsalBackendPaths.swift",
                "ComputerControl.swift",
                "B2TargetClick.swift",
                "PermissionFlowState.swift",
                "KeepAwake.swift",
                "MenuBarState.swift",
                "EmergencyStopHotKey.swift",
                "LoginItemService.swift",
                "SetupConversation.swift",
                "ChromeHelperInstall.swift",
                "ChromeAccessibilityWait.swift",
                "ClientFeatures.swift",
                "NativeDiagnostics.swift",
                "PluginIconExport.swift",
                "ClientNotifications.swift",
                "ConfirmGuard.swift",
                "PermissionAssistant.swift",
                "WindowChrome.swift",
                "main.swift"
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
