import Foundation
import CoreFoundation

// These classes/functions are the complete injected AX boundary. No native
// application, accessibility, permission, browser, or real-home API is invoked.
final class FixtureAX {
    var kind: String, title: String, children: [FixtureAX] = []
    var number: UInt32? = 1, url = "", identifier = ""
    var sheetResult: AXError = .success, sheetValue: AnyObject? = NSArray()
    var metadataValues: [String:AnyObject] = [:], metadataResult: AXError = .success
    var messagingResult: AXError = .success
    var windowsResult: AXError = .success, roleResult: AXError = .success
    var overrideWindows = false, overrideRole = false
    var windowsValue: AnyObject?, roleValue: AnyObject?
    var childrenResult: AXError = .attributeUnsupported, parentResult: AXError = .attributeUnsupported
    var overrideChildren = false, childrenValue: AnyObject?, parentValue: AnyObject?
    init(_ kind: String = "AXWindow", _ title: String = "") { self.kind = kind; self.title = title }
}
final class FixtureArrayCastFailure: NSObject {}
typealias AXUIElement = FixtureAX
typealias CFTypeRef = AnyObject
typealias CFArray = AnyObject
typealias CFString = String
typealias CGWindowID = UInt32
enum AXError: Int32 { case success = 0, noValue = -25212, attributeUnsupported = -25205, cannotComplete = -25204, apiDisabled = -25211, invalidUIElement = -25202, failure = -25200, unknown = -25399 }
enum ChromeInstallCode: String, Error { case sheet = "CHROME_INSTALL_SHEET_UNKNOWN", target = "CHROME_INSTALL_TARGET_UNKNOWN"; case permission = "CHROME_INSTALL_PERMISSION_CHANGED", interrupted = "CHROME_INSTALL_USER_INTERRUPTED" }
/* PRODUCTION_DIAGNOSTIC_TYPES */
enum ChromeExtensionsPageCode: Error { case accessibility, unverified }
var fixtureTypeCheckHook: ((AnyObject) -> Void)?
func CFArrayGetCount(_ value: AnyObject) -> Int { (value as? NSArray)?.count ?? 1 }
func CFGetTypeID(_ value: AnyObject) -> Int { fixtureTypeCheckHook?(value); if value is NSNumber { return Int(CoreFoundation.CFGetTypeID(value)) }; return value is FixtureAX ? 1 : value is NSArray || value is FixtureArrayCastFailure ? 2 : 3 }
func CFBooleanGetTypeID() -> Int { Int(CoreFoundation.CFBooleanGetTypeID()) }
func AXUIElementGetTypeID() -> Int { 1 }
func CFArrayGetTypeID() -> Int { 2 }
var reads = 0, timeoutCalls = 0
var fixtureTrusted = true
var fixtureReadHook: ((FixtureAX, String) -> Void)?
var fixtureTimeoutHook: ((FixtureAX, Float) -> Void)?
func AXUIElementCopyAttributeValue(_ target: FixtureAX, _ name: String, _ value: inout AnyObject?) -> AXError {
    reads += 1; fixtureReadHook?(target, name)
    switch name {
    case "AXSheets": value = target.sheetValue; return target.sheetResult
    case "AXWindows": value = target.overrideWindows ? target.windowsValue : NSArray(array: target.children); return target.windowsResult
    case "AXRole": value = target.overrideRole ? target.roleValue : target.kind as NSString; return target.roleResult
    case "AXChildren": value = target.overrideChildren ? target.childrenValue : NSArray(array: target.children); return target.childrenResult
    case "AXParent": value = target.parentValue; return target.parentResult
    case "AXMinimized", "AXMain", "AXFocused", "AXSubrole": value = target.metadataValues[name]; return target.metadataResult
    default: preconditionFailure("unexpected fixture attribute")
    }
}
func AXUIElementSetMessagingTimeout(_ target: FixtureAX, _ timeout: Double) -> AXError {
    precondition(timeout == 0.2); timeoutCalls += 1; return target.messagingResult
}
func AXUIElementSetMessagingTimeout(_ target: FixtureAX, _ timeout: Float) -> AXError {
    precondition(timeout > 0 && timeout <= 0.2); timeoutCalls += 1
    fixtureTimeoutHook?(target, timeout); return target.messagingResult
}
func CFEqual(_ first: AnyObject, _ second: AnyObject) -> Bool { first === second }
let fixtureApp = FixtureAX("AXApplication")
func AXUIElementCreateApplication(_ pid: Int32) -> FixtureAX { precondition(pid == 1); return fixtureApp }
func AXIsProcessTrusted() -> Bool { fixtureTrusted }
struct NSRunningApplication {
    let bundleIdentifier = "com.google.Chrome"
    var processIdentifier: Int32 = 1, isTerminated = false, isActive = false, isHidden = false
    var launchDate: Date? = Date(timeIntervalSince1970: 100)
    let bundleURL: URL? = URL(fileURLWithPath: "/fixture/Chrome.app")
}
final class NSWorkspace {
    static let shared = NSWorkspace()
    var runningApplications = [NSRunningApplication()]
    var frontmostApplication: NSRunningApplication? = NSRunningApplication()
}
enum B2TargetClick {
    final class WindowReader {
        static var shared: WindowReader? = WindowReader()
        func id(_ node: FixtureAX) -> UInt32? { node.number }
    }
}
enum ChromeExtensionsPageOpen {
    static func isExtensionsPage(address: String, documentURL: String, title: String, developerControl: Bool) -> Bool {
        address == "chrome://extensions" && documentURL == "chrome://extensions/" && title == "Extensions" && developerControl
    }
}
final class Reader {
    var window: FixtureAX?, observationDeadline: TimeInterval?
    var failureDetail: ChromeInstallFailureDetail?
    var discoveryProof: ChromeInstallDiscoveryProof?, diagnosingPreflight = false
    var emptyWindowDeadline: TimeInterval?, runningChromeDeadline: TimeInterval?
    var windowDiagnostics: [ChromeInstallWindowDiagnostic] = []
    var windowDiagnosticsComplete = false, windowDiagnosticsExpectedCount = 0
    var identityDifference: ChromeInstallWindowDifference?
    var chromeURL: URL? = URL(fileURLWithPath: "/fixture/Chrome.app")
    var baselinePID: Int32?, baselineLaunch: Date?, chrome: NSRunningApplication?, launch: Date?
    func elements(_ node: FixtureAX, _ name: String) -> [FixtureAX]? {
        switch name {
        case "AXWindows", "AXChildren": return node.children
        case "AXSheets": return node.sheetResult == .success ? node.sheetValue as? [FixtureAX] : nil
        default: return nil
        }
    }
    func element(_ node: FixtureAX, _ name: String) -> FixtureAX? { name == "AXFocusedWindow" ? node.children.first : nil }
    func role(_ node: FixtureAX) -> String { node.kind }
    func label(_ node: FixtureAX) -> String { node.title }
    func same(_ a: FixtureAX, _ b: FixtureAX) -> Bool { a === b }
    func currentAddress() throws -> String { "chrome://extensions" }
    func nodes(_ root: FixtureAX) throws -> [FixtureAX] { [root] + root.children.flatMap { [$0] + $0.children } }
    func attr(_ node: FixtureAX, _ name: String) -> Any? { name == "AXURL" ? node.url : nil }
    func text(_ node: FixtureAX, _ name: String) -> String? { name == "AXIdentifier" ? node.identifier : nil }
/* PRODUCTION_SHEET_ELEMENTS */
/* PRODUCTION_SHEETS */
/* PRODUCTION_DIAGNOSTIC_READERS */
/* PRODUCTION_INVENTORY */
/* PRODUCTION_VISIBLE */
    func sheetCount() throws -> Int { try sheets().count }
    func inventory() throws -> Int { try windowInventory(NSRunningApplication()).count }
    func visible() throws -> Bool { try extensionsPageVisible() }
}
@main struct Checks {
    static var count = 0
    static func expect(_ condition: Bool, _ message: String) {
        precondition(condition, message); count += 1
    }
    static func outcome(_ operation: () throws -> Any) -> String {
        do { _ = try operation(); return "ok" }
        catch ChromeInstallCode.sheet { return "sheet" }
        catch ChromeInstallCode.target { return "target" }
        catch { return "other" }
    }
    static func reader(_ result: AXError, _ value: AnyObject?) -> Reader {
        let window = FixtureAX(); window.sheetResult = result; window.sheetValue = value
        let page = FixtureAX("AXWebArea", "Extensions"); page.url = "chrome://extensions/"
        let control = FixtureAX("AXCheckBox", "Developer mode"); control.identifier = "devMode"
        page.children = [control]; window.children = [page]; fixtureApp.children = [window]
        let reader = Reader(); reader.window = window; return reader
    }
    static func main() throws {
        for (result, value) in [(AXError.noValue, nil as AnyObject?), (.success, NSArray())] {
            let f = reader(result, value)
            expect(try f.sheetCount() == 0, "explicit absence returns zero sheets")
            expect(try f.inventory() == 1, "no-sheet Chrome window passes inventory")
            expect(try f.visible(), "no-sheet extensions page can be verified")
        }
        for result in [AXError.attributeUnsupported, .cannotComplete, .apiDisabled, .invalidUIElement, .failure, .unknown] {
            let f = reader(result, nil)
            expect(outcome { try f.sheetCount() } == "sheet", "sheet read failure stops")
            expect(outcome { try f.inventory() } == "sheet", "inventory read failure stops")
            expect(outcome { try f.visible() } == "sheet", "visibility read failure stops")
        }
        for value: AnyObject? in [nil, "not an array" as NSString, NSArray(object: "not an AX element"), NSArray(array: [FixtureAX("AXSheet"), "foreign"])] {
            let f = reader(.success, value)
            expect(outcome { try f.sheetCount() } == "sheet", "successful malformed value stops")
            expect(outcome { try f.inventory() } == "sheet", "malformed inventory sheet value stops")
            expect(outcome { try f.visible() } == "sheet", "malformed visible sheet value stops")
        }
        for value: AnyObject in [NSArray(), NSArray(object: FixtureAX("AXSheet"))] {
            let f = reader(.noValue, value)
            expect(outcome { try f.sheetCount() } == "sheet", "noValue with a contradictory value stops")
        }
        let sheet = FixtureAX("AXSheet"), f = reader(.success, NSArray(object: sheet))
        expect(try f.sheetCount() == 1, "real AX sheet preserved")
        expect(outcome { try f.inventory() } == "sheet", "attached sheet stops inventory")
        expect(try !f.visible(), "attached sheet blocks visible page verification")
        for kind in ["AXGroup", "AXWindow"] {
            let f = reader(.success, NSArray()); f.window?.kind = kind
            if kind == "AXWindow" { f.window?.number = nil }
            expect(outcome { try f.inventory() } == "sheet", "role and missing ID keep existing error contract")
        }
        let missing = Reader()
        expect(outcome { try missing.sheetCount() } == "sheet", "missing window stops")
        let duplicate = reader(.success, NSArray()); fixtureApp.children.append(FixtureAX())
        expect(outcome { try duplicate.inventory() } == "target", "duplicate IDs stop")
        for messaging in [AXError.success, .cannotComplete] {
            let f = reader(.noValue, nil); f.observationDeadline = ProcessInfo.processInfo.systemUptime + 10
            f.window?.messagingResult = messaging; let before = reads
            expect(outcome { try f.sheetCount() } == (messaging == .success ? "ok" : "sheet"), "messaging setup must succeed")
            expect(reads == before + (messaging == .success ? 1 : 0), "failed messaging setup performs no read")
        }
        let expired = reader(.noValue, nil); expired.observationDeadline = 0
        let before = reads, priorTimeouts = timeoutCalls
        expect(outcome { try expired.sheetCount() } == "sheet", "expired observation stops")
        expect(reads == before && timeoutCalls == priorTimeouts, "expired observation performs no AX boundary calls")
        print("PASS: \(count) production sheet attribute checks; no live AX")
    }
}
