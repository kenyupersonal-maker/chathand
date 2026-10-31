enum PermissionFlowStep: Equatable {
    case idle
    case accessibility
    case screenRecording
    case complete
}

enum PermissionRestartDecision: Equatable {
    case permissionsIncomplete
    case waitForTask
    case restart
}

enum PermissionFlowState {
    static func begin(accessibilityGranted: Bool, screenRecordingGranted: Bool) -> PermissionFlowStep {
        if accessibilityGranted && screenRecordingGranted { return .complete }
        return accessibilityGranted ? .screenRecording : .accessibility
    }

    static func advance(
        from current: PermissionFlowStep,
        accessibilityGranted: Bool,
        screenRecordingGranted: Bool
    ) -> PermissionFlowStep {
        if accessibilityGranted && screenRecordingGranted { return .complete }
        switch current {
        case .idle:
            return begin(accessibilityGranted: accessibilityGranted, screenRecordingGranted: screenRecordingGranted)
        case .accessibility:
            return accessibilityGranted ? .screenRecording : .accessibility
        case .screenRecording:
            return screenRecordingGranted ? .accessibility : .screenRecording
        case .complete:
            return begin(accessibilityGranted: accessibilityGranted, screenRecordingGranted: screenRecordingGranted)
        }
    }

    static func restartDecision(
        accessibilityGranted: Bool,
        screenRecordingGranted: Bool,
        taskBusy: Bool
    ) -> PermissionRestartDecision {
        guard accessibilityGranted && screenRecordingGranted else { return .permissionsIncomplete }
        return taskBusy ? .waitForTask : .restart
    }
}
