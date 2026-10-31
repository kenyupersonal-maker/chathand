import Foundation

@main struct ChatHandUninstallChecks {
    static let fm = FileManager.default
    static func check(_ value: @autoclosure () -> Bool, _ label: String) { if !value() { fatalError(label) } }
    static func refuses(_ label: String, _ body: () throws -> Void) { do { try body(); fatalError("expected refusal: " + label) } catch {} }
    static func main() throws {
        let root = fm.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("chathand-uninstall-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        func fixture(_ name: String) throws -> (URL, URL, URL, URL) {
            FileHandle.standardError.write(Data(("fixture: " + name + "\n").utf8))
            let home = root.appendingPathComponent(name), app = home.appendingPathComponent("Applications/ChatHand.app"), state = home.appendingPathComponent("Library/Application Support/ChatHand/data"), hosts = home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts")
            for dir in [app.appendingPathComponent("Contents"), state, hosts] { try fm.createDirectory(at: dir, withIntermediateDirectories: true) }
            let plist: [String: Any] = ["CFBundleIdentifier": "com.kenyu.chathand", "CFBundleExecutable": "ChatHand"]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
            try Data("fake data only".utf8).write(to: state.appendingPathComponent("fixture.txt"))
            for name in ["com.kenyu.chathand.browser", "org.kenbridge.browser"] {
                let object = ["name": name, "type": "stdio", "path": app.appendingPathComponent("Contents/Resources/runtime/bin/ken-browser-host").path]
                try JSONSerialization.data(withJSONObject: object).write(to: hosts.appendingPathComponent(name + ".json"))
            }
            try Data("foreign".utf8).write(to: hosts.appendingPathComponent("other.product.json"))
            return (home, app, state, hosts)
        }
        do {
            let (home, app, state, hosts) = try fixture("keep")
            let plan = try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: false)
            refuses("live backend") { try plan.execute(backendStopped: false, loginRemoved: true) }
            refuses("login item") { try plan.execute(backendStopped: true, loginRemoved: false) }
            check(fm.fileExists(atPath: app.path), "preconditions must not remove App")
            let lease = try plan.excludeUpgrade()
            refuses("updater cannot overlap uninstall") { _ = try plan.excludeUpgrade() }
            try plan.execute(backendStopped: true, loginRemoved: true, exclusion: lease)
            lease.release()
            check(!fm.fileExists(atPath: home.appendingPathComponent("Library/Application Support/ChatHand/upgrades/install.lock").path), "own lock removed")
            check(!fm.fileExists(atPath: app.path), "own App removed")
            check(fm.fileExists(atPath: state.appendingPathComponent("fixture.txt").path), "keep data")
            check(!fm.fileExists(atPath: hosts.appendingPathComponent("com.kenyu.chathand.browser.json").path), "host removed")
            check(!fm.fileExists(atPath: hosts.appendingPathComponent("org.kenbridge.browser.json").path), "legacy host removed")
            check(fm.fileExists(atPath: hosts.appendingPathComponent("other.product.json").path), "foreign host retained")
        }
        do {
            let (home, app, state, _) = try fixture("existing-upgrade")
            let lock = home.appendingPathComponent("Library/Application Support/ChatHand/upgrades/install.lock")
            try fm.createDirectory(at: lock, withIntermediateDirectories: true)
            try Data("existing transaction fixture".utf8).write(to: lock.appendingPathComponent("owner.json"))
            let plan = try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: true)
            refuses("existing upgrade is preserved") { _ = try plan.excludeUpgrade() }
            check(fm.fileExists(atPath: app.path), "App retained during existing upgrade")
            check(try! String(contentsOf: lock.appendingPathComponent("owner.json"), encoding: .utf8) == "existing transaction fixture", "lock unchanged")
        }
        do {
            let (home, app, state, _) = try fixture("delete")
            let outside = home.appendingPathComponent("personal.txt"); try Data("fake personal".utf8).write(to: outside)
            try fm.createSymbolicLink(at: state.appendingPathComponent("link"), withDestinationURL: outside)
            try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: true).execute(backendStopped: true, loginRemoved: true)
            check(!fm.fileExists(atPath: state.deletingLastPathComponent().path), "delete own data")
            check(fm.fileExists(atPath: outside.path), "never follow nested symlink")
        }
        do {
            let (home, app, state, hosts) = try fixture("foreign-host")
            let host = hosts.appendingPathComponent("org.kenbridge.browser.json")
            try JSONSerialization.data(withJSONObject: ["name":"org.kenbridge.browser", "type":"stdio", "path":"/fake/another/ChatHand.app/Contents/Resources/runtime/bin/ken-browser-host"]).write(to: host)
            refuses("foreign registration") { _ = try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: true) }
            check(fm.fileExists(atPath: app.path), "foreign preflight is all or nothing")
        }
        do {
            let (home, app, state, hosts) = try fixture("changed")
            let plan = try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: true)
            let host = hosts.appendingPathComponent("org.kenbridge.browser.json")
            try Data("changed fixture".utf8).write(to: host)
            refuses("changed after consent") { try plan.execute(backendStopped: true, loginRemoved: true) }
            check(fm.fileExists(atPath: hosts.appendingPathComponent("com.kenyu.chathand.browser.json").path), "preflight rejects before first delete")
        }
        do {
            let (home, app, state, _) = try fixture("symlink")
            let support = state.deletingLastPathComponent(), moved = home.appendingPathComponent("saved-fixture")
            try fm.moveItem(at: support, to: moved); try fm.createSymbolicLink(at: support, withDestinationURL: moved)
            refuses("symlink ancestor") { _ = try ChatHandUninstallPlan(app: app, home: home, state: state, deleteData: true) }
            refuses("arbitrary state") { _ = try ChatHandUninstallPlan(app: app, home: home, state: home, deleteData: true) }
            check(fm.fileExists(atPath: moved.appendingPathComponent("data/fixture.txt").path), "symlink destination retained")
        }
        // Kernel identity read is restricted to this disposable test executable.
        let selfIdentity = ChatHandProcessOwnership.identity(ProcessInfo.processInfo.processIdentifier)
        check(selfIdentity?.pid == ProcessInfo.processInfo.processIdentifier, "own helper PID identity")
        print("PASS: keep/delete, exact paths, foreign hosts, changed targets, symlinks, shutdown prerequisites, own PID identity")
    }
}
