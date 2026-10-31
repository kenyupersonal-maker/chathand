@main struct Checks {
    static var checks = 0
    static func expect(_ condition: Bool, _ label: String) { precondition(condition,label); checks += 1 }
    static func window(_ id: UInt32) -> FixtureAX {
        let w=FixtureAX();w.number=id;w.sheetResult = .attributeUnsupported;w.sheetValue=nil;w.childrenResult = .success
        return w
    }
    static func complete() -> FixtureAX {
        let w=window(11),group=FixtureAX("AXGroup"),address=FixtureAX("AXTextField","Address and search bar"),page=FixtureAX("AXWebArea")
        address.value="chrome://version/";page.url="chrome://version/"
        for (label,value) in [("Google Chrome:","155.0.8059.85"),("Profile Path:","/fixture/Library/Application Support/Google/Chrome/Profile 4")] {
            let field=FixtureAX("AXGroup",label),text=FixtureAX("AXStaticText");text.value=value;field.children=[text];page.children.append(field)
        }
        group.children=[address,page];group.parentResult = .success;group.parentValue=w;w.children=[group];return w
    }
    static func proof(_ window: FixtureAX, attempt: UUID = UUID(), pid: Int32 = 1, epoch: TimeInterval = 100, time: TimeInterval = 100) -> ChromeInstallDiscoveryProof {
        ChromeInstallDiscoveryProof(attempt:attempt,observedAt:time,anchors:[.init(pid:pid,epoch:epoch,windowID:window.number!,reference:window,profileID:"Profile 4")])
    }
    static func stop(_ windows: [FixtureAX], proof: ChromeInstallDiscoveryProof?, relation: ChromeInstallWindowRelation, terminal: ChromeInstallCode? = nil) -> Reader {
        fixtureApp.children=windows
        let f=Reader();f.diagnosingPreflight=true;f.discoveryProof=proof
        do { let count=try f.inventory();expect(terminal == nil && count == windows.count,"all identities retained without declaring unknown window clear") }
        catch { expect(terminal == error as? ChromeInstallCode && terminal != nil,"deadline/identity/permission stops remain authoritative") }
        let row=f.windowDiagnostics.first { $0.sheets == .unknown }!
        expect(row.detail?.code == .sheetsAXError && row.detail?.axError == -25205 && row.detail?.fallbackCode == .childrenEmpty,"original empty fallback receipt retained in UNKNOWN row")
        expect(row.context.relation == relation,"finite expected window relation")
        return f
    }
    static func main() throws {
        let full=complete(),empty=window(22),attempt=UUID()
        fixtureApp.children=[full,empty]
        var discovered:ChromeInstallDiscoveryProof?
        let ids=try Decoder.observedProfiles(runtime:URL(fileURLWithPath:"/fixture/runtime"),deadline:110,attempt:attempt,proof:{discovered=$0})
        expect(ids == ["Profile 4"],"actual version discovery succeeds beside empty window")
        expect(discovered?.anchors.count == 1 && discovered?.anchors.first?.reference === full,"only actually proven window retained")
        let selected=discovered?.selected("Profile 4",attempt:attempt,now:100)
        expect(selected != nil,"same attempt selects exact proved profile")
        expect(discovered?.selected("Default",attempt:attempt,now:100) == nil,"unproved selected profile has no anchor")
        expect(discovered?.selected("Profile 4",attempt:UUID(),now:100) == nil,"new attempt cannot reuse proof")
        expect(discovered?.selected("Profile 4",attempt:attempt,now:116) == nil,"expired proof cannot be selected")
        expect(discovered?.selected("Profile 4",attempt:attempt,now:99) == nil,"backwards time cannot authorize proof")
        _=stop([full,empty],proof:selected,relation:.other)
        _=stop([empty,full],proof:selected,relation:.other)
        _=stop([empty],proof:proof(empty),relation:.same)
        _=stop([empty],proof:nil,relation:.anchorMissing)
        let expired=stop([empty],proof:proof(empty,time:80),relation:.anchorMissing)
        expect(expired.discoveryProof == nil,"expired raw proof cleared after attribution")
        let changedEpoch=stop([empty],proof:proof(empty,epoch:99),relation:.processChanged)
        expect(changedEpoch.discoveryProof == nil,"changed process raw proof discarded without reuse")
        _=stop([empty],proof:proof(empty,pid:2),relation:.processChanged)
        let alias=window(22)
        _=stop([empty],proof:proof(alias),relation:.unknown)
        let wrongID=proof(empty);empty.number=23
        _=stop([empty],proof:wrongID,relation:.unknown);empty.number=22
        empty.metadataValues=["AXMinimized":true as NSNumber,"AXMain":false as NSNumber,"AXFocused":true as NSNumber,"AXSubrole":"AXStandardWindow" as NSString]
        let initial=reads,typed=stop([empty],proof:selected,relation:.other)
        let context=typed.windowDiagnostics.first!.context
        expect(context.minimized == true && context.main == false && context.focused == true,"successful strict Boolean attributes retained")
        expect(context.appActive == false && context.appHidden == false && context.subrole == .standard,"app state and finite subrole")
        expect(reads-initial == 9,"exact existing five reads plus four optional reads")
        empty.metadataValues=["AXMinimized":1 as NSNumber,"AXMain":"private text" as NSString,"AXSubrole":"PRIVATE_SUBROLE" as NSString]
        let unknown=stop([empty],proof:selected,relation:.other).windowDiagnostics.first!.context
        expect(unknown.minimized == nil && unknown.main == nil && unknown.focused == nil && unknown.subrole == .unknown,"unreadable or foreign state stays unknown, never false")
        empty.metadataResult = .cannotComplete
        let failed=stop([empty],proof:selected,relation:.other)
        expect(failed.windowDiagnostics.first?.context.minimized == nil,"optional attribute error keeps primary stop")
        empty.metadataResult = .success
        var metadataReads=0
        fixtureReadHook={ _,name in if ["AXMinimized","AXMain","AXFocused","AXSubrole"].contains(name) {metadataReads += 1;DiagnosticClock.now=102} }
        let exhausted=stop([empty],proof:selected,relation:.other,terminal:.sheet)
        expect(metadataReads == 1 && exhausted.windowDiagnostics.first?.context.minimized == nil,"all optional reads share original fallback deadline")
        fixtureReadHook=nil;DiagnosticClock.now=100
        var readsAfterChange=0
        fixtureReadHook={_,name in if name == "AXMinimized" {var changed=NSRunningApplication();changed.launchDate=Date(timeIntervalSince1970:101);NSWorkspace.shared.runningApplications=[changed]} else if ["AXMain","AXFocused","AXSubrole"].contains(name) {readsAfterChange += 1} }
        _=stop([empty],proof:selected,relation:.processChanged,terminal:.target)
        expect(readsAfterChange == 0,"process change stops optional AX reads")
        fixtureReadHook=nil;NSWorkspace.shared.runningApplications=[NSRunningApplication()]
        var permissionReads=0
        fixtureReadHook={_,name in if name == "AXMinimized" {fixtureTrusted=false;permissionReads += 1} }
        let permission=stop([empty],proof:selected,relation:.other,terminal:.permission)
        expect(permissionReads == 1 && permission.windowDiagnostics.first?.context.minimized == nil,"permission change cannot turn optional failure into false")
        fixtureReadHook=nil;fixtureTrusted=true
        let sheet=FixtureAX("AXSheet");sheet.parentResult = .success;sheet.parentValue=full;full.children.append(sheet);fixtureApp.children=[full]
        let blocked=Reader();blocked.diagnosingPreflight=true;blocked.discoveryProof=selected
        do {_ = try blocked.inventory();preconditionFailure("real sheet must stop")} catch {expect(error as? ChromeInstallCode == .sheet,"real sheet original stop")}
        expect(blocked.failureDetail?.code == .sheetsPresent && blocked.failureDetail?.windowContext == nil,"real sheet never receives empty context or disappears")
        let slot=ChromeInstallDiscoveryProofSlot();slot.store(proof(empty));slot.clear();slot.store(proof(full));expect(slot.take() == nil,"cancelled slot ignores late worker")
        let once=ChromeInstallDiscoveryProofSlot();once.store(proof(empty));expect(once.take() != nil && once.take() == nil,"proof consumed only once")
        once.store(proof(full));expect(once.take() == nil,"consumed slot stays closed")
        print("PASS: \(checks) window attribution checks; actual production extracts; no live AX")
    }
}
