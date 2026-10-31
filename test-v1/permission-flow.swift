import Foundation

@main
struct PermissionFlowStateTests {
    static func expect(_ value: Bool, _ message: String) {
        guard value else {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func main() {
        expect(PermissionFlowState.begin(accessibilityGranted: false, screenRecordingGranted: false) == .accessibility,
               "request accessibility first when both permissions are missing")
        expect(PermissionFlowState.begin(accessibilityGranted: true, screenRecordingGranted: false) == .screenRecording,
               "skip accessibility when already granted")
        expect(PermissionFlowState.begin(accessibilityGranted: true, screenRecordingGranted: true) == .complete,
               "skip guidance when both permissions are already granted")
        expect(PermissionFlowState.advance(from: .accessibility, accessibilityGranted: false, screenRecordingGranted: false) == .accessibility,
               "keep waiting for accessibility")
        expect(PermissionFlowState.advance(from: .accessibility, accessibilityGranted: true, screenRecordingGranted: false) == .screenRecording,
               "continue with screen recording after accessibility is granted")
        expect(PermissionFlowState.advance(from: .screenRecording, accessibilityGranted: true, screenRecordingGranted: true) == .complete,
               "complete only after both permissions are granted")
        expect(PermissionFlowState.restartDecision(accessibilityGranted: false, screenRecordingGranted: true, taskBusy: false) == .permissionsIncomplete,
               "do not restart before permissions are complete")
        expect(PermissionFlowState.restartDecision(accessibilityGranted: true, screenRecordingGranted: true, taskBusy: true) == .waitForTask,
               "do not interrupt an active task")
        expect(PermissionFlowState.restartDecision(accessibilityGranted: true, screenRecordingGranted: true, taskBusy: false) == .restart,
               "allow restart once permissions are ready and idle")
        print("PASS permission flow state machine")
    }
}
