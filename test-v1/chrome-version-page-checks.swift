import Foundation

// Synthetic AX objects only. The decoder methods below are extracted verbatim
// from production; no application, accessibility, permission or real-home APIs run.
final class FixtureAX {
    let kind: String, title: String
    let value: String?, url: String?, identifier: String?
    let children: [FixtureAX]
    init(_ kind: String, _ title: String = "", value: String? = nil,
         url: String? = nil, identifier: String? = nil, children: [FixtureAX] = []) {
        self.kind = kind; self.title = title; self.value = value
        self.url = url; self.identifier = identifier; self.children = children
    }
}
typealias AXUIElement = FixtureAX
struct FixtureHome { let homeDirectoryForCurrentUser = URL(fileURLWithPath: "/fixture") }
struct FixtureLease { let profileID = "Profile 4" }
final class Decoder {
    var window: AXUIElement?, observationDeadline: TimeInterval?
    var lease: FixtureLease? = FixtureLease(), existingSourceVerified = false
    var profilePath: String?
    let fm = FixtureHome()
    init(_ window: AXUIElement) { self.window = window }
    private func attr(_ node: AXUIElement, _ name: String) -> Any? {
        switch name {
        case "AXRole": return node.kind
        case "AXTitle": return node.title
        case "AXValue": return node.value
        case "AXURL": return node.url
        case "AXIdentifier", "AXDOMIdentifier": return node.identifier
        default: return nil
        }
    }
    private func text(_ node: AXUIElement, _ name: String) -> String? {
        (attr(node, name) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private func role(_ node: AXUIElement) -> String { node.kind }
    private func label(_ node: AXUIElement) -> String { node.title }
    private func elements(_ node: AXUIElement, _ name: String) -> [AXUIElement]? {
        name == "AXChildren" ? node.children : nil
    }
    private func same(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
/* PRODUCTION_NODES */
/* PRODUCTION_ADDRESS */
/* PRODUCTION_VERSION */
    func read(discovering: Bool = true) throws -> ChromeInstallObservation? {
        try versionEvidence(discovering: discovering)
    }
}

final class PreparationSchedule {
    var workers: [()->Void] = [], deliveries: [()->Void] = [], deadlines: [()->Void] = []
}
final class PreparationFixture {
    let schedule: PreparationSchedule, chromeProfileDiscovery: ChromeProfileDiscovery
    var chromeDiscoveryProof: ChromeInstallDiscoveryProof?, chromePreflightProof: ChromeInstallDiscoveryProof?
    var chromeDiscoveryProofSlot: ChromeInstallDiscoveryProofSlot?
    var shuttingDown = false
    var chromeInstallPreparation = UUID(), outerDeadline: (()->Void)?
    var replies: [[String:Any]] = []
    init() {
        let schedule = PreparationSchedule(); self.schedule = schedule
        chromeProfileDiscovery = ChromeProfileDiscovery(execute: {schedule.workers.append($0)},
            deliver: {schedule.deliveries.append($0)}, schedule: {_,work in schedule.deadlines.append(work)})
    }
/* PRODUCTION_PREPARATION */
        chromeProfileDiscovery.start(timeout: max(0,deadline-ProcessInfo.processInfo.systemUptime),
            read: {.success(["Profile 4"])}, completion: {result in
                switch result {
                case .failure(let code): finish(["error_code":code.rawValue])
                case .success(let ids): finish(["ids":ids])
                }
            })
    }
    func start() {
        observeChromeProfiles(preparation: chromeInstallPreparation, completion: {self.replies.append($0)})
    }
    func unblock() {schedule.workers[0](); schedule.deliveries[0]()}
}

@main struct Checks {
    static let profile = "/fixture/Library/Application Support/Google/Chrome/Profile 4"
    static let version = "155.0.8059.40 (Official Build) (arm64)"
    static var checks = 0
    static func expect(_ value: Bool, _ message: String) {
        precondition(value, message); checks += 1
    }
    static func field(_ label: String, _ value: String, rows: Bool = false) -> FixtureAX {
        let texts = [FixtureAX("AXStaticText", value: label), FixtureAX("AXStaticText", value: value)]
        return rows ? FixtureAX("AXRow", children: [FixtureAX("AXCell", children: texts)])
            : FixtureAX("AXGroup", label, children: texts)
    }
    static func page(rows: Bool = false, profile: String = profile, version: String = version,
                     url: String = "chrome://version/") -> FixtureAX {
        FixtureAX("AXWebArea", url: url, children: [
            field("Google Chrome:", version, rows: rows), field("Profile Path:", profile, rows: rows)])
    }
    static func window(_ page: FixtureAX, address: String = "chrome://version/",
                       other: [FixtureAX] = []) -> FixtureAX {
        FixtureAX("AXWindow", children: [
            FixtureAX("AXTextField", "Address and search bar", value: address), page] + other)
    }
    static func isVersion(_ value: ChromeInstallObservation?) -> Bool {
        if case .version(let path, let major)? = value { return path == profile && major == 155 }
        return false
    }
    static func rejectedProfile(_ decoder: Decoder, discovering: Bool = true) -> Bool {
        do { _ = try decoder.read(discovering: discovering); return false }
        catch ChromeInstallCode.profile { return true }
        catch { return false }
    }
    static func main() throws {
        expect(isVersion(try Decoder(window(page(rows: true))).read()), "legacy nested table cells")
        expect(isVersion(try Decoder(window(page())).read()), "current labelled AX groups and trailing colon")
        let wrapped = FixtureAX("AXWebArea", url: "chrome://version/", children: [
            FixtureAX("AXGroup", children: [field("Google Chrome:", version), field("Profile Path:", profile)])])
        expect(isVersion(try Decoder(window(wrapped)).read()), "outer layout group does not hide unique inner fields")
        let chrome155 = FixtureAX("AXWebArea", url: "chrome://version/", children: [
            FixtureAX("AXGroup", children: [
                FixtureAX("AXGroup", "Google Chrome:", children: [FixtureAX("AXStaticText", value: "Google Chrome:")]),
                FixtureAX("AXGroup", version + " Copy version string", children: [
                    FixtureAX("AXGroup", children: [FixtureAX("AXStaticText", value: version)])])]),
            FixtureAX("AXGroup", children: [
                FixtureAX("AXGroup", "Profile Path:", children: [FixtureAX("AXStaticText", value: "Profile Path:")]),
                FixtureAX("AXGroup", profile, children: [FixtureAX("AXStaticText", value: profile)])])])
        expect(isVersion(try Decoder(window(chrome155)).read()), "Chrome 155 observed sibling label/value containers")
        let foreign = FixtureAX("AXWebArea", url: "https://example.invalid",
            children: (0..<3000).map { _ in FixtureAX("AXStaticText", value: "unrelated") })
        expect(isVersion(try Decoder(window(page(), other: [foreign])).read()), "unrelated page contents are pruned")
        expect(try Decoder(window(page(), address: "https://example.invalid")).read() == nil, "selected address required")
        expect(try Decoder(window(page(url: "https://example.invalid"))).read() == nil, "internal document URL required")
        expect(try Decoder(window(page(), other: [page()])).read() == nil, "duplicate internal documents rejected")
        expect(rejectedProfile(Decoder(window(page(profile: profile.replacingOccurrences(of: "Profile 4", with: "Profile 5")))),
            discovering: false), "lease profile required")
        expect(rejectedProfile(Decoder(window(page(profile: "/other/Chrome/Profile 4")))), "home profile root required")
        expect(try Decoder(window(page(version: "155x0x8059x40"))).read() == nil, "literal dotted version required")
        let conflicting = FixtureAX("AXWebArea", url: "chrome://version", children: [
            field("Google Chrome", version), field("Google Chrome", "155.0.9000.1"),
            field("Profile Path", profile)])
        expect(try Decoder(window(conflicting)).read() == nil, "conflicting same-major versions rejected")
        let twoProfiles = FixtureAX("AXWebArea", url: "chrome://version", children: [
            field("Google Chrome", version), field("Profile Path", profile),
            field("Profile Path", profile.replacingOccurrences(of: "Profile 4", with: "Profile 5"))])
        expect(try Decoder(window(twoProfiles)).read() == nil, "conflicting profiles rejected")
        let localized = FixtureAX("AXWebArea", url: "chrome://version", children: [
            field("Google Chrome", version), field("個人資料路徑：", profile),
            field("Command Line", "/unrelated/command")])
        expect(isVersion(try Decoder(window(localized)).read()), "localized labels, unrelated command ignored")
        let fixedIDs = FixtureAX("AXWebArea", url: "chrome://version", children: [
            FixtureAX("AXStaticText", value: profile, identifier: "profile_path"),
            FixtureAX("AXStaticText", value: version, identifier: "version")])
        expect(isVersion(try Decoder(window(fixedIDs)).read()), "legacy fixed IDs supported within proved document")
        for outerFirst in [true,false] {
            let f = PreparationFixture(); f.start()
            if outerFirst {f.outerDeadline?(); f.schedule.deadlines[0]()}
            else {f.schedule.deadlines[0](); f.outerDeadline?()}
            f.unblock()
            expect(f.replies.count == 1, "one terminal response for either deadline order and a late AX return")
            expect(f.replies[0]["error_code"] as? String == "CHROME_INSTALL_TIMEOUT", "timeout never becomes user cancellation")
        }
        let cancelled = PreparationFixture(); cancelled.start(); cancelled.chromeProfileDiscovery.cancel()
        cancelled.outerDeadline?(); cancelled.unblock()
        expect(cancelled.replies.count == 1 && cancelled.replies[0]["error_code"] as? String == "CHROME_INSTALL_CANCELLED",
            "explicit cancellation retains its own terminal code")
        print("PASS: \(checks) production Chrome version decoder checks; synthetic AX only")
    }
}
