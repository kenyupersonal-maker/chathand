@main struct Checks {
    static var count=0
    static func expect(_ condition:Bool,_ label:String){precondition(condition,label);count += 1}
    static func window(_ id:UInt32,ready:Bool)->FixtureAX {
        let w=FixtureAX();w.number=id;w.sheetResult = .attributeUnsupported;w.sheetValue=nil;w.childrenResult = .success
        if ready {makeReady(w)};return w
    }
    static func makeReady(_ w:FixtureAX){let group=FixtureAX("AXGroup");group.parentResult = .success;group.parentValue=w;w.children=[group]}
    static func fresh(_ windows:[FixtureAX],baseline:Set<UInt32>=[11,22])->Reader {
        PolicyClock.now=100;fixtureTrusted=true;fixtureReadHook=nil;fixtureTimeoutHook=nil;fixtureInfoHook=nil
        fixtureWindowInfo=["bounds":["value":1]];NSWorkspace.shared.runningApplications=[NSRunningApplication()]
        fixtureApp.children=windows;fixtureApp.windowsResult = .success;fixtureApp.overrideWindows=false
        let f=Reader();f.baselineIDs=baseline;f.baselinePID=1;f.baselineLaunch=Date(timeIntervalSince1970:100);f.observationBudget(until:110);return f
    }
    static func unbound(_ f:Reader){expect(f.chrome == nil && f.launch == nil && f.window == nil && f.windowID == nil && f.frame == nil,"no partial target binding escapes failed or pending reads")}
    static func fails(_ f:Reader,_ code:ChromeInstallCode,_ difference:ChromeInstallWindowDifference?=nil){
        do{_ = try f.poll();preconditionFailure("invalid candidate accepted")}catch{expect(error as? ChromeInstallCode == code,"exact failure remains fail-closed")}
        if let difference {expect(f.identityDifference == difference,"finite difference classification")};unbound(f)
    }
    static func main() throws {
        let full=window(11,ready:true),empty=window(22,ready:false),target=window(33,ready:false)
        for windows in [[full,empty,target],[target,empty,full]] {
            let f=fresh(windows)
            expect(try f.poll() == nil,"empty candidate yields asynchronously without binding")
            unbound(f)
            expect(f.windowDiagnosticsComplete && f.windowDiagnosticsExpectedCount == 3 && f.windowDiagnostics.count == 3,"all finite window rows retained within shared budget")
            expect(f.windowDiagnostics.filter{$0.sheets == .unknown}.count == 2 && f.windowDiagnostics.filter{$0.sheets == .clear}.count == 1,"unknown baseline and target never become CLEAR")
            expect(f.windowDiagnostics.map{$0.ordinal} == [1,2,3],"finite ordinal uses inventory order")
            makeReady(target)
            if case .runningChrome? = try f.poll(){count += 1}else{preconditionFailure("ready candidate did not bind")}
            expect(f.chrome?.processIdentifier == 1 && f.launch == Date(timeIntervalSince1970:100) && f.window === target && f.windowID == 33 && f.frame == CGRect(value:1),"all five binding fields commit together after strict evidence")
            try f.verifyIdentity();count += 1
            target.children=[]
        }
        makeReady(target)
        let becameEmpty=fresh([full,empty,target]);var targetReads=0
        fixtureReadHook={node,name in if node === target && name == "AXChildren" {targetReads += 1;if targetReads == 3 {target.children=[]}}}
        expect(try becameEmpty.poll() == nil,"CLEAR inventory becoming EMPTY on strict target re-read yields nil")
        unbound(becameEmpty);expect(becameEmpty.windowDiagnostics.last?.sheets == .unknown,"latest strict empty result updates target row to UNKNOWN")
        let recovered=fresh([full,empty,target])
        fixtureReadHook={node,name in if node === target && name == "AXMinimized" {makeReady(target)}}
        if case .runningChrome? = try recovered.poll(){count += 1}else{preconditionFailure("strictly recovered candidate did not bind")}
        expect(recovered.windowDiagnostics.last?.sheets == .clear,"only successful strict recovery updates target row CLEAR")
        let appeared=fresh([full,empty,target]);targetReads=0
        fixtureReadHook={node,name in if node === target && name == "AXChildren" {targetReads += 1;if targetReads == 3 {let s=FixtureAX("AXSheet");s.parentResult = .success;s.parentValue=target;target.children.append(s)}}}
        fails(appeared,.sheet);expect(appeared.failureDetail?.code == .sheetsPresent && appeared.windowDiagnostics.last?.sheets == .present,"real sheet appearing on strict re-read updates PRESENT and keeps original stop")
        fixtureReadHook=nil;target.children=[]
        let pending=fresh([full,empty,target]);expect(try pending.poll() == nil,"first persistent-empty sample")
        PolicyClock.now=101;expect(try pending.poll() == nil,"second persistent-empty sample remains nil")
        pending.observationBudget(until:200);expect(pending.runningChromeDeadline == 110,"later polls cannot renew original deadline")
        PolicyClock.now=110;let before=reads;fails(pending,.timeout);expect(reads == before,"expired stage performs no AX reads")
        let canceled=fresh([full,empty,target]);expect(try canceled.poll() == nil,"candidate exists before interruption");canceled.interrupted=true
        let beforeCancel=reads;fails(canceled,.interrupted);expect(reads == beforeCancel,"cancellation prevents all further observation")
        let changed=fresh([full,empty,target]);expect(try changed.poll() == nil,"candidate exists before epoch change")
        var replacement=NSRunningApplication();replacement.launchDate=Date(timeIntervalSince1970:101);NSWorkspace.shared.runningApplications=[replacement]
        fails(changed,.target,.processChanged)
        let pid=fresh([full,empty,target]);expect(try pid.poll() == nil,"candidate exists before PID change")
        replacement=NSRunningApplication();replacement.processIdentifier=2;NSWorkspace.shared.runningApplications=[replacement];fails(pid,.target,.processChanged)
        let swapped=fresh([full,empty,target]);expect(try swapped.poll() == nil,"candidate ref anchored before replacement")
        fixtureApp.children=[full,empty,window(33,ready:true)];fails(swapped,.target,.candidateChanged)
        let changedID=fresh([full,empty,target]);expect(try changedID.poll() == nil,"candidate ID anchored before change")
        target.number=34;fails(changedID,.target,.candidateChanged);target.number=33
        let double=fresh([full,empty,window(33,ready:true),window(44,ready:true)]);fails(double,.target,.unexpectedWindow)
        let missing=fresh([full,target]);fails(missing,.target,.baselineMissing)
        let duplicate=fresh([full,empty,window(22,ready:true)]);fails(duplicate,.target)
        makeReady(target)
        let frame=fresh([full,empty,target]);fixtureWindowInfo=["bounds":["value":9]];fails(frame,.target,.frameMismatch)
        let finalCancel=fresh([full,empty,target]);fixtureInfoHook={finalCancel.interrupted=true};fails(finalCancel,.interrupted)
        let finalRef=fresh([full,empty,target]);fixtureInfoHook={fixtureApp.children=[full,empty,window(33,ready:true)]};fails(finalRef,.target,.candidateChanged)
        let sheet=FixtureAX("AXSheet");sheet.parentResult = .success;sheet.parentValue=full;full.children.append(sheet)
        for windows in [[empty,full,target],[full,empty,target]] {
            let f=fresh(windows);fails(f,.sheet);expect(f.failureDetail?.code == .sheetsPresent,"real sheet wins over unrelated UNKNOWN empty")
            expect(f.windowDiagnosticsComplete && f.windowDiagnostics.contains{$0.sheets == .present} && f.windowDiagnostics.contains{$0.sheets == .unknown},"present sheet and unknown windows are both collected")
        }
        full.children.removeLast()
        for error in [AXError.cannotComplete,.apiDisabled,.failure] {
            let f=fresh([full,empty,target]);empty.sheetResult=error;fails(f,.sheet);expect(f.windowDiagnostics.first{$0.code != nil}?.sheets == .unknown,"other AX errors remain UNKNOWN and fatal");empty.sheetResult = .attributeUnsupported
        }
        let zero=window(0,ready:true);let invalidID=fresh([full,empty,zero]);fails(invalidID,.sheet,.identityInvalid)
        let oversized=fresh([full,empty,target]);fixtureApp.overrideWindows=true;fixtureApp.windowsValue=NSArray(array:(0...100).map{_ in "private-non-AX"})
        fails(oversized,.target,.identityInvalid);expect(oversized.failureDetail?.code == .windowsTooMany,"window count cap precedes element interpretation")
        let incomplete=fresh([full,empty,target]);fixtureReadHook={_,name in if name == "AXMinimized" {PolicyClock.now=102} }
        fails(incomplete,.sheet);expect(!incomplete.windowDiagnosticsComplete && incomplete.windowDiagnostics.count < incomplete.windowDiagnosticsExpectedCount,"shared budget reports incomplete count honestly")
        fixtureReadHook=nil
        let allowed:Set<String>=["ordinal","sheets","window_relation","empty_window_minimized","empty_window_main","empty_window_focused","app_active","app_hidden","window_subrole","code","detail_code","ax_error","fallback_code"]
        expect(incomplete.windowDiagnostics.allSatisfy{Set($0.metadata.keys).isSubset(of:allowed)},"finite rows never contain raw IDs, refs, titles, URL or profile paths")
        expect(fixtureContentReads == 0,"no page content traversal occurs before binding or during target readiness")
        print("PASS: \(count) window policy checks; actual inventory/capture/poll/identity extracts; no GUI or input")
    }
}
