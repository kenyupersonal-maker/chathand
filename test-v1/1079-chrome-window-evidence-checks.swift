// Synthetic multi-window evidence only. No native browser, permission or input API.
final class FallbackClock {
    static let processInfo = FallbackClock()
    let systemUptime: TimeInterval = 100
}
@main struct Checks {
    static var checks = 0
    static func expect(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
    static func field(_ label: String, _ value: String) -> FixtureAX {
        let group = FixtureAX("AXGroup", label)
        let name = FixtureAX("AXStaticText"); name.value = label
        let text = FixtureAX("AXStaticText"); text.value = value
        group.children = [name, text]; return group
    }
    static func window(id: UInt32, complete: Bool) -> FixtureAX {
        let window = FixtureAX(); window.number = id
        window.sheetResult = .attributeUnsupported; window.sheetValue = nil
        window.childrenResult = .success
        if complete {
            let group = FixtureAX("AXGroup"); group.parentResult = .success; group.parentValue = window
            let address = FixtureAX("AXTextField", "Address and search bar"); address.value = "chrome://version/"
            let page = FixtureAX("AXWebArea"); page.url = "chrome://version/"
            page.children = [field("Google Chrome:", "155.0.8059.40 (Official Build) (arm64)"), field("Profile Path:", "/fixture/Library/Application Support/Google/Chrome/Profile 4")]
            group.children = [address, page]; window.children = [group]
        }
        return window
    }
    static func reader(_ windows: [FixtureAX], focused: FixtureAX) -> Reader {
        fixtureTrusted = true; fixtureReadHook = nil; fixtureTimeoutHook = nil; fixtureTypeCheckHook = nil
        fixtureApp.windowsResult = .success; fixtureApp.overrideWindows = false; fixtureApp.children = windows
        B2TargetClick.WindowReader.shared = B2TargetClick.WindowReader()
        let reader = Reader(); reader.window = focused; return reader
    }
    static func unknownInventory(_ f: Reader, complete: FixtureAX, empty: FixtureAX, completeFirst: Bool) throws {
        var completeChildrenReads = 0, emptyChildrenReads = 0
        fixtureReadHook = { node, name in
            if name == "AXChildren", node === complete { completeChildrenReads += 1 }
            if name == "AXChildren", node === empty { emptyChildrenReads += 1 }
        }
        expect(try f.inventory() == 2, "complete identity inventory retains both windows")
        expect(f.failureDetail == nil, "unrelated empty window is not a fatal target result")
        expect(f.windowDiagnosticsComplete && f.windowDiagnostics.count == 2, "both window rows collected within one budget")
        let unknown = f.windowDiagnostics.first { $0.sheets == .unknown }
        expect(unknown?.detail?.code == .sheetsAXError && unknown?.detail?.axError == -25205 && unknown?.detail?.fallbackCode == .childrenEmpty, "empty evidence remains UNKNOWN with original finite reason")
        expect(f.windowDiagnostics.filter { $0.sheets == .clear }.count == 1, "only complete reciprocal window is CLEAR")
        expect(emptyChildrenReads == 1, "empty window retains its actual successful empty response")
        expect(completeChildrenReads == 2, "both orders collect the complete window's strict snapshots")
        fixtureReadHook = nil
    }
    static func main() throws {
        let complete = window(id: 11, complete: true), empty = window(id: 22, complete: false)
        expect(complete.kind == "AXWindow" && empty.kind == "AXWindow", "both fixtures have valid window role")
        expect(complete.number != nil && empty.number != nil && complete.number != empty.number, "both fixtures have distinct valid IDs")
        expect(empty.childrenResult == .success && empty.children.isEmpty, "empty window is a successful empty response, not a read failure")
        let single = reader([complete], focused: complete)
        expect(try single.inventory() == 1, "the complete reciprocal window alone passes current inventory")
        expect(single.failureDetail == nil, "single complete window has no failure receipt")
        expect(try single.sheetRefs().isEmpty, "single complete window proves an empty direct sheet set")

        // Same synthetic objects: an actual production versionEvidence decoder
        // can read Profile 4 from one while the other exposes no version page.
        if case .version(let profile, let major)? = try Decoder(complete).read() {
            expect(profile == "/fixture/Library/Application Support/Google/Chrome/Profile 4" && major == 155, "production versionEvidence succeeds on the complete window")
        } else { preconditionFailure("production version decoder did not read the complete window") }
        expect(try Decoder(empty).read() == nil, "the other empty window contributes no version evidence")
        try unknownInventory(reader([complete, empty], focused: complete), complete: complete, empty: empty, completeFirst: true)
        try unknownInventory(reader([empty, complete], focused: complete), complete: complete, empty: empty, completeFirst: false)

        let withSheet = window(id: 33, complete: true), sheet = FixtureAX("AXSheet")
        sheet.parentResult = .success; sheet.parentValue = withSheet; withSheet.children.append(sheet)
        let realSheet = reader([complete, withSheet], focused: withSheet)
        expect(try realSheet.sheetRefs().first === sheet, "the fallback preserves a genuine sheet reference")
        do { _ = try realSheet.inventory(); preconditionFailure("genuine sheet was cleared from inventory") }
        catch ChromeInstallCode.sheet { checks += 1 }
        expect(realSheet.failureDetail?.code == .sheetsPresent && realSheet.failureDetail?.axError == 0, "genuine sheet is distinguishable from CHILDREN_EMPTY")
        expect(realSheet.failureDetail?.fallbackCode == nil, "a found sheet does not reuse the empty-window rejection receipt")
        print("PASS: \(checks) multi-window evidence checks; production extracts and synthetic AX only")
        print("REPRODUCTION: both identity orders retain UNKNOWN CHILDREN_EMPTY beside CLEAR complete window")
        print("BOUNDARY: versionEvidence success and a separate empty window coexist in this fixture; real 1078 cause remains unproven")
    }
}
