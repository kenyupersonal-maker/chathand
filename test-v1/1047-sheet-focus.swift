import Cocoa
import ApplicationServices

// Pure rules only. No App launch, AX tree read, event dispatch or permission request.
@main struct SheetFocusChecks {
    static var checks = 0
    static func expect(_ value: Bool, _ name: String) {
        checks += 1
        if !value { fputs("FAIL: \(name)\n", stderr); exit(1) }
    }
    static func node(_ id: UInt64, _ pid: pid_t = 17, _ role: String = "AXSheet",
                     _ parent: UInt64? = 100, _ root: UInt64? = 100,
                     _ frame: CGRect = CGRect(x: 110, y: 120, width: 600, height: 350)) -> ComputerControl.SurfaceNodeFacts {
        ComputerControl.SurfaceNodeFacts(id: id, pid: pid, role: role, parentID: parent, windowID: root, frame: frame)
    }
    @MainActor static func main() async {
        expect(ComputerControl.directSheetIndices(nil) == nil, "failed children read stays unknown")
        expect(ComputerControl.directSheetIndices(["AXGroup", nil]) == nil, "unknown child role cannot prove no sheet")
        expect(ComputerControl.directSheetIndices([nil]) == nil, "unknown nested child role stays unknown")
        expect(ComputerControl.directSheetIndices(["AXGroup", "AXButton"]) == [], "complete non-sheet children preserve fallback")
        expect(ComputerControl.directSheetIndices(["AXGroup", "AXSheet"]) == [1], "known sheet retains its real child identity")
        let root = node(100, 17, "AXWindow", nil, nil, CGRect(x: 100, y: 100, width: 800, height: 600))
        let sheet = node(200)
        let nested = node(300, 17, "AXSheet", 200)
        expect(ComputerControl.validSurfaceChain([root], pid: 17), "ordinary window keeps strict existing identity")
        expect(ComputerControl.validSurfaceChain([root, sheet], pid: 17), "observed attached sheet is a valid separate input surface")
        expect(ComputerControl.validSurfaceChain([root, sheet, nested], pid: 17), "explicitly observed nested sheet chain")
        expect(!ComputerControl.validSurfaceChain([], pid: 17), "missing chain rejected")
        expect(!ComputerControl.validSurfaceChain([root], pid: 0), "missing process rejected")
        expect(!ComputerControl.validSurfaceChain([node(100, 17, "AXSheet")], pid: 17), "sheet cannot impersonate top-level parent")
        for bad in [
            node(200, 18), node(200, 17, "AXWindow"), node(200, 17, "AXDialog"),
            node(200, 17, "AXSheet", nil), node(200, 17, "AXSheet", 999),
            node(200, 17, "AXSheet", 100, nil), node(200, 17, "AXSheet", 100, 999),
            node(100),
            node(200, 17, "AXSheet", 100, 100, CGRect(x: -200, y: 120, width: 200, height: 100)),
            node(200, 17, "AXSheet", 100, 100, CGRect(x: 110, y: 120, width: 0, height: 100)),
            node(200, 17, "AXSheet", 100, 100, CGRect(x: Double.nan, y: 120, width: 100, height: 100))
        ] {
            expect(!ComputerControl.validSurfaceChain([root, bad], pid: 17), "unproven/cross-process/unrelated/cyclic/out-of-bounds sheet rejected")
        }
        expect(!ComputerControl.validSurfaceChain([root, sheet, node(300)], pid: 17), "sibling cannot impersonate nested sheet")
        expect(!ComputerControl.validSurfaceChain([root, sheet, nested, node(400,17,"AXSheet",300), node(500,17,"AXSheet",400), node(600,17,"AXSheet",500)], pid: 17), "depth limit fails closed")
        for target: pid_t? in [nil, 0, 17] {
            for front: pid_t? in [nil, 0, 17, 18] {
                for current in [true, false] {
                    for focused in [true, false] {
                        let reason = ComputerControl.foregroundSurfaceProblem(targetPID: target, frontPID: front, surfaceCurrent: current, focusMatches: focused)
                        let allowed = target == 17 && front == 17 && current && focused
                        expect((reason == nil) == allowed, "all foreground gate combinations must agree")
                    }
                }
            }
        }
        expect(ComputerControl.foregroundSurfaceProblem(targetPID:17,frontPID:18,surfaceCurrent:true,focusMatches:true) == "front_app_changed", "user switched App is distinguishable")
        expect(ComputerControl.foregroundSurfaceProblem(targetPID:17,frontPID:17,surfaceCurrent:false,focusMatches:true) == "surface_changed", "replaced sheet remains rejected")
        expect(ComputerControl.foregroundSurfaceProblem(targetPID:17,frontPID:17,surfaceCurrent:true,focusMatches:false) == "focused_surface_changed", "same App but another focused window remains rejected")
        for count in [0, 1, 2, 100, 100001] {
            let failure = ComputerControl.foregroundFailure("FOCUS_CHANGED", "fixture", attempted: count, reason: "surface_changed")
            let details = failure.payload["details"] as! [String:Any]
            expect(failure.code == "FOCUS_CHANGED", "original rejection code retained")
            expect(failure.uncertain == (count > 0), "uncertainty follows actual dispatch provenance")
            expect(details["do_not_replay"] as? Bool == (count > 0), "not attempted is not invented posted delivery")
            expect(details["foreground_input_events"] as? Int == min(count,100000), "counts are bounded")
            expect(details["focus_reason"] as? String == "surface_changed", "fixed reason survives native payload")
        }
        let safe = ComputerControl.foregroundFailure("TASK_REVOKED", "revoked", attempted: 1)
        expect(safe.uncertain && safe.code == "TASK_REVOKED", "late task revocation remains unknown and non-replayable")
        expect(!ComputerControl.requestIsCurrent(token:1,liveGeneration:2,stopped:false,deadline:100,now:1), "generation gate is not relaxed")
        expect(!ComputerControl.requestIsCurrent(token:1,liveGeneration:1,stopped:true,deadline:100,now:1), "user stop not relaxed")
        expect(!ComputerControl.inputAllowedForBundle("com.kenyu.chathand",selfBundleID:nil), "AI never controls its own bridge confirmation")
        for code in ["SECURE_INPUT", "FOCUS_CHANGED", "TASK_REVOKED"] {
            var sent = 0
            let output = try! await ComputerControl.runBatch([["step_id":"first"],["step_id":"rest"]], foregroundEvents: { sent }) { _ in
                sent += 2
                throw ComputerControl.ControlFailure(code, "fixture", uncertain:false)
            }
            let receipts = output["receipts"] as! [[String:Any]]
            let stepError = receipts[0]["error"] as! [String:Any]
            let details = stepError["details"] as! [String:Any]
            expect(stepError["code"] as? String == code, "same-step late guard retains original code")
            expect(details["foreground_input_events"] as? Int == 2, "same-step dispatch provenance survives batch catch")
            expect(details["delivery_unconfirmed"] as? Bool == true && details["do_not_replay"] as? Bool == true, "same-step partial input stays uncertain")
            expect(receipts[1]["status"] as? String == "not_attempted", "batch stops without replaying remaining steps")
            expect(output["error"] != nil, "aggregate dispatch failure is an error RPC")
        }
        var sent = 0
        let earlier = try! await ComputerControl.runBatch([["step_id":"sent"],["step_id":"zero"],["step_id":"rest"]], foregroundEvents: { sent }) { step in
            if step["step_id"] as? String == "sent" { sent += 2; return ["performed":"type"] }
            throw ComputerControl.ControlFailure("SECURE_INPUT", "fixture", uncertain:false)
        }
        let receipts = earlier["receipts"] as! [[String:Any]]
        let zeroDetails = (receipts[1]["error"] as! [String:Any])["details"] as! [String:Any]
        let aggregateDetails = (earlier["error"] as! [String:Any])["details"] as! [String:Any]
        expect(zeroDetails["do_not_replay"] as? Bool == false, "later zero-attempt step does not inherit previous step count")
        expect(zeroDetails["foreground_input_events"] == nil, "no invented events for failed zero-attempt step")
        expect(aggregateDetails["do_not_replay"] as? Bool == true && aggregateDetails["foreground_input_events"] as? Int == 2, "request aggregate still retains earlier attempted input")
        expect(receipts[2]["status"] as? String == "not_attempted", "last step remains unattempted")
        for code in ["FOCUS_CHANGED", "COMPUTER_REQUEST_EXPIRED", "TASK_REVOKED"] {
            var sent = 0
            let output = try! await ComputerControl.runBatch([["step_id":"sent"],["step_id":"guard"],["step_id":"rest"]], foregroundEvents: { sent }) { step in
                if step["step_id"] as? String == "sent" { sent += 2; return ["performed":"type"] }
                // Production Session guards supply the cumulative request count.
                throw ComputerControl.foregroundFailure(code, "fixture", attempted:sent, reason:"surface_changed")
            }
            let receipts = output["receipts"] as! [[String:Any]]
            let stepError = receipts[1]["error"] as! [String:Any]
            let stepDetails = stepError["details"] as! [String:Any]
            let aggregate = (output["error"] as! [String:Any])["details"] as! [String:Any]
            expect(stepError["code"] as? String == code, "zero-attempt production guard keeps rejection code")
            expect(stepDetails["foreground_input_events"] as? Int == 0, "production guard count is rebased to current step")
            expect(stepDetails["delivery_unconfirmed"] as? Bool == false && stepDetails["do_not_replay"] as? Bool == false, "zero-attempt guard cannot inherit earlier uncertainty")
            expect(stepDetails["delivery_status"] == nil, "zero-attempt guard is not falsely posted")
            expect(stepDetails["focus_reason"] as? String == "surface_changed", "guard reason stays intact")
            expect(aggregate["foreground_input_events"] as? Int == 2 && aggregate["do_not_replay"] as? Bool == true, "batch aggregate preserves earlier actual input")
            expect(receipts[2]["status"] as? String == "not_attempted", "production guard stops remaining steps")
        }
        for uncertain in [false, true] {
            let noForeground = try! await ComputerControl.runBatch([["step_id":"zero"],["step_id":"rest"]]) { _ in
                throw ComputerControl.ControlFailure("COMPUTER_ACTION_UNCONFIRMED", "fixture", uncertain:uncertain)
            }
            let details = (noForeground["failure"] as! [String:Any])["details"] as! [String:Any]
            expect(details["do_not_replay"] as? Bool == uncertain, "zero foreground count never clears existing AX uncertainty")
            expect(noForeground["foreground_input_events"] == nil, "zero-attempt request does not invent input")
        }
        print("PASS \(checks) isolated 1047 surface checks; zero real events")
    }
}
