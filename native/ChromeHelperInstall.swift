import Foundation
import CryptoKit
import Darwin
#if !CHATHAND_INSTALL_PURE_TEST
import Cocoa
import ApplicationServices
import ImageIO
import ScreenCaptureKit
#endif

/// Store installation opens a fixed listing. It never inspects Chrome windows or sends input.
struct ChromeWebStoreLaunchRequest: Equatable {
    let url: URL
    let profileID: String
    var arguments: [String] { ["--profile-directory=" + profileID, url.absoluteString] }
}

enum ChromeWebStoreOpeningPolicy {
    enum Failure: String, Error {
        case configuration = "CHROME_STORE_CONFIGURATION_PENDING"
        case invalidListing = "CHROME_STORE_LISTING_INVALID"
        case profile = "CHROME_STORE_PROFILE_UNKNOWN"
    }
    static let openActions: Set<String> = ["openChromeStore", "extensionSetup", "extensionRepair", "extensionManual", "revealChromeHelper", "extensionSettings", "reconnectBrowserHelper"]
    static func validProfile(_ id: String) -> Bool {
        if id == "Default" { return true }
        guard let match = id.range(of: "^Profile (0|[1-9][0-9]{0,5})$", options: .regularExpression) else { return false }
        return match.lowerBound == id.startIndex && match.upperBound == id.endIndex
    }
    static func listing(_ prepared: [String: Any]) throws -> URL {
        guard prepared["distribution"] as? String == "chrome_web_store",
              prepared["config_state"] as? String == "ready", prepared["store_ready"] as? Bool == true else { throw Failure.configuration }
        guard let id = prepared["extension_id"] as? String,
              id.utf8.count == 32, id.utf8.allSatisfy({ $0 >= 97 && $0 <= 112 }),
              let address = prepared["store_url"] as? String,
              let url = URL(string: address),
              ["https://chromewebstore.google.com/detail/" + id, "https://chrome.google.com/webstore/detail/" + id].contains(address),
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { throw Failure.invalidListing }
        return url
    }
    static func request(_ prepared: [String: Any], chosenProfile: String?) throws -> ChromeWebStoreLaunchRequest {
        let url = try listing(prepared)
        let selected = prepared["selected_profile"] as? String
        guard let profile = chosenProfile ?? selected, validProfile(profile),
              chosenProfile == nil || selected == chosenProfile else { throw Failure.profile }
        return ChromeWebStoreLaunchRequest(url: url, profileID: profile)
    }
}

/// Main-thread coordinator; late preparation/open callbacks cannot finish a cancelled or newer attempt.
final class ChromeWebStoreFlow {
    typealias Reply = ([String: Any]) -> Void
    private let authorized: () -> Bool
    private let prepare: ([String: Any], @escaping Reply) -> Void
    private let launch: (ChromeWebStoreLaunchRequest, @escaping (Bool) -> Void) -> Void
    private var generation: UUID?
    private var completion: Reply?
    init(authorized: @escaping () -> Bool, prepare: @escaping ([String: Any], @escaping Reply) -> Void,
         launch: @escaping (ChromeWebStoreLaunchRequest, @escaping (Bool) -> Void) -> Void) {
        self.authorized = authorized; self.prepare = prepare; self.launch = launch
    }
    @discardableResult func cancel() -> [String: Any] {
        generation = nil
        let reply = completion; completion = nil
        let result: [String: Any] = ["cancelled": true, "error_code": "CHROME_STORE_CANCELLED"]
        reply?(result)
        return result
    }
    private func finish(_ attempt: UUID, _ result: [String: Any]) {
        guard generation == attempt else { return }
        generation = nil
        let reply = completion; completion = nil; reply?(result)
    }
    func open(profileID: String?, completion reply: @escaping Reply) {
        _ = cancel()
        guard authorized() else { reply(["error_code": "OWNED_WINDOW_REQUIRED"]); return }
        if let profileID, !ChromeWebStoreOpeningPolicy.validProfile(profileID) { reply(["error_code": "CHROME_STORE_PROFILE_UNKNOWN"]); return }
        let attempt = UUID(); generation = attempt; completion = reply
        var body: [String: Any] = [:]
        if let profileID { body["profile_id"] = profileID }
        prepare(body) { [weak self] prepared in
            guard let self, self.generation == attempt else { return }
            guard self.authorized() else { self.finish(attempt, ["error_code": "OWNED_WINDOW_REQUIRED"]); return }
            if prepared["error"] != nil || prepared["error_code"] != nil { self.finish(attempt, prepared); return }
            do { _ = try ChromeWebStoreOpeningPolicy.listing(prepared) }
            catch { self.finish(attempt, ["error_code": (error as? ChromeWebStoreOpeningPolicy.Failure)?.rawValue ?? "CHROME_STORE_LISTING_INVALID"]); return }
            if profileID == nil, prepared["selected_profile"] as? String == nil,
               let profiles = prepared["profiles"] as? [[String: Any]], !profiles.isEmpty {
                var selection = prepared; selection["choose_profile"] = true
                self.finish(attempt, selection); return
            }
            do {
                let request = try ChromeWebStoreOpeningPolicy.request(prepared, chosenProfile: profileID)
                self.launch(request) { [weak self] opened in
                    guard let self, self.generation == attempt else { return }
                    guard self.authorized() else { self.finish(attempt, ["error_code": "OWNED_WINDOW_REQUIRED"]); return }
                    var result = prepared
                    result["opened"] = opened
                    if !opened { result["error_code"] = "CHROME_STORE_OPEN_FAILED" }
                    self.finish(attempt, result)
                }
            } catch {
                self.finish(attempt, ["error_code": (error as? ChromeWebStoreOpeningPolicy.Failure)?.rawValue ?? "CHROME_STORE_LISTING_INVALID"])
            }
        }
    }
}

// Legacy local installation is disabled in the App entry points; retained for rollback and its unit tests.
/// 1042: a fixed, personally initiated installer, never a generic desktop tool.
/// The controller below is exercised only with fake adapters in developer tests.
enum ChromeInstallCode: String, Error {
    case busy = "CHROME_INSTALL_BUSY"
    case cancelled = "CHROME_INSTALL_CANCELLED"
    case invalidLease = "CHROME_INSTALL_INVALID_LEASE"
    case source = "CHROME_INSTALL_SOURCE_MISMATCH"
    case accessibility = "CHROME_INSTALL_ACCESSIBILITY_REQUIRED"
    case accessibilityTimeout = "CHROME_INSTALL_ACCESSIBILITY_TIMEOUT"
    case chromeMissing = "CHROME_INSTALL_CHROME_UNAVAILABLE"
    case target = "CHROME_INSTALL_TARGET_UNKNOWN"
    case focus = "CHROME_INSTALL_FOCUS_UNKNOWN"
    case sheet = "CHROME_INSTALL_SHEET_UNKNOWN"
    case controls = "CHROME_INSTALL_CONTROLS_UNKNOWN"
    case profile = "CHROME_INSTALL_PROFILE_UNKNOWN"
    case dataAccess = "CHROME_DATA_ACCESS_DENIED"
    case oldChrome = "CHROME_INSTALL_CHROME_TOO_OLD"
    case interrupted = "CHROME_INSTALL_USER_INTERRUPTED"
    case permission = "CHROME_INSTALL_PERMISSION_CHANGED"
    case timeout = "CHROME_INSTALL_TIMEOUT"
    case unconfirmed = "CHROME_INSTALL_INPUT_UNCONFIRMED"
    case network = "CHROME_INSTALL_LOCAL_NETWORK"
    case verification = "CHROME_INSTALL_VERIFICATION_FAILED"
    case managed = "CHROME_INSTALL_MANAGED_POLICY_BLOCKED"
    case notInstalled = "CHROME_INSTALL_NOT_INSTALLED"
    case otherProfile = "CHROME_INSTALL_OTHER_PROFILE"
    case nativeHost = "CHROME_INSTALL_NATIVE_HOST_NOT_CONNECTED"
    case handshakeTimeout = "CHROME_INSTALL_TARGET_HANDSHAKE_TIMEOUT"
}

/// Finite preflight diagnostics only. Never retain an AX value, window ID or text.
enum ChromeInstallDetailCode: String, CaseIterable {
    case windowsAXError = "WINDOWS_AX_ERROR"
    case windowsValueMissing = "WINDOWS_VALUE_MISSING"
    case windowsValueInvalid = "WINDOWS_VALUE_INVALID"
    case windowsTooMany = "WINDOWS_TOO_MANY"
    case windowIDDuplicate = "WINDOW_ID_DUPLICATE"
    case windowRoleAXError = "WINDOW_ROLE_AX_ERROR"
    case windowRoleValueInvalid = "WINDOW_ROLE_VALUE_INVALID"
    case windowRoleMismatch = "WINDOW_ROLE_MISMATCH"
    case windowIDReaderMissing = "WINDOW_ID_READER_MISSING"
    case windowIDUnavailable = "WINDOW_ID_UNAVAILABLE"
    case sheetsDeadline = "SHEETS_DEADLINE"
    case sheetsTimeoutAXError = "SHEETS_TIMEOUT_AX_ERROR"
    case sheetsAXError = "SHEETS_AX_ERROR"
    case sheetsNoValueWithValue = "SHEETS_NOVALUE_WITH_VALUE"
    case sheetsValueMissing = "SHEETS_VALUE_MISSING"
    case sheetsValueNotArray = "SHEETS_VALUE_NOT_ARRAY"
    case sheetsArrayCastFailed = "SHEETS_ARRAY_CAST_FAILED"
    case sheetsElementInvalid = "SHEETS_ELEMENT_INVALID"
    case sheetsPresent = "SHEETS_PRESENT"

    var mainCode: ChromeInstallCode {
        switch self {
        case .windowsAXError, .windowsValueMissing, .windowsValueInvalid, .windowsTooMany, .windowIDDuplicate: return .target
        default: return .sheet
        }
    }
}
enum ChromeInstallFallbackCode: String, CaseIterable {
    case entryValuePresent = "ENTRY_VALUE_PRESENT"
    case deadline = "DEADLINE"
    case permissionChanged = "PERMISSION_CHANGED"
    case timeoutSetupFailed = "TIMEOUT_SETUP_FAILED"
    case windowRoleReadFailed = "WINDOW_ROLE_READ_FAILED"
    case windowRoleInvalid = "WINDOW_ROLE_INVALID"
    case childrenReadFailed = "CHILDREN_READ_FAILED"
    case childrenInvalid = "CHILDREN_INVALID"
    case childrenEmpty = "CHILDREN_EMPTY"
    case childrenLimit = "CHILDREN_LIMIT"
    case childIdentityInvalid = "CHILD_IDENTITY_INVALID"
    case childRoleReadFailed = "CHILD_ROLE_READ_FAILED"
    case childRoleInvalid = "CHILD_ROLE_INVALID"
    case childRoleDisallowed = "CHILD_ROLE_DISALLOWED"
    case childParentReadFailed = "CHILD_PARENT_READ_FAILED"
    case childParentInvalid = "CHILD_PARENT_INVALID"
    case snapshotChanged = "SNAPSHOT_CHANGED"
}
enum ChromeInstallWindowRelation: String, CaseIterable {
    case same = "SAME", other = "OTHER", unknown = "UNKNOWN", processChanged = "PROCESS_CHANGED", anchorMissing = "ANCHOR_MISSING"
}
enum ChromeInstallWindowSubrole: String { case standard = "STANDARD", dialog = "DIALOG", unknown = "UNKNOWN" }
enum ChromeInstallWindowSheets: String { case clear = "CLEAR", present = "PRESENT", unknown = "UNKNOWN" }
enum ChromeInstallWindowDifference: String {
    case processChanged = "PROCESS_CHANGED", baselineMissing = "BASELINE_MISSING", unexpectedWindow = "UNEXPECTED_WINDOW"
    case targetMissing = "TARGET_MISSING", targetReferenceChanged = "TARGET_REFERENCE_CHANGED", candidateChanged = "CANDIDATE_CHANGED"
    case frameMismatch = "FRAME_MISMATCH", identityInvalid = "IDENTITY_INVALID"
}
struct ChromeInstallWindowDiagnostic {
    let ordinal: Int, sheets: ChromeInstallWindowSheets
    let context: ChromeInstallEmptyWindowContext
    let code: ChromeInstallCode?, detail: ChromeInstallFailureDetail?
    var metadata: [String: Any] {
        var result = context.metadata
        result["ordinal"] = ordinal; result["sheets"] = sheets.rawValue
        if let code { result["code"] = code.rawValue }
        if let detail {
            result["detail_code"] = detail.code.rawValue
            if let ax = detail.axError { result["ax_error"] = ax }
            if let fallback = detail.fallbackCode { result["fallback_code"] = fallback.rawValue }
        }
        return result
    }
}
/// Only these finite structural fields may cross the native bridge.
struct ChromeInstallEmptyWindowContext {
    let relation: ChromeInstallWindowRelation
    var minimized: Bool?, main: Bool?, focused: Bool?, appActive: Bool?, appHidden: Bool?
    var subrole: ChromeInstallWindowSubrole?
    var metadata: [String: Any] {
        var result: [String: Any] = ["window_relation":relation.rawValue]
        if let minimized { result["empty_window_minimized"] = minimized }
        if let main { result["empty_window_main"] = main }
        if let focused { result["empty_window_focused"] = focused }
        if let appActive { result["app_active"] = appActive }
        if let appHidden { result["app_hidden"] = appHidden }
        if let subrole { result["window_subrole"] = subrole.rawValue }
        return result
    }
    init(relation: ChromeInstallWindowRelation) { self.relation = relation }
    init?(metadata: [String: Any]) {
        guard let raw = metadata["window_relation"] as? String, let relation = ChromeInstallWindowRelation(rawValue:raw) else { return nil }
        self.init(relation:relation)
        func boolean(_ key: String) -> Bool? {
            guard let value = metadata[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
            return value.boolValue
        }
        minimized = boolean("empty_window_minimized"); main = boolean("empty_window_main"); focused = boolean("empty_window_focused")
        appActive = boolean("app_active"); appHidden = boolean("app_hidden")
        subrole = (metadata["window_subrole"] as? String).flatMap(ChromeInstallWindowSubrole.init(rawValue:))
    }
}
/// Attempt-local, memory-only version-page proof. Never serialize this object.
struct ChromeInstallDiscoveryProof {
    struct Anchor {
        let pid: Int32, epoch: TimeInterval, windowID: UInt32
        let reference: AnyObject, profileID: String
    }
    let attempt: UUID, observedAt: TimeInterval
    let anchors: [Anchor]
    func selected(_ profileID: String, attempt: UUID, now: TimeInterval) -> ChromeInstallDiscoveryProof? {
        guard self.attempt == attempt, now >= observedAt, now - observedAt <= 15, anchors.count <= 100 else { return nil }
        let selected = anchors.filter { $0.profileID == profileID }
        guard !selected.isEmpty else { return nil }
        return ChromeInstallDiscoveryProof(attempt:attempt, observedAt:observedAt, anchors:selected)
    }
    func relation(pid: Int32, epoch: TimeInterval?, windowID: UInt32, reference: AnyObject, now: TimeInterval,
                  equal: (AnyObject, AnyObject) -> Bool) -> ChromeInstallWindowRelation {
        guard now >= observedAt, now - observedAt <= 15, !anchors.isEmpty, anchors.count <= 100 else { return .anchorMissing }
        guard let epoch else { return .unknown }
        guard anchors.allSatisfy({ $0.pid == pid && $0.epoch == epoch }) else { return .processChanged }
        let comparisons = anchors.map { ($0.windowID == windowID, equal($0.reference, reference)) }
        guard !comparisons.contains(where: { $0.0 != $0.1 }) else { return .unknown }
        return comparisons.contains(where: { $0.0 && $0.1 }) ? .same : .other
    }
}
/// A late worker can neither publish proof after timeout nor race main-queue cancellation.
final class ChromeInstallDiscoveryProofSlot {
    private let lock = NSLock()
    private var closed = false, proof: ChromeInstallDiscoveryProof?
    func store(_ value: ChromeInstallDiscoveryProof) { lock.lock(); defer { lock.unlock() }; if !closed { proof = value } }
    func take() -> ChromeInstallDiscoveryProof? { lock.lock(); defer { lock.unlock() }; let value = proof; proof = nil; closed = true; return value }
    func clear() { lock.lock(); defer { lock.unlock() }; proof = nil; closed = true }
}
struct ChromeInstallFailureDetail {
    let code: ChromeInstallDetailCode
    let axError: Int32?
    let fallbackCode: ChromeInstallFallbackCode?
    let windowContext: ChromeInstallEmptyWindowContext?
    init?(_ code: ChromeInstallDetailCode, axError: Int32? = nil, fallbackCode: ChromeInstallFallbackCode? = nil, windowContext: ChromeInstallEmptyWindowContext? = nil) {
        let valid: Bool
        switch code {
        case .windowsAXError, .windowRoleAXError, .sheetsTimeoutAXError:
            valid = axError != nil && axError != 0
        case .sheetsAXError:
            valid = axError != nil && axError != 0 && axError != -25212
        case .sheetsNoValueWithValue: valid = axError == -25212
        case .windowIDDuplicate, .windowIDReaderMissing, .windowIDUnavailable, .sheetsDeadline:
            valid = axError == nil
        default: valid = axError == 0
        }
        guard valid, fallbackCode == nil || code == .sheetsAXError && axError == -25205 else { return nil }
        self.code = code; self.axError = axError; self.fallbackCode = fallbackCode
        self.windowContext = code == .sheetsAXError && axError == -25205 && fallbackCode == .childrenEmpty ? windowContext : nil
    }
    init?(metadata: [String: Any]) {
        guard let raw = metadata["detail_code"] as? String, let code = ChromeInstallDetailCode(rawValue: raw) else { return nil }
        var axError: Int32?
        if let value = metadata["ax_error"] {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue >= Double(Int32.min), number.doubleValue <= Double(Int32.max),
                  number.doubleValue == Double(number.int64Value) else { return nil }
            axError = Int32(number.int64Value)
        }
        let fallback = (metadata["fallback_code"] as? String).flatMap(ChromeInstallFallbackCode.init(rawValue:))
        self.init(code, axError: axError, fallbackCode: code == .sheetsAXError && axError == -25205 ? fallback : nil, windowContext: ChromeInstallEmptyWindowContext(metadata:metadata))
    }
    func matches(_ mainCode: String?) -> Bool { code.mainCode.rawValue == mainCode }
}

/// Chrome exposes version fields as table rows on older releases and labelled groups on newer ones.
enum ChromeVersionPageEvidence {
    struct Field {
        let label: String
        let values: [String]
    }
    static func fieldName(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ":： "))
        if ["Profile Path", "个人资料路径", "個人資料路徑", "配置文件路径"].contains(name) { return "profile" }
        if name == "Google Chrome" { return "version" }
        return nil
    }
    static func major(_ raw: String) -> Int? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^[0-9]{2,3}\.[0-9]+\.[0-9]+\.[0-9]+(?:\s|$)"#, options: .regularExpression) != nil else { return nil }
        return Int(value.split(separator: ".")[0])
    }
    static func parse(_ fields: [Field]) -> (profile: String, major: Int)? {
        var paths = Set<String>(), versions = Set<String>()
        for field in fields {
            switch fieldName(field.label) {
            case "profile":
                for raw in field.values {
                    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                    if value.hasPrefix("/") { paths.insert(value) }
                }
            case "version":
                for raw in field.values where major(raw) != nil {
                    versions.insert(raw.trimmingCharacters(in: .whitespacesAndNewlines))
                }
            default: break
            }
        }
        guard paths.count == 1, versions.count == 1,
              let profile = paths.first, let version = versions.first, let major = major(version) else { return nil }
        return (profile, major)
    }
}

/// A blocked/queued AX reader can never block the main queue or deliver late authority.
final class ChromeProfileDiscovery {
    typealias Value=Result<[String],ChromeInstallCode>
    private let execute:(@escaping ()->Void)->Void
    private let deliver:(@escaping ()->Void)->Void
    private let schedule:(TimeInterval,@escaping ()->Void)->Void
    private var token:UUID?
    private var completion:((Value)->Void)?
    private static let queue=DispatchQueue(label:"chathand.chrome.profile-observation")
    init(execute:@escaping (@escaping ()->Void)->Void={work in queue.async(execute:work)},deliver:@escaping (@escaping ()->Void)->Void={work in DispatchQueue.main.async(execute:work)},schedule:@escaping (TimeInterval,@escaping ()->Void)->Void={delay,work in DispatchQueue.main.asyncAfter(deadline:.now()+delay,execute:work)}){self.execute=execute;self.deliver=deliver;self.schedule=schedule}
    func start(timeout:TimeInterval,read:@escaping ()->Value,completion:@escaping (Value)->Void){
        cancel();let key=UUID();token=key;self.completion=completion
        schedule(max(0,timeout)){[weak self] in self?.finish(key,.failure(.timeout))}
        execute{[weak self] in let value=read();self?.deliver{[weak self] in self?.finish(key,value)}}
    }
    private func finish(_ key:UUID,_ value:Value){guard token==key else{return};let done=completion;token=nil;completion=nil;done?(value)}
    func cancel(){if let key=token{finish(key,.failure(.cancelled))}}
}

/// Permission recovery retries only after returning from Settings, within one bounded intent.
/// It never replays an uncertain Chrome click or holds an old installer lease.
final class ChromeDataAccessResume {
    typealias Reply = ([String:Any])->Void
    private let now:()->TimeInterval
    private let schedule:(TimeInterval,@escaping ()->Void)->Void
    private var token:UUID?
    private var retry:((@escaping Reply)->Void)?
    private var completion:Reply?
    private var inFlight=false
    private var deadline:TimeInterval=0
    init(now:@escaping ()->TimeInterval={ProcessInfo.processInfo.systemUptime},schedule:@escaping (TimeInterval,@escaping ()->Void)->Void={delay,work in DispatchQueue.main.asyncAfter(deadline:.now()+delay,execute:work)}) {self.now=now;self.schedule=schedule}
    var active:Bool {token != nil}
    func start(timeout:TimeInterval=120,retry:@escaping (@escaping Reply)->Void,completion:@escaping Reply){
        cancel();let key=UUID();token=key;deadline=now()+max(0,timeout);self.retry=retry;self.completion=completion
        schedule(max(0,timeout)){[weak self] in guard let self,self.token == key else{return};self.finish(["error":["code":"CHROME_DATA_ACCESS_TIMEOUT"]])}
    }
    func returnedToApp(){
        guard let key=token,!inFlight,let retry else{return}
        guard now()<deadline else{finish(["error":["code":"CHROME_DATA_ACCESS_TIMEOUT"]]);return};inFlight=true
        retry{[weak self] result in
            guard let self,self.token == key else{return};self.inFlight=false
            let code=(result["error"] as? [String:Any])?["code"] as? String ?? result["error_code"] as? String ?? result["error"] as? String
            if code == "CHROME_DATA_ACCESS_DENIED" {return}
            self.finish(result)
        }
    }
    private func finish(_ result:[String:Any]){let callback=completion;token=nil;retry=nil;completion=nil;inFlight=false;callback?(result)}
    func cancel(){if active{finish(["error":["code":"CHROME_INSTALL_CANCELLED"]])}}
}

/// Only an unambiguous effective blocker gets the managed-policy receipt.
/// Incomplete/unsupported policy evidence stays unknown; no policy is changed.
enum ChromeInstallPolicies {
    static let names: Set<String> = ["ExtensionDeveloperModeSettings", "DeveloperToolsAvailability", "ExtensionInstallBlocklist", "ExtensionInstallAllowlist", "ExtensionSettings"]
    static func check(_ values: [String: String], helperID: String) throws {
        func integer(_ name: String, allowed: Set<Int>) throws -> Int? {
            guard let raw = values[name] else { return nil }
            guard let value = Int(raw), allowed.contains(value) else { throw ChromeInstallCode.controls }; return value
        }
        func list(_ name: String) throws -> [String] {
            guard let raw = values[name] else { return [] }
            guard raw.utf8.count <= 65536, let array = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String], array.count <= 1000 else { throw ChromeInstallCode.controls }; return array
        }
        let devMode = try integer("ExtensionDeveloperModeSettings", allowed: [0, 1])
        let devTools = try integer("DeveloperToolsAvailability", allowed: [0, 1, 2])
        if devMode == 1 || devMode == nil && devTools == 2 { throw ChromeInstallCode.managed }
        let block = try list("ExtensionInstallBlocklist"), allow = try list("ExtensionInstallAllowlist")
        var specific: [String: Any]?, defaults: [String: Any]?
        if let raw = values["ExtensionSettings"] {
            guard raw.utf8.count <= 65536, let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any], object.count <= 1000 else { throw ChromeInstallCode.controls }
            if let item = object["*"] { guard let parsed = item as? [String: Any] else { throw ChromeInstallCode.controls }; defaults = parsed }
            let matches = object.keys.filter { $0.split(separator: ",").map(String.init).contains(helperID) }
            guard matches.count <= 1 else { throw ChromeInstallCode.controls }
            if let key = matches.first { guard let parsed = object[key] as? [String: Any] else { throw ChromeInstallCode.controls }; specific = parsed }
            // An update-url policy cannot be evaluated without its complete effective binding.
            guard !object.keys.contains(where: { $0.hasPrefix("update_url:") }) else { throw ChromeInstallCode.controls }
        }
        func mode(_ item: [String: Any]?) throws -> String? {
            guard let raw = item?["installation_mode"] else { return nil }
            guard let value = raw as? String, ["allowed", "blocked", "removed", "force_installed", "normal_installed"].contains(value) else { throw ChromeInstallCode.controls }; return value
        }
        let scopedMode = try mode(specific), defaultMode = try mode(defaults)
        if let scopedMode {
            if ["blocked", "removed", "force_installed"].contains(scopedMode) { throw ChromeInstallCode.managed }
            return // explicit per-ID mode overrides legacy/default installation mode
        }
        if block.contains(helperID) && !allow.contains(helperID) { throw ChromeInstallCode.managed }
        if allow.contains(helperID) {
            // Official legacy '*' allowlist exception describes packed extensions only.
            // Do not guess unpacked eligibility for a mixed legacy configuration.
            guard !block.contains("*") else { throw ChromeInstallCode.controls }; return
        }
        if let defaultMode {
            if ["blocked", "removed"].contains(defaultMode) { throw ChromeInstallCode.managed }
            if defaultMode != "allowed" { throw ChromeInstallCode.controls }
        } else if block.contains("*") { throw ChromeInstallCode.managed }
    }
}

enum ChromeInstallSource {
    /// Chrome resolves manifest __MSG_*__ names before exposing them through AX.
    /// Catalogs come only from the fingerprinted, bundled helper source.
    static func displayNames(_ name: String, catalogs: [[String: Any]]) throws -> Set<String> {
        func valid(_ value: String) -> Bool {
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.count <= 100 &&
            value.utf8.count <= 512 && value.rangeOfCharacter(from: .controlCharacters) == nil
        }
        guard valid(name) else { throw ChromeInstallCode.source }
        guard name.hasPrefix("__MSG_") else { return [name] }
        guard name.range(of: "^__MSG_[A-Za-z0-9_]+__$", options: .regularExpression) != nil, !catalogs.isEmpty else { throw ChromeInstallCode.source }
        let key = String(name.dropFirst(6).dropLast(2))
        var names = Set<String>()
        for catalog in catalogs {
            guard let entry = catalog[key] as? [String: Any], let message = entry["message"] as? String,
                  valid(message), !message.contains("$") else { throw ChromeInstallCode.source }
            names.insert(message)
        }
        return names
    }
    /// Chrome's developer_private info.version uses GetVersionForDisplay():
    /// manifest version_name when present, otherwise its numeric version.
    /// The caller has already verified the fixed manifest/source fingerprint.
    static func displayVersion(_ manifest: [String: Any], numericVersion: String) -> String {
        guard let name = manifest["version_name"] as? String,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.count <= 160, name.utf8.count <= 512,
              name.rangeOfCharacter(from: .controlCharacters) == nil else { return numericVersion }
        return name // preserve the display text exactly for the AX comparison
    }
    static func openedPathMatches(_ opened: String, expected: String) -> Bool {
        if opened == expected { return true }
        // Foundation preserves these macOS system aliases while F_GETPATH reports
        // /private. Accept only their exact byte-for-byte physical counterpart;
        // arbitrary parent/file links still fail the separate canonical checks.
        return ["/var/", "/tmp/"].contains { expected.hasPrefix($0) && opened == "/private" + expected }
    }
    // Keep this order identical to the server's source-fingerprint contract.
    static let files = ["manifest.json", "background.js", "driver.js", "experience.js",
        "page-helper.js", "click-target.js", "scroll-target.js", "frame-tree.js",
        "vendor/playwright-injected.js", "popup.js", "popup.html", "popup.css",
        "locale.js", "locale-catalogs.js", "_locales/zh_CN/messages.json", "_locales/en/messages.json",
        "icons/chathand-16.png", "icons/chathand-32.png", "icons/chathand-48.png", "icons/chathand-128.png"]

    static func canonicalDirectory(_ url: URL) throws -> URL {
        let clean = url.standardizedFileURL
        guard clean.isFileURL, clean.path == clean.resolvingSymlinksInPath().path else { throw ChromeInstallCode.source }
        let values = try clean.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw ChromeInstallCode.source }
        return clean
    }
    static func fingerprint(runtime: URL) throws -> String {
        let base = try canonicalDirectory(runtime)
        return try fingerprintFolder(base.appendingPathComponent("browser-extension", isDirectory: true))
    }
    static func fingerprintFolder(_ source: URL) throws -> String {
        let folder = try canonicalDirectory(source)
        _ = try canonicalDirectory(folder.appendingPathComponent("vendor", isDirectory: true))
        var hash = SHA256(), total = 0
        for name in files {
            let url = folder.appendingPathComponent(name).standardizedFileURL
            guard url.path == url.resolvingSymlinksInPath().path else { throw ChromeInstallCode.source }
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size > 0, size <= 16 * 1024 * 1024 else { throw ChromeInstallCode.source }
            total += size; guard total <= 32 * 1024 * 1024 else { throw ChromeInstallCode.source }
            let data = try boundedFile(url, expectedSize: size)
            guard data.count == size else { throw ChromeInstallCode.source }
            hash.update(data: Data(name.utf8)); hash.update(data: Data([0]))
            hash.update(data: data); hash.update(data: Data([0]))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private static func boundedFile(_ url: URL, expectedSize: Int) throws -> Data {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ChromeInstallCode.source }
        defer { _ = Darwin.close(descriptor) }
        var openedPath = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        let resolved = openedPath.withUnsafeMutableBufferPointer { buffer in
            Darwin.fcntl(descriptor, F_GETPATH, UnsafeMutableRawPointer(buffer.baseAddress!))
        }
        guard resolved == 0, openedPathMatches(String(cString: openedPath), expected: url.path) else { throw ChromeInstallCode.source }
        var before = stat(), after = stat()
        guard fstat(descriptor, &before) == 0, (before.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG),
              before.st_size == off_t(expectedSize) else { throw ChromeInstallCode.source }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        var data = Data()
        while true {
            let remaining = expectedSize + 1 - data.count
            guard remaining > 0 else { throw ChromeInstallCode.source }
            let chunk = try handle.read(upToCount: min(64 * 1024, remaining)) ?? Data()
            if chunk.isEmpty { break }
            data.append(chunk); guard data.count <= expectedSize else { throw ChromeInstallCode.source }
        }
        guard data.count == expectedSize, fstat(descriptor, &after) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw ChromeInstallCode.source }
        return data
    }
}

struct ChromeInstallLease {
    static func validProfile(_ id: String) -> Bool { id.range(of: "^(Default|Profile [0-9]{1,6})$", options: .regularExpression) != nil }
    let id: String
    let probeURL: String
    let folder: URL
    let fingerprint: String
    let profileID: String
    init(response: [String: Any], origin: String, runtime: URL, expectedFolder: URL, profileID: String) throws {
        guard let id = response["lease_id"] as? String,
              Self.validProfile(profileID), response["profile_id"] as? String == profileID,
              id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              let probe = response["probe_url"] as? String, let url = URLComponents(string: probe),
              let local = URLComponents(string: origin), local.scheme == "http", local.host == "127.0.0.1",
              let port = local.port, port > 0, port <= 65535,
              url.scheme == local.scheme, url.host == local.host, url.port == port,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.percentEncodedPath.range(of: "^/api/browser/extension/install/probe/[a-f0-9]{64}$", options: .regularExpression) != nil,
              let path = response["extension_folder"] as? String,
              let fingerprint = response["source_fingerprint"] as? String,
              fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ChromeInstallCode.invalidLease }
        let base = try ChromeInstallSource.canonicalDirectory(runtime)
        let expected = try ChromeInstallSource.canonicalDirectory(expectedFolder)
        guard URL(fileURLWithPath: path).standardizedFileURL.path == path, path == expected.path,
              try ChromeInstallSource.fingerprint(runtime: base) == fingerprint,
              try ChromeInstallSource.fingerprintFolder(expected) == fingerprint else { throw ChromeInstallCode.source }
        self.id = id; self.probeURL = probe; self.folder = expected; self.fingerprint = fingerprint; self.profileID = profileID
    }
}

enum ChromeInstallStage: Hashable { case normal, runningChrome, newTab, version, policies, extensions, helperList, helperDetails, helperReady, chooser, goFolder, selectedFolder, chooserClosing, probe, finalVersion }
enum ChromeInstallAction: String {
    case launchChrome, raiseWindow, activate, newTab, focusAddress, versionURL, policyURL, extensionsURL, detailsURL, probeURL, submitAddress
    case developerMode, loadUnpacked, goToFolder, folderPath, submitFolder, openFolder, restoreForeground
    case enableHelper, reloadHelper
}
enum ChromeInstallObservation {
    case newTab
    case runningChrome
    case version(profile: String, major: Int), extensions(developerMode: Bool)
    case policiesClear
    case missingHelper, helperFound, helperDetails(enabled: Bool, current: Bool), helperReady
    case chooser, pathEntry, selectedFolder, chooserDismissed, probe
}
// Separate repair operations keep existing install adapters and their exhaustive
// stage switches unchanged. An adapter that has no repair support fails closed.
enum ChromeInstallRepairStage { case details, removable, confirmation, removed }
enum ChromeInstallRepairAction { case remove, confirm }
enum ChromeInstallRepairObservation {
    case details(enabled: Bool, current: Bool, sourceMatches: Bool)
    case removable, confirmation, removed
}
enum ChromeRepairEvidence {
    static func isFixedID(_ value: String, expected: String) -> Bool {
        guard expected.range(of: "^[a-p]{32}$", options: .regularExpression) != nil else { return false }
        return value == expected || ["ID: " + expected, "ID：" + expected, "ID:　" + expected].contains(value)
    }
    static func sourcePath(_ paths: [String]) throws -> String {
        let unique = Set(paths)
        guard unique.count == 1, let path = unique.first, path.hasPrefix("/"),
              !path.contains("\n"), !path.contains("\r"),
              URL(fileURLWithPath: path).standardizedFileURL.path == path else { throw ChromeInstallCode.source }
        return path
    }
    static func removalTitle(_ value: String, helperName: String) -> Bool {
        // Exact Chrome-owned confirmation text, never a substring/name-only match.
        let names = ["Remove “\(helperName)”?", "Remove \"\(helperName)\"?", "Remove ‘\(helperName)’?",
                     "移除“\(helperName)”？", "删除“\(helperName)”？", "要移除「\(helperName)」嗎？",
                     "移除「\(helperName)」？"]
        return !helperName.isEmpty && names.contains(value)
    }
}

enum ChromeExtensionsPageCode: String, Error {
    case unavailable = "CHROME_INSTALL_CHROME_UNAVAILABLE"
    case accessibility = "CHROME_INSTALL_ACCESSIBILITY_REQUIRED"
    case failed = "CHROME_EXTENSIONS_OPEN_FAILED"
    case unverified = "CHROME_EXTENSIONS_OPEN_UNVERIFIED"
    case cancelled = "CHROME_EXTENSIONS_OPEN_CANCELLED"
    case busy = "CHROME_INSTALL_BUSY"
}

/// A launch receipt is not a page receipt. Both operations are injected so tests
/// cannot open a browser or inspect the user's desktop. All callbacks use main.
final class ChromeExtensionsPageOpen {
    typealias Open = (@escaping () -> Bool, @escaping (Result<Void, ChromeExtensionsPageCode>) -> Void) -> Void
    typealias Observe = (TimeInterval, @escaping (Result<Bool, ChromeExtensionsPageCode>) -> Void) -> Void
    private let requestOpen: Open
    private let observe: Observe
    private let now: () -> TimeInterval
    private let schedule: (TimeInterval, @escaping () -> Void) -> Void
    private var generation: UUID?
    private var deadline: TimeInterval = 0
    private var completion: (([String: Any]) -> Void)?
    var active: Bool { generation != nil }

    init(requestOpen: @escaping Open, observe: @escaping Observe,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         schedule: @escaping (TimeInterval, @escaping () -> Void) -> Void = { delay, work in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work) }) {
        self.requestOpen = requestOpen; self.observe = observe; self.now = now; self.schedule = schedule
    }
    static func isExtensionsPage(address: String, documentURL: String, title: String, developerControl: Bool) -> Bool {
        ["chrome://extensions", "chrome://extensions/"].contains(address) &&
        ["chrome://extensions", "chrome://extensions/"].contains(documentURL) &&
        ["Extensions", "扩展程序", "擴充功能"].contains(title) && developerControl
    }
    func start(completion: @escaping ([String: Any]) -> Void) {
        guard !active else { completion(["error_code": ChromeExtensionsPageCode.busy.rawValue]); return }
        let run = UUID(); generation = run; deadline = now() + 10; self.completion = completion
        schedule(10) { [weak self] in self?.finish(run, code: .unverified) }
        requestOpen({ [weak self] in self?.live(run) == true }) { [weak self] result in
            guard let self, self.live(run) else { return }
            switch result {
            case .failure(let code): self.finish(run, code: code)
            case .success: self.poll(run)
            }
        }
    }
    private func live(_ run: UUID) -> Bool {
        guard generation == run else { return false }
        guard now() < deadline else { finish(run, code: .unverified); return false }
        return true
    }
    private func poll(_ run: UUID) {
        guard live(run) else { return }
        observe(deadline) { [weak self] result in
            guard let self, self.live(run) else { return }
            switch result {
            case .failure(let code): self.finish(run, code: code)
            case .success(true): self.finish(run, code: nil)
            case .success(false): self.schedule(0.2) { [weak self] in self?.poll(run) }
            }
        }
    }
    private func finish(_ run: UUID, code: ChromeExtensionsPageCode?) {
        guard generation == run else { return }
        let done = completion; generation = nil; completion = nil
        if let code { done?(["error_code": code.rawValue]) } else { done?(["opened": true]) }
    }
    func cancel() { if let run = generation { finish(run, code: .cancelled) } }
}
protocol ChromeInstallAdapter: AnyObject {
    var needsLaunch: Bool { get }
    var inputReady: Bool { get }
    var failureDetail: ChromeInstallFailureDetail? { get }
    func preflight() throws
    func bind(_ lease: ChromeInstallLease) throws
    func check(_ stage: ChromeInstallStage, input: Bool) throws
    /// Each action is attempted at most once. Non-confirmed input throws; never retry it.
    func perform(_ action: ChromeInstallAction) throws
    func observe(_ stage: ChromeInstallStage) throws -> ChromeInstallObservation?
    func observationBudget(until deadline: TimeInterval)
    func finalEvidence() throws -> String
    func progress(_ stage: String)
    func failureEvidence(code: String, stage: String, current: @escaping () -> Bool, completion: @escaping ([String: Any]) -> Void)
    func close()
    func checkRepair(_ stage: ChromeInstallRepairStage, input: Bool) throws
    func observeRepair(_ stage: ChromeInstallRepairStage) throws -> ChromeInstallRepairObservation?
    func performRepair(_ action: ChromeInstallRepairAction) throws
}
extension ChromeInstallAdapter {
    var failureDetail: ChromeInstallFailureDetail? { nil }
    func observationBudget(until deadline: TimeInterval) {}
    func checkRepair(_ stage: ChromeInstallRepairStage, input: Bool) throws { throw ChromeInstallCode.controls }
    func observeRepair(_ stage: ChromeInstallRepairStage) throws -> ChromeInstallRepairObservation? { throw ChromeInstallCode.controls }
    func performRepair(_ action: ChromeInstallRepairAction) throws { throw ChromeInstallCode.controls }
    var inputReady: Bool { true }
    func progress(_ stage: String) {}
    func failureEvidence(code: String, stage: String, current: @escaping () -> Bool, completion: @escaping ([String: Any]) -> Void) {
        if current() { completion(["code": code, "stage": stage, "evidence_code": "CHROME_INSTALL_EVIDENCE_UNAVAILABLE"]) }
    }
}

final class ChromeHelperInstaller {
    typealias API = (String, [String: Any], @escaping ([String: Any]) -> Void) -> Void
    typealias Schedule = (Double, @escaping () -> Void) -> Void
    private let api: API
    private let schedule: Schedule
    private let now: () -> TimeInterval
    private let runtime: URL
    private let expectedFolder: URL
    private let origin: () -> String
    private let makeAdapter: () -> ChromeInstallAdapter
    private let diagnostic: ([String: Any]) -> Void
    private var attemptStartedAt: TimeInterval = 0
    private var targetIsDefault = false
    private var helperInstalled = false
    private var targetHelperInstalled = false
    private var helperSeen = false
    private var waitingForHandshake = false
    private var repairing = false
    private var generation: UUID?
    private var evidenceRun: UUID?
    private var adapter: ChromeInstallAdapter?
    private var lease: ChromeInstallLease?
    private var deadline: TimeInterval = 0
    private var profile: String?
    private var progressStage = "preparing"
    private var reportedStage: String?
    private(set) var lastCode: ChromeInstallCode?
    var active: Bool { generation != nil }
    private let base = "/api/browser/extension/install/"

    init(runtime: URL, expectedFolder: URL, origin: @escaping () -> String, api: @escaping API,
         adapter: @escaping () -> ChromeInstallAdapter, diagnostic: @escaping ([String: Any]) -> Void = { _ in }, now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 },
         schedule: @escaping Schedule = { seconds, work in DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work) }) {
        self.runtime = runtime; self.expectedFolder = expectedFolder; self.origin = origin; self.api = api; self.makeAdapter = adapter; self.diagnostic = diagnostic; self.now = now; self.schedule = schedule
    }
    func start(profileID: String, repair: Bool = false, completion: @escaping ([String: Any]) -> Void) {
        let startedAt = now()
        func preflightNote(_ event: String, _ code: ChromeInstallCode? = nil, detail: ChromeInstallFailureDetail? = nil) {
            var metadata: [String: Any] = ["native_event":event, "stage":"preparing", "elapsed_ms":max(0, min(90000, Int((now() - startedAt) * 1000))), "target_is_default":ChromeInstallLease.validProfile(profileID) ? (profileID == "Default") as Any : NSNull()]
            if let code { metadata["code"] = code.rawValue }
            if event == "stopped", let detail, detail.matches(code?.rawValue) {
                metadata["detail_code"] = detail.code.rawValue
                if let axError = detail.axError { metadata["ax_error"] = axError }
                if let fallback = detail.fallbackCode { metadata["fallback_code"] = fallback.rawValue }
                if let context = detail.windowContext { for (key, value) in context.metadata { metadata[key] = value } }
            }
            diagnostic(metadata)
        }
        guard !active else { preflightNote("stopped", .busy); completion(Self.error(.busy)); return }
        guard ChromeInstallLease.validProfile(profileID) else { preflightNote("stopped", .profile); completion(Self.error(.profile)); return }
        preflightNote("started")
        evidenceRun = nil // a new attempt invalidates even an asynchronous old capture
        let run = UUID(), candidate = makeAdapter()
        do { _ = try ChromeInstallSource.fingerprint(runtime: runtime); try candidate.preflight() }
        catch {
            let code = (error as? ChromeInstallCode) ?? .source
            let detail = candidate.failureDetail // close clears attempt-local diagnostics.
            candidate.close(); preflightNote("stopped", code, detail: detail)
            completion(Self.error(code, detail: detail)); return
        }
        attemptStartedAt = startedAt; targetIsDefault = profileID == "Default"
        repairing = repair
        generation = run; adapter = candidate; lease = nil; profile = nil; helperInstalled = false; targetHelperInstalled = false; helperSeen = false; waitingForHandshake = false; lastCode = nil; deadline = now() + 90; progressStage = "preparing"; reportedStage = "preparing"
        api(base + "start", ["profile_id": profileID]) { [weak self] response in
            guard let self else { return }
            // Cancellation while start is in flight still cancels its eventual private lease.
            guard self.generation == run else {
                if let id = response["lease_id"] as? String, id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil {
                    self.api(self.base + "cancel", ["lease_id": id, "code": ChromeInstallCode.cancelled.rawValue]) { _ in }
                }
                completion(Self.error(.cancelled)); return
            }
            do {
                guard response["error"] == nil else {
                    let code=(response["error"] as? [String:Any])?["code"] as? String ?? response["error_code"] as? String ?? response["error"] as? String
                    throw code == ChromeInstallCode.dataAccess.rawValue ? ChromeInstallCode.dataAccess : ChromeInstallCode.permission
                }
                let lease = try ChromeInstallLease(response: response, origin: self.origin(), runtime: self.runtime, expectedFolder: self.expectedFolder, profileID: profileID)
                self.lease = lease; try candidate.bind(lease)
                candidate.progress("preparing")
                completion(["started": true]) // Nothing private goes back to the renderer.
                if candidate.needsLaunch {
                    self.progressStage = "opening_chrome"
                    self.input(.launchChrome, stage: .normal, run: run) { self.wait(.runningChrome, run: run) { _ in self.activate(run) } }
                } else { self.activate(run) }
            } catch {
                // If malformed source metadata still includes a valid lease, cancel only that lease.
                if self.lease == nil, let id = response["lease_id"] as? String,
                   id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil {
                    self.api(self.base + "cancel", ["lease_id": id, "code": ChromeInstallCode.invalidLease.rawValue]) { _ in }
                }
                let code = (error as? ChromeInstallCode) ?? .invalidLease; self.stop(code, run: run); completion(Self.error(code))
            }
        }
    }
    func cancel(completion: (([String: Any]) -> Void)? = nil) {
        evidenceRun = nil
        if let run = generation { stop(.cancelled, run: run) }
        completion?(["cancelled": true])
    }
    private func activate(_ run: UUID) {
        progressStage = "opening_chrome"
        input(.raiseWindow, stage: .normal, run: run) {
            self.input(.activate, stage: .normal, run: run) {
                self.input(.newTab, stage: .normal, run: run) { self.wait(.newTab, run: run) { _ in self.navigate(.versionURL, run: run) { self.readInitialProfile(run) } } }
            }
        }
    }
    private static func error(_ code: ChromeInstallCode, detail: ChromeInstallFailureDetail? = nil) -> [String: Any] {
        var result: [String: Any] = ["error": ["code": code.rawValue], "manual_available": true]
        if let detail, detail.matches(code.rawValue) {
            result["detail_code"] = detail.code.rawValue
            if let axError = detail.axError { result["ax_error"] = axError }
            if let fallback = detail.fallbackCode { result["fallback_code"] = fallback.rawValue }
            if let context = detail.windowContext { for (key, value) in context.metadata { result[key] = value } }
        }
        return result
    }
    private func live(_ run: UUID) -> Bool {
        guard generation == run else { return false }
        if now() >= deadline { stop(timeoutCode, run: run); return false }
        return true
    }
    private var timeoutCode: ChromeInstallCode {
        // A global connection cannot establish a profile. These codes describe only
        // evidence from the owned installer window and this lease's fresh probe.
        guard waitingForHandshake, targetHelperInstalled else { return .timeout }
        return helperSeen ? .handshakeTimeout : .nativeHost
    }
    private func stop(_ code: ChromeInstallCode, run: UUID) {
        guard generation == run else { return }
        lastCode = code
        let id = lease?.id, failedAdapter = adapter, stage = progressStage
        evidenceRun = code == .cancelled ? nil : run
        generation = nil; lease = nil; profile = nil
        adapter?.close(); adapter = nil // close emits no input and does not claim to undo installation.
        if id == nil {
            diagnostic(["native_event":"stopped", "stage":"preparing", "elapsed_ms":max(0, min(90000, Int((now() - attemptStartedAt) * 1000))), "target_is_default":targetIsDefault, "code":code.rawValue])
        }
        if let id {
            api(base + "cancel", ["lease_id": id, "code": code.rawValue]) { [weak self] result in
                // Stop/close are immediate. Capture begins only for the confirmed old
                // stopped lease, and never emits input. New start/cancel invalidates it.
                guard let self, let failedAdapter, self.evidenceRun == run, self.generation == nil, result["error"] == nil,
                      result["phase"] as? String == "stopped", result["active"] as? Bool == false else { return }
                failedAdapter.failureEvidence(code: code.rawValue, stage: stage,
                    current: { [weak self] in self?.evidenceRun == run && self?.generation == nil }) { [weak self] captured in
                    guard let self, self.evidenceRun == run, self.generation == nil else { return }
                    var evidence = captured; evidence["lease_id"] = id
                    self.api(self.base + "evidence", evidence) { _ in }
                }
            }
        }
    }
    private func authorized(stage: ChromeInstallStage, input: Bool = false, repairStage: ChromeInstallRepairStage? = nil, run: UUID, then: @escaping () -> Void) {
        guard live(run), let lease else { return }
        if reportedStage != progressStage {
            let progress = progressStage
            api(base + "progress", ["lease_id": lease.id, "stage": progress]) { [weak self] result in
                guard let self, self.live(run) else { return }
                guard result["error"] == nil, result["active"] as? Bool == true,
                      result["code"] == nil || result["code"] is NSNull else { self.stop(.permission, run: run); return }
                self.reportedStage = progress
                self.adapter?.progress(progress)
                // Progress grants nothing: the fresh status and local guard still run below.
                self.authorized(stage: stage, input: input, repairStage: repairStage, run: run, then: then)
            }
            return
        }
        api(base + "status", ["lease_id": lease.id]) { [weak self] result in
            guard let self, self.live(run) else { return }
            guard result["error"] == nil, result["active"] as? Bool == true,
                  result["code"] == nil || result["code"] is NSNull else { self.stop(.permission, run: run); return }
            if self.adapter?.inputReady == false {
                // No input is issued while session/screen state is inactive. Wait inside the
                // original lease TTL; wake-up rechecks status and all local evidence.
                self.schedule(0.3) { self.authorized(stage: stage, input: input, repairStage: repairStage, run: run, then: then) }
                return
            }
            do {
                if let repairStage { try self.adapter?.checkRepair(repairStage, input: input) }
                else { try self.adapter?.check(stage, input: input) }
                guard self.live(run) else { return }; then()
            }
            catch { self.stop((error as? ChromeInstallCode) ?? .target, run: run) }
        }
    }
    private func input(_ action: ChromeInstallAction, stage: ChromeInstallStage, run: UUID, then: @escaping () -> Void) {
        authorized(stage: stage, input: true, run: run) { [weak self] in
            guard let self, self.live(run), let adapter = self.adapter else { return }
            do { try adapter.perform(action); guard self.live(run) else { return }; self.schedule(0.12) { if self.live(run) { then() } } }
            catch { self.stop((error as? ChromeInstallCode) ?? .unconfirmed, run: run) }
        }
    }
    private func navigate(_ action: ChromeInstallAction, run: UUID, then: @escaping () -> Void) {
        if action == .versionURL { progressStage = "checking_profile" }
        else if action == .extensionsURL { progressStage = "extensions" }
        else if action == .detailsURL || action == .probeURL { progressStage = "validating_helper" }
        input(.focusAddress, stage: .normal, run: run) {
            self.input(action, stage: .normal, run: run) { self.input(.submitAddress, stage: .normal, run: run, then: then) }
        }
    }
    private func wait(_ stage: ChromeInstallStage, run: UUID, attempts: Int = 0, then: @escaping (ChromeInstallObservation) -> Void) {
        guard live(run) else { return }
        guard attempts < 45 else { stop(timeoutCode, run: run); return }
        authorized(stage: stage, run: run) { [weak self] in
            guard let self, self.live(run) else { return }
            do {
                if stage == .runningChrome { self.adapter?.observationBudget(until:ProcessInfo.processInfo.systemUptime + max(0,self.deadline - self.now())) }
                if let observation = try self.adapter?.observe(stage) { then(observation) }
                else { self.schedule(0.15) { self.wait(stage, run: run, attempts: attempts + 1, then: then) } }
            } catch { self.stop((error as? ChromeInstallCode) ?? .controls, run: run) }
        }
    }
    private func readInitialProfile(_ run: UUID) {
        wait(.version, run: run) { observation in
            guard case .version(let path, let major) = observation else { self.stop(.profile, run: run); return }
            guard major >= 128 else { self.stop(.oldChrome, run: run); return }
            guard URL(fileURLWithPath:path).lastPathComponent == self.lease?.profileID else { self.stop(.profile, run: run); return }
            self.profile = path
            self.navigate(.policyURL, run: run) {
                self.wait(.policies, run: run) { observation in
                    guard case .policiesClear = observation else { self.stop(.controls, run: run); return }
                    self.navigate(.extensionsURL, run: run) { self.inspectExtensions(run) }
                }
            }
        }
    }
    private func inspectExtensions(_ run: UUID) {
        wait(.extensions, run: run) { observation in
            guard case .extensions(let enabled) = observation else { self.stop(.controls, run: run); return }
            if enabled { self.existingOrLoad(run) }
            else {
                self.input(.developerMode, stage: .extensions, run: run) {
                    self.wait(.extensions, run: run) { next in
                        guard case .extensions(true) = next else { self.stop(.unconfirmed, run: run); return }
                        self.existingOrLoad(run)
                    }
                }
            }
        }
    }
    private func existingOrLoad(_ run: UUID) {
        wait(.helperList, run: run) { observation in
            switch observation {
            case .missingHelper: self.load(run)
            case .helperFound:
                self.navigate(.detailsURL, run: run) {
                    if self.repairing { self.repairDetails(run) } else { self.existingDetails(run) }
                }
            default: self.stop(.controls, run: run)
            }
        }
    }
    private func repairWait(_ stage: ChromeInstallRepairStage, run: UUID, attempts: Int = 0,
                            then: @escaping (ChromeInstallRepairObservation) -> Void) {
        guard live(run) else { return }
        guard attempts < 45 else { stop(.timeout, run: run); return }
        authorized(stage: .normal, repairStage: stage, run: run) {
            do {
                if let observation = try self.adapter?.observeRepair(stage) { then(observation) }
                else { self.schedule(0.15) { self.repairWait(stage, run: run, attempts: attempts + 1, then: then) } }
            } catch { self.stop((error as? ChromeInstallCode) ?? .controls, run: run) }
        }
    }
    private func repairInput(_ action: ChromeInstallRepairAction, stage: ChromeInstallRepairStage,
                             run: UUID, then: @escaping () -> Void) {
        authorized(stage: .normal, input: true, repairStage: stage, run: run) {
            do {
                guard let adapter = self.adapter else { throw ChromeInstallCode.target }
                try adapter.performRepair(action)
                guard self.live(run) else { return }
                self.schedule(0.12) { if self.live(run) { then() } }
            } catch { self.stop((error as? ChromeInstallCode) ?? .unconfirmed, run: run) }
        }
    }
    private func repairDetails(_ run: UUID) {
        repairWait(.details, run: run) { observation in
            guard case .details(_, let current, let sourceMatches) = observation else { self.stop(.controls, run: run); return }
            if current && sourceMatches { self.existingDetails(run); return }
            self.navigate(.extensionsURL, run: run) {
                self.progressStage = "removing_copy"
                self.repairWait(.removable, run: run) { ready in
                    guard case .removable = ready else { self.stop(.controls, run: run); return }
                    self.repairInput(.remove, stage: .removable, run: run) {
                        self.repairWait(.confirmation, run: run) { confirmation in
                            guard case .confirmation = confirmation else { self.stop(.sheet, run: run); return }
                            self.repairInput(.confirm, stage: .confirmation, run: run) {
                                self.repairWait(.removed, run: run) { removed in
                                    guard case .removed = removed else { self.stop(.verification, run: run); return }
                                    self.load(run)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    private func existingDetails(_ run: UUID) {
        wait(.helperDetails, run: run) { observation in
            guard case .helperDetails(let enabled, let current) = observation else { self.stop(.controls, run: run); return }
            if !enabled {
                self.input(.enableHelper, stage: .helperDetails, run: run) {
                    self.wait(.helperDetails, run: run) { next in
                        guard case .helperDetails(true, true) = next else { self.stop(.verification, run: run); return }
                        self.helperInstalled = true
                        self.reloadExisting(run)
                    }
                }
            } else if current { self.helperInstalled = true; self.reloadExisting(run) }
            else { self.stop(.verification, run: run) }
        }
    }
    private func reloadExisting(_ run: UUID) {
        navigate(.extensionsURL, run: run) {
            self.wait(.helperReady, run: run) { _ in
                self.input(.reloadHelper, stage: .helperReady, run: run) {
                    self.readInstalledProfile(run)
                }
            }
        }
    }
    private func load(_ run: UUID) {
        progressStage = "loading_directory"
        input(.loadUnpacked, stage: .extensions, run: run) {
            self.wait(.chooser, run: run) { observation in
                guard case .chooser = observation else { self.stop(.sheet, run: run); return }
                self.input(.goToFolder, stage: .chooser, run: run) {
                    self.wait(.goFolder, run: run) { _ in
                        self.input(.folderPath, stage: .goFolder, run: run) {
                            self.input(.submitFolder, stage: .goFolder, run: run) {
                                self.wait(.selectedFolder, run: run) { _ in
                                    self.input(.openFolder, stage: .selectedFolder, run: run) {
                                        self.wait(.chooserClosing, run: run) { _ in
                                            self.inspectLoadedHelper(run)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    private func inspectLoadedHelper(_ run: UUID) {
        // Picker dismissal only proves the sheet closed. Inspect the actual fixed
        // helper and source before describing an installation as present.
        navigate(.extensionsURL, run: run) { self.waitForLoadedHelper(run) }
    }
    private func waitForLoadedHelper(_ run: UUID, attempts: Int = 0) {
        wait(.helperList, run: run) { observation in
            if case .missingHelper = observation {
                // Chrome may publish the card after its picker closes. Observe a
                // bounded settling interval; never replay the load/open action.
                guard attempts < 44 else { self.stop(.notInstalled, run: run); return }
                self.schedule(0.15) { self.waitForLoadedHelper(run, attempts: attempts + 1) }
                return
            }
            guard case .helperFound = observation else { self.stop(.controls, run: run); return }
            self.navigate(.detailsURL, run: run) {
                self.wait(.helperDetails, run: run) { observation in
                    guard case .helperDetails(true, true) = observation else { self.stop(.verification, run: run); return }
                    self.helperInstalled = true
                    self.readInstalledProfile(run)
                }
            }
        }
    }
    private func readInstalledProfile(_ run: UUID) {
        // Same owned Chrome window, fixed helper source, and a fresh version tab
        // bind presence to the selected profile before waiting for NativeHost.
        input(.newTab, stage: .normal, run: run) {
            self.wait(.newTab, run: run) { _ in self.navigate(.versionURL, run: run) {
                self.wait(.finalVersion, run: run) { observation in
                    guard case .version(let path, let major) = observation, major >= 128 else { self.stop(.profile, run: run); return }
                    guard path == self.profile else {
                        let id = URL(fileURLWithPath:path).lastPathComponent
                        self.stop(self.helperInstalled && ChromeInstallLease.validProfile(id) && id != self.lease?.profileID ? .otherProfile : .profile, run: run); return
                    }
                    self.targetHelperInstalled = self.helperInstalled
                    self.navigate(.probeURL, run: run) { self.wait(.probe, run: run) { _ in
                        self.waitingForHandshake = true
                        self.verify(run)
                    } }
                }
            } }
        }
    }
    private func verify(_ run: UUID, attempts: Int = 0) {
        guard live(run), let lease else { return }
        guard attempts < 120 else { stop(timeoutCode, run: run); return }
        authorized(stage: .probe, run: run) {
            self.api(self.base + "verify", ["lease_id": lease.id]) { [weak self] result in
                guard let self, self.live(run) else { return }
                guard result["error"] == nil, result["active"] as? Bool == true,
                      result["code"] == nil || result["code"] is NSNull else { self.stop(.verification, run: run); return }
                self.helperSeen = self.helperSeen || result["helper_seen"] as? Bool == true
                if result["phase"] as? String == "probe_verified" {
                    // Re-read profile on a second owned tab; leave the verified probe tab intact.
                    self.input(.newTab, stage: .probe, run: run) {
                        self.wait(.newTab, run: run) { _ in self.navigate(.versionURL, run: run) {
                            self.wait(.finalVersion, run: run) { observation in
                                guard case .version(let path, let major) = observation, path == self.profile, major >= 128 else { self.stop(.profile, run: run); return }
                                self.complete(run)
                            }
                        } }
                    }
                } else { self.schedule(0.3) { self.verify(run, attempts: attempts + 1) } }
            }
        }
    }
    private func complete(_ run: UUID) {
        progressStage = "validating_helper"
        authorized(stage: .finalVersion, run: run) {
            do {
                guard let adapter = self.adapter, let lease = self.lease,
                      try adapter.finalEvidence() == lease.fingerprint else { throw ChromeInstallCode.source }
                // Restoration is a guarded optional action while the lease remains active.
                self.input(.restoreForeground, stage: .finalVersion, run: run) {
                    guard self.live(run) else { return }
                    do { guard try adapter.finalEvidence() == lease.fingerprint else { throw ChromeInstallCode.source } }
                    catch { self.stop((error as? ChromeInstallCode) ?? .source, run: run); return }
                    self.api(self.base + "finish", ["lease_id": lease.id, "native_verified": true, "source_fingerprint": lease.fingerprint]) { [weak self] result in
                        guard let self, self.live(run) else { return }
                        guard result["error"] == nil, result["phase"] as? String == "installed_verified",
                              result["active"] as? Bool == false, result["code"] == nil || result["code"] is NSNull else { self.stop(.verification, run: run); return }
                        self.generation = nil; self.lease = nil; self.profile = nil; self.adapter?.close(); self.adapter = nil
                    }
                }
            } catch { self.stop((error as? ChromeInstallCode) ?? .source, run: run) }
        }
    }
}

#if !CHATHAND_INSTALL_PURE_TEST
enum ChromeExtensionsPageOpener {
    static func open(applicationURL: URL? = nil, completion: @escaping ([String: Any]) -> Void) {
        ChromeInstallAXAdapter.openExtensionsPage(applicationURL: applicationURL, completion: completion)
    }
}

/// Protected as part of ChatHand itself; no approval controls or private values.
private final class ChromeInstallProgress {
    private var panel: NSPanel?
    private var label: NSTextField?
    func show(_ stage: String) {
        let names = ["preparing":LocalText.text("native.chrome.preparing"), "opening_chrome":LocalText.text("native.chrome.opening"), "checking_profile":LocalText.text("native.chrome.profile"), "extensions":LocalText.text("native.chrome.extensions"), "loading_directory":LocalText.text("native.chrome.loading"), "validating_helper":LocalText.text("native.chrome.validating")]
        guard let name = names[stage] else { return }
        if panel == nil {
            guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
            let frame = NSRect(x: screen.visibleFrame.midX - 220, y: screen.visibleFrame.maxY - 64, width: 440, height: 44)
            let view = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            view.level = .floating; view.isFloatingPanel = true; view.hidesOnDeactivate = false
            view.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            view.ignoresMouseEvents = true; view.isOpaque = false; view.backgroundColor = .clear
            let box = NSVisualEffectView(frame: NSRect(origin: .zero, size: frame.size))
            box.material = .hudWindow; box.blendingMode = .behindWindow; box.state = .active
            box.wantsLayer = true; box.layer?.cornerRadius = 10
            let text = NSTextField(labelWithString: "")
            text.frame = NSRect(x: 16, y: 12, width: 408, height: 20); text.font = .systemFont(ofSize: 13, weight: .medium)
            text.alignment = .center; box.addSubview(text); view.contentView = box
            panel = view; label = text
        }
        label?.stringValue = LocalText.text("native.chrome.progress", ["stage": name])
        panel?.orderFrontRegardless()
    }
    func close() { panel?.orderOut(nil); panel = nil; label = nil }
}

/// Live adapter is instantiated only by the private, HID-guarded App UI entry.
/// No Chrome configuration files, AppleScript, clipboard, permissions
/// requests or general event/tool arguments are used by this installer.
final class ChromeInstallAXAdapter: ChromeInstallAdapter {
    private static let extensionsQueue = DispatchQueue(label: "chathand.chrome.extensions-page-observation")
    private let presentation = ChromeInstallProgress()
    private var observationDeadline:TimeInterval?
    private(set) var failureDetail: ChromeInstallFailureDetail?
    private var discoveryProof: ChromeInstallDiscoveryProof?
    private var diagnosingPreflight = false
    private(set) var windowDiagnostics: [ChromeInstallWindowDiagnostic] = []
    private(set) var windowDiagnosticsComplete = false
    private(set) var windowDiagnosticsExpectedCount = 0
    private(set) var identityDifference: ChromeInstallWindowDifference?
    private struct CandidateWindow {
        let pid: Int32, epoch: Date, id: CGWindowID, reference: AXUIElement
    }
    private var pendingCandidate: CandidateWindow?
    private var runningChromeDeadline: TimeInterval?
    private let runtime: URL
    private var lease: ChromeInstallLease?
    private var chrome: NSRunningApplication?
    private var chromeURL: URL?
    private var launchRequested = false
    private var launchError = false
    var needsLaunch: Bool { true } // Always create an owned installation window for the selected profile.
    private var baselineIDs = Set<CGWindowID>()
    private var baselinePID: pid_t?
    private var baselineLaunch: Date?
    private var launch: Date?
    private var window: AXUIElement?
    private var windowID: CGWindowID?
    private var frame: CGRect?
    private var originalApp: NSRunningApplication?
    private var originalWindow: AXUIElement?
    private var originalLaunch: Date?
    private var monitors: [Any] = []
    private var workspaceMonitors: [NSObjectProtocol] = []
    private var sessionInactive = false
    private var screensAsleep = false
    var inputReady: Bool { !sessionInactive && !screensAsleep }
    private var interrupted = false
    private var activated = false
    private var restored = false
    private var chosenPath: String?
    private var addressValue: String?
    private var folderValueSet = false
    private var selectionVerified = false
    private var profilePath: String?
    private var helperID = ""
    private var helperName = ""
    private var helperNames = Set<String>()
    private var helperDisplayVersion = ""
    private var existingSourceVerified = false
    private var repairSourcePath: String?
    private var repairHelperName: String?
    private var removalIssued = false
    private var removalConfirmed = false
    private var helperAbsentRead: Set<UInt64>?
    private var policyRead: [String: String]?
    private var pressed = Set<ChromeInstallAction>()
    private var ownedTab: AXUIElement?
    private var pendingTab: (count: Int, previous: AXUIElement)?
    private let tag: Int64 = 0x4348494E5354414C
    private let fm = FileManager.default
    init(runtime: URL, discoveryProof: ChromeInstallDiscoveryProof? = nil) { self.runtime = runtime; self.discoveryProof = discoveryProof }
    func observationBudget(until deadline: TimeInterval) {
        runningChromeDeadline = min(runningChromeDeadline ?? deadline, deadline)
    }

    /// Preserve the measured NSWorkspace URL dispatch, then prove the selected
    /// visible page. This path never calls installer input methods or Chrome CLI.
    static func openExtensionsPage(applicationURL: URL?, completion: @escaping ([String: Any]) -> Void) {
        let reader = ChromeInstallAXAdapter(runtime: Bundle.main.bundleURL)
        let operation = ChromeExtensionsPageOpen(requestOpen: { current, done in
            extensionsQueue.async {
                do {
                    reader.observationDeadline = ProcessInfo.processInfo.systemUptime + 2
                    try reader.prepareExtensionsPage(applicationURL: applicationURL)
                    DispatchQueue.main.async {
                        guard current() else { return }
                        guard let url = reader.chromeURL else { done(.failure(.unavailable)); return }
                        let configuration = NSWorkspace.OpenConfiguration()
                        NSWorkspace.shared.open([URL(string: "chrome://extensions")!], withApplicationAt: url, configuration: configuration) { app, error in
                            DispatchQueue.main.async {
                                done(error == nil && app != nil ? .success(()) : .failure(.failed))
                            }
                        }
                    }
                } catch {
                    let code = (error as? ChromeExtensionsPageCode) ?? .unverified
                    DispatchQueue.main.async { done(.failure(code)) }
                }
            }
        }, observe: { deadline, done in
            extensionsQueue.async {
                reader.observationDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 1)
                let result: Result<Bool, ChromeExtensionsPageCode>
                do { result = .success(try reader.extensionsPageVisible()) }
                catch { result = .failure((error as? ChromeExtensionsPageCode) ?? .unverified) }
                DispatchQueue.main.async { done(result) }
            }
        })
        // Retain only until success/failure/deadline; stale queued reads grant nothing.
        operation.start { [operation] result in
            _ = operation.active
            completion(result)
        }
    }
    private func prepareExtensionsPage(applicationURL: URL?) throws {
        guard let installed = applicationURL ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome"),
              installed.standardizedFileURL.path == installed.resolvingSymlinksInPath().path,
              Bundle(url: installed)?.bundleIdentifier == "com.google.Chrome" else { throw ChromeExtensionsPageCode.unavailable }
        chromeURL = installed
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
        guard apps.count <= 1 else { throw ChromeExtensionsPageCode.unverified }
        if let app = apps.first {
            guard app.bundleURL?.standardizedFileURL == installed.standardizedFileURL, let date = app.launchDate else { throw ChromeExtensionsPageCode.unverified }
            baselinePID = app.processIdentifier; baselineLaunch = date
        }
    }
    private func extensionsPageVisible() throws -> Bool {
        guard AXIsProcessTrusted() else { throw ChromeExtensionsPageCode.accessibility }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
        if apps.isEmpty || apps.count == 2 { return false }
        guard apps.count == 1, let app = apps.first, app.bundleURL?.standardizedFileURL == chromeURL?.standardizedFileURL else { throw ChromeExtensionsPageCode.unverified }
        if let baselinePID {
            guard app.processIdentifier == baselinePID, app.launchDate == baselineLaunch else { throw ChromeExtensionsPageCode.unverified }
        }
        if let chrome {
            guard app.processIdentifier == chrome.processIdentifier, app.launchDate == launch else { throw ChromeExtensionsPageCode.unverified }
        } else { chrome = app; launch = app.launchDate }
        let appAX = AXUIElementCreateApplication(app.processIdentifier)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              let focused = element(appAX, "AXFocusedWindow"), role(focused) == "AXWindow",
              let windows = elements(appAX, "AXWindows"), windows.count <= 100, windows.contains(where: { same($0, focused) }),
              try sheetElements(focused).isEmpty else { return false }
        window = focused
        guard let address = try? currentAddress() else { return false }
        let window = focused
        let all = try nodes(window)
        let pages = all.filter { role($0) == "AXWebArea" && ["Extensions", "扩展程序", "擴充功能"].contains(label($0)) }
        guard pages.count == 1 else { return false }
        let rawURL = attr(pages[0], "AXURL")
        guard let documentURL = (rawURL as? URL)?.absoluteString ?? (rawURL as? String) else { return false }
        let content = try nodes(pages[0])
        let controls = content.filter {
            ["AXCheckBox", "AXSwitch"].contains(role($0)) &&
            (["Developer mode", "开发者模式", "开发人员模式", "開發人員模式"].contains(label($0)) || text($0, "AXIdentifier") == "devMode")
        }
        return ChromeExtensionsPageOpen.isExtensionsPage(address: address, documentURL: documentURL,
                                                         title: label(pages[0]), developerControl: controls.count == 1)
    }

    private func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        if let deadline=observationDeadline {
            guard ProcessInfo.processInfo.systemUptime < deadline else{return nil}
            guard AXUIElementSetMessagingTimeout(element,0.2) == .success else{return nil}
        }
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func text(_ element: AXUIElement, _ name: String) -> String? { (attr(element, name) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement]? { attr(element, name) as? [AXUIElement] }
    private func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attr(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    private func bool(_ element: AXUIElement, _ name: String) -> Bool? { (attr(element, name) as? NSNumber)?.boolValue }
    private func role(_ element: AXUIElement) -> String { text(element, "AXRole") ?? "" }
    private func label(_ element: AXUIElement) -> String { text(element, "AXTitle") ?? text(element, "AXDescription") ?? "" }
    private func same(_ a: AXUIElement, _ b: AXUIElement) -> Bool { CFEqual(a, b) }
    private func nodes(_ root: AXUIElement, descendWebAreas: Bool = true) throws -> [AXUIElement] {
        var out: [AXUIElement] = [], stack: [(AXUIElement, Int)] = [(root, 0)]
        while let (node, depth) = stack.popLast() {
            if let deadline=observationDeadline,ProcessInfo.processInfo.systemUptime >= deadline{throw ChromeInstallCode.profile}
            guard depth <= 40, out.count < 2500 else { throw ChromeInstallCode.controls }
            if out.contains(where: { same($0, node) }) { continue }
            out.append(node)
            if !descendWebAreas && role(node) == "AXWebArea" { continue }
            for child in elements(node, "AXChildren") ?? [] { stack.append((child, depth + 1)) }
        }
        return out
    }
    private func unique(_ list: [AXUIElement]) throws -> AXUIElement {
        guard list.count == 1 else { throw ChromeInstallCode.controls }; return list[0]
    }
    private func belongs(_ node: AXUIElement, to root: AXUIElement) -> Bool {
        var cursor: AXUIElement? = node
        for _ in 0..<50 { guard let current = cursor else { return false }; if same(current, root) { return true }; cursor = element(current, "AXParent") }
        return false
    }
    private func isAddress(_ node: AXUIElement) -> Bool {
        guard ["AXTextField", "AXComboBox"].contains(role(node)) else { return false }
        let names: Set<String> = ["Address and search bar", "地址和搜索栏", "地址栏和搜索栏", "網址列與搜尋列", "網址和搜尋列"]
        return names.contains(label(node)) || text(node, "AXIdentifier") == "omnibox"
    }
    private func address() throws -> AXUIElement { guard let window else { throw ChromeInstallCode.target }; return try unique(nodes(window).filter(isAddress)) }
    private func currentAddress() throws -> String { guard let value = text(try address(), "AXValue"), !value.isEmpty else { throw ChromeInstallCode.focus }; return value }
    private func tabs() throws -> ([AXUIElement], AXUIElement) {
        guard let window else { throw ChromeInstallCode.target }
        let group = try unique(nodes(window).filter { role($0) == "AXTabGroup" })
        let list = (elements(group, "AXChildren") ?? []).filter { ["AXRadioButton", "AXTab"].contains(role($0)) }
        guard !list.isEmpty else { throw ChromeInstallCode.controls }
        let selected = try unique(list.filter { bool($0, "AXSelected") == true || (attr($0, "AXValue") as? NSNumber)?.intValue == 1 })
        return (list, selected)
    }
    @discardableResult private func checkOwnedTab(waiting: Bool = false) throws -> Bool {
        let (list, selected) = try tabs()
        if let pending = pendingTab {
            if waiting && (list.count == pending.count && same(selected, pending.previous) || list.count == pending.count + 1 && same(selected, pending.previous)) { return false }
            guard list.count == pending.count + 1, !same(selected, pending.previous),
                  ["New Tab", "新标签页", "新分頁"].contains(label(selected)) else { throw ChromeInstallCode.unconfirmed }
            ownedTab = selected; pendingTab = nil
        }
        if let ownedTab { guard same(selected, ownedTab) else { throw ChromeInstallCode.interrupted } }
        return true
    }
    private func addressMatches(_ expected: String) -> Bool {
        guard let actual = try? currentAddress() else { return false }
        return actual == expected || expected.hasPrefix("chrome://") && actual == expected + "/"
    }
    private func appElement() throws -> AXUIElement { guard let chrome else { throw ChromeInstallCode.target }; return AXUIElementCreateApplication(chrome.processIdentifier) }
    private func sheetElements(_ target: AXUIElement) throws -> [AXUIElement] {
        if let deadline = observationDeadline {
            let timeout = Float(min(0.2,deadline - ProcessInfo.processInfo.systemUptime)).nextDown
            guard timeout > 0 else { try installFailure(.sheetsDeadline) }
            let timeoutResult = AXUIElementSetMessagingTimeout(target,timeout)
            guard timeoutResult == .success else { try installFailure(.sheetsTimeoutAXError, axError: timeoutResult.rawValue) }
        }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(target, "AXSheets" as CFString, &value)
        if let deadline = observationDeadline { guard ProcessInfo.processInfo.systemUptime < deadline else { try installFailure(.sheetsDeadline) } }
        if result == .noValue {
            guard value == nil else { try installFailure(.sheetsNoValueWithValue, axError: result.rawValue) }
            return []
        }
        if result == .attributeUnsupported {
            guard value == nil else { try unsupportedSheetFailure(.entryValuePresent) }
            return try unsupportedSheetElements(target)
        }
        guard result == .success else { try installFailure(.sheetsAXError, axError: result.rawValue) }
        guard let value else { try installFailure(.sheetsValueMissing, axError: 0) }
        guard CFGetTypeID(value) == CFArrayGetTypeID() else { try installFailure(.sheetsValueNotArray, axError: 0) }
        guard let list = value as? [AnyObject] else { try installFailure(.sheetsArrayCastFailed, axError: 0) }
        guard list.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { try installFailure(.sheetsElementInvalid, axError: 0) }
        return list.map { unsafeBitCast($0, to: AXUIElement.self) }
    }
    private func unsupportedSheetFailure(_ fallback: ChromeInstallFallbackCode) throws -> Never {
        failureDetail = ChromeInstallFailureDetail(.sheetsAXError, axError: -25205, fallbackCode: fallback)
        throw ChromeInstallCode.sheet
    }
    /// AXSheets is not a public attribute. Only its explicit unsupported result
    /// may use the public, reciprocal direct-child contract; incomplete evidence stops.
    private func unsupportedSheetElements(_ target: AXUIElement) throws -> [AXUIElement] {
        let start = ProcessInfo.processInfo.systemUptime
        let deadline = min(start + 2, observationDeadline ?? (start + 2))
        let nonSheetRoles: Set<String> = ["AXGroup", "AXToolbar", "AXTabGroup", "AXScrollArea", "AXSplitGroup", "AXWebArea", "AXButton"]
        func checkpoint() throws {
            guard ProcessInfo.processInfo.systemUptime < deadline else { try unsupportedSheetFailure(.deadline) }
            guard AXIsProcessTrusted() else { try unsupportedSheetFailure(.permissionChanged) }
        }
        func read(_ node: AXUIElement, _ name: String, failure: ChromeInstallFallbackCode) throws -> CFTypeRef? {
            try checkpoint()
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            let timeout = Float(min(0.2, remaining)).nextDown
            guard timeout > 0 else { try unsupportedSheetFailure(.deadline) }
            let configured = AXUIElementSetMessagingTimeout(node, timeout)
            try checkpoint()
            guard configured == .success else { try unsupportedSheetFailure(.timeoutSetupFailed) }
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(node, name as CFString, &value)
            try checkpoint()
            guard result == .success else { try unsupportedSheetFailure(failure) }
            return value
        }
        struct Snapshot {
            let children: [AXUIElement]
            let roles: [String]
            let parents: [AXUIElement]
        }
        func snapshot() throws -> Snapshot {
            let rawRole = try read(target, "AXRole", failure: .windowRoleReadFailed)
            guard let role = rawRole as? String, role.trimmingCharacters(in: .whitespacesAndNewlines) == "AXWindow" else { try unsupportedSheetFailure(.windowRoleInvalid) }
            let rawChildren = try read(target, "AXChildren", failure: .childrenReadFailed)
            guard let rawChildren, CFGetTypeID(rawChildren) == CFArrayGetTypeID() else { try unsupportedSheetFailure(.childrenInvalid) }
            let count = CFArrayGetCount(unsafeBitCast(rawChildren, to: CFArray.self))
            guard count > 0 else { try unsupportedSheetFailure(.childrenEmpty) }
            guard count <= 100 else { try unsupportedSheetFailure(.childrenLimit) }
            guard let values = rawChildren as? [AnyObject], values.count == count,
                  values.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { try unsupportedSheetFailure(.childrenInvalid) }
            let children = values.map { unsafeBitCast($0, to: AXUIElement.self) }
            var seen: [AXUIElement] = [], roles: [String] = [], parents: [AXUIElement] = []
            for child in children {
                try checkpoint()
                guard !CFEqual(child, target), !seen.contains(where: { CFEqual($0, child) }) else { try unsupportedSheetFailure(.childIdentityInvalid) }
                seen.append(child)
                let rawRole = try read(child, "AXRole", failure: .childRoleReadFailed)
                guard let role = rawRole as? String else { try unsupportedSheetFailure(.childRoleInvalid) }
                let normalized = role.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalized.isEmpty else { try unsupportedSheetFailure(.childRoleInvalid) }
                guard normalized == "AXSheet" || nonSheetRoles.contains(normalized) else { try unsupportedSheetFailure(.childRoleDisallowed) }
                let rawParent = try read(child, "AXParent", failure: .childParentReadFailed)
                guard let rawParent, CFGetTypeID(rawParent) == AXUIElementGetTypeID() else { try unsupportedSheetFailure(.childParentInvalid) }
                let parent = unsafeBitCast(rawParent, to: AXUIElement.self)
                guard CFEqual(parent, target) else { try unsupportedSheetFailure(.childParentInvalid) }
                roles.append(normalized); parents.append(parent)
            }
            return Snapshot(children: children, roles: roles, parents: parents)
        }
        let first = try snapshot(), second = try snapshot()
        guard first.children.count == second.children.count,
              zip(first.children, second.children).allSatisfy({ CFEqual($0.0, $0.1) }),
              first.roles == second.roles,
              zip(first.parents, second.parents).allSatisfy({ CFEqual($0.0, $0.1) }) else { try unsupportedSheetFailure(.snapshotChanged) }
        try checkpoint()
        return zip(second.children, second.roles).filter { $0.1 == "AXSheet" }.map { $0.0 }
    }
    private func sheets() throws -> [AXUIElement] {
        guard let window else { throw ChromeInstallCode.sheet }
        return try sheetElements(window)
    }
    private func picker() throws -> AXUIElement {
        let sheet = try unique(sheets())
        guard role(sheet) == "AXSheet", let window, belongs(sheet, to: window),
              ["Open", "Select the extension directory", "Choose a folder", "打开", "選取擴充功能目錄", "选择扩展程序目录", "选择文件夹", "選擇檔案夾"].contains(label(sheet)) else { throw ChromeInstallCode.sheet }
        return sheet
    }
    private func goSheet() throws -> AXUIElement {
        let panel = try picker(), nested = try nodes(panel).filter { !same($0, panel) && role($0) == "AXSheet" }
        let go = try unique(nested)
        let hasPrompt = try nodes(go).contains(where: { role($0) == "AXStaticText" && ["Go to the folder:", "前往文件夹：", "前往資料夾："].contains(text($0, "AXValue") ?? label($0)) })
        guard ["Go to the folder:", "Go to Folder", "前往文件夹：", "前往文件夹", "前往資料夾：", "前往資料夾"].contains(label(go)) || hasPrompt else { throw ChromeInstallCode.sheet }
        return go
    }
    private func pathField() throws -> AXUIElement { try unique(nodes(goSheet()).filter { role($0) == "AXTextField" && bool($0, "AXEnabled") == true }) }
    private func button(_ root: AXUIElement, _ names: Set<String>) throws -> AXUIElement {
        try unique(nodes(root).filter { role($0) == "AXButton" && names.contains(label($0)) && bool($0, "AXEnabled") == true })
    }
    private func developer() throws -> AXUIElement {
        guard let window else { throw ChromeInstallCode.target }
        return try unique(nodes(window).filter {
            ["AXCheckBox", "AXSwitch"].contains(role($0)) &&
            (["Developer mode", "开发者模式", "开发人员模式", "開發人員模式"].contains(label($0)) || text($0, "AXIdentifier") == "devMode") && bool($0, "AXEnabled") == true
        })
    }
    private func developerValue() throws -> Bool {
        guard let value = attr(try developer(), "AXValue") as? NSNumber, [0, 1].contains(value.intValue) else { throw ChromeInstallCode.controls }
        return value.intValue == 1
    }
    private func press(_ node: AXUIElement) throws {
        var actions: CFArray?
        guard AXUIElementCopyActionNames(node, &actions) == .success,
              (actions as? [String])?.contains("AXPress") == true else { throw ChromeInstallCode.controls }
        guard AXUIElementPerformAction(node, "AXPress" as CFString) == .success else { throw ChromeInstallCode.unconfirmed }
    }
    private func write(_ node: AXUIElement, _ value: String) throws {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(node, "AXValue" as CFString, &settable) == .success, settable.boolValue else { throw ChromeInstallCode.controls }
        guard AXUIElementSetAttributeValue(node, "AXValue" as CFString, value as CFString) == .success,
              text(node, "AXValue") == value else { throw ChromeInstallCode.unconfirmed }
    }
    private func keyboard(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
        guard let chrome, let window, NSWorkspace.shared.frontmostApplication?.processIdentifier == chrome.processIdentifier,
              let focusedWindow = element(try appElement(), "AXFocusedWindow"), same(focusedWindow, window),
              let focused = element(try appElement(), "AXFocusedUIElement"), belongs(focused, to: window), !interrupted else { throw ChromeInstallCode.focus }
        guard let down = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: code, keyDown: false) else { throw ChromeInstallCode.unconfirmed }
        for event in [down, up] { event.flags = flags; event.setIntegerValueField(.eventSourceUserData, value: tag); event.post(tap: .cghidEventTap) }
        // A posted pair is not a receipt; subsequent read-only observations must confirm each effect.
        guard !interrupted, NSWorkspace.shared.frontmostApplication?.processIdentifier == chrome.processIdentifier else { throw ChromeInstallCode.unconfirmed }
    }
    func preflight() throws {
        failureDetail = nil
        diagnosingPreflight = true
        windowDiagnostics = []; windowDiagnosticsComplete = false; windowDiagnosticsExpectedCount = 0
        identityDifference = nil; pendingCandidate = nil; runningChromeDeadline = nil
        defer { diagnosingPreflight = false; discoveryProof = nil }
        guard AXIsProcessTrusted() else { throw ChromeInstallCode.accessibility }
        guard let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome"),
              installed.standardizedFileURL.path == installed.resolvingSymlinksInPath().path,
              Bundle(url: installed)?.bundleIdentifier == "com.google.Chrome" else { throw ChromeInstallCode.chromeMissing }
        chromeURL = installed
        let metadata = runtime.appendingPathComponent("browser-extension/manifest.json")
        guard let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: metadata)) as? [String: Any],
              let name = manifest["name"] as? String, !name.isEmpty, name.count <= 100,
              let version = manifest["version"] as? String, version.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil,
              let encoded = manifest["key"] as? String, let key = Data(base64Encoded: encoded), key.count >= 100, key.count <= 4096 else { throw ChromeInstallCode.source }
        let catalogs = try ["zh_CN", "en"].map { locale -> [String: Any] in
            let url = runtime.appendingPathComponent("browser-extension/_locales/" + locale + "/messages.json")
            guard let catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw ChromeInstallCode.source }
            return catalog
        }
        helperNames = try ChromeInstallSource.displayNames(name, catalogs: catalogs)
        helperName = helperNames.sorted().first ?? ""
        helperDisplayVersion = ChromeInstallSource.displayVersion(manifest, numericVersion: version)
        helperID = SHA256.hash(data: key).prefix(16).map { byte in String(UnicodeScalar(97 + Int(byte >> 4))!) + String(UnicodeScalar(97 + Int(byte & 15))!) }.joined()
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
        originalApp = NSWorkspace.shared.frontmostApplication; originalLaunch = originalApp?.launchDate
        if let app = originalApp { originalWindow = element(AXUIElementCreateApplication(app.processIdentifier), "AXFocusedWindow") }
        try monitorInput()
        if apps.isEmpty { return } // Installed but stopped: launch is deferred until the private lease permits it.
        guard apps.count == 1, let date = apps[0].launchDate, apps[0].bundleURL?.standardizedFileURL.path == installed.path else { throw ChromeInstallCode.target }
        baselinePID = apps[0].processIdentifier; baselineLaunch = date
        let windows = try windowInventory(apps[0])
        baselineIDs = Set(windows.map { $0.0 })
    }
    private func installFailure(_ detail: ChromeInstallDetailCode, axError: Int32? = nil) throws -> Never {
        failureDetail = ChromeInstallFailureDetail(detail, axError: axError)
        throw detail.mainCode
    }
    /// Preserve the generic reader's deadline/timeout semantics without discarding AXError.
    private func inventoryAttribute(_ target: AXUIElement, _ name: String, code: ChromeInstallCode) throws -> (AXError, CFTypeRef?) {
        if let deadline = observationDeadline {
            let timeout = Float(min(0.2, deadline - ProcessInfo.processInfo.systemUptime)).nextDown
            guard timeout > 0, AXUIElementSetMessagingTimeout(target,timeout) == .success,
                  ProcessInfo.processInfo.systemUptime < deadline else { throw code }
        }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(target,name as CFString,&value)
        if let deadline = observationDeadline { guard ProcessInfo.processInfo.systemUptime < deadline else { throw code } }
        return (result,value)
    }
    /// Structural state only; optional metadata never supplies no-sheet evidence.
    private func windowStructuralContext(_ target: AXUIElement, id: CGWindowID, app: NSRunningApplication, deadline: TimeInterval) -> ChromeInstallEmptyWindowContext {
        let now = ProcessInfo.processInfo.systemUptime
        let relation = discoveryProof?.relation(pid:app.processIdentifier, epoch:app.launchDate?.timeIntervalSince1970,
            windowID:id, reference:target, now:now, equal:{ CFEqual($0, $1) }) ?? .anchorMissing
        if relation == .processChanged || relation == .anchorMissing { discoveryProof = nil }
        var context = ChromeInstallEmptyWindowContext(relation:relation)
        func sameProcess() -> Bool {
            let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
            return apps.count == 1 && apps[0].processIdentifier == app.processIdentifier && apps[0].launchDate != nil && apps[0].launchDate == app.launchDate
        }
        func read(_ attribute: String) -> CFTypeRef? {
            guard ProcessInfo.processInfo.systemUptime < deadline, AXIsProcessTrusted(), sameProcess() else { return nil }
            let timeout = Float(min(0.2, deadline - ProcessInfo.processInfo.systemUptime)).nextDown
            guard timeout > 0, AXUIElementSetMessagingTimeout(target, timeout) == .success,
                  AXIsProcessTrusted(), sameProcess(), ProcessInfo.processInfo.systemUptime < deadline else { return nil }
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(target, attribute as CFString, &value)
            guard result == .success, ProcessInfo.processInfo.systemUptime < deadline, AXIsProcessTrusted(), sameProcess() else { return nil }
            return value
        }
        func boolean(_ attribute: String) -> Bool? {
            guard let value = read(attribute), CFGetTypeID(value) == CFBooleanGetTypeID(), let number = value as? NSNumber else { return nil }
            return number.boolValue
        }
        if (diagnosingPreflight || runningChromeDeadline != nil), relation != .processChanged, sameProcess() {
            context.appActive = app.isActive; context.appHidden = app.isHidden
            context.minimized = boolean("AXMinimized"); context.main = boolean("AXMain"); context.focused = boolean("AXFocused")
            let subrole = read("AXSubrole") as? String
            context.subrole = subrole == "AXStandardWindow" ? .standard : subrole == "AXDialog" ? .dialog : .unknown
        }
        if !sameProcess() { context = ChromeInstallEmptyWindowContext(relation:.processChanged); discoveryProof = nil }
        return context
    }
    private func identityFailure(_ difference: ChromeInstallWindowDifference) throws -> Never {
        identityDifference = difference
        throw ChromeInstallCode.target
    }
    private func inventoryProcess(_ app: NSRunningApplication) throws {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
        guard !app.isTerminated, app.launchDate != nil, apps.count == 1,
              apps[0].processIdentifier == app.processIdentifier, apps[0].launchDate == app.launchDate else { try identityFailure(.processChanged) }
    }
    /// Identity only: never infer interaction readiness from a window's contents.
    private func windowIdentities(_ app: NSRunningApplication) throws -> [(CGWindowID, AXUIElement)] {
        var complete = false
        defer { if !complete, identityDifference == nil { identityDifference = .identityInvalid } }
        try inventoryProcess(app)
        let appAX = AXUIElementCreateApplication(app.processIdentifier)
        let (windowsResult, rawWindows) = try inventoryAttribute(appAX, "AXWindows", code: .target)
        guard windowsResult == .success else { try installFailure(.windowsAXError, axError: windowsResult.rawValue) }
        guard let rawWindows else { try installFailure(.windowsValueMissing, axError: 0) }
        guard CFGetTypeID(rawWindows) == CFArrayGetTypeID() else { try installFailure(.windowsValueInvalid,axError:0) }
        let count = CFArrayGetCount(unsafeBitCast(rawWindows,to:CFArray.self))
        guard count <= 100 else { try installFailure(.windowsTooMany,axError:0) }
        guard let windows = rawWindows as? [AXUIElement], windows.count == count else { try installFailure(.windowsValueInvalid, axError: 0) }
        var result: [(CGWindowID, AXUIElement)] = []
        for window in windows {
            let (roleResult, rawRole) = try inventoryAttribute(window, "AXRole", code: .sheet)
            guard roleResult == .success else { try installFailure(.windowRoleAXError, axError: roleResult.rawValue) }
            guard let role = rawRole as? String else { try installFailure(.windowRoleValueInvalid, axError: 0) }
            guard role.trimmingCharacters(in: .whitespacesAndNewlines) == "AXWindow" else { try installFailure(.windowRoleMismatch, axError: 0) }
            guard let reader = B2TargetClick.WindowReader.shared else { try installFailure(.windowIDReaderMissing) }
            guard let id = reader.id(window), id != 0 else { try installFailure(.windowIDUnavailable) }
            guard !result.contains(where:{ $0.0 == id || CFEqual($0.1,window) }) else { try installFailure(.windowIDDuplicate) }
            result.append((id, window))
        }
        guard Set(result.map { $0.0 }).count == result.count else { try installFailure(.windowIDDuplicate) }
        try inventoryProcess(app)
        complete = true
        return result
    }
    private func isEmptyWindow(_ code: ChromeInstallCode, _ detail: ChromeInstallFailureDetail?) -> Bool {
        code == .sheet && detail?.code == .sheetsAXError && detail?.axError == -25205 && detail?.fallbackCode == .childrenEmpty
    }
    private func windowInventory(_ app: NSRunningApplication) throws -> [(CGWindowID, AXUIElement)] {
        let prior = observationDeadline, now = ProcessInfo.processInfo.systemUptime
        let deadline = min(now + 2, prior ?? (now + 2))
        observationDeadline = deadline
        defer { observationDeadline = prior }
        failureDetail = nil; windowDiagnostics = []; windowDiagnosticsComplete = false; windowDiagnosticsExpectedCount = 0
        let identities = try windowIdentities(app)
        windowDiagnosticsExpectedCount = identities.count
        var rejection: (ChromeInstallCode, ChromeInstallFailureDetail?)?
        for (index, entry) in identities.enumerated() {
            if ProcessInfo.processInfo.systemUptime >= deadline { break }
            var state = ChromeInstallWindowSheets.clear
            var rowCode: ChromeInstallCode?, rowDetail: ChromeInstallFailureDetail?
            do {
                if try !sheetElements(entry.1).isEmpty {
                    state = .present; rowCode = .sheet
                    rowDetail = ChromeInstallFailureDetail(.sheetsPresent, axError:0)
                    rejection = (.sheet, rowDetail) // A real sheet has priority over unknown windows.
                }
            } catch let code as ChromeInstallCode {
                state = .unknown; rowCode = code; rowDetail = failureDetail
                if !isEmptyWindow(code, rowDetail), rejection?.1?.code != .sheetsPresent, rejection == nil { rejection = (code,rowDetail) }
            }
            let context = windowStructuralContext(entry.1, id:entry.0, app:app, deadline:deadline)
            if let detail = rowDetail, isEmptyWindow(rowCode ?? .sheet, detail) {
                rowDetail = ChromeInstallFailureDetail(detail.code, axError:detail.axError, fallbackCode:detail.fallbackCode, windowContext:context)
            }
            windowDiagnostics.append(.init(ordinal:index + 1, sheets:state, context:context, code:rowCode, detail:rowDetail))
            if !AXIsProcessTrusted() { if rejection?.1?.code != .sheetsPresent { rejection = (.permission,rowDetail) }; break }
            do { try inventoryProcess(app) }
            catch let code as ChromeInstallCode { if rejection?.1?.code == .sheetsPresent { break }; throw code }
        }
        windowDiagnosticsComplete = windowDiagnostics.count == identities.count
        if let (code, detail) = rejection { failureDetail = detail; throw code }
        guard windowDiagnosticsComplete, ProcessInfo.processInfo.systemUptime < deadline else { try installFailure(.sheetsDeadline) }
        failureDetail = nil
        return identities
    }
    private func captureTarget(_ apps: [NSRunningApplication], windowID newID: CGWindowID, inventory: [(CGWindowID, AXUIElement)]) throws -> Bool {
        guard apps.count == 1, let date = apps[0].launchDate, let bundle = apps[0].bundleURL,
              bundle.standardizedFileURL.path == bundle.resolvingSymlinksInPath().path,
              bundle.standardizedFileURL.path == chromeURL?.standardizedFileURL.path else { try identityFailure(.processChanged) }
        let exact = inventory.filter { $0.0 == newID }
        guard exact.count == 1 else { try identityFailure(.targetMissing) }
        guard !baselineIDs.contains(newID), Set(inventory.map { $0.0 }) == baselineIDs.union([newID]) else { try identityFailure(.unexpectedWindow) }
        let target = exact[0].1
        if let candidate = pendingCandidate {
            guard candidate.pid == apps[0].processIdentifier, candidate.epoch == date,
                  candidate.id == newID, same(candidate.reference,target) else { try identityFailure(.candidateChanged) }
        } else { pendingCandidate = CandidateWindow(pid:apps[0].processIdentifier, epoch:date, id:newID, reference:target) }
        func recordTarget(_ state: ChromeInstallWindowSheets, code: ChromeInstallCode? = nil, detail: ChromeInstallFailureDetail? = nil) {
            guard let index = inventory.firstIndex(where:{ $0.0 == newID }), index < windowDiagnostics.count else { return }
            let previous = windowDiagnostics[index]
            let finite = detail.flatMap { ChromeInstallFailureDetail($0.code, axError:$0.axError, fallbackCode:$0.fallbackCode, windowContext:previous.context) }
            windowDiagnostics[index] = .init(ordinal:previous.ordinal, sheets:state, context:previous.context, code:code, detail:finite)
        }
        do {
            guard try sheetElements(target).isEmpty else { try installFailure(.sheetsPresent,axError:0) }
            recordTarget(.clear)
        } catch let code as ChromeInstallCode {
            recordTarget(failureDetail?.code == .sheetsPresent ? .present : .unknown, code:code, detail:failureDetail)
            if isEmptyWindow(code,failureDetail) { failureDetail = nil; return false }
            throw code
        }
        guard let rect = ComputerControl.elementFrame(target), let info = B2TargetClick.windowInfo(pid:apps[0].processIdentifier,id:newID),
              let bounds = info[kCGWindowBounds as String] as? [String:Any], CGRect(dictionaryRepresentation:bounds as CFDictionary) == rect else { try identityFailure(.frameMismatch) }
        try inventoryProcess(apps[0])
        let current = try windowIdentities(apps[0])
        guard Set(current.map { $0.0 }) == baselineIDs.union([newID]) else { try identityFailure(.unexpectedWindow) }
        guard let candidate = pendingCandidate, candidate.pid == apps[0].processIdentifier, candidate.epoch == date,
              current.contains(where: { $0.0 == candidate.id && same($0.1,candidate.reference) }) else { try identityFailure(.candidateChanged) }
        guard AXIsProcessTrusted(), !interrupted else { throw ChromeInstallCode.interrupted }
        guard ProcessInfo.processInfo.systemUptime < (observationDeadline ?? 0) else { throw ChromeInstallCode.timeout }
        // Publish only after every throwing operation. No partial target binding can escape.
        chrome = apps[0]; launch = date; window = target; windowID = newID; frame = rect
        pendingCandidate = nil; failureDetail = nil
        return true
    }
    private func observeRunningChrome() throws -> ChromeInstallObservation? {
        guard AXIsProcessTrusted(), !interrupted else { throw ChromeInstallCode.interrupted }
        guard !launchError, launchRequested else { throw ChromeInstallCode.chromeMissing }
        guard let stageDeadline = runningChromeDeadline, ProcessInfo.processInfo.systemUptime < stageDeadline else { throw ChromeInstallCode.timeout }
        let prior = observationDeadline, now = ProcessInfo.processInfo.systemUptime
        observationDeadline = min(now + 2, min(stageDeadline, prior ?? stageDeadline))
        defer { observationDeadline = prior }
        let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
        if apps.isEmpty { if pendingCandidate != nil { try identityFailure(.processChanged) }; return nil }
        if apps.count == 2, pendingCandidate == nil { return nil } // fixed launcher may transiently coexist
        guard apps.count == 1 else { try identityFailure(.processChanged) }
        if let baselinePID { guard apps[0].processIdentifier == baselinePID, apps[0].launchDate == baselineLaunch else { try identityFailure(.processChanged) } }
        if let pendingCandidate { guard pendingCandidate.pid == apps[0].processIdentifier, pendingCandidate.epoch == apps[0].launchDate else { try identityFailure(.candidateChanged) } }
        let inventory = try windowInventory(apps[0]), ids = Set(inventory.map { $0.0 }), fresh = ids.subtracting(baselineIDs)
        guard baselineIDs.isSubset(of:ids) else { try identityFailure(.baselineMissing) }
        if fresh.isEmpty { if pendingCandidate != nil { try identityFailure(.targetMissing) }; return nil }
        guard fresh.count == 1, let id = fresh.first else { try identityFailure(.unexpectedWindow) }
        return try captureTarget(apps,windowID:id,inventory:inventory) ? .runningChrome : nil
    }
    func bind(_ lease: ChromeInstallLease) throws {
        guard !interrupted, try ChromeInstallSource.fingerprint(runtime: runtime) == lease.fingerprint else { throw ChromeInstallCode.source }
        self.lease = lease
    }
    private func monitorInput() throws {
        let center = NSWorkspace.shared.notificationCenter
        workspaceMonitors.append(center.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.sessionInactive = true })
        workspaceMonitors.append(center.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.sessionInactive = false })
        workspaceMonitors.append(center.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.screensAsleep = true })
        workspaceMonitors.append(center.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.screensAsleep = false })
        let mask: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .scrollWheel, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in self?.noteInput(event) }) { monitors.append(monitor) }
        else { throw ChromeInstallCode.interrupted }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in self?.noteInput(event); return event }) { monitors.append(monitor) }
        else { throw ChromeInstallCode.interrupted }
    }
    private func noteInput(_ event: NSEvent) {
        guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) != tag else { return }
        // Unlock input is not an installer action. No action can run while the
        // session/screens are inactive, and wake-up never replays an uncertain input.
        if !inputReady && !(event.type == .keyDown && event.keyCode == 53) { return }
        interrupted = true
    }
    private func identity(foreground: Bool) throws {
        guard AXIsProcessTrusted(), !interrupted else { throw ChromeInstallCode.interrupted }
        guard let chrome, !chrome.isTerminated, chrome.launchDate == launch else { try identityFailure(.processChanged) }
        try inventoryProcess(chrome)
        guard let window, let id = windowID, let frame else { try identityFailure(.targetMissing) }
        let identities = try windowIdentities(chrome), ids = Set(identities.map { $0.0 })
        guard baselineIDs.isSubset(of:ids) else { try identityFailure(.baselineMissing) }
        guard ids.contains(id) else { try identityFailure(.targetMissing) }
        guard ids == baselineIDs.union([id]), identities.count == baselineIDs.count + 1 else { try identityFailure(.unexpectedWindow) }
        guard identities.contains(where: { $0.0 == id && same($0.1,window) }), B2TargetClick.WindowReader.shared?.id(window) == id else { try identityFailure(.targetReferenceChanged) }
        guard ComputerControl.elementFrame(window) == frame,
              let info = B2TargetClick.windowInfo(pid:chrome.processIdentifier,id:id),
              let bounds = info[kCGWindowBounds as String] as? [String:Any], CGRect(dictionaryRepresentation:bounds as CFDictionary) == frame else { try identityFailure(.frameMismatch) }
        if foreground {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == chrome.processIdentifier,
                  bool(window, "AXMinimized") == false, bool(window, "AXFullScreen") == false,
                  (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
                  bool(window, "AXMain") == true,
                  let focusedWindow = element(try appElement(), "AXFocusedWindow"), same(focusedWindow, window),
                  let focused = element(try appElement(), "AXFocusedUIElement"), belongs(focused, to: window) else { throw ChromeInstallCode.focus }
        }
    }
    func check(_ stage: ChromeInstallStage, input: Bool) throws {
        try checkTarget(stage, input: input, removalDialogAllowed: false)
    }
    private func checkTarget(_ stage: ChromeInstallStage, input: Bool, removalDialogAllowed: Bool) throws {
        guard let lease, try ChromeInstallSource.fingerprint(runtime: runtime) == lease.fingerprint,
              try ChromeInstallSource.fingerprintFolder(lease.folder) == lease.fingerprint else { throw ChromeInstallCode.source }
        if chrome == nil {
            guard AXIsProcessTrusted(), !interrupted, chromeURL != nil, !launchError,
                  stage == .normal || stage == .runningChrome else { throw ChromeInstallCode.target }
            return
        }
        try identity(foreground: input && activated && !restored)
        if activated && (input || pendingTab == nil) { try checkOwnedTab() }
        if removalDialogAllowed {
            if try removalDialog() == nil { guard !input else { throw ChromeInstallCode.sheet } }
            return
        }
        switch stage {
        case .chooser, .selectedFolder, .goFolder, .chooserClosing:
            let direct = try sheets()
            if direct.isEmpty {
                guard !input else { throw ChromeInstallCode.sheet }
                return // read-only poll during known modal transitions
            }
            let panel = try picker(), nested = try nodes(panel).filter { !same($0, panel) && role($0) == "AXSheet" }
            if !nested.isEmpty {
                guard stage == .goFolder || stage == .selectedFolder else { throw ChromeInstallCode.sheet }
                _ = try goSheet()
            }
            if input {
                if stage == .goFolder { _ = try pathField() }
                else { guard nested.isEmpty else { throw ChromeInstallCode.sheet } }
            }
        default: guard try sheets().isEmpty else { throw ChromeInstallCode.sheet }
        }
    }
    func perform(_ action: ChromeInstallAction) throws {
        guard let lease else { throw ChromeInstallCode.invalidLease }
        switch action {
        case .launchChrome:
            guard chrome == nil, let chromeURL, !launchRequested else { throw ChromeInstallCode.target }
            let apps = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated }
            if let baselinePID {
                guard apps.count == 1, apps[0].processIdentifier == baselinePID, apps[0].launchDate == baselineLaunch,
                      Set(try windowInventory(apps[0]).map { $0.0 }) == baselineIDs else { throw ChromeInstallCode.target }
            } else { guard apps.isEmpty else { throw ChromeInstallCode.target } }
            launchRequested = true
            let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = false
            configuration.arguments = ["--profile-directory=" + lease.profileID, "--new-window", "chrome://version"]
            configuration.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: chromeURL, configuration: configuration) { [weak self] app, error in
                DispatchQueue.main.async { if error != nil || app == nil { self?.launchError = true } }
            }
        case .raiseWindow:
            guard let window, !activated,
                  bool(window, "AXMinimized") == false, bool(window, "AXFullScreen") == false else { throw ChromeInstallCode.unconfirmed }
            // Raise only the newly bound window. Existing minimized/full-screen/other
            // Space windows remain untouched; subsequent focus/on-screen proof is mandatory.
            var actions: CFArray?
            guard AXUIElementCopyActionNames(window, &actions) == .success,
                  (actions as? [String])?.contains("AXRaise") == true,
                  AXUIElementPerformAction(window, "AXRaise" as CFString) == .success else { throw ChromeInstallCode.unconfirmed }
        case .activate:
            guard let chrome, !activated else { throw ChromeInstallCode.unconfirmed }
            guard chrome.activate(options: [.activateIgnoringOtherApps]) else { throw ChromeInstallCode.focus }; activated = true
        case .newTab:
            let (list, selected) = try tabs(); try keyboard(17, flags: .maskCommand)
            pendingTab = (list.count, selected); addressValue = nil
        case .focusAddress: try keyboard(37, flags: .maskCommand)
        case .versionURL, .policyURL, .extensionsURL, .detailsURL, .probeURL:
            let node = try address(), focused = element(try appElement(), "AXFocusedUIElement")
            guard let focused, same(focused, node) || belongs(focused, to: node) else { throw ChromeInstallCode.focus }
            let value = action == .versionURL ? "chrome://version" : action == .policyURL ? "chrome://policy" : action == .extensionsURL ? "chrome://extensions" : action == .detailsURL ? "chrome://extensions/?id=" + helperID : lease.probeURL
            try write(node, value); addressValue = value
        case .submitAddress:
            guard let addressValue, try currentAddress() == addressValue else { throw ChromeInstallCode.unconfirmed }; try keyboard(36)
        case .developerMode:
            guard !pressed.contains(action), addressMatches("chrome://extensions"), try developerValue() == false else { throw ChromeInstallCode.controls }
            pressed.insert(action); try press(developer())
        case .loadUnpacked:
            guard !pressed.contains(action), addressMatches("chrome://extensions"), try developerValue() else { throw ChromeInstallCode.controls }
            pressed.insert(action); guard let window else { throw ChromeInstallCode.target }
            try press(button(window, ["Load unpacked", "加载已解压的扩展程序", "載入未封裝項目", "加载解压的扩展程序"]))
        case .enableHelper:
            guard !pressed.contains(action), addressMatches("chrome://extensions/?id=" + helperID), existingSourceVerified,
                  let window, try detailsEvidence() != nil else { throw ChromeInstallCode.source }
            let toggle = try helperToggle(window)
            guard try toggleValue(toggle) == false else { throw ChromeInstallCode.controls }
            pressed.insert(action); try press(toggle)
        case .reloadHelper:
            guard !pressed.contains(action), existingSourceVerified, addressMatches("chrome://extensions"),
                  let card = try helperCard(), try cardCurrent(card), try toggleValue(helperToggle(card)) else { throw ChromeInstallCode.source }
            pressed.insert(action); try press(button(card, ["Reload", "Reload extension", "重新加载", "重新載入", "重新加载扩展程序"]))
        case .goToFolder:
            guard !pressed.contains(action) else { throw ChromeInstallCode.unconfirmed }; _ = try picker()
            pressed.insert(action); try keyboard(5, flags: [.maskCommand, .maskShift])
        case .folderPath: try write(pathField(), lease.folder.path); folderValueSet = true
        case .submitFolder:
            guard folderValueSet, text(try pathField(), "AXValue") == lease.folder.path, !pressed.contains(action) else { throw ChromeInstallCode.unconfirmed }
            pressed.insert(action); try press(button(goSheet(), ["Go", "前往"]))
        case .openFolder:
            guard selectionVerified, try selectedFolder(), chosenPath == lease.folder.path, !pressed.contains(action) else { throw ChromeInstallCode.source }
            helperAbsentRead = nil
            pressed.insert(action); try press(button(picker(), ["Open", "Select", "Select Folder", "打开", "选择", "選取", "選擇"]))
        case .restoreForeground:
            // Never restore after user intervention or into a replaced previous app/window.
            guard !interrupted, let previous = originalApp, let date = originalLaunch,
                  !previous.isTerminated, previous.launchDate == date, let before = originalWindow,
                  let current = element(AXUIElementCreateApplication(previous.processIdentifier), "AXFocusedWindow"), same(before, current),
                  previous.processIdentifier != chrome?.processIdentifier else { return }
            guard previous.activate(options: [.activateIgnoringOtherApps]) else { throw ChromeInstallCode.focus }; restored = true
        }
    }
    private func hasHelperID(_ node: AXUIElement) -> Bool {
        let value = text(node, "AXValue") ?? label(node)
        return ChromeRepairEvidence.isFixedID(value, expected: helperID)
    }
    private func displayedHelperName(_ list: [AXUIElement]) throws -> String? {
        let matches = Set(list.map { text($0, "AXValue") ?? label($0) }).intersection(helperNames)
        guard matches.count <= 1 else { throw ChromeInstallCode.controls }
        return matches.first
    }
    private func helperCard() throws -> AXUIElement? {
        guard let window else { throw ChromeInstallCode.target }
        let list = try nodes(window), ids = list.filter(hasHelperID)
        if ids.isEmpty { return nil }
        let id = try unique(ids)
        var cursor = element(id, "AXParent")
        for _ in 0..<30 {
            guard let node = cursor, belongs(node, to: window) else { break }
            if role(node) == "AXGroup" {
                let descendants = try nodes(node)
                let details = descendants.filter { role($0) == "AXButton" && ["Details", "详细信息", "詳情", "詳細資料"].contains(label($0)) }
                let remove = descendants.filter { role($0) == "AXButton" && ["Remove", "移除", "删除"].contains(label($0)) }
                if details.count == 1, remove.count == 1, let name = try displayedHelperName(descendants) { helperName = name; return node }
            }
            cursor = element(node, "AXParent")
        }
        throw ChromeInstallCode.controls
    }
    private func helperToggle(_ root: AXUIElement) throws -> AXUIElement {
        let names: Set<String> = ["Enable", "Enabled", "On", "启用", "已启用", "啟用", "已啟用", "Enable " + helperName, "启用" + helperName, "啟用" + helperName]
        return try unique(nodes(root).filter {
            ["AXCheckBox", "AXSwitch"].contains(role($0)) && bool($0, "AXEnabled") == true &&
            (names.contains(label($0)) || ["enableToggle", "enable-toggle"].contains(text($0, "AXIdentifier") ?? ""))
        })
    }
    private func toggleValue(_ toggle: AXUIElement) throws -> Bool {
        guard let number = attr(toggle, "AXValue") as? NSNumber, [0, 1].contains(number.intValue) else { throw ChromeInstallCode.controls }
        return number.intValue == 1
    }
    private func cardCurrent(_ card: AXUIElement) throws -> Bool {
        try nodes(card).contains { node in (text(node, "AXValue") ?? label(node)) == helperDisplayVersion }
    }
    private func detailsEvidence() throws -> ChromeInstallObservation? {
        guard addressMatches("chrome://extensions/?id=" + helperID), let window, let lease else { return nil }
        let list = try nodes(window)
        guard list.contains(where: hasHelperID), let name = try displayedHelperName(list) else { return nil }
        helperName = name
        let paths = sourcePaths(list)
        guard paths.contains(lease.folder.path), paths.filter({ $0 != lease.folder.path }).isEmpty,
              try ChromeInstallSource.fingerprintFolder(lease.folder) == lease.fingerprint else { throw ChromeInstallCode.source }
        existingSourceVerified = true; chosenPath = lease.folder.path; selectionVerified = true
        let enabled = try toggleValue(helperToggle(window)), current = list.contains { (text($0, "AXValue") ?? label($0)) == helperDisplayVersion }
        if enabled && !current { return nil } // existing normal helper-update mechanism may still be refreshing the card
        return .helperDetails(enabled: enabled, current: current)
    }
    private func sourcePaths(_ list: [AXUIElement]) -> [String] {
        list.compactMap { node -> String? in
            let values = [text(node, "AXValue"), text(node, "AXURL"), text(node, "AXDescription")].compactMap { $0 }
            for value in values {
                var path = value
                for prefix in ["Loaded from: ", "Loaded from:　", "加载位置：", "加载位置: ", "載入來源："] { if path.hasPrefix(prefix) { path = String(path.dropFirst(prefix.count)) } }
                if path.hasPrefix("file://"), let url = URL(string: path), url.isFileURL { path = url.path }
                if path.hasPrefix("~/") { path = fm.homeDirectoryForCurrentUser.path + String(path.dropFirst()) }
                if path.hasPrefix("/") { return path }
            }
            return nil
        }
    }
    private func removalDialog() throws -> AXUIElement? {
        guard removalIssued, addressMatches("chrome://extensions"), let window else { throw ChromeInstallCode.sheet }
        let direct = try sheets(), all = try nodes(window)
        // Chrome can expose its confirmation as a web dialog or a native sheet.
        // Multiple/nested dialogs, an unrelated sheet, or an ambiguous title stop.
        let candidates = all.filter { role($0) == "AXDialog" || role($0) == "AXSheet" }
        if candidates.isEmpty { guard direct.isEmpty else { throw ChromeInstallCode.sheet }; return nil }
        let dialog = try unique(candidates)
        guard belongs(dialog, to: window), direct.allSatisfy({ same($0, dialog) }) else { throw ChromeInstallCode.sheet }
        let content = try nodes(dialog)
        let titles = [label(dialog)] + content.filter { role($0) == "AXStaticText" }.map { text($0, "AXValue") ?? label($0) }
        guard titles.contains(where: { ChromeRepairEvidence.removalTitle($0, helperName: helperName) }) else { throw ChromeInstallCode.sheet }
        _ = try button(dialog, ["Remove", "移除", "删除"])
        _ = try button(dialog, ["Cancel", "取消"])
        return dialog
    }
    func checkRepair(_ stage: ChromeInstallRepairStage, input: Bool) throws {
        try checkTarget(.normal, input: input, removalDialogAllowed: stage == .confirmation || stage == .removed)
        if stage != .confirmation && stage != .removed, let window,
           try nodes(window).contains(where: { role($0) == "AXDialog" }) { throw ChromeInstallCode.sheet }
    }
    func observeRepair(_ stage: ChromeInstallRepairStage) throws -> ChromeInstallRepairObservation? {
        guard let window, let lease else { throw ChromeInstallCode.target }
        switch stage {
        case .details:
            guard addressMatches("chrome://extensions/?id=" + helperID) else { return nil }
            let list = try nodes(window)
            guard list.contains(where: hasHelperID), let name = try displayedHelperName(list) else { return nil }
            _ = try unique(list.filter(hasHelperID))
            let path = try ChromeRepairEvidence.sourcePath(sourcePaths(list))
            repairSourcePath = path; repairHelperName = name; helperName = name
            return .details(enabled: try toggleValue(helperToggle(window)),
                            current: list.contains { (text($0, "AXValue") ?? label($0)) == helperDisplayVersion },
                            sourceMatches: path == lease.folder.path)
        case .removable:
            guard let source = repairSourcePath, !removalIssued, addressMatches("chrome://extensions"),
                  try developerValue(), let card = try helperCard() else { return nil }
            guard helperName == repairHelperName else { throw ChromeInstallCode.source }
            // A same-folder helper that refreshed since details was read no longer
            // needs removal. Stop rather than erase that now-current installation.
            if source == lease.folder.path {
                guard try !cardCurrent(card) else { throw ChromeInstallCode.verification }
            }
            _ = try button(card, ["Remove", "移除", "删除"])
            return .removable
        case .confirmation:
            guard !removalConfirmed else { throw ChromeInstallCode.unconfirmed }
            return try removalDialog() == nil ? nil : .confirmation
        case .removed:
            guard removalConfirmed else { throw ChromeInstallCode.unconfirmed }
            if try removalDialog() != nil { return nil }
            if case .missingHelper? = try observe(.helperList) { return .removed }
            return nil
        }
    }
    func performRepair(_ action: ChromeInstallRepairAction) throws {
        switch action {
        case .remove:
            guard case .removable? = try observeRepair(.removable), let card = try helperCard() else { throw ChromeInstallCode.controls }
            let remove = try button(card, ["Remove", "移除", "删除"])
            removalIssued = true // An uncertain press is never retried.
            try press(remove)
        case .confirm:
            guard !removalConfirmed, let dialog = try removalDialog() else { throw ChromeInstallCode.sheet }
            let confirm = try button(dialog, ["Remove", "移除", "删除"])
            removalConfirmed = true
            try press(confirm)
            existingSourceVerified = false; chosenPath = nil; selectionVerified = false; helperAbsentRead = nil
        }
    }
    private func selectedFolder() throws -> Bool {
        guard let lease else { throw ChromeInstallCode.invalidLease }
        let panel = try picker()
        let candidates = try nodes(panel).filter { node in
            let r = role(node)
            guard ["AXRow", "AXBrowser", "AXOutline", "AXPopUpButton", "AXTextField"].contains(r),
                  bool(node, "AXSelected") == true || (r == "AXPopUpButton" && ["Where:", "位置：", "位置:"].contains(label(node))) else { return false }
            let raw = text(node, "AXURL") ?? text(node, "AXFilename")
            guard let raw else { return false }
            let url = raw.hasPrefix("file://") ? URL(string: raw) : URL(fileURLWithPath: raw)
            return url?.isFileURL == true && url?.standardizedFileURL.path == lease.folder.path && url?.resolvingSymlinksInPath().path == lease.folder.path
        }
        return candidates.count == 1
    }
    private func policyEvidence() throws -> ChromeInstallObservation? {
        guard addressMatches("chrome://policy"), let window else { return nil }
        let all = try nodes(window)
        guard all.contains(where: { role($0) == "AXWebArea" && ["Policies", "Chrome Policies", "政策", "策略"].contains(label($0)) }) else { return nil }
        let empty = all.contains { ["No policies set", "未设置政策", "未设置任何政策", "未設定政策", "未设置策略"].contains(text($0, "AXValue") ?? label($0)) }
        let rows = all.filter { role($0) == "AXRow" }
        guard rows.count <= 256 else { throw ChromeInstallCode.controls }
        let headers = all.contains { ["Policy name", "政策名称", "政策名稱", "策略名称"].contains(text($0, "AXValue") ?? label($0)) }
        guard empty || headers && !rows.isEmpty else { return nil }
        var values: [String: String] = [:]
        for row in rows {
            let cells = elements(row, "AXChildren") ?? []
            let contents = try nodes(row)
            let names = Set(contents.compactMap { text($0, "AXValue") ?? text($0, "AXTitle") }.filter { ChromeInstallPolicies.names.contains($0) })
            guard names.count <= 1 else { throw ChromeInstallCode.controls }
            guard let name = names.first else { continue }
            guard values[name] == nil, cells.count >= 2,
                  ["AXCell", "AXGroup"].contains(role(cells[1])) else { throw ChromeInstallCode.controls }
            let valueNodes = try nodes(cells[1])
            let strings = Set(valueNodes.compactMap { node -> String? in
                guard ["AXStaticText", "AXTextField"].contains(role(node)) else { return nil }
                guard let value = text(node, "AXValue") ?? text(node, "AXTitle"), !value.isEmpty else { return nil }; return value
            })
            guard strings.count == 1, let value = strings.first, value.utf8.count <= 65536 else { throw ChromeInstallCode.controls }
            // Not-set rows are not effective policy values. Error/merged/multi-value
            // layouts cannot establish the effective value and stop as unknown.
            if ["Not set", "未设置", "未設定"].contains(value) { continue }
            values[name] = value
        }
        guard !empty || values.isEmpty else { throw ChromeInstallCode.controls }
        guard policyRead == values else { policyRead = values; return nil }
        try ChromeInstallPolicies.check(values, helperID: helperID)
        return .policiesClear
    }
    /// Observe only Chrome-rendered version pages. Never enumerate or read its data directory.
    static func observedProfiles(runtime: URL,deadline:TimeInterval, attempt: UUID? = nil, proof: ((ChromeInstallDiscoveryProof) -> Void)? = nil) throws -> [String] {
        guard AXIsProcessTrusted() else { throw ChromeInstallCode.accessibility }
        guard let installed=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.google.Chrome"),
              Bundle(url:installed)?.bundleIdentifier == "com.google.Chrome" else { throw ChromeInstallCode.chromeMissing }
        let apps=NSWorkspace.shared.runningApplications.filter{$0.bundleIdentifier == "com.google.Chrome" && !$0.isTerminated}
        guard apps.count <= 1 else { throw ChromeInstallCode.target }
        let proofStartedAt = ProcessInfo.processInfo.systemUptime
        let reader=ChromeInstallAXAdapter(runtime:runtime);reader.observationDeadline=deadline;var ids=Set<String>()
        var anchors: [ChromeInstallDiscoveryProof.Anchor] = []
        for app in apps {
            guard app.bundleURL?.standardizedFileURL == installed.standardizedFileURL,
                  let windows=reader.elements(AXUIElementCreateApplication(app.processIdentifier),"AXWindows"),windows.count <= 100 else {throw ChromeInstallCode.target}
            for window in windows {
                reader.window=window
                if case .version(let path, _)? = try reader.versionEvidence(discovering:true) {
                    let profileID = URL(fileURLWithPath:path).lastPathComponent
                    ids.insert(profileID)
                    // Failure to obtain a structural anchor never changes discovery semantics.
                    if let epoch = app.launchDate?.timeIntervalSince1970, let id = B2TargetClick.WindowReader.shared?.id(window), id != 0 {
                        anchors.append(.init(pid:app.processIdentifier, epoch:epoch, windowID:id, reference:window, profileID:profileID))
                    }
                }
                reader.profilePath=nil
            }
        }
        if let attempt, !anchors.isEmpty, ProcessInfo.processInfo.systemUptime < deadline {
            proof?(ChromeInstallDiscoveryProof(attempt:attempt, observedAt:proofStartedAt, anchors:anchors))
        }
        return ids.sorted()
    }
    private func versionEvidence(discovering: Bool = false) throws -> ChromeInstallObservation? {
        guard let window else { return nil }
        // Prove the selected address and document without walking unrelated page contents.
        let chromeNodes = try nodes(window, descendWebAreas: false)
        let addresses = chromeNodes.filter(isAddress)
        guard addresses.count == 1, let address = addresses.first,
              let value = text(address, "AXValue"), ["chrome://version", "chrome://version/"].contains(value) else { return nil }
        let pages = chromeNodes.filter { node in
            guard role(node) == "AXWebArea", let raw = attr(node, "AXURL") else { return false }
            let value = (raw as? URL)?.absoluteString ?? (raw as? String)
            return value == "chrome://version" || value == "chrome://version/"
        }
        guard pages.count == 1, let page = pages.first else { return nil }
        let all = try nodes(page)
        var fields: [ChromeVersionPageEvidence.Field] = []
        for node in all {
            let kind = role(node)
            guard ["AXRow", "AXGroup"].contains(kind) else { continue }
            let children = elements(node, "AXChildren") ?? []
            var labels = ([text(node, "AXTitle"), text(node, "AXDescription"), text(node, "AXValue")].compactMap { $0 }
                + children.flatMap { [text($0, "AXValue"), text($0, "AXTitle"), text($0, "AXDescription")].compactMap { $0 } })
                .filter { ChromeVersionPageEvidence.fieldName($0) != nil }
            // Legacy table cells may hold their label one level deeper.
            let contents: [AXUIElement]
            if kind == "AXRow" {
                contents = try nodes(node)
                labels += contents.compactMap { text($0, "AXValue") ?? text($0, "AXTitle") }
                    .filter { ChromeVersionPageEvidence.fieldName($0) != nil }
            } else {
                guard !labels.isEmpty else { continue }
                contents = try nodes(node)
            }
            // An outer layout group can contain both labelled field groups.
            // Let the individual fields contribute evidence; final uniqueness
            // still rejects conflicting profiles or complete version values.
            guard Set(labels.compactMap(ChromeVersionPageEvidence.fieldName)).count <= 1 else { continue }
            guard let fieldLabel = labels.first else { continue }
            let values = contents.filter { ["AXStaticText", "AXTextField"].contains(role($0)) }
                .compactMap { text($0, "AXValue") ?? text($0, "AXTitle") }
            fields.append(.init(label: fieldLabel, values: values))
        }
        // Older fixed-ID layouts remain supported within the proved document.
        for node in all {
            let identifiers = [text(node, "AXIdentifier"), text(node, "AXDOMIdentifier")].compactMap { $0 }
            guard let value = text(node, "AXValue") else { continue }
            if identifiers.contains("profile_path") { fields.append(.init(label: "Profile Path", values: [value])) }
            if identifiers.contains("version") { fields.append(.init(label: "Google Chrome", values: [value])) }
        }
        guard let evidence = ChromeVersionPageEvidence.parse(fields) else { return nil }
        let path = evidence.profile, home = fm.homeDirectoryForCurrentUser.standardizedFileURL.path
        let base = home + "/Library/Application Support/Google/Chrome/"
        guard path.hasPrefix(base), String(path.dropFirst(base.count)).range(of: "^(Default|Profile [0-9]{1,6})$", options: .regularExpression) != nil,
              URL(fileURLWithPath: path).standardizedFileURL.path == path else { throw ChromeInstallCode.profile }
        if !discovering && String(path.dropFirst(base.count)) != lease?.profileID {
            throw existingSourceVerified && profilePath != nil ? ChromeInstallCode.otherProfile : ChromeInstallCode.profile
        }
        if let profilePath, profilePath != path { throw ChromeInstallCode.profile }; profilePath = path
        return .version(profile: path, major: evidence.major)
    }
    func observe(_ stage: ChromeInstallStage) throws -> ChromeInstallObservation? {
        switch stage {
        case .runningChrome: return try observeRunningChrome()
        case .newTab: return try checkOwnedTab(waiting: true) ? .newTab : nil
        case .version, .finalVersion: return try versionEvidence()
        case .policies: return try policyEvidence()
        case .extensions:
            guard addressMatches("chrome://extensions") else { return nil }
            guard let window else { throw ChromeInstallCode.target }
            let controls = try nodes(window).filter { ["AXCheckBox", "AXSwitch"].contains(role($0)) && (["Developer mode", "开发者模式", "开发人员模式", "開發人員模式"].contains(label($0)) || text($0, "AXIdentifier") == "devMode") }
            if controls.isEmpty { return nil }
            return .extensions(developerMode: try developerValue())
        case .helperList:
            guard addressMatches("chrome://extensions"), try developerValue(), let window else { return nil }
            if try helperCard() != nil { return .helperFound }
            let list = try nodes(window)
            guard list.contains(where: { role($0) == "AXWebArea" && ["Extensions", "扩展程序", "擴充功能"].contains(label($0)) }) else { return nil }
            let buttons = list.filter { role($0) == "AXButton" && ["Details", "详细信息", "詳情", "詳細資料"].contains(label($0)) }
            let empty = list.contains { ["Your installed extensions appear here", "Find extensions and themes in the Chrome Web Store", "您安装的扩展程序会显示在这里", "你安装的扩展程序会显示在这里", "您安裝的擴充功能會顯示在這裡"].contains(text($0, "AXValue") ?? label($0)) }
            guard !buttons.isEmpty || empty else { return nil }
            let signature = Set(buttons.map { UInt64(bitPattern: Int64(CFHash($0))) })
            guard helperAbsentRead == signature else { helperAbsentRead = signature; return nil }
            return .missingHelper
        case .helperDetails: return try detailsEvidence()
        case .helperReady:
            guard existingSourceVerified, addressMatches("chrome://extensions"), let card = try helperCard(),
                  try cardCurrent(card), try toggleValue(helperToggle(card)) else { return nil }
            return .helperReady
        case .chooser: guard try !sheets().isEmpty else { return nil }; _ = try picker(); return .chooser
        case .goFolder:
            guard try !sheets().isEmpty else { return nil }
            let panel = try picker(); guard (try nodes(panel)).contains(where: { !same($0, panel) && role($0) == "AXSheet" }) else { return nil }
            let go = try goSheet(), fields = try nodes(go).filter { role($0) == "AXTextField" && bool($0, "AXEnabled") == true }
            if fields.isEmpty { return nil }; _ = try unique(fields); return .pathEntry
        case .selectedFolder:
            guard try !sheets().isEmpty else { return nil }
            let panel = try picker(); guard !(try nodes(panel)).contains(where: { !same($0, panel) && role($0) == "AXSheet" }) else { return nil }
            guard try selectedFolder(), let lease else { return nil }; chosenPath = lease.folder.path; selectionVerified = true; return .selectedFolder
        case .normal, .chooserClosing: return try sheets().isEmpty ? .chooserDismissed : nil
        case .probe: guard let lease else { throw ChromeInstallCode.invalidLease }; return addressMatches(lease.probeURL) ? .probe : nil
        }
    }
    func finalEvidence() throws -> String {
        try identity(foreground: !restored)
        try checkOwnedTab()
        guard let observation = try versionEvidence(), case .version(let path, _) = observation else { throw ChromeInstallCode.profile }
        guard try sheets().isEmpty, let lease, selectionVerified, chosenPath == lease.folder.path,
              profilePath != nil, path == profilePath,
              try ChromeInstallSource.fingerprint(runtime: runtime) == lease.fingerprint,
              try ChromeInstallSource.fingerprintFolder(lease.folder) == lease.fingerprint else { throw ChromeInstallCode.source }
        return lease.fingerprint
    }
    func progress(_ stage: String) { presentation.show(stage) }
    func failureEvidence(code: String, stage: String, current: @escaping () -> Bool, completion: @escaping ([String: Any]) -> Void) {
        let unavailable: [String: Any] = ["code":code,"stage":stage,"evidence_code":"CHROME_INSTALL_EVIDENCE_UNAVAILABLE"]
        guard current(), inputReady, CGPreflightScreenCaptureAccess(), let id = windowID, let chrome, let frame,
              frame.width > 0, frame.height > 0, frame.width <= 8192, frame.height <= 8192 else { if current() { completion(unavailable) }; return }
        let pid = chrome.processIdentifier, start = chrome.launchDate
        Task { @MainActor [self] in
          do {
            guard current() else { return }
            try identity(foreground: false)
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard current() else { return }
            try identity(foreground: false)
            let candidates = content.windows.filter { $0.windowID == id && $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame == frame }
            guard candidates.count == 1, let captureWindow = candidates.first, chrome.launchDate == start else { completion(unavailable); return }
            let filter = SCContentFilter(desktopIndependentWindow: captureWindow), configuration = SCStreamConfiguration()
            let scale = min(1, min(1024 / Double(frame.width), 768 / Double(frame.height)))
            configuration.width = max(1, Int(Double(frame.width) * scale)); configuration.height = max(1, Int(Double(frame.height) * scale))
            configuration.showsCursor = false; configuration.capturesAudio = false
            if #available(macOS 14.2, *) { configuration.ignoreShadowsSingleWindow = true }
            guard current() else { return }
            let captured = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            guard current() else { return }
            try identity(foreground: false) // same PID/start/AX/CG target after capture
            guard chrome.launchDate == start, captured.width > 0, captured.height > 0, captured.width <= 1600, captured.height <= 1200 else { completion(unavailable); return }
            let width = captured.width, height = captured.height
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { completion(unavailable); return }
            // Capture never leaves memory. Mask every pixel, including browser title,
            // toolbar, unknown sheets, path/nonce and page contents, before encoding.
            context.setFillColor(CGColor(gray: 0.92, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            ((LocalText.text("native.chrome.failureMasked", ["stage": stage])) as NSString).draw(in: NSRect(x:16,y:CGFloat(max(0,height-64)),width:CGFloat(max(1,width-32)),height:48), withAttributes:[.font:NSFont.systemFont(ofSize:13),.foregroundColor:NSColor.darkGray])
            NSGraphicsContext.restoreGraphicsState()
            guard let safe = context.makeImage() else { completion(unavailable); return }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { completion(unavailable); return }
            CGImageDestinationAddImage(destination, safe, [:] as CFDictionary)
            guard CGImageDestinationFinalize(destination), data.length <= 2 * 1024 * 1024 else { completion(unavailable); return }
            try identity(foreground: false)
            guard current() else { return }
            completion(["code":code,"stage":stage,"image_base64":(data as Data).base64EncodedString()])
          } catch { if current() { completion(unavailable) } }
        }
    }
    func close() {
        failureDetail = nil
        discoveryProof = nil; diagnosingPreflight = false
        pendingCandidate = nil; runningChromeDeadline = nil
        presentation.close()
        for monitor in monitors { NSEvent.removeMonitor(monitor) }; monitors.removeAll()
        for monitor in workspaceMonitors { NSWorkspace.shared.notificationCenter.removeObserver(monitor) }; workspaceMonitors.removeAll()
        lease = nil
    }
}
#endif
