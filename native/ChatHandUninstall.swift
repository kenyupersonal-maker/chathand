import Foundation
import Darwin
import CoreFoundation
import Security

/// Native-menu-only filesystem plan. There is deliberately no executable, RPC,
/// URL scheme, JavaScript bridge message or tool entrypoint for this operation.
struct ChatHandUninstallPlan {
    enum Failure: Error { case unsupportedLocation, identity, unsafePath, changed, foreignHost, upgradeBusy }
    struct Target {
        let url: URL
        let device: UInt64
        let inode: UInt64
        let directory: Bool
        let hostContents: Data?
    }
    let app: URL
    let home: URL
    let deleteData: Bool
    private let incremental: Bool
    private let support: URL
    private let targets: [Target]

    init(app: URL, home: URL, state: URL, deleteData: Bool, incremental: Bool = false) throws {
        let app = app.standardizedFileURL, home = home.standardizedFileURL
        let support = home.appendingPathComponent("Library/Application Support/ChatHand", isDirectory: true)
        guard [home.appendingPathComponent("Applications/ChatHand.app").path, "/Applications/ChatHand.app"].contains(app.path),
              ["data", "v05"].map({ support.appendingPathComponent($0).path }).contains(state.standardizedFileURL.path) else { throw Failure.unsupportedLocation }
        self.app = app; self.home = home; self.deleteData = deleteData; self.support = support; self.incremental = incremental
        try Self.checkAncestors(app)
        let info = app.appendingPathComponent("Contents/Info.plist")
        try Self.checkAncestors(info)
        guard let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: info), format: nil) as? [String: Any],
              plist["CFBundleIdentifier"] as? String == "com.kenyu.chathand",
              ["ChatHand", "KenBridge"].contains(plist["CFBundleExecutable"] as? String ?? "") else { throw Failure.identity }
        var targets: [Target] = []
        let hosts = home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts")
        for name in (incremental ? [] : ["com.kenyu.chathand.browser", "org.kenbridge.browser"]) {
            let url = hosts.appendingPathComponent(name + ".json")
            if let target = try Self.snapshot(url, directory: false, readHost: true) {
                guard let value = try JSONSerialization.jsonObject(with: target.hostContents!) as? [String: Any],
                      value["name"] as? String == name, value["type"] as? String == "stdio",
                      ["ken-browser-host", "ChatHandBrowserHost"].map({ app.appendingPathComponent("Contents/Resources/runtime/bin/" + $0).path }).contains(value["path"] as? String ?? "") else { throw Failure.foreignHost }
                targets.append(target)
            }
        }
        guard let bundle = try Self.snapshot(app, directory: true) else { throw Failure.identity }
        targets.append(bundle)
        // Keep the install lock alive until the App has been removed.
        if deleteData && !incremental, let target = try Self.snapshot(support, directory: true) { targets.append(target) }
        self.targets = targets
    }

    // Foundation canonicalizes macOS /private/var back to /var. Permit only
    // that fixed OS alias; never resolve user-controlled ancestor symlinks.
    private static func checkAncestors(_ url: URL) throws {
        var cursor = URL(fileURLWithPath: "/", isDirectory: true)
        for part in url.pathComponents.dropFirst() {
            cursor.appendPathComponent(part)
            do {
                let a = try FileManager.default.attributesOfItem(atPath: cursor.path)
                if a[.type] as? FileAttributeType == .typeSymbolicLink {
                    let destination = try FileManager.default.destinationOfSymbolicLink(atPath: cursor.path)
                    guard cursor.path == "/var", ["private/var", "/private/var"].contains(destination) else { throw Failure.unsafePath }
                }
            } catch let error as NSError where error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) { break }
        }
    }
    private static func snapshot(_ url: URL, directory: Bool, readHost: Bool = false) throws -> Target? {
        try checkAncestors(url)
        let a: [FileAttributeKey: Any]
        do { a = try FileManager.default.attributesOfItem(atPath: url.path) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) { return nil }
        guard a[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              let device = a[.systemNumber] as? NSNumber, let inode = a[.systemFileNumber] as? NSNumber,
              (a[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              directory || (a[.referenceCount] as? NSNumber)?.intValue == 1,
              !readHost || ((a[.size] as? NSNumber)?.intValue ?? Int.max) <= 65536 else { throw Failure.unsafePath }
        return Target(url: url, device: device.uint64Value, inode: inode.uint64Value, directory: directory, hostContents: readHost ? try Data(contentsOf: url) : nil)
    }
    private func revalidate(_ target: Target) throws {
        guard let current = try Self.snapshot(target.url, directory: target.directory, readHost: target.hostContents != nil),
              current.device == target.device, current.inode == target.inode,
              current.hostContents == target.hostContents else { throw Failure.changed }
    }
    func validate() throws { for target in targets { try revalidate(target) } }
    // Immutable receipt; all uses revalidate the pinned filesystem identity.
    final class UpgradeExclusion: @unchecked Sendable {
        fileprivate let directory: URL
        private let owner: Data
        private let target: Target
        private let createdParents: [URL]
        fileprivate init(directory: URL, owner: Data, target: Target, createdParents: [URL]) {
            self.directory = directory; self.owner = owner; self.target = target; self.createdParents = createdParents
        }
        fileprivate func validate() throws {
            guard let now = try ChatHandUninstallPlan.snapshot(directory, directory: true),
                  now.device == target.device, now.inode == target.inode,
                  try Data(contentsOf: directory.appendingPathComponent("owner.json")) == owner else { throw Failure.changed }
        }
        func release() {
            guard (try? validate()) != nil else { return }
            // Only the two entries created by us; never reap an existing lock.
            _ = unlink(directory.appendingPathComponent("owner.json").path)
            _ = rmdir(directory.path)
            for parent in createdParents { _ = rmdir(parent.path) } // Empty directories only.
        }
        deinit { release() }
    }
    func excludeUpgrade() throws -> UpgradeExclusion {
        try validate()
        let upgrades = support.appendingPathComponent("upgrades"), lock = upgrades.appendingPathComponent("install.lock")
        try Self.checkAncestors(lock)
        let created = [upgrades, support].filter { !FileManager.default.fileExists(atPath: $0.path) }
        try FileManager.default.createDirectory(at: upgrades, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard mkdir(lock.path, 0o700) == 0 else { if errno == EEXIST { throw Failure.upgradeBusy }; throw NSError(domain:NSPOSIXErrorDomain,code:Int(errno)) }
        let owner = try JSONSerialization.data(withJSONObject: ["pid": getpid(), "token": UUID().uuidString, "purpose": "native-menu-uninstall"])
        do {
            try owner.write(to: lock.appendingPathComponent("owner.json"), options: .withoutOverwriting)
            guard let target = try Self.snapshot(lock, directory: true) else { throw Failure.changed }
            return UpgradeExclusion(directory: lock, owner: owner, target: target, createdParents: created)
        } catch { _ = unlink(lock.appendingPathComponent("owner.json").path); _ = rmdir(lock.path); throw error }
    }
    // The caller first unregisters the login item and stops/awaits this App's
    // backend and exact runtime processes. Failures stop before any removal.
    func execute(backendStopped: Bool, loginRemoved: Bool, exclusion: UpgradeExclusion? = nil) throws {
        guard backendStopped, loginRemoved else { throw Failure.changed }
        let lease = try exclusion ?? excludeUpgrade()
        defer { if exclusion == nil { lease.release() } }
        guard lease.directory.standardizedFileURL.path == support.appendingPathComponent("upgrades/install.lock").standardizedFileURL.path else { throw Failure.changed }
        try lease.validate()
        try validate()
        for target in targets { try revalidate(target); try Self.removeExact(target) }
    }

    struct Item {
        let stage: String
        let url: URL
        let code: String
        let remaining: Bool
        let preserved: Bool
    }
    struct Report {
        var items: [Item] = []
        var complete: Bool { !items.contains { $0.remaining } }
    }
    static func reason(_ error: Error) -> String {
        if let value = error as? Failure {
            switch value {
            case .unsupportedLocation: return "UNSUPPORTED_LOCATION"
            case .identity: return "IDENTITY_FAILED"
            case .unsafePath: return "UNSAFE_PATH"
            case .changed: return "TARGET_CHANGED"
            case .foreignHost: return "FOREIGN_RETAINED"
            case .upgradeBusy: return "UPGRADE_BUSY"
            }
        }
        let value = error as NSError
        if (value.domain == NSPOSIXErrorDomain && [Int(EACCES),Int(EPERM)].contains(value.code)) ||
            (value.domain == NSCocoaErrorDomain && [NSFileReadNoPermissionError,NSFileWriteNoPermissionError].contains(value.code)) { return "ACCESS_DENIED" }
        return "IO_FAILED"
    }
    private func ownedAppBackup(_ target:Target) throws -> Bool {
        let info=target.url.appendingPathComponent("Contents/Info.plist")
        guard let header=try Self.snapshot(info,directory:false,readHost:true),let bytes=header.hostContents,
              let value=(try? PropertyListSerialization.propertyList(from:bytes,format:nil)) as? [String:Any],
              value["CFBundleIdentifier"] as? String == "com.kenyu.chathand",
              ["ChatHand","KenBridge"].contains(value["CFBundleExecutable"] as? String ?? "") else{return false}
        var source:SecStaticCode?,backup:SecStaticCode?,requirement:SecRequirement?
        guard SecStaticCodeCreateWithPath(app as CFURL,[],&source)==errSecSuccess,let source,
              SecStaticCodeCheckValidity(source,SecCSFlags(rawValue:kSecCSStrictValidate),nil)==errSecSuccess,
              SecCodeCopyDesignatedRequirement(source,[],&requirement)==errSecSuccess,let requirement,
              SecStaticCodeCreateWithPath(target.url as CFURL,[],&backup)==errSecSuccess,let backup else{return false}
        return SecStaticCodeCheckValidity(backup,SecCSFlags(rawValue:kSecCSStrictValidate),requirement)==errSecSuccess
    }
    private func legacySetupSkill(_ target:Target) throws -> Bool {
        guard let skill=try Self.snapshot(target.url.appendingPathComponent("SKILL.md"),directory:false,readHost:true),
              let bytes=skill.hostContents,let text=String(data:bytes,encoding:.utf8) else{return false}
        let lines=text.components(separatedBy:"\n").map{$0.hasSuffix("\r") ? String($0.dropLast()):$0}
        guard lines.first=="---",let end=lines.dropFirst().firstIndex(of:"---") else{return false}
        return lines[1..<end].contains { $0.range(of:#"^name\s*:\s*chathand-setup\s*$"#,options:.regularExpression) != nil }
    }
    static func clearPreferences(_ defaults:UserDefaults, domain:String) -> Bool {
        defaults.removePersistentDomain(forName:domain)
        return defaults.synchronize()
    }
    var auditState: URL { home.appendingPathComponent("Library/Logs/ChatHand/uninstall", isDirectory: true) }
    func prepareAudit() throws {
        try Self.checkAncestors(auditState)
        try FileManager.default.createDirectory(at: auditState, withIntermediateDirectories: true, attributes: [.posixPermissions:0o700])
        var value = stat()
        guard lstat(auditState.path,&value) == 0, value.st_uid == getuid(), value.st_mode & S_IFMT == S_IFDIR,
              value.st_mode & 0o077 == 0 else { throw Failure.unsafePath }
    }

    /// Incremental menu path. Identity/update/backend guards remain hard gates.
    /// An unrelated/blocked host never prevents cleanup of other owned targets.
    /// The App is the final product target; only our lock/empty shells follow it.
    func executeStages(backendStopped: Bool, loginRemoved: Bool, exclusion: UpgradeExclusion,
                       auditFailure:String? = nil, preferencesCleared:Bool = true,
                       event: (String,String) -> Void = {_,_ in},
                       dataAccess: ([String:Any])->Void = {_ in}) -> Report {
        var result = Report()
        func add(_ stage:String,_ url:URL,_ code:String,_ remaining:Bool = false,_ preserved:Bool = false) {
            event(stage,code); result.items.append(Item(stage:stage,url:url,code:code,remaining:remaining,preserved:preserved))
        }
        if let auditFailure { event("audit","AUDIT_UNAVAILABLE"); add("audit",auditState,auditFailure,true) }
        guard incremental else { add("plan",app,"IDENTITY_FAILED",true); return result }
        do {
            guard exclusion.directory.standardizedFileURL.path == support.appendingPathComponent("upgrades/install.lock").standardizedFileURL.path else { throw Failure.changed }
            try exclusion.validate(); try validate()
        } catch { add("plan",app,Self.reason(error),true); return result }
        func chromeDenied(_ stage:String,_ operation:String,_ error:Error) {
            guard ["host","host_backup"].contains(stage),Self.reason(error) == "ACCESS_DENIED" else{return}
            var value=error as NSError
            if let underlying=value.userInfo[NSUnderlyingErrorKey] as? NSError {value=underlying}
            let reason=value.domain == NSPOSIXErrorDomain ? (value.code == Int(EACCES) ? "EACCES":value.code == Int(EPERM) ? "EPERM":"UNKNOWN") : "UNKNOWN"
            event(stage,"CHROME_DATA_ACCESS_DENIED")
            dataAccess(["flow":"uninstall","operation":operation,"path_kind":stage == "host" ? "native_host":"native_host_backup","accessor_role":"native","pid":Int(getpid()),"errno":reason,"os_attribution":"unknown","code":"CHROME_DATA_ACCESS_DENIED"])
        }
        func remove(_ stage:String,_ url:URL,_ directory:Bool,owned:((Target)throws->Bool)? = nil) {
            event(stage,"STARTED")
            var operation="read"
            do {
                try exclusion.validate()
                guard let target = try Self.snapshot(url,directory:directory,readHost:owned != nil && !directory) else { add(stage,url,"NOT_FOUND"); return }
                if let owned, try !owned(target) { add(stage,url,"FOREIGN_RETAINED",false,true); return }
                guard backendStopped else { add(stage,url,"BACKEND_RUNNING",true); return }
                try revalidate(target);operation="remove";try Self.removeExact(target); add(stage,url,"REMOVED")
            } catch { chromeDenied(stage,operation,error); add(stage,url,Self.reason(error),true) }
        }
        let hosts = home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts")
        func isHost(_ target:Target,_ name:String)throws->Bool {
            guard let bytes=target.hostContents, let value=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] else { return false }
            return value["name"] as? String == name && value["type"] as? String == "stdio" &&
                ["ken-browser-host","ChatHandBrowserHost"].map { app.appendingPathComponent("Contents/Resources/runtime/bin/"+$0).path }.contains(value["path"] as? String ?? "")
        }
        for name in ["com.kenyu.chathand.browser","org.kenbridge.browser"] {
            remove("host",hosts.appendingPathComponent(name+".json"),false,owned:{try isHost($0,name)})
            // Backups can contain another product's former registration. A name
            // match is not ownership; inspect only bounded fixed-schema JSON.
            do {
                try Self.checkAncestors(hosts)
                let names: [String]
                do { names = try FileManager.default.contentsOfDirectory(atPath:hosts.path) }
                catch let e as NSError where e.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError,NSFileReadNoSuchFileError].contains(e.code) { names=[] }
                for entry in names.sorted() where entry.hasPrefix(name+".json.backup-") {
                    let suffix=String(entry.dropFirst((name+".json.backup-").count))
                    guard UUID(uuidString:suffix) != nil else { continue }
                    remove("host_backup",hosts.appendingPathComponent(entry),false,owned:{try isHost($0,name)})
                }
            } catch { chromeDenied("host_backup","list",error);add("host_backup",hosts,Self.reason(error),true) }
        }
        let skill=home.appendingPathComponent(".codex/skills/chathand-setup")
        remove("skill",skill,true,owned:{ target in
            let marker=target.url.appendingPathComponent(".chathand-owned.json")
            if let value=try Self.snapshot(marker,directory:false,readHost:true),let bytes=value.hostContents {
                guard let object=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],object.count == 3,
                      let format=object["format"] as? NSNumber, CFGetTypeID(format) != CFBooleanGetTypeID(),format == 1,
                      object["owner"] as? String == "com.kenyu.chathand",object["kind"] as? String == "setup-skill" else { return false }
                return true
            }
            return try legacySetupSkill(target)
        })
        let manualInstall=support.appendingPathComponent("manual-install"),previous=manualInstall.appendingPathComponent("previous.app")
        remove("app_backup",previous,true,owned:{try ownedAppBackup($0)})
        do {
            try Self.checkAncestors(manualInstall)
            if try Self.snapshot(manualInstall,directory:true) != nil,
               try FileManager.default.contentsOfDirectory(atPath:manualInstall.path).contains(where:{$0 != "previous.app"}) {
                add("app_backup",manualInstall,"FOREIGN_RETAINED",false,true)
            }
        } catch {add("app_backup",manualInstall,Self.reason(error),true)}
        for relative in ["Library/Caches/com.kenyu.chathand","Library/HTTPStorages/com.kenyu.chathand","Library/WebKit/com.kenyu.chathand","Library/Saved Application State/com.kenyu.chathand.savedState"] {
                remove("cache",home.appendingPathComponent(relative),true)
        }
        if deleteData {
            remove("preferences",home.appendingPathComponent("Library/Preferences/com.kenyu.chathand.plist"),false)
            if !preferencesCleared { add("preferences",home.appendingPathComponent("Library/Preferences/com.kenyu.chathand.plist"),"PREFERENCES_SYNC_FAILED",true) }
            // Keep install.lock continuously visible until App deletion. Remove
            // each other child independently, preserving any failed subtree.
            for parent in [support,support.appendingPathComponent("upgrades")] {
                do {
                    try Self.checkAncestors(parent)
                    guard try Self.snapshot(parent,directory:true) != nil else { continue }
                    let children=try FileManager.default.contentsOfDirectory(atPath:parent.path)
                    for name in children.sorted() where !(parent == support && ["upgrades","manual-install"].contains(name)) && !(parent != support && name == "install.lock") {
                        let url=parent.appendingPathComponent(name)
                        var value=stat()
                        guard lstat(url.path,&value) == 0 else { throw Failure.changed }
                        remove("data",url,value.st_mode & S_IFMT == S_IFDIR)
                    }
                } catch { add("data",parent,Self.reason(error),true) }
            }
        } else { add("data",support,"DATA_KEPT",false,true) }
        event("app","STARTED")
        if !backendStopped { add("app",app,"BACKEND_RUNNING",true) }
        else if !loginRemoved { add("app",app,"LOGIN_ITEM_REMAINS",true) }
        else {
            do { try exclusion.validate(); guard let target=targets.first(where:{$0.url == app}) else { throw Failure.identity }; try revalidate(target); try Self.removeExact(target); add("app",app,"REMOVED") }
            catch { add("app",app,Self.reason(error),true) }
        }
        exclusion.release()
        if deleteData && backendStopped {
            // Empty-directory cleanup only; never recurse after lease release.
            _ = rmdir(support.appendingPathComponent("upgrades").path)
            _ = rmdir(manualInstall.path) // Empty only; never recurse this directory.
            if rmdir(support.path) != 0 && errno != ENOENT {
                let onlyPreservedManual=(try? FileManager.default.contentsOfDirectory(atPath:support.path)) == ["manual-install"] && result.items.contains(where:{$0.stage == "app_backup" && $0.preserved})
                if onlyPreservedManual { event("data","FOREIGN_RETAINED") }
                else if !result.items.contains(where:{$0.stage == "data" && $0.remaining}) { add("data",support,"REMAINDER",true) }
            }
        }
        event("result",result.complete ? "COMPLETED" : "PARTIAL")
        return result
    }

    // Descriptor-relative traversal pins each ancestor; a symlink/rename race
    // cannot redirect recursive deletion into a user's unrelated directory.
    private static func removeExact(_ target: Target) throws {
        let raw = target.url.path
        let canonical = raw.hasPrefix("/var/") ? "/private" + raw : raw
        let parts = canonical.split(separator: "/").map(String.init)
        guard let leaf = parts.last, !parts.isEmpty else { throw Failure.unsafePath }
        var parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parent >= 0 else { throw Failure.unsafePath }
        defer { close(parent) }
        for part in parts.dropLast() {
            let child = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard child >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            close(parent); parent = child
        }
        var current = stat()
        guard fstatat(parent, leaf, &current, AT_SYMLINK_NOFOLLOW) == 0,
              UInt64(current.st_dev) == target.device, UInt64(current.st_ino) == target.inode else { throw Failure.changed }
        try removeEntry(parent: parent, name: leaf, expected: current, device: current.st_dev)
    }

    private static func removeEntry(parent: Int32, name: String, expected: stat, device: dev_t) throws {
        guard expected.st_dev == device else { throw Failure.unsafePath } // Never cross a mounted filesystem.
        if (expected.st_mode & S_IFMT) == S_IFDIR {
            let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            defer { close(fd) }
            var pinned = stat()
            guard fstat(fd, &pinned) == 0, pinned.st_dev == expected.st_dev, pinned.st_ino == expected.st_ino else { throw Failure.changed }
            let copy = dup(fd)
            guard copy >= 0 else { throw Failure.unsafePath }
            guard let directory = fdopendir(copy) else { close(copy); throw Failure.unsafePath }
            defer { closedir(directory) }
            while true {
                errno = 0
                guard let entry = readdir(directory) else {
                    if errno != 0 { throw Failure.changed }
                    break
                }
                let child = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                    pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
                }
                if child == "." || child == ".." { continue }
                var observed = stat()
                guard fstatat(fd, child, &observed, AT_SYMLINK_NOFOLLOW) == 0 else { throw Failure.changed }
                try removeEntry(parent: fd, name: child, expected: observed, device: device)
            }
        }
        var final = stat()
        guard fstatat(parent, name, &final, AT_SYMLINK_NOFOLLOW) == 0,
              final.st_dev == expected.st_dev, final.st_ino == expected.st_ino else { throw Failure.changed }
        let flags = (expected.st_mode & S_IFMT) == S_IFDIR ? AT_REMOVEDIR : 0
        guard unlinkat(parent, name, flags) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    }
}
