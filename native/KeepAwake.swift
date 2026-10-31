import Foundation
import IOKit.pwr_mgt

/// Prevent idle system sleep only while the authenticated local service reports work.
final class KeepAwake {
    private var assertion: IOPMAssertionID = 0
    func update(_ active: Bool) {
        if active && assertion == 0 {
            var created: IOPMAssertionID = 0
            if IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), LocalText.text("native.keepAwake.reason") as CFString, &created) == kIOReturnSuccess {
                assertion = created
            }
        } else if !active && assertion != 0 {
            IOPMAssertionRelease(assertion)
            assertion = 0
        }
    }
    deinit { if assertion != 0 { IOPMAssertionRelease(assertion) } }
}
