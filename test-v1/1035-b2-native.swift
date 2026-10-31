import Cocoa
import ApplicationServices

// Offline injections only. Never call Transport/attempt/processStart/eligible,
// WindowReader/status/execute/Session or an AX, permission, capture/input API.
@main struct B2RuleChecks {
    @MainActor static func main() async {
        var checks = 0
        func expect(_ ok: Bool, _ message: String) {
            checks += 1
            if !ok { fputs("FAIL \(message)\n", stderr); exit(1) }
        }
        for bundle in ["com.openai.chat", "com.openai.codex"] {
            expect(!ComputerControl.chatGPTAllowedForBundle(bundle, allowed:false), "ChatGPT first-risk gate")
            expect(ComputerControl.chatGPTAllowedForBundle(bundle, allowed:true), "consented ChatGPT remains usable")
        }
        expect(ComputerControl.chatGPTAllowedForBundle("com.apple.TextEdit", allowed:false), "ordinary app needs no self risk grant")
        expect(!ComputerControl.inputAllowedForBundle("com.kenyu.chathand", selfBundleID:nil), "ChatHand protection unchanged")
        expect(!ComputerControl.inputAllowedForBundle("com.apple.notificationcenterui", selfBundleID:nil), "notification protection unchanged")
        let local = CGPoint(x: 100, y: 120), frame = CGRect(x: -800, y: 30, width: 600, height: 500)
        let start = B2TargetClick.ProcessStart(seconds: 1000, microseconds: 42)
        let identity = B2TargetClick.Identity(pid: 7, start: start, bundle: "fixture", windowID: 23, frame: frame)
        let chromeTitle = "1035 chrome own fixture", axChromeTitle = chromeTitle + " - Google Chrome"
        func captureFact(_ id: UInt32 = 23, pid: pid_t? = 7, layer: Int = 0,
                         bounds: CGRect? = nil, title: String? = chromeTitle) -> ComputerControl.CaptureWindowFacts {
            .init(id: id, pid: pid, layer: layer, frame: bounds ?? frame, title: title)
        }
        func matches(_ facts: ComputerControl.CaptureWindowFacts, identity: B2TargetClick.Identity?,
                     pid: pid_t = 7, bounds: CGRect? = nil) -> Bool {
            ComputerControl.captureWindowMatches(facts, targetPID: pid, targetFrame: bounds ?? frame,
                                                 targetTitle: axChromeTitle, identity: identity)
        }
        expect(matches(captureFact(), identity: identity), "real Chrome AX suffix cannot block exact-ID SC capture")
        for title in [nil, "", "completely different display title"] as [String?] {
            expect(matches(captureFact(title: title), identity: identity), "exact window uses ID rather than title")
        }
        for changed in [captureFact(24), captureFact(pid: 8), captureFact(pid: nil), captureFact(layer: 1),
                        captureFact(bounds: frame.offsetBy(dx: 0.1, dy: 0)),
                        captureFact(bounds: CGRect(x: -800, y: 30, width: 601, height: 500))] {
            expect(!matches(changed, identity: identity), "exact ID/PID/layer/frame change rejects capture")
        }
        expect(!matches(captureFact(), identity: identity, pid: 8), "snapshot cannot bind another target PID")
        expect(!matches(captureFact(), identity: identity, bounds: frame.offsetBy(dx: 0.1, dy: 0)), "snapshot cannot bind a moved target frame")
        let sameGeometry = [captureFact(24, title: axChromeTitle), captureFact(), captureFact(25, title: axChromeTitle)]
        let exactMatches = sameGeometry.filter { matches($0, identity: identity) }
        expect(exactMatches.count == 1 && exactMatches.first?.id == 23, "same-PID/frame windows cannot redirect exact-ID capture")
        expect(ComputerControl.captureSelectionProblem(count: 0, identityKnown: true) == "TARGET_CHANGED", "missing exact ID refuses rather than choosing geometry/title")
        expect(ComputerControl.captureSelectionProblem(count: 2, identityKnown: true) == "TARGET_CHANGED", "nonunique exact-ID evidence refuses")
        expect(ComputerControl.captureSelectionProblem(count: 1, identityKnown: true) == nil, "one exact-ID capture candidate")
        expect(!matches(captureFact(), identity: nil), "unproven identity keeps former title rule; no Chrome suffix heuristic")
        for title in [nil, "", axChromeTitle] as [String?] {
            expect(matches(captureFact(title: title), identity: nil), "former absent/empty/equal title rule retained")
        }
        expect(matches(captureFact(bounds: frame.offsetBy(dx: 8, dy: 0), title: axChromeTitle), identity: nil), "former frame tolerance retained")
        for changed in [captureFact(pid: 8, title: axChromeTitle), captureFact(layer: 1, title: axChromeTitle),
                        captureFact(bounds: frame.offsetBy(dx: 9, dy: 0), title: axChromeTitle), captureFact(title: "wrong title")] {
            expect(!matches(changed, identity: nil), "unproven identity cannot weaken legacy PID/layer/frame/title checks")
        }
        expect(ComputerControl.captureSelectionProblem(count: 0, identityKnown: false) == "COMPUTER_WINDOW_MISSING", "legacy missing capture code")
        expect(ComputerControl.captureSelectionProblem(count: 2, identityKnown: false) == "COMPUTER_WINDOW_AMBIGUOUS", "legacy ambiguous capture code")
        for changed in [
            B2TargetClick.Identity(pid: 8, start: start, bundle: "fixture", windowID: 23, frame: frame),
            B2TargetClick.Identity(pid: 7, start: .init(seconds: 1000, microseconds: 43), bundle: "fixture", windowID: 23, frame: frame),
            B2TargetClick.Identity(pid: 7, start: start, bundle: "other", windowID: 23, frame: frame),
            B2TargetClick.Identity(pid: 7, start: start, bundle: "fixture", windowID: 24, frame: frame),
            B2TargetClick.Identity(pid: 7, start: start, bundle: "fixture", windowID: 23, frame: frame.offsetBy(dx: 0.1, dy: 0)),
            B2TargetClick.Identity(pid: 7, start: start, bundle: "fixture", windowID: 23, frame: CGRect(x: -800, y: 30, width: 601, height: 500))
        ] { expect(identity != changed, "all target identity components exact; no movement tolerance") }
        let eligibility: [(Bool, Int, Bool?, Bool?, Int?, UInt32?, UInt32?, Bool, Bool)] = [
            (false, 1, false, true, 0, 23, 23, true, true),
            (true, 1, false, true, 0, 23, 23, true, false),
            (false, 2, false, true, 0, 23, 23, true, false),
            (false, 0, false, true, 0, 23, 23, true, false),
            (false, 1, true, true, 0, 23, 23, true, false),
            (false, 1, nil, true, 0, 23, 23, true, false),
            (false, 1, false, false, 0, 23, 23, true, false),
            (false, 1, false, nil, 0, 23, 23, true, false),
            (false, 1, false, true, 1, 23, 23, true, false),
            (false, 1, false, true, nil, 23, 23, true, false),
            (false, 1, false, true, 0, nil, 23, true, false),
            (false, 1, false, true, 0, 24, 23, true, false),
            (false, 1, false, true, 0, 23, nil, true, false),
            (false, 1, false, true, 0, 23, 24, true, false),
            (false, 1, false, true, 0, 23, 23, false, false)
        ]
        for (hidden, count, minimized, onscreen, layer, window, responder, known, wanted) in eligibility {
            let facts = B2TargetClick.Eligibility(hidden: hidden, windowCount: count, minimized: minimized,
                onscreen: onscreen, layer: layer, focusedWindowID: window, responderWindowID: responder, responderRoleKnown: known)
            expect(facts.allows(23) == wanted, "hidden/minimized/Space/multiwindow/unknown-focus eligibility; no singleton exception")
        }
        let recipe = B2TargetClick.recipe(local: local)
        expect(recipe.count == 5, "fixed five events")
        expect(recipe.map { $0.type } == [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp], "fixed event order")
        expect(recipe.map { $0.phase } == [2, 1, 2, 3, 3] && recipe.map { $0.click } == [0, 1, 1, 1, 1], "OCU click/phase metadata")
        expect(recipe[1].local == CGPoint(x: -1, y: -1) && recipe[2].local == CGPoint(x: -1, y: -1), "OCU sentinel pair")
        // Every rejection is fed to the same guard reached before the first
        // focus record. No fake permission or fake app is ever created.
        for code in ["TARGET_UNPROVEN", "TARGET_CHANGED", "SECURE_INPUT", "LOCAL_USER_REQUIRED", "TASK_REVOKED", "COMPUTER_REQUEST_EXPIRED"] {
            var posts = 0
            do {
                _ = try await B2TargetClick.runRecipe(local: local, check: { throw ComputerControl.ControlFailure(code, "fixture") },
                    focus: { _ in posts += 1 }, post: { _, _ in posts += 1 }, wait: { _ in })
                expect(false, "guard must reject")
            } catch let failure as B2TargetClick.Failure {
                expect(posts == 0 && !failure.receipt.attempted, "\(code) is zero events")
                expect((failure.cause as? ComputerControl.ControlFailure)?.code == code, "guard failure retained")
            } catch { expect(false, "structured pre-dispatch failure") }
        }
        // Inject a change before every transport boundary, including after
        // the full recipe: stop immediately with no cleanup/replay channel.
        for failureAt in 1...14 {
            var guards = 0, focus: [Bool] = [], channels: [(Int, Bool)] = []
            do {
                _ = try await B2TargetClick.runRecipe(local: local, check: {
                    guards += 1
                    if guards == failureAt { throw ComputerControl.ControlFailure("TARGET_CHANGED", "fixture") }
                }, focus: { focus.append($0) }, post: { channels.append(($0, $1)) }, wait: { _ in })
                // There are 13 guard checks (begin + 10 channels + end + final).
                expect(failureAt == 14, "all earlier guard failures stop")
                expect(channels.count == 10 && focus == [true, false], "successful fixed recipe never adds channels")
            } catch let failure as B2TargetClick.Failure {
                expect(guards == failureAt, "no checks/cleanup after failed guard")
                expect(failure.receipt.targetChannels == channels.count && failure.receipt.focusRecords == focus.count, "partial receipt exact")
                expect(failure.receipt.attempted == (failureAt > 1), "post-dispatch cannot be treated as zero-event fallback")
                expect(channels.count <= 10 && focus.count <= 2, "fixed upper bounds after every rejection")
                let translated = B2TargetClick.controlFailure(failure)
                let details = translated.payload["details"] as! [String: Any]
                expect(translated.code == "TARGET_CHANGED" && details["do_not_replay"] as? Bool == (failureAt > 1), "actual production conversion preserves change code and uncertainty")
            } catch { expect(false, "structured partial failure") }
        }
        // A dispatch throwing gives no reliable non-delivery evidence. Count
        // it before calling it and never try the other channel/foreground.
        for failureAt in 1...12 {
            var dispatches = 0
            func dispatch() throws {
                dispatches += 1
                if dispatches == failureAt { throw ComputerControl.ControlFailure("COMPUTER_ACTION_UNCONFIRMED", "fixture") }
            }
            do {
                _ = try await B2TargetClick.runRecipe(local: local, check: {}, focus: { _ in try dispatch() },
                    post: { _, _ in try dispatch() }, wait: { _ in })
                expect(false, "every throwing dispatch stops")
            } catch let failure as B2TargetClick.Failure {
                expect(dispatches == failureAt && failure.receipt.attempted, "no retry after unknown focus/private/public transport")
                expect(failure.receipt.focusRecords + failure.receipt.targetChannels == dispatches, "including throwing dispatch in attempted receipt")
                expect(B2TargetClick.controlFailure(failure).uncertain, "throwing dispatch always becomes production no-replay receipt")
            } catch { expect(false, "structured transport failure") }
        }
        var channels: [(Int, Bool)] = [], focus: [Bool] = [], guards = 0
        let receipt = try! await B2TargetClick.runRecipe(local: local, check: { guards += 1 }, focus: { focus.append($0) },
            post: { channels.append(($0, $1)) }, wait: { _ in })
        expect(guards == 13 && receipt.targetChannels == 10 && receipt.focusRecords == 2, "every event channel and focus record guarded")
        expect(focus == [true, false], "target-only begin/end once")
        expect(channels.map { $0.0 } == [0, 0, 1, 1, 2, 2, 3, 3, 4, 4], "each fixed event uses two channels")
        expect(channels.map { $0.1 } == [true, false, true, false, true, false, true, false, true, false], "private then public is one policy")
        let posted = try! B2TargetClick.postedReceipt(receipt)
        expect(posted["method"] as? String == "background_target_click" &&
               posted["background"] as? Bool == true, "completed recipe has target-only background method")
        expect(posted["delivery_status"] as? String == "posted_unconfirmed" &&
               posted["delivery_unconfirmed"] as? Bool == true &&
               posted["do_not_replay"] as? Bool == true, "completed recipe is normal but not replayable")
        expect(posted["verified"] as? Bool == false && posted["completed"] as? Bool == false &&
               posted["automatic_retry"] as? Bool == false &&
               posted["next_action"] as? String == "computer_screenshot", "completed recipe never claims target consumption")
        expect(posted["attempted_target_channels"] as? Int == 10 &&
               posted["target_focus_records"] as? Int == 2, "normal receipt requires complete recipe counters")
        var partial = B2TargetClick.Receipt()
        partial.focusRecords = 1
        partial.targetChannels = 9
        do {
            _ = try B2TargetClick.postedReceipt(partial)
            expect(false, "partial recipe cannot produce a normal result")
        } catch let failure as ComputerControl.ControlFailure {
            expect(failure.uncertain && failure.code == "COMPUTER_ACTION_UNCONFIRMED", "partial recipe retains an uncertain error")
        } catch { expect(false, "partial recipe throws only a structured failure") }
        var stoppedCalls = 0
        let stopped = try! await ComputerControl.runBatch([["step_id":"one"],["step_id":"two"],["step_id":"three"]]) { _ in
            stoppedCalls += 1
            return posted
        }
        let stoppedSteps = stopped["receipts"] as! [[String:Any]]
        expect(stoppedCalls == 1 && stopped["completed"] as? Bool == false &&
               stopped["remaining_steps"] as? Int == 2, "normal unconfirmed B2 stops a batch after one step")
        expect(stoppedSteps.count == 3 && stoppedSteps[0]["status"] as? String == "posted_unconfirmed" &&
               stoppedSteps[1]["status"] as? String == "not_attempted" &&
               stoppedSteps[2]["status"] as? String == "not_attempted", "no later B2 batch steps are dispatched")
        expect(stopped["stop_reason"] as? String == "posted_unconfirmed" &&
               stopped["next_action"] as? String == "computer_screenshot" &&
               stopped["do_not_replay"] as? Bool == true, "batch preserves no-replay and read-only guidance")
        let broken = try! await ComputerControl.runBatch([["step_id":"one"],["step_id":"two"]]) { _ in
            return ["method":"background_target_click","delivery_status":"verified"]
        }
        let brokenSteps = broken["receipts"] as! [[String:Any]]
        expect(broken["completed"] as? Bool == false && brokenSteps[0]["status"] as? String == "failed_or_unconfirmed" &&
               brokenSteps[1]["status"] as? String == "not_attempted", "malformed normal B2 receipt fails closed")
        let malformedError = broken["error"] as? [String:Any]
        let malformedDetails = malformedError?["details"] as? [String:Any]
        expect(malformedError?["code"] as? String == "COMPUTER_ACTION_UNCONFIRMED" &&
               malformedDetails?["delivery_unconfirmed"] as? Bool == true &&
               malformedDetails?["do_not_replay"] as? Bool == true &&
               malformedDetails?["batch_stopped"] as? Bool == true &&
               malformedDetails?["remaining_steps"] as? Int == 1,
               "malformed B2 returns an error, not an apparently normal RPC")
        let missingMethod = try! await ComputerControl.runBatch([["step_id":"one"],["step_id":"two"]]) { _ in
            return ["delivery_status":"posted_unconfirmed","completed":false]
        }
        let missingError = missingMethod["error"] as? [String:Any]
        let missingDetails = missingError?["details"] as? [String:Any]
        expect(missingError?["code"] as? String == "COMPUTER_ACTION_UNCONFIRMED" &&
               missingDetails?["do_not_replay"] as? Bool == true &&
               missingMethod["remaining_steps"] as? Int == 1,
               "B2-like receipt missing method fails closed and stops successors")
        var axCalls = 0
        let axBatch = try! await ComputerControl.runBatch([["step_id":"one"],["step_id":"two"]]) { _ in
            axCalls += 1
            return ["method":"accessibility_press","performed":"click"]
        }
        expect(axCalls == 2 && axBatch["completed"] as? Bool == true, "verified AX branches retain ordinary batch semantics")
        // Astra R1: full target dispatch was already attempted when a later
        // readback or task/epoch guard fails. These injections send ZERO events.
        let steps: [[String:Any]] = [["step_id":"first"],["step_id":"second"],["step_id":"third"]]
        for (reason, failInRead) in [("COMPUTER_WINDOW_STALE",true),("COMPUTER_REQUEST_EXPIRED",false)] {
            var postCalls = 0, readCalls = 0, checkCalls = 0
            let failedBatch = try! await ComputerControl.runBatch(steps) { step in
                try await ComputerControl.postStepReadback(step,
                    perform: { _ in postCalls += 1; return posted },
                    observe: { _ in
                        readCalls += 1
                        if failInRead { throw ComputerControl.ControlFailure(reason,"isolated failure",uncertain:false) }
                        return ["native_snapshot_id":"fixture-readback"]
                    },
                    check: {
                        checkCalls += 1
                        if !failInRead { throw ComputerControl.ControlFailure(reason,"isolated late authorization",uncertain:false) }
                    })
            }
            let b = failedBatch["receipts"] as! [[String:Any]]
            let err = failedBatch["error"] as! [String:Any]
            let e = err["details"] as! [String:Any]
            expect(postCalls == 1 && readCalls == 1 && checkCalls == (failInRead ? 0 : 1),
                   "B2 late failure does not attempt a second step")
            expect(failedBatch["completed"] as? Bool == false && failedBatch["remaining_steps"] as? Int == 2,
                   "B2 late failure has two not-attempted successors")
            expect(b.count == 3 && b[0]["status"] as? String == "failed_or_unconfirmed" &&
                   b[1]["status"] as? String == "not_attempted" &&
                   b[2]["status"] as? String == "not_attempted", "B2 late failure receipts preserve stop")
            expect(err["code"] as? String == reason && e["delivery_unconfirmed"] as? Bool == true &&
                   e["do_not_replay"] as? Bool == true &&
                   e["delivery_status"] as? String == "posted_unconfirmed" &&
                   e["batch_stopped"] as? Bool == true &&
                   e["remaining_steps"] as? Int == 2,
                   "B2 late original guard code is an error and not replayable")
            expect(e["method"] as? String == "background_target_click" &&
                   e["background"] as? Bool == true &&
                   e["attempted_target_channels"] as? Int == 10 &&
                   e["target_focus_records"] as? Int == 2,
                   "B2 late failure carries fixed dispatch provenance")
        }
        // Do not silently alter the existing AX batch readback contract.
        let axReadFail = try! await ComputerControl.runBatch(steps) { step in
            try await ComputerControl.postStepReadback(step,
                perform: { _ in ["method":"accessibility_press","performed":"click"] },
                observe: { _ in throw ComputerControl.ControlFailure("COMPUTER_WINDOW_STALE","isolated",uncertain:false) },
                check: {})
        }
        let axReadError = axReadFail["failure"] as! [String:Any]
        let axReadDetails = axReadError["details"] as! [String:Any]
        expect(axReadError["code"] as? String == "COMPUTER_ACTION_UNCONFIRMED" &&
               axReadDetails["do_not_replay"] as? Bool == true &&
               axReadFail["error"] == nil, "old AX batch unknown stays uncertain without new B2 RPC branch")
        let failure = ComputerControl.ControlFailure("TARGET_CHANGED", "已发出，未确认", uncertain: true,
            details: ["method": "background_target_click", "background": true, "attempted_target_channels": 3])
        let details = failure.payload["details"] as! [String: Any]
        expect(details["delivery_unconfirmed"] as? Bool == true && details["do_not_replay"] as? Bool == true, "unconfirmed no-replay receipt")
        expect(details["method"] as? String == "background_target_click" && details["background"] as? Bool == true, "observable native route")
        expect(!ComputerControl.inputAllowedForBundle("com.kenyu.chathand", selfBundleID: nil), "self exclusion")
        expect(ComputerControl.sensitiveName("Password") && ComputerControl.sensitiveName("密码"), "password rejection")
        print("PASS \(checks) isolated B2 click checks; zero real events, AX reads or permission prompts")
    }
}
