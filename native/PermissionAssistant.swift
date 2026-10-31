import AppKit
import ApplicationServices
import CoreGraphics
import PermissionFlow
import PermissionFlowScreenRecordingStatus

@available(macOS 14.0, *)
@MainActor
final class PermissionAssistant {
    private let flowController = PermissionFlow.makeController(configuration: PermissionFlowConfiguration(
        requiredAppURLs: [Bundle.main.bundleURL],
        promptForAccessibilityTrust: false,
        localeIdentifier: LocalText.systemLocale == "en" ? "en" : "zh-Hans"
    ))
    private var controller: PermissionFlowController {
        refreshLanguage()
        return flowController
    }
    func refreshLanguage() {
        flowController.setLocaleIdentifier(LocalText.systemLocale == "en" ? "en" : "zh-Hans")
    }
    private var genericGeneration: UUID?
    var onboardingBegin: ((String) -> ((String, String) -> Void))?
    private var onboardingEnd: ((String, String) -> Void)?
    private var timer: Timer?
    private var step: PermissionFlowStep = .idle
    private var update: (([String: Any]) -> Void)?
    private var accessibilityOnly = false

    init() {
        PermissionFlowScreenRecordingStatus.register()
    }

    func status() -> [String: Any] {
        let accessibility = PermissionStatusRegistry.provider(for: .accessibility).authorizationState() == .granted
        let screenRecording = PermissionStatusRegistry.provider(for: .screenRecording).authorizationState() == .granted
        return [
            "accessibility": accessibility,
            "screen_recording": screenRecording,
            "complete": accessibility && screenRecording,
            "step": stepName(step)
        ]
    }

    func requestPermissions(onUpdate: @escaping ([String: Any]) -> Void) -> [String: Any] {
        genericGeneration = nil
        timer?.invalidate(); timer = nil
        accessibilityOnly = false
        update = onUpdate
        let current = status()
        let accessibility = current["accessibility"] as? Bool == true
        let screenRecording = current["screen_recording"] as? Bool == true
        if accessibility, let finish = onboardingBegin?("permission_accessibility") { finish("skipped","NONE") }
        if screenRecording, let finish = onboardingBegin?("permission_screen_recording") { finish("skipped","NONE") }
        step = PermissionFlowState.begin(accessibilityGranted: accessibility, screenRecordingGranted: screenRecording)
        guard step != .complete else {
            timer?.invalidate(); timer = nil
            return status()
        }
        let generation = UUID()
        genericGeneration = generation
        openCurrentPane()
        startGenericPolling(generation)
        return status()
    }

    private func startGenericPolling(_ generation: UUID) {
        guard genericGeneration == generation else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.genericGeneration == generation else { return }
                self.refresh()
            }
        }
    }

    /// Chrome installation needs AX only. ChromeAccessibilityWait owns its bounded
    /// polling; this entry never advances to or requests Screen Recording.
    func requestAccessibilityOnly() -> [String: Any] {
        genericGeneration = nil
        timer?.invalidate(); timer = nil; update = nil
        onboardingEnd?("cancelled", "CANCELLED"); onboardingEnd = nil
        accessibilityOnly = true
        if AXIsProcessTrusted() {
            step = .complete
            return ["accessibility": true, "step": "complete"]
        }
        step = .accessibility
        onboardingEnd = onboardingBegin?("permission_accessibility")
        controller.authorize(pane: .accessibility, suggestedAppURLs: [Bundle.main.bundleURL])
        return ["accessibility": false, "step": "accessibility"]
    }

    func finishAccessibilityOnly(granted: Bool) {
        guard accessibilityOnly else { return }
        accessibilityOnly = false
        onboardingEnd?(granted ? "ok" : "cancelled", granted ? "NONE" : "CANCELLED")
        onboardingEnd = nil
        step = granted ? .complete : .idle
        controller.closePanel()
    }

    func reopenGuidance() -> [String: Any] {
        if accessibilityOnly { return requestAccessibilityOnly() }
        genericGeneration = nil
        timer?.invalidate(); timer = nil
        let current = status()
        step = PermissionFlowState.begin(
            accessibilityGranted: current["accessibility"] as? Bool == true,
            screenRecordingGranted: current["screen_recording"] as? Bool == true
        )
        guard step != .complete else { return current }
        let generation = UUID()
        genericGeneration = generation
        openCurrentPane()
        startGenericPolling(generation)
        return status()
    }

    func repairPermissions(completion: @escaping ([String: Any]) -> Void) {
        guard BuildVersion.bundleID == "com.kenyu.chathand" else {
            completion(["error": "BUNDLE_ID_NOT_ALLOWED"])
            return
        }
        let alert = NSAlert()
        alert.messageText = LocalText.text("native.permissionReset.title")
        alert.informativeText = LocalText.text("native.permissionReset.body")
        alert.addButton(withTitle: LocalText.text("native.permissionReset.confirm"))
        alert.addButton(withTitle: LocalText.text("native.button.cancel"))
        guard alert.runModal() == .alertFirstButtonReturn else {
            completion(["cancelled": true])
            return
        }
        let accessibility = runTCCReset(service: "Accessibility")
        let screenRecording = runTCCReset(service: "ScreenCapture")
        let result: [String: Any] = [
            "reset": accessibility == 0 && screenRecording == 0,
            "accessibility_exit": accessibility,
            "screen_recording_exit": screenRecording,
            "bundle_id": BuildVersion.bundleID
        ]
        if accessibility == 0 && screenRecording == 0 { _ = requestPermissions(onUpdate: update ?? { _ in }) }
        completion(result)
    }

    private func runTCCReset(service: String) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        process.arguments = ["reset", service, BuildVersion.bundleID]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }

    private func refresh() {
        guard !accessibilityOnly else { return }
        let current = status()
        let accessibility = current["accessibility"] as? Bool == true
        let screenRecording = current["screen_recording"] as? Bool == true
        let next = PermissionFlowState.advance(from: step, accessibilityGranted: accessibility, screenRecordingGranted: screenRecording)
        if next != step {
            onboardingEnd?("ok","NONE"); onboardingEnd = nil
            step = next
            if next == .complete {
                genericGeneration = nil
                timer?.invalidate(); timer = nil
                controller.closePanel()
            } else {
                openCurrentPane()
            }
        }
        let refreshed = status()
        update?(refreshed)
    }

    private func openCurrentPane() {
        onboardingEnd?("cancelled","CANCELLED"); onboardingEnd = nil
        if step == .accessibility { onboardingEnd = onboardingBegin?("permission_accessibility") }
        if step == .screenRecording { onboardingEnd = onboardingBegin?("permission_screen_recording") }
        // AX/CG requests and state transitions are visible; individual system clicks are not.
        switch step {
        case .accessibility:
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            controller.authorize(pane: .accessibility, suggestedAppURLs: [Bundle.main.bundleURL])
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
            controller.authorize(pane: .screenRecording, suggestedAppURLs: [Bundle.main.bundleURL])
        case .idle, .complete:
            break
        }
    }

    private func stepName(_ step: PermissionFlowStep) -> String {
        switch step {
        case .idle: return "idle"
        case .accessibility: return "accessibility"
        case .screenRecording: return "screen_recording"
        case .complete: return "complete"
        }
    }
}
