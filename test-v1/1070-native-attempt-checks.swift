import Foundation

// All desktop, permission, input, installer and HTTP boundaries are synthetic.
// The test runner inserts the actual extensionSetup/extensionRepair switch entry.
private let backendIntegration = CommandLine.arguments.contains("--backend-integration")
private func backendRPC(_ route:String,_ body:[String:Any]) -> [String:Any] {
    let message:[String:Any] = ["route":route,"body":body,"clock_ms":Int(TestQueue.now()*1000)]
    let bytes=try! JSONSerialization.data(withJSONObject:message)
    FileHandle.standardOutput.write(bytes+Data("\n".utf8))
    guard let line=readLine(),let data=line.data(using:.utf8),let result=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {fatalError("RPC reply missing")}
    return result
}
private var trusted = true
func AXIsProcessTrusted() -> Bool { trusted }
enum ChromeInstallCode: String, Error { case sheet = "CHROME_INSTALL_SHEET_UNKNOWN", target = "CHROME_INSTALL_TARGET_UNKNOWN", busy = "CHROME_INSTALL_BUSY", cancelled = "CHROME_INSTALL_CANCELLED", accessibilityTimeout = "CHROME_INSTALL_ACCESSIBILITY_TIMEOUT" }
// ACTUAL_DIAGNOSTIC_TYPES
enum ChromeInstallLease {
    static func validProfile(_ id: String) -> Bool { id == "Default" || id.range(of: "^Profile [0-9]{1,6}$", options: .regularExpression) != nil }
}
final class TestProcessInfo {
    static let processInfo = TestProcessInfo()
    var systemUptime: TimeInterval = 0
    let processIdentifier: Int32 = 123
}
final class TestQueue {
    static let main = TestQueue()
    var jobs: [(TimeInterval, () -> Void)] = []
    func asyncAfter(deadline: TimeInterval, execute: @escaping () -> Void) { jobs.append((deadline, execute)) }
    static func now() -> TimeInterval { TestProcessInfo.processInfo.systemUptime }
    func advance(_ time: TimeInterval) {
        while let index = jobs.indices.filter({ jobs[$0].0 <= time }).min(by: { jobs[$0].0 < jobs[$1].0 }) {
            let job = jobs.remove(at: index); TestProcessInfo.processInfo.systemUptime = job.0; job.1()
        }
        TestProcessInfo.processInfo.systemUptime = time
    }
}
// Enables the original .now()+delay syntax without DispatchQueue.
extension TimeInterval { static func now() -> TimeInterval { TestQueue.now() } }
struct Input { let timestamp: TimeInterval }
final class FakeApplication {
    let processIdentifier: Int32 = 123
    func activate(ignoringOtherApps: Bool) {}
}
let NSApp = FakeApplication()
final class NSWorkspace {
    static let shared = NSWorkspace()
    var frontmostApplication: FakeApplication? = FakeApplication()
}
struct NSEvent {
    struct EventTypeMask: OptionSet {
        let rawValue: Int
        static let keyDown = Self(rawValue: 1), leftMouseDown = Self(rawValue: 2), rightMouseDown = Self(rawValue: 4), otherMouseDown = Self(rawValue: 8), mouseMoved = Self(rawValue: 16), scrollWheel = Self(rawValue: 32), leftMouseDragged = Self(rawValue: 64), rightMouseDragged = Self(rawValue: 128), otherMouseDragged = Self(rawValue: 256)
    }
    static var callbacks: [UUID: () -> Void] = [:]
    static func removeMonitor(_ token: Any) { callbacks.removeValue(forKey: token as! UUID) }
    static func addGlobalMonitorForEvents(matching: EventTypeMask, handler: @escaping (NSEvent) -> Void) -> Any? {
        let id = UUID(); callbacks[id] = { handler(NSEvent()) }; return id
    }
    static func addLocalMonitorForEvents(matching: EventTypeMask, handler: @escaping (NSEvent) -> NSEvent?) -> Any? {
        let id = UUID(); callbacks[id] = { _ = handler(NSEvent()) }; return id
    }
}
final class FakePermissionAssistant {
    var onboardingBegin: ((String) -> ((String,String)->Void))?
    var requests = 0, closes = 0
    var accessibilityOnly = false
    func requestAccessibilityOnly() -> [String:Any] { requests += 1; accessibilityOnly=true; return [:] }
    func finishAccessibilityOnly(granted: Bool) { if accessibilityOnly { closes += 1; accessibilityOnly=false } }
}
final class FakeInstaller {
    var active = false, starts = 0
    var completion: (([String:Any])->Void)?
    var leaseID:String?
    var repairs:[Bool]=[]
    func start(profileID: String, repair: Bool, completion: @escaping ([String:Any])->Void) { starts += 1; repairs.append(repair); self.completion = completion
        if backendIntegration {
            let result=backendRPC("start",["profile_id":profileID]);leaseID=result["lease_id"] as? String;active=leaseID != nil
            completion(active ? ["started":true]:result)
        }
    }
    func cancel() {
        if backendIntegration,active,let leaseID { _=backendRPC("cancel",["lease_id":leaseID]) }
        active=false;leaseID=nil
    }
}
final class FakeDiscovery { func cancel() {} }
final class FakeDataAccessResume { var cancellations=0;func cancel() { cancellations += 1 } }
final class AppDelegate {
    var ownsService = true, interfaceKeyShared = true, shuttingDown = false, human = true
    var chromeDiscoveryProof: ChromeInstallDiscoveryProof?, chromePreflightProof: ChromeInstallDiscoveryProof?
    var chromeDiscoveryProofSlot: ChromeInstallDiscoveryProofSlot?
    var chromeInstallPreparation: UUID?
    var chromeSettingsGeneration: UUID?
    let chromeDataAccessResume=FakeDataAccessResume()
    var chromeInstallPreparationCancel: (() -> Void)?
    var chromeInstallContinuation: ((@escaping ([String:Any])->Void)->Void)?
    var lastWindowInput: Input? = Input(timestamp: 0)
    var lastChromeInstallProfile: String?
    let permissionAssistant = FakePermissionAssistant(), chromeHelperInstaller = FakeInstaller(), chromeProfileDiscovery = FakeDiscovery()
    lazy var chromeAccessibilityWait = ChromeAccessibilityWait(now: { TestQueue.now() }, schedule: { delay, work in TestQueue.main.asyncAfter(deadline: .now()+delay, execute: work) }, trusted: { trusted })
    var discovery: (([String:Any])->Void)?
    var discoveryCalls = 0
    var permissionAllowed = true, holdPermission = false
    struct Request { let body: [String:Any]; let reply: ([String:Any])->Void }
    var requests: [Request] = [], replies: [[String:Any]] = []
    var progress: [[String:Any]] { requests.map(\.body).filter { $0["native_event"] != nil } }
    func api(_ route: String, _ body: [String:Any], completion: @escaping ([String:Any])->Void) {
        if backendIntegration {requests.append(Request(body:body,reply:completion));completion(backendRPC(route,body));return}
        // AX-ready scenarios approve the read-free gate synchronously; waiting
        // scenarios hold it explicitly so tests can reject or race the reply.
        if body["discovery_only"] as? Bool == true, trusted, !holdPermission { completion(["observe_allowed":permissionAllowed]);return }
        requests.append(Request(body: body, reply: completion))
    }
    func confirmationInput(via: String) -> [String:Any] { ["human":human] }
    func notifyComputerPermissions(_ result: [String:Any]) {}
    func onboardingBegin(_ step: String) -> (String,String)->Void { { _,_ in } }
    func observeChromeProfiles(preparation: UUID, completion: @escaping ([String:Any])->Void) { discoveryCalls += 1; discovery = completion
        if backendIntegration {completion(["ids":["Default","Profile 1"]])}
    }
    func click(_ action: String = "extensionSetup", _ data: [String:Any] = [:]) {
        let done: ([String:Any])->Void = { self.replies.append($0) }
        let repairExtension = action == "extensionRepair"
        switch repairExtension ? "extensionSetup" : action {
// ACTUAL_NATIVE_ENTRY
        default: fatalError("unexpected action")
        }
    }
    // ACTUAL_PREPARATION_CANCEL
    func cancel() { cancelChromePreparation() }
    func performLifecycleCleanup(_ kind: Int) {
        switch kind {
        case 0: // ACTUAL_STOP_CLEANUP
        case 1: // ACTUAL_BACKEND_CLEANUP
        default: // ACTUAL_RECOVERY_ERROR_CLEANUP
        }
    }
    func discover(_ ids: [String] = ["Default", "Profile 1"]) {
        discovery?(["ids":ids]); requests.last!.reply(["profiles":ids.map { ["id":$0,"name":$0] },"selected_profile":""])
    }
}
private func reset() { trusted = true; TestProcessInfo.processInfo.systemUptime = 0; TestQueue.main.jobs = []; NSEvent.callbacks = [:]; NSWorkspace.shared.frontmostApplication = FakeApplication() }
private func expect(_ condition: Bool, _ label: String) { precondition(condition, label) }
private func event(_ app: AppDelegate, _ name: String) -> Int { app.progress.filter { $0["native_event"] as? String == name }.count }
@main struct Checks {
    static func main() {
        if backendIntegration {
            reset();let app=AppDelegate();app.click()
            let choice=backendRPC("status",[:])
            let multiProfile=choice["choose_profile"] as? Bool == true && (choice["profiles"] as? [[String:Any]])?.count == 2 && app.replies.count == 1 && app.replies[0]["started"] as? Bool == true
            let setupBridge=app.replies[0]
            let firstID=choice["attempt_id"] as? String
            app.click("extensionRepair",["profile_id":"Profile 1"])
            let loading=backendRPC("status",[:])
            let repair=app.chromeHelperInstaller.active && app.chromeHelperInstaller.repairs == [true] && loading["active"] as? Bool == true
            let freshID=(loading["attempt_id"] as? String) != firstID
            let firstFollowup=app.replies.last!
            app.performLifecycleCleanup(0)
            let canceled=backendRPC("status",[:])["active"] as? Bool == false
            trusted=false;app.click("extensionSetup",["wait_for_accessibility":true])
            let waiting=backendRPC("status",[:])["phase"] as? String == "waiting_accessibility" && app.permissionAssistant.accessibilityOnly
            let before=app.discoveryCalls;app.performLifecycleCleanup(1)
            trusted=true;TestQueue.main.advance(200)
            let stopped=backendRPC("status",[:])["active"] as? Bool == false && app.discoveryCalls == before && !app.chromeAccessibilityWait.active
            app.lastWindowInput=Input(timestamp:200);app.click("extensionSetup",["profile_id":"Default"])
            let retry=app.chromeHelperInstaller.active && backendRPC("status",[:])["active"] as? Bool == true
            app.performLifecycleCleanup(0);trusted=false
            app.click("extensionRepair",["wait_for_accessibility":true])
            let waitingBridge=app.replies.last!
            trusted=true;TestQueue.main.advance(201);TestQueue.main.advance(201.1)
            let waitingChoice=backendRPC("status",[:])
            app.click("extensionRepair",["profile_id":"Profile 1","wait_for_accessibility":true])
            let waitingFollowup=app.replies.last!
            let uiCases:[[String:Any]]=[
                ["bridge":setupBridge,"status":choice,"followup":firstFollowup,"repair":false,"wait":false],
                ["bridge":waitingBridge,"status":waitingChoice,"followup":waitingFollowup,"repair":true,"wait":true]
            ]
            let receipt:[String:Any]=["ui_cases":uiCases,"receipt":[
"multiProfile":multiProfile,"repair":repair,"freshID":freshID,"canceled":canceled,"waiting":waiting,"stopped":stopped,"retry":retry]]
            FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject:receipt)+Data("\n".utf8));return
        }
        // Local rejected preflight never creates an attempt or a started event.
        for reject in 0..<6 {
            reset(); let app = AppDelegate(); var data: [String:Any] = [:]
            switch reject {
            case 0: app.human = false
            case 1: app.ownsService = false
            case 2: NSWorkspace.shared.frontmostApplication = nil
            case 3: app.chromeHelperInstaller.active = true
            case 4: data["profile_id"] = "../../outside"
            default: data["profile_id"] = 42
            }
            app.click("extensionSetup", data)
            expect(app.replies.count == 1 && event(app,"started") == 0 && app.discoveryCalls == 0, "preflight creates no attempt")
        }
        reset()
        do {
            let app = AppDelegate(); app.click()
            expect(app.replies.count == 1 && app.replies[0]["started"] as? Bool == true && event(app,"started") == 1, "AX-ready immediate acknowledgement")
            let start = app.requests[0]; expect(app.discoveryCalls == 0, "discovery waits for backend acceptance")
            start.reply(["recorded":true]); expect(app.discoveryCalls == 1, "accepted start unlocks discovery")
            app.discover(); expect(event(app,"choose_profile") == 1 && app.replies.count == 1, "choice delivered only by status")
            let oldID = app.progress[0]["attempt_id"] as! String
            app.requests.last!.reply(["accepted":true])
            app.click("extensionRepair", ["profile_id":"Profile 1"])
            let newStart = app.requests.last!
            expect(event(app,"started") == 2 && newStart.body["attempt_id"] as? String != oldID, "profile follow-up creates fresh UUID")
            expect(event(app,"stopped") == 1, "old choice retired once")
            newStart.reply(["recorded":true]); app.discover()
            expect(app.chromeHelperInstaller.starts == 1, "follow-up reaches installer after accepted start")
            let fail: [String:Any] = ["error":["code":"CHROME_INSTALL_SOURCE_CHANGED"]]
            app.chromeHelperInstaller.completion?(fail); app.chromeHelperInstaller.completion?(fail)
            expect(event(app,"stopped") == 2 && app.replies.count == 2, "post-ack installer error stops exactly once, no second bridge reply")
        }
        reset()
        do {
            trusted = false; let app = AppDelegate(); app.click("extensionRepair", ["wait_for_accessibility":true])
            expect(app.replies.isEmpty && event(app,"started") == 0, "permission preflight precedes acceptance")
            app.requests[0].reply(["observe_allowed":true])
            expect(app.replies.count == 1 && event(app,"started") == 1 && app.permissionAssistant.requests == 0, "waiting ack before guidance")
            app.requests.last!.reply(["recorded":true]); expect(app.permissionAssistant.requests == 1, "accepted waiting start opens fake guidance")
            trusted = true; TestQueue.main.advance(1)
            expect(event(app,"started") == 1 && event(app,"running") == 1 && app.discoveryCalls == 0, "grant queues running without duplicate start")
            let running = app.requests.last!
            TestQueue.main.advance(1.1); app.discover()
            expect(event(app,"choose_profile") == 0, "choice cannot overtake in-flight running")
            running.reply(["recorded":true])
            expect(event(app,"choose_profile") == 1 && app.replies.count == 1, "waiting choice follows running, one bridge reply")
            let ids = Set(app.progress.compactMap { $0["attempt_id"] as? String })
            expect(ids.count == 1, "all wait/resume/choice events share UUID")
        }
        reset()
        do {
            let app = AppDelegate(); app.click(); let start = app.requests[0]
            app.cancel(); app.cancel()
            expect(event(app,"stopped") == 0 && app.replies.count == 1, "cancel queues behind started and never replies twice")
            start.reply(["recorded":true])
            expect(event(app,"stopped") == 1 && app.discoveryCalls == 0, "late acceptance after cancel cannot resume")
        }
        reset()
        do {
            let app = AppDelegate(); app.click("extensionSetup", ["profile_id":"Default"])
            app.requests[0].reply(["recorded":true]); app.discover(["Default"])
            let oldCompletion = app.chromeHelperInstaller.completion!
            app.click(); app.requests.last!.reply(["recorded":true]); app.discover()
            app.requests.last!.reply(["accepted":true])
            oldCompletion(["error":["code":"CHROME_INSTALL_CANCELLED"]])
            app.cancel()
            expect(event(app,"stopped") == 2, "stale installer completion preserves the new choice cancellation hook")
            expect(app.progress.suffix(2).compactMap { $0["attempt_id"] as? String }.count == 2, "stale terminal events retain their original attempt IDs")
        }
        for response: [String:Any] in [["recorded":false,"discarded":true], ["error":["code":"LOCAL_NETWORK"]]] {
            reset(); let app = AppDelegate(); app.click()
            app.requests[0].reply(response)
            expect(event(app,"stopped") == 1 && app.discoveryCalls == 0 && app.replies.count == 1, "rejected/lost start cannot discover or reply again")
        }
        reset()
        do {
            let app = AppDelegate(); app.click(); let start = app.requests[0]
            TestQueue.main.advance(10); start.reply(["recorded":true])
            expect(event(app,"stopped") == 1 && app.discoveryCalls == 0 && app.replies.count == 1, "start deadline fences late HTTP reply")
        }
        reset()
        do {
            let app = AppDelegate(); app.click(); app.lastWindowInput = Input(timestamp: 1)
            app.requests[0].reply(["recorded":true])
            expect(event(app,"stopped") == 1 && app.discoveryCalls == 0, "start handshake retains human input baseline")
        }
        reset()
        do {
            let app = AppDelegate(); app.permissionAllowed = false; app.click()
            expect(event(app,"started") == 0 && app.replies.count == 1 && app.discoveryCalls == 0, "AX-ready rejected permission preflight creates no attempt")
        }
        reset()
        do {
            trusted = false; let app = AppDelegate(); app.click("extensionSetup", ["wait_for_accessibility":true])
            app.requests[0].reply(["observe_allowed":false])
            expect(event(app,"started") == 0 && app.replies.count == 1, "backend permission preflight rejection creates no attempt")
        }
        reset()
        do {
            trusted = false; let app = AppDelegate(); app.click("extensionSetup", ["wait_for_accessibility":true])
            app.requests[0].reply(["observe_allowed":true]); app.requests.last!.reply(["recorded":true])
            app.cancel(); app.cancel(); trusted = true; TestQueue.main.advance(200)
            expect(event(app,"stopped") == 1 && app.discoveryCalls == 0 && app.replies.count == 1, "waiting cancellation cannot grant late or duplicate stop")
        }
        reset()
        do {
            trusted = false; let app = AppDelegate(); app.click("extensionSetup", ["wait_for_accessibility":true])
            app.requests[0].reply(["observe_allowed":true]); trusted = true
            app.requests.last!.reply(["recorded":true])
            expect(event(app,"started") == 1 && event(app,"running") == 1 && app.permissionAssistant.requests == 0 && app.discoveryCalls == 1, "AX grant during handshake resets stage without a second start or permission UI")
        }
        reset()
        do {
            trusted = false; let app = AppDelegate(); app.click("extensionSetup", ["wait_for_accessibility":true])
            app.requests[0].reply(["observe_allowed":true]); app.requests.last!.reply(["recorded":true])
            TestQueue.main.advance(180); app.cancel()
            expect(event(app,"stopped") == 1 && app.progress.last?["code"] as? String == "CHROME_INSTALL_ACCESSIBILITY_TIMEOUT" && app.replies.count == 1, "180s grant timeout stops once after asynchronous acknowledgement")
        }
        reset()
        do {
            trusted = false; let app = AppDelegate(); app.click("extensionSetup", ["wait_for_accessibility":true])
            app.requests[0].reply(["observe_allowed":true]); app.requests.last!.reply(["recorded":true])
            trusted = true; TestQueue.main.advance(1)
            let interrupt = NSEvent.callbacks.values.first!; interrupt(); interrupt()
            app.requests.last!.reply(["recorded":true]); TestQueue.main.advance(1.1)
            expect(event(app,"stopped") == 1 && app.discoveryCalls == 0 && NSEvent.callbacks.isEmpty, "post-grant input cancels before discovery and removes monitors")
        }
        reset()
        do {
            let app=AppDelegate();app.click();app.requests[0].reply(["recorded":true]);app.discover()
            app.requests.last!.reply(["accepted":true])
            let resume=app.chromeInstallContinuation!,recovery=UUID()
            app.chromeSettingsGeneration=recovery
            let cancellations=app.chromeDataAccessResume.cancellations
            resume {_ in}
            expect(app.chromeDataAccessResume.cancellations == cancellations && app.chromeSettingsGeneration == recovery,"resumed attempt keeps the recovery callback alive until started reply completes it")
            app.requests.last!.reply(["recorded":true])
            expect(app.discoveryCalls == 2,"resumed recovery starts a fresh accepted attempt")
        }
        for kind in 0..<3 {
            reset();trusted=false;let app=AppDelegate()
            app.click("extensionSetup",["wait_for_accessibility":true])
            app.requests[0].reply(["observe_allowed":true]);app.requests.last!.reply(["recorded":true])
            expect(app.chromeAccessibilityWait.active && app.permissionAssistant.requests == 1,"lifecycle fixture is waiting in guidance")
            app.chromeSettingsGeneration=UUID()
            let cancellations=app.chromeDataAccessResume.cancellations
            app.performLifecycleCleanup(kind)
            expect(!app.chromeAccessibilityWait.active && app.permissionAssistant.closes == 1,"actual lifecycle cleanup closes AX wait and guidance")
            expect(app.chromeInstallPreparation == nil && app.chromeInstallContinuation == nil && app.chromeSettingsGeneration == nil,"actual lifecycle cleanup invalidates preparation and recovery")
            expect(app.chromeDataAccessResume.cancellations > cancellations,"actual lifecycle cleanup cancels data access recovery")
            trusted=true;TestQueue.main.advance(200)
            expect(app.discoveryCalls == 0 && event(app,"stopped") == 1,"stopped lifecycle never resumes from a late grant")
        }
        print("PASS: native attempt entry; fake HTTP, AX, desktop, clocks and input only")
    }
}
