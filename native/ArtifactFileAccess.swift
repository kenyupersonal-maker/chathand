import Foundation
import Darwin
import CryptoKit
import ImageIO
import CoreGraphics

// 1043: fixed, no-network file receiver. Private requests travel through stdin,
// never argv. The parent owns task/session/permission authorization.
enum ArtifactIOError: String, Error {
    case request = "ARTIFACT_REQUEST_INVALID"
    case root = "ARTIFACT_ROOT_CHANGED"
    case path = "ARTIFACT_PATH_UNSAFE"
    case link = "ARTIFACT_LINK_UNSAFE"
    case missing = "FILE_GONE"
    case exists = "ARTIFACT_DESTINATION_EXISTS"
    case intent = "ARTIFACT_INTENT_CONFLICT"
    case limit = "ARTIFACT_BUDGET_EXCEEDED"
    case hash = "ARTIFACT_HASH_CHANGED"
    case io = "ARTIFACT_IO_FAILED"
    case unknown = "ARTIFACT_COMMIT_UNKNOWN"
    case image = "ARTIFACT_IMAGE_UNAVAILABLE"
    case metadata = "FILE_METADATA_UNPRESERVED"
    case metadataLimit = "FILE_METADATA_XATTR_LIMIT"
    case metadataForkLimit = "FILE_METADATA_RESOURCE_FORK_LIMIT"
}

private final class ArtifactFD {
    let value: Int32
    init(_ value: Int32) throws { guard value >= 0 else { throw errno == ENOENT ? ArtifactIOError.missing : ArtifactIOError.link }; self.value = value }
    deinit { close(value) }
    func info() throws -> stat { var s = stat(); guard fstat(value, &s) == 0 else { throw ArtifactIOError.io }; return s }
    func path() throws -> String {
        var b = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(value, F_GETPATH, &b) == 0 else { throw ArtifactIOError.root }
        return String(cString: b)
    }
}

enum ArtifactFileAccess {
    static let inputLimit = 96 * 1024 * 1024
    static let chunkLimit = 64 * 1024 * 1024
    static let totalLimit: UInt64 = 1024 * 1024 * 1024
    static let entryLimit = 4096
    static let manifestLimit = 8 * 1024 * 1024
    static let manifestName = ".chathand-artifact-manifest.json"
    static let lockName = ".chathand-artifact-lock"
    static let reserved = Set([manifestName, lockName])

    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    static func integer(_ value: Any?) throws -> UInt64 {
        let text: String
        if let s = value as? String { text = s }
        else if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { text = n.stringValue }
        else { throw ArtifactIOError.request }
        guard !text.isEmpty, text.count <= 20, text.allSatisfy({ $0 >= "0" && $0 <= "9" }), let number = UInt64(text) else { throw ArtifactIOError.request }
        return number
    }
    static func sha(_ value: Any?) throws -> String? {
        guard let value else { return nil }
        guard let text = value as? String, text.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ArtifactIOError.request }
        return text
    }
    static func relative(_ raw: String) throws -> String {
        guard !raw.isEmpty, raw.utf8.count <= 2048, !raw.hasPrefix("/"), !raw.contains("\\"), !raw.contains(":"), raw.rangeOfCharacter(from: .controlCharacters) == nil else { throw ArtifactIOError.path }
        let parts = raw.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count <= 32, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 }) else { throw ArtifactIOError.path }
        let result = raw.precomposedStringWithCanonicalMapping
        guard result.utf8.count <= 2048, result.split(separator: "/").allSatisfy({ $0.utf8.count <= 255 }), !reserved.contains(String(parts[0])), !parts.contains(where: { $0.hasPrefix(".chathand-artifact-stage-") }) else { throw ArtifactIOError.path }
        return result
    }
    static func absolute(_ raw: String) throws -> String {
        guard raw.hasPrefix("/"), raw != "/", raw.utf8.count < Int(MAXPATHLEN), !raw.contains("\\"), raw.rangeOfCharacter(from: .controlCharacters) == nil else { throw ArtifactIOError.path }
        // These are fixed macOS system aliases, not arbitrary user links.
        var path = raw
        if path.hasPrefix("/var/") || path == "/var" || path.hasPrefix("/tmp/") || path == "/tmp" { path = "/private" + path }
        let parts = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255 }) else { throw ArtifactIOError.path }
        return path.precomposedStringWithCanonicalMapping
    }
    private static func isDirectory(_ s: stat) -> Bool { (s.st_mode & S_IFMT) == S_IFDIR }
    private static func isFile(_ s: stat) -> Bool { (s.st_mode & S_IFMT) == S_IFREG }
    private static func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private static func childDirectory(_ parent: ArtifactFD, _ name: String, create: Bool = false) throws -> ArtifactFD {
        if create, mkdirat(parent.value, name, 0o700) != 0, errno != EEXIST { throw ArtifactIOError.io }
        let fd = try ArtifactFD(openat(parent.value, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        guard isDirectory(try fd.info()) else { throw ArtifactIOError.link }; return fd
    }
    private static func walk(_ root: ArtifactFD, _ parts: [String], create: Bool = false) throws -> ArtifactFD {
        var current = root
        for part in parts { current = try childDirectory(current, part, create: create) }
        return current
    }
    private static func root(_ request: [String: Any]) throws -> (ArtifactFD, String, stat) {
        guard let raw = request["root"] as? String, let identity = request["root_identity"] as? [String: Any] else { throw ArtifactIOError.request }
        let path = try absolute(raw), base = try ArtifactFD(open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let fd = try walk(base, path.dropFirst().split(separator: "/").map(String.init))
        let s = try fd.info()
        guard s.st_dev >= 0, UInt64(s.st_dev) == (try integer(identity["dev"])), UInt64(s.st_ino) == (try integer(identity["ino"])) else { throw ArtifactIOError.root }
        try checkRoot(fd, path: path, before: s); return (fd, path, s)
    }
    private static func checkRoot(_ fd: ArtifactFD, path: String, before: stat) throws {
        let now = try fd.info()
        guard isDirectory(now), now.st_dev == before.st_dev, now.st_ino == before.st_ino, try fd.path().precomposedStringWithCanonicalMapping == path else { throw ArtifactIOError.root }
        // Reopen each ancestor as well: a held FD alone cannot prove that its
        // directory is still in the original workspace namespace.
        let slash = try ArtifactFD(open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let fresh = try walk(slash, path.dropFirst().split(separator: "/").map(String.init))
        let s = try fresh.info(); guard s.st_dev == before.st_dev, s.st_ino == before.st_ino else { throw ArtifactIOError.root }
    }
    private static func checkPath(_ fd: ArtifactFD, expected: String) throws {
        guard try fd.path().precomposedStringWithCanonicalMapping == expected else { throw ArtifactIOError.root }
    }
    private static func file(_ parent: ArtifactFD, _ name: String) throws -> ArtifactFD {
        let fd = try ArtifactFD(openat(parent.value, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK))
        let s = try fd.info(); guard isFile(s), s.st_nlink == 1 else { throw ArtifactIOError.link }; return fd
    }
    private static func read(_ fd: ArtifactFD, limit: Int) throws -> Data {
        let before = try fd.info(); guard before.st_size >= 0, before.st_size <= limit, isFile(before), before.st_nlink == 1, lseek(fd.value, 0, SEEK_SET) == 0 else { throw ArtifactIOError.limit }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = Darwin.read(fd.value, &buffer, buffer.count)
            if n < 0 { if errno == EINTR { continue }; throw ArtifactIOError.io }
            if n == 0 { break }
            guard data.count <= limit - n else { throw ArtifactIOError.limit }
            data.append(contentsOf: buffer.prefix(n))
        }
        guard data.count == before.st_size, same(before, try fd.info()) else { throw ArtifactIOError.hash }; return data
    }
    private static func hash(_ fd: ArtifactFD) throws -> (String, stat) {
        let before = try fd.info(); guard isFile(before), before.st_nlink == 1, before.st_size >= 0, UInt64(before.st_size) <= 16 * 1024 * 1024 * 1024, lseek(fd.value, 0, SEEK_SET) == 0 else { throw ArtifactIOError.limit }
        var hash = SHA256(), total: Int64 = 0, buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        while true {
            let n = Darwin.read(fd.value, &buffer, buffer.count)
            if n < 0 { if errno == EINTR { continue }; throw ArtifactIOError.io }
            if n == 0 { break }; total += Int64(n); guard total <= before.st_size else { throw ArtifactIOError.hash }
            hash.update(data: Data(buffer.prefix(n)))
        }
        guard total == before.st_size, same(before, try fd.info()) else { throw ArtifactIOError.hash }
        return (hash.finalize().map { String(format: "%02x", $0) }.joined(), before)
    }
    private static func write(_ data: Data, parent: ArtifactFD, name: String) throws {
        let raw = openat(parent.value, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard raw >= 0 else { throw errno == EEXIST ? ArtifactIOError.exists : ArtifactIOError.io }
        let fd = try ArtifactFD(raw)
        do {
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let n = Darwin.write(fd.value, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if n < 0 { if errno == EINTR { continue }; throw ArtifactIOError.io }; guard n > 0 else { throw ArtifactIOError.io }; offset += n
                }
            }
            guard fsync(fd.value) == 0, try fd.info().st_nlink == 1 else { throw ArtifactIOError.io }
        } catch { _ = unlinkat(parent.value, name, 0); throw error }
    }
    private static func uuid(_ request: [String: Any]) throws -> String {
        guard let value = request["operation_id"] as? String, value.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil else { throw ArtifactIOError.request }; return value
    }
    private static func stagingName(_ id: String) -> String { ".chathand-artifact-stage-" + id }
    private static func locked(_ directory: ArtifactFD, create: Bool) throws -> ArtifactFD {
        let flags = O_RDWR | O_NOFOLLOW | O_CLOEXEC | (create ? O_CREAT | O_EXCL : 0)
        let fd = try ArtifactFD(openat(directory.value, lockName, flags, 0o600))
        let s = try fd.info(); guard isFile(s), s.st_nlink == 1, flock(fd.value, LOCK_EX | LOCK_NB) == 0 else { throw ArtifactIOError.intent }; return fd
    }
    private static func manifest(_ directory: ArtifactFD) throws -> ([String: Any], String) {
        let data = try read(file(directory, manifestName), limit: manifestLimit)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ArtifactIOError.intent }; return (object, digest(data))
    }
    private static func saveManifest(_ object: [String: Any], _ directory: ArtifactFD, first: Bool = false) throws -> String {
        let data = try json(object); guard data.count <= manifestLimit else { throw ArtifactIOError.limit }
        if first { try write(data, parent: directory, name: manifestName) }
        else {
            let old = try file(directory, manifestName); let oldStat = try old.info()
            let temporary = ".chathand-artifact-manifest-" + UUID().uuidString.lowercased()
            try write(data, parent: directory, name: temporary)
            defer { _ = unlinkat(directory.value, temporary, 0) }
            let fresh = try file(directory, manifestName); guard same(oldStat, try fresh.info()) else { throw ArtifactIOError.intent }
            guard renameat(directory.value, temporary, directory.value, manifestName) == 0 else { throw ArtifactIOError.io }
        }
        guard fsync(directory.value) == 0 else { throw ArtifactIOError.io }; return digest(data)
    }
    private static func boundManifest(_ m: [String: Any], request: [String: Any], id: String, destination: String, rootStat: stat) throws {
        guard m["version"] as? Int == 1, m["operation_id"] as? String == id, m["destination"] as? String == destination, try integer(m["root_dev"]) == UInt64(rootStat.st_dev), try integer(m["root_ino"]) == UInt64(rootStat.st_ino), let entries = m["entries"] as? [[String: Any]], entries.count <= entryLimit, let chunks = m["chunks"] as? [String], chunks.count <= entryLimit else { throw ArtifactIOError.intent }
        if let source = try sha(request["source_sha256"]), m["source_sha256"] as? String != source { throw ArtifactIOError.intent }
    }
    private static func verifyEntries(_ m: [String: Any], directory: ArtifactFD, expectedPath: String) throws {
        guard let entries = m["entries"] as? [[String: Any]] else { throw ArtifactIOError.intent }
        for entry in entries {
            guard let raw = entry["path"] as? String, let expected = try sha(entry["sha256"]) else { throw ArtifactIOError.intent }
            let path = try relative(raw), parts = path.split(separator: "/").map(String.init)
            let parent = try walk(directory, Array(parts.dropLast())), f = try file(parent, parts.last!)
            try checkPath(parent, expected: expectedPath + (parts.count > 1 ? "/" + parts.dropLast().joined(separator: "/") : ""))
            let (actual, s) = try hash(f)
            guard actual == expected, UInt64(s.st_size) == (try integer(entry["bytes"])), UInt64(s.st_ino) == (try integer(entry["ino"])), UInt64(s.st_dev) == (try integer(entry["dev"])) else { throw ArtifactIOError.hash }
        }
        try checkTree(directory, manifest: m)
    }
    private static func directoryNames(_ directory: ArtifactFD) throws -> [String] {
        // dup would share a directory offset: a second validation/cleanup
        // must enumerate again, not silently observe the prior EOF.
        let raw = openat(directory.value, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard raw >= 0, let stream = fdopendir(raw) else { if raw >= 0 { close(raw) }; throw ArtifactIOError.io }
        defer { closedir(stream) }
        var names: [String] = []
        while let pointer = readdir(stream) {
            let name = withUnsafePointer(to: pointer.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(cString: $0) } }
            if name != "." && name != ".." { names.append(name) }; guard names.count <= entryLimit * 33 + 16 else { throw ArtifactIOError.limit }
        }
        return names
    }
    private static func checkTree(_ directory: ArtifactFD, manifest: [String: Any]) throws {
        let files = Set((manifest["entries"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String })
        var directories = Set<String>()
        for path in files { let p = path.split(separator: "/").map(String.init); for count in 1..<p.count { directories.insert(p.prefix(count).joined(separator: "/")) } }
        func visit(_ folder: ArtifactFD, prefix: String, depth: Int) throws {
            guard depth <= 32 else { throw ArtifactIOError.path }
            for name in try directoryNames(folder) {
                let path = prefix.isEmpty ? name : prefix + "/" + name
                var s = stat(); guard fstatat(folder.value, name, &s, AT_SYMLINK_NOFOLLOW) == 0 else { throw ArtifactIOError.io }
                if prefix.isEmpty && reserved.contains(name) { guard isFile(s), s.st_nlink == 1 else { throw ArtifactIOError.link }; continue }
                if isDirectory(s) { guard directories.contains(path) else { throw ArtifactIOError.intent }; try visit(childDirectory(folder, name), prefix: path, depth: depth + 1) }
                else { guard isFile(s), s.st_nlink == 1, files.contains(path) else { throw ArtifactIOError.intent } }
            }
        }
        try visit(directory, prefix: "", depth: 0)
    }
    private static func receipt(_ m: [String: Any], digest: String, status: String, replayed: Bool = false) -> [String: Any] {
        let entries = (m["entries"] as? [[String: Any]] ?? []).map { entry -> [String: Any] in
            var e = entry; e.removeValue(forKey: "ino"); e.removeValue(forKey: "dev"); return e
        }
        var result: [String: Any] = ["version": 1, "status": status, "manifest_sha256": digest, "operation_id": m["operation_id"] ?? "", "destination": m["destination"] ?? "", "bytes": m["bytes"] ?? 0, "count": entries.count, "entries": entries, "replayed": replayed]
        if let source = m["source_sha256"] as? String { result["source_sha256"] = source }; return result
    }
    private static func existing(_ root: ArtifactFD, _ relativePath: String) throws -> ArtifactFD {
        try walk(root, relativePath.split(separator: "/").map(String.init))
    }
    private static func stage(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        let id = try uuid(request)
        guard let rawDestination = request["destination"] as? String, let incoming = request["entries"] as? [[String: Any]], !incoming.isEmpty, incoming.count <= entryLimit else { throw ArtifactIOError.request }
        let destination = try relative(rawDestination), index = try integer(request["chunk_index"] ?? 0)
        guard index < entryLimit else { throw ArtifactIOError.limit }
        var prepared: [(String, Data, String)] = [], bytes = 0, identities = Set<String>(), chunkData = Data()
        for entry in incoming {
            guard let raw = entry["path"] as? String, let encoded = entry["data_base64"] as? String, encoded.utf8.count <= (chunkLimit + 2) / 3 * 4, let data = Data(base64Encoded: encoded), data.base64EncodedString() == encoded else { throw ArtifactIOError.request }
            let path = try relative(raw), actual = digest(data)
            guard identities.insert(path).inserted else { throw ArtifactIOError.intent }
            if let expected = try sha(entry["sha256"]), expected != actual { throw ArtifactIOError.hash }
            guard data.count <= chunkLimit - bytes else { throw ArtifactIOError.limit }; bytes += data.count
            chunkData.append(Data((path + "\n" + actual + "\n" + String(data.count) + "\n").utf8)); prepared.append((path, data, actual))
        }
        let chunkHash = digest(chunkData), stageName = stagingName(id)
        if let published = try? existing(root, destination) {
            let (m, sum) = try manifest(published); try boundManifest(m, request: request, id: id, destination: destination, rootStat: rootStat)
            guard let chunks = m["chunks"] as? [String], Int(index) < chunks.count, chunks[Int(index)] == chunkHash else { throw ArtifactIOError.intent }
            try verifyEntries(m, directory: published, expectedPath: rootPath + "/" + destination); try checkRoot(root, path: rootPath, before: rootStat)
            return receipt(m, digest: sum, status: "applied", replayed: true)
        }
        let made = mkdirat(root.value, stageName, 0o700) == 0
        if !made && errno != EEXIST { throw ArtifactIOError.io }
        let directory = try childDirectory(root, stageName), lock = try locked(directory, create: made)
        defer { _ = lock }
        let stagePath = rootPath + "/" + stageName
        try checkPath(directory, expected: stagePath); try checkRoot(root, path: rootPath, before: rootStat)
        var m: [String: Any], sum: String?
        if made {
            guard index == 0, request["expected_manifest_sha256"] == nil else { throw ArtifactIOError.intent }
            m = ["version": 1, "operation_id": id, "destination": destination, "root_dev": String(rootStat.st_dev), "root_ino": String(rootStat.st_ino), "entries": [[String: Any]](), "chunks": [String](), "bytes": 0]
            if let source = try sha(request["source_sha256"]) { m["source_sha256"] = source }
            sum = try saveManifest(m, directory, first: true)
        } else {
            let loaded = try manifest(directory); m = loaded.0; sum = loaded.1
            try boundManifest(m, request: request, id: id, destination: destination, rootStat: rootStat)
        }
        let chunks = m["chunks"] as? [String] ?? []
        if Int(index) < chunks.count {
            guard chunks[Int(index)] == chunkHash else { throw ArtifactIOError.intent }
            try verifyEntries(m, directory: directory, expectedPath: stagePath)
            return receipt(m, digest: sum!, status: "staged", replayed: true)
        }
        guard Int(index) == chunks.count, try made || sha(request["expected_manifest_sha256"]) == sum else { throw ArtifactIOError.intent }
        var all = m["entries"] as? [[String: Any]] ?? [], total = try integer(m["bytes"])
        guard total <= totalLimit, all.count + prepared.count <= entryLimit, UInt64(bytes) <= totalLimit - total else { throw ArtifactIOError.limit }
        try checkTree(directory, manifest: m)
        var oldPaths = Set(all.compactMap { $0["path"] as? String })
        for (path, data, actual) in prepared {
            guard oldPaths.insert(path).inserted else { throw ArtifactIOError.intent }
            let parts = path.split(separator: "/").map(String.init), parent = try walk(directory, Array(parts.dropLast()), create: true)
            try checkPath(parent, expected: stagePath + (parts.count > 1 ? "/" + parts.dropLast().joined(separator: "/") : ""))
            try checkRoot(root, path: rootPath, before: rootStat)
            try write(data, parent: parent, name: parts.last!)
            let f = try file(parent, parts.last!), s = try f.info()
            var record: [String: Any] = ["path": path, "bytes": data.count, "sha256": actual, "dev": String(s.st_dev), "ino": String(s.st_ino)]
            let image = thumbnail(data)
            if image["available"] as? Bool == true { record["image"] = image.filter { $0.key != "image_base64" } }
            all.append(record); total += UInt64(data.count)
        }
        m["entries"] = all; m["chunks"] = chunks + [chunkHash]; m["bytes"] = total
        try checkRoot(root, path: rootPath, before: rootStat); try checkPath(directory, expected: stagePath)
        let saved = try saveManifest(m, directory)
        return receipt(m, digest: saved, status: "staged")
    }
    private static func commit(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        let id = try uuid(request); guard let raw = request["destination"] as? String, let expected = try sha(request["manifest_sha256"]) else { throw ArtifactIOError.request }
        let destination = try relative(raw)
        if let published = try? existing(root, destination) {
            let (m, sum) = try manifest(published); try boundManifest(m, request: request, id: id, destination: destination, rootStat: rootStat)
            guard sum == expected else { throw ArtifactIOError.intent }; try verifyEntries(m, directory: published, expectedPath: rootPath + "/" + destination)
            try checkRoot(root, path: rootPath, before: rootStat); return receipt(m, digest: sum, status: "applied", replayed: true)
        }
        let name = stagingName(id), directory = try childDirectory(root, name), lock = try locked(directory, create: false)
        defer { _ = lock }
        let (m, sum) = try manifest(directory); try boundManifest(m, request: request, id: id, destination: destination, rootStat: rootStat)
        guard sum == expected, (m["entries"] as? [Any])?.isEmpty == false else { throw ArtifactIOError.intent }
        try verifyEntries(m, directory: directory, expectedPath: rootPath + "/" + name)
        let parts = destination.split(separator: "/").map(String.init), parent = try walk(root, Array(parts.dropLast()), create: true)
        let parentPath = rootPath + (parts.count > 1 ? "/" + parts.dropLast().joined(separator: "/") : "")
        try checkPath(parent, expected: parentPath); try checkPath(directory, expected: rootPath + "/" + name); try checkRoot(root, path: rootPath, before: rootStat)
        guard renameatx_np(root.value, name, parent.value, parts.last!, UInt32(RENAME_EXCL)) == 0 else { throw errno == EEXIST || errno == ENOTEMPTY ? ArtifactIOError.exists : ArtifactIOError.io }
        guard fsync(parent.value) == 0, fsync(root.value) == 0 else { throw ArtifactIOError.unknown }
        do { try checkRoot(root, path: rootPath, before: rootStat); try checkPath(directory, expected: rootPath + "/" + destination) } catch { throw ArtifactIOError.unknown }
        return receipt(m, digest: sum, status: "applied")
    }
    private static func inspect(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        let id = try uuid(request); guard let raw = request["destination"] as? String else { throw ArtifactIOError.request }; let destination = try relative(raw)
        var selected: ArtifactFD?, relativePath = destination, status = "applied"
        do { selected = try existing(root, destination) } catch ArtifactIOError.missing {
            relativePath = stagingName(id); status = "staged"
            do { selected = try childDirectory(root, relativePath) } catch ArtifactIOError.missing { return ["version": 1, "status": "absent"] }
        }
        guard let selected else { throw ArtifactIOError.intent }
        let (m, sum) = try manifest(selected); try boundManifest(m, request: request, id: id, destination: destination, rootStat: rootStat)
        if let expected = try sha(request["manifest_sha256"]), expected != sum { throw ArtifactIOError.intent }
        try verifyEntries(m, directory: selected, expectedPath: rootPath + "/" + relativePath); try checkRoot(root, path: rootPath, before: rootStat)
        return receipt(m, digest: sum, status: status, replayed: true)
    }
    private static func removeOwnedTree(_ directory: ArtifactFD, prefix: String, owned: [String: (UInt64, UInt64, UInt64)]) throws {
        // Enumeration is FD-relative. Any special/link entry blocks cleanup;
        // it never follows or unlinks a foreign linked file.
        let names = try directoryNames(directory)
        for name in names {
            let path = prefix.isEmpty ? name : prefix + "/" + name
            var s = stat(); guard fstatat(directory.value, name, &s, AT_SYMLINK_NOFOLLOW) == 0 else { throw ArtifactIOError.io }
            if isDirectory(s) {
                let child = try childDirectory(directory, name); try removeOwnedTree(child, prefix: path, owned: owned)
                var fresh = stat(); guard fstatat(directory.value, name, &fresh, AT_SYMLINK_NOFOLLOW) == 0, fresh.st_dev == s.st_dev, fresh.st_ino == s.st_ino, unlinkat(directory.value, name, AT_REMOVEDIR) == 0 else { throw ArtifactIOError.io }
            } else {
                guard isFile(s), s.st_nlink == 1, s.st_size >= 0, let identity = owned[path], identity.0 == UInt64(s.st_dev), identity.1 == UInt64(s.st_ino), identity.2 == UInt64(s.st_size) else { throw ArtifactIOError.link }
                let f = try file(directory, name); guard same(s, try f.info()) else { throw ArtifactIOError.hash }
                var leaf = stat(); guard fstatat(directory.value, name, &leaf, AT_SYMLINK_NOFOLLOW) == 0, same(s, leaf) else { throw ArtifactIOError.hash }
                guard unlinkat(directory.value, name, 0) == 0 else { throw ArtifactIOError.io }
            }
        }
    }
    private static func cancel(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        let id = try uuid(request); guard let raw = request["destination"] as? String else { throw ArtifactIOError.request }; let destination = try relative(raw)
        let name = stagingName(id), directory: ArtifactFD
        do { directory = try childDirectory(root, name) } catch ArtifactIOError.missing { return ["version": 1, "status": "absent"] }
        let lock = try locked(directory, create: false); defer { _ = lock }
        let metadataFD = try file(directory, manifestName), metadataIdentity = try metadataFD.info()
        let (m, _) = try manifest(directory); try boundManifest(m, request: request, id: id, destination: destination, rootStat: rootStat)
        try checkPath(directory, expected: rootPath + "/" + name); try checkRoot(root, path: rootPath, before: rootStat)
        try verifyEntries(m, directory: directory, expectedPath: rootPath + "/" + name)
        var owned: [String: (UInt64, UInt64, UInt64)] = [:]
        for entry in m["entries"] as? [[String: Any]] ?? [] {
            guard let path = entry["path"] as? String else { throw ArtifactIOError.intent }
            owned[path] = (try integer(entry["dev"]), try integer(entry["ino"]), try integer(entry["bytes"]))
        }
        let lockIdentity = try lock.info()
        owned[manifestName] = (UInt64(metadataIdentity.st_dev), UInt64(metadataIdentity.st_ino), UInt64(metadataIdentity.st_size))
        owned[lockName] = (UInt64(lockIdentity.st_dev), UInt64(lockIdentity.st_ino), UInt64(lockIdentity.st_size))
        let s = try directory.info(); try removeOwnedTree(directory, prefix: "", owned: owned)
        let fresh = try childDirectory(root, name); guard try fresh.info().st_ino == s.st_ino, unlinkat(root.value, name, AT_REMOVEDIR) == 0 else { throw ArtifactIOError.io }
        return ["version": 1, "status": "cancelled"]
    }
    private static func target(_ request: [String: Any], root: ArtifactFD, rootPath: String) throws -> (ArtifactFD, String, stat) {
        guard let raw = request["path"] as? String else { throw ArtifactIOError.request }
        // An explicitly authorized common output folder can be the root itself.
        // This is read-only verification, never a stage/commit path escape.
        if raw == ".", request["action"] as? String == "verify", request["is_directory"] as? Bool != false {
            try checkPath(root, expected: rootPath); return (root, ".", try root.info())
        }
        let path = try relative(raw), parts = path.split(separator: "/").map(String.init)
        let parent = try walk(root, Array(parts.dropLast()))
        try checkPath(parent, expected: rootPath + (parts.count > 1 ? "/" + parts.dropLast().joined(separator: "/") : ""))
        let fd = try ArtifactFD(openat(parent.value, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK))
        let s = try fd.info(); guard isDirectory(s) || isFile(s) && s.st_nlink == 1 else { throw ArtifactIOError.link }
        try checkPath(fd, expected: rootPath + "/" + path)
        if let identity = request["identity"] as? [String: Any] ?? request["expected_identity"] as? [String: Any] {
            guard try integer(identity["dev"]) == UInt64(s.st_dev), try integer(identity["ino"]) == UInt64(s.st_ino) else { throw ArtifactIOError.hash }
        }
        return (fd, path, s)
    }
    private static func verify(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        let (fd, path, initial) = try target(request, root: root, rootPath: rootPath)
        let directory = isDirectory(initial)
        if let expectedDirectory = request["is_directory"] as? Bool, expectedDirectory != directory { throw ArtifactIOError.hash }
        let actual: String?
        if directory { guard request["sha256"] == nil else { throw ArtifactIOError.request }; actual = nil }
        else { actual = try hash(fd).0; if let expected = try sha(request["sha256"]), expected != actual { throw ArtifactIOError.hash } }
        if let expectedIdentity = request["identity"] as? [String: Any] {
            guard try integer(expectedIdentity["dev"]) == UInt64(initial.st_dev), try integer(expectedIdentity["ino"]) == UInt64(initial.st_ino) else { throw ArtifactIOError.hash }
        }
        try checkRoot(root, path: rootPath, before: rootStat); try checkPath(fd, expected: path == "." ? rootPath : rootPath + "/" + path)
        guard same(initial, try fd.info()) else { throw ArtifactIOError.hash }
        let risky = Set(["app", "pkg", "mpkg", "dmg", "command", "sh", "tool", "scpt", "workflow", "terminal", "jar", "exe", "bin"])
        var result: [String: Any] = ["version": 1, "verified": true, "relative_path": path, "is_directory": directory, "identity": ["dev": String(initial.st_dev), "ino": String(initial.st_ino)], "bytes": directory ? 0 : initial.st_size, "needs_confirmation": risky.contains((path as NSString).pathExtension.lowercased()) || !directory && (initial.st_mode & 0o111) != 0]
        if let actual { result["sha256"] = actual }; return result
    }
    private static func thumbnail(_ data: Data) -> [String: Any] {
        func unavailable(_ code: String = "ARTIFACT_IMAGE_UNAVAILABLE") -> [String: Any] { ["available": false, "code": code] }
        guard !data.isEmpty, data.count <= chunkLimit else { return unavailable("ARTIFACT_IMAGE_BUDGET") }
        let bytes = [UInt8](data.prefix(16))
        let png = bytes.count >= 8 && Array(bytes.prefix(8)) == [137,80,78,71,13,10,26,10]
        let jpeg = bytes.count >= 3 && Array(bytes.prefix(3)) == [255,216,255]
        let webp = bytes.count >= 12 && Array(bytes.prefix(4)) == [82,73,70,70] && Array(bytes[8..<12]) == [87,69,66,80]
        guard png || jpeg || webp else { return unavailable("ARTIFACT_IMAGE_TYPE") }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary), let type = CGImageSourceGetType(source) else { return unavailable() }
        let name = type as String
        guard png && name == "public.png" || jpeg && name == "public.jpeg" || webp && ["org.webmproject.webp", "public.webp", "com.google.webp"].contains(name) else { return unavailable("ARTIFACT_IMAGE_TYPE") }
        guard CGImageSourceGetCount(source) == 1 else { return unavailable("ARTIFACT_IMAGE_ANIMATED") }
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else { return unavailable() }
        let w = width.doubleValue, h = height.doubleValue
        guard w.isFinite, h.isFinite, w >= 1, h >= 1, w.rounded(.down) == w, h.rounded(.down) == h, w <= 16384, h <= 16384, w * h <= 64_000_000 else { return unavailable("ARTIFACT_IMAGE_BUDGET") }
        let options = [kCGImageSourceShouldCache: false, kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 256] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options), CGImageSourceGetStatus(source) == .statusComplete, CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              image.width > 0, image.height > 0, image.width <= 256, image.height <= 256,
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return unavailable() }
        context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
        guard let raster = context.makeImage() else { return unavailable() }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil) else { return unavailable() }
        CGImageDestinationAddImage(destination, raster, [:] as CFDictionary)
        guard CGImageDestinationFinalize(destination), let clean = cleanPNG(output as Data), clean.count <= 128 * 1024 else { return unavailable("ARTIFACT_IMAGE_BUDGET") }
        return ["available": true, "mime_type": "image/png", "width": Int(w), "height": Int(h), "thumbnail_width": image.width, "thumbnail_height": image.height, "image_base64": clean.base64EncodedString()]
    }
    private static func cleanPNG(_ input: Data) -> Data? {
        let bytes = [UInt8](input); guard bytes.count >= 8, Array(bytes.prefix(8)) == [137,80,78,71,13,10,26,10] else { return nil }
        func number(_ offset: Int) -> UInt32 { bytes[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } }
        func crc(_ range: Range<Int>) -> UInt32 { var v: UInt32 = 0xffffffff; for byte in bytes[range] { v ^= UInt32(byte); for _ in 0..<8 { v = (v >> 1) ^ (v & 1 == 1 ? 0xedb88320 : 0) } }; return v ^ 0xffffffff }
        var output = Data(bytes.prefix(8)), offset = 8, header = false, image = false, end = false
        while offset < bytes.count {
            guard offset <= bytes.count - 12 else { return nil }; let length = Int(number(offset))
            guard length <= bytes.count - offset - 12 else { return nil }
            let kind = String(bytes: bytes[offset + 4..<offset + 8], encoding: .ascii) ?? ""
            guard crc(offset + 4..<offset + 8 + length) == number(offset + 8 + length) else { return nil }
            if kind == "IHDR" { guard !header, offset == 8, length == 13, bytes[offset + 16] == 8, [2,6].contains(bytes[offset + 17]), bytes[offset + 20] == 0 else { return nil }; header = true }
            if kind == "IDAT" { guard header, !end else { return nil }; image = true }
            if kind == "IEND" { guard header, image, !end, length == 0, offset + 12 == bytes.count else { return nil }; end = true }
            if ["IHDR", "IDAT", "IEND"].contains(kind) { output.append(contentsOf: bytes[offset..<offset + length + 12]) }
            else if kind.first?.isUppercase == true { return nil }
            offset += length + 12
        }
        return header && image && end ? output : nil
    }
    private static func sourceIdentity(_ s: stat, expected: [String: Any]) throws {
        guard isFile(s), s.st_nlink == 1, s.st_size >= 0, try integer(expected["dev"]) == UInt64(s.st_dev), try integer(expected["ino"]) == UInt64(s.st_ino), try integer(expected["size"]) == UInt64(s.st_size) else { throw ArtifactIOError.hash }
        if let time = expected["mtime_ms"] as? NSNumber {
            let actual = Double(s.st_mtimespec.tv_sec) * 1000 + Double(s.st_mtimespec.tv_nsec) / 1_000_000
            guard time.doubleValue.isFinite, abs(actual - time.doubleValue) <= 0.001 else { throw ArtifactIOError.hash }
        }
    }
    private static func archiveDay(_ request: [String: Any]) throws -> String {
        if let day = request["archive_day"] {
            guard let value = day as? String, value.range(of: "^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$", options: .regularExpression) != nil else { throw ArtifactIOError.request }; return value
        }
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX"); format.dateFormat = "yyyy-MM-dd"; return format.string(from: Date())
    }
    private static func archivePath(_ request: [String: Any]) throws -> String {
        guard let leaf = request["path"] as? String, !leaf.contains("/") else { throw ArtifactIOError.request }
        let name = try relative(leaf), id = try uuid(request), day = try archiveDay(request)
        return "_待清理-" + day + ".noindex/" + id + "/" + name
    }
    private static func inspectSource(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        guard let leaf = request["path"] as? String, !leaf.contains("/"), let identity = request["expected_identity"] as? [String: Any], let expected = try sha(request["sha256"]) else { throw ArtifactIOError.request }
        let name = try relative(leaf), archived = try archivePath(request)
        func matches(_ path: String) throws -> Bool {
            var body = request; body["path"] = path
            let (f, _, s) = try target(body, root: root, rootPath: rootPath)
            try sourceIdentity(s, expected: identity); guard try hash(f).0 == expected else { throw ArtifactIOError.hash }; return true
        }
        do { if try matches(archived) { try checkRoot(root, path: rootPath, before: rootStat); return ["status": "archived", "archive_path": archived] } }
        catch ArtifactIOError.missing { }
        catch { return ["status": "archive_unconfirmed"] }
        do { if try matches(name) { try checkRoot(root, path: rootPath, before: rootStat); return ["status": "source_present"] } }
        catch ArtifactIOError.missing { return ["status": "absent"] }
        catch { return ["status": "archive_unconfirmed"] }
        return ["status": "archive_unconfirmed"]
    }
    private static func archiveDownload(_ request: [String: Any], root: ArtifactFD, rootPath: String, rootStat: stat) throws -> [String: Any] {
        guard let leaf = request["path"] as? String, !leaf.contains("/"), let identity = request["expected_identity"] as? [String: Any], let expected = try sha(request["sha256"]), let committed = request["committed"] as? [String: Any] else { throw ArtifactIOError.request }
        let name = try relative(leaf), id = try uuid(request), path = try archivePath(request)
        var proof = committed; proof["version"] = 1; proof["action"] = "inspect"; proof["operation_id"] = id; proof["source_sha256"] = expected
        let published = try handle(proof)
        guard published["status"] as? String == "applied", published["source_sha256"] as? String == expected else { throw ArtifactIOError.intent }
        let source = try file(root, name), before = try source.info(); try sourceIdentity(before, expected: identity)
        guard try hash(source).0 == expected else { throw ArtifactIOError.hash }
        try checkRoot(root, path: rootPath, before: rootStat); try checkPath(source, expected: rootPath + "/" + name)
        let parts = path.split(separator: "/").map(String.init), day = try childDirectory(root, parts[0], create: true)
        // Never reuse an archive operation directory to execute a second move.
        guard mkdirat(day.value, parts[1], 0o700) == 0 else { throw ArtifactIOError.unknown }
        let folder = try childDirectory(day, parts[1]), expectedFolder = rootPath + "/" + parts.dropLast().joined(separator: "/")
        try checkPath(folder, expected: expectedFolder); try checkRoot(root, path: rootPath, before: rootStat)
        let fresh = try file(root, name); guard same(before, try fresh.info()), same(before, try source.info()) else { throw ArtifactIOError.hash }
        // Darwin has no conditional-by-inode rename. Recheck immediately before
        // the no-overwrite move and prove the moved leaf before acknowledging.
        guard renameatx_np(root.value, name, folder.value, name, UInt32(RENAME_EXCL)) == 0 else { throw ArtifactIOError.unknown }
        do {
            let moved = try file(folder, name), s = try moved.info(); try sourceIdentity(s, expected: identity)
            guard s.st_dev == before.st_dev, s.st_ino == before.st_ino, try hash(moved).0 == expected else { throw ArtifactIOError.hash }
            try checkRoot(root, path: rootPath, before: rootStat); try checkPath(folder, expected: expectedFolder)
            guard fsync(folder.value) == 0, fsync(root.value) == 0 else { throw ArtifactIOError.unknown }
            return ["status": "archived", "archive_path": path]
        } catch {
            // Best-effort restoration never overwrites a new original leaf.
            // An uncertain result is preserved for inspect-source, never replayed.
            _ = renameatx_np(folder.value, name, root.value, name, UInt32(RENAME_EXCL))
            return ["status": "archive_unconfirmed"]
        }
    }
    // Internal store copy support, not a new public tool. Never creates files or
    // removes sources. Each path component is opened without following links.
    private static func metadataFile(_ raw: String, identity: [String: Any]) throws -> ArtifactFD {
        guard raw.hasPrefix("/"), !raw.utf8.contains(0) else { throw ArtifactIOError.path }
        let parts = raw.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw ArtifactIOError.path }
        let slash = try ArtifactFD(open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let parent = try walk(slash, Array(parts.dropLast()))
        let fd = try ArtifactFD(openat(parent.value, parts.last!, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK))
        let s = try fd.info()
        guard (isFile(s) && s.st_nlink == 1) || isDirectory(s) else { throw ArtifactIOError.link }
        guard try integer(identity["dev"]) == UInt64(s.st_dev), try integer(identity["ino"]) == UInt64(s.st_ino) else { throw ArtifactIOError.hash }
        try checkPath(fd, expected: raw)
        return fd
    }
    private static func metadataFingerprint(_ fd: ArtifactFD) throws -> String {
        let before = try fd.info()
        let length = flistxattr(fd.value, nil, 0, 0)
        guard length >= 0, length <= 1024 * 1024 else { throw ArtifactIOError.metadata }
        var names = [CChar](repeating: 0, count: max(1, length))
        guard flistxattr(fd.value, &names, length, 0) == length else { throw ArtifactIOError.metadata }
        let keys = names.prefix(length).split(separator: 0).map { String(decoding: $0.map { UInt8(bitPattern: $0) }, as: UTF8.self) }.sorted()
        var attributes: [[String: String]] = []
        for key in keys {
            let size = fgetxattr(fd.value, key, nil, 0, 0, 0)
            guard size >= 0 else { throw ArtifactIOError.metadata }
            var valueHash: String
            if key == "com.apple.ResourceFork" {
                // Darwin supports positioned resource-fork reads. Stream these,
                // including large forks, instead of buffering them as ordinary xattrs.
                guard UInt64(size) <= UInt64(UInt32.max) + 1 else { throw ArtifactIOError.metadataForkLimit }
                var hash = SHA256(), offset = 0, bytes = [UInt8](repeating: 0, count: 1024 * 1024)
                while offset < size {
                    let count = min(bytes.count, size - offset)
                    guard fgetxattr(fd.value, key, &bytes, count, UInt32(offset), 0) == count else { throw ArtifactIOError.metadata }
                    hash.update(data: Data(bytes.prefix(count))); offset += count
                }
                valueHash = hash.finalize().map { String(format: "%02x", $0) }.joined()
            } else {
                guard size <= 64 * 1024 * 1024 else { throw ArtifactIOError.metadataLimit }
                var bytes = [UInt8](repeating: 0, count: max(1, size))
                guard fgetxattr(fd.value, key, &bytes, size, 0, 0) == size else { throw ArtifactIOError.metadata }
                valueHash = digest(Data(bytes.prefix(size)))
            }
            attributes.append(["name": key, "sha256": valueHash])
        }
        var aclText = ""
        if let acl = acl_get_fd_np(fd.value, ACL_TYPE_EXTENDED) {
            defer { acl_free(UnsafeMutableRawPointer(acl)) }
            var lengthACL = 0
            guard let text = acl_to_text(acl, &lengthACL) else { throw ArtifactIOError.metadata }
            defer { acl_free(text) }
            // Darwin returns ENOENT for no ACL and an empty ACL after copyfile.
            var entry: acl_entry_t?
            if acl_get_entry(acl, ACL_FIRST_ENTRY.rawValue, &entry) == 0 { aclText = String(cString: text) }
            else if errno != ENOENT { throw ArtifactIOError.metadata }
        } else if errno != ENOENT { throw ArtifactIOError.metadata }
        func stamp(_ t: timespec) -> String { "\(t.tv_sec):\(t.tv_nsec)" }
        let result = try digest(json(["mode": Int(before.st_mode & 0o7777), "flags": before.st_flags,
            "birth": stamp(before.st_birthtimespec), "mtime": stamp(before.st_mtimespec),
            "acl": aclText, "xattrs": attributes]))
        guard same(before, try fd.info()) else { throw ArtifactIOError.hash }
        return result
    }
    private static func accessTime(_ value: Any?) throws -> timespec {
        guard let text = value as? String, let ns = Int64(text) else { throw ArtifactIOError.request }
        var sec = ns / 1_000_000_000, nano = ns % 1_000_000_000
        if nano < 0 { sec -= 1; nano += 1_000_000_000 }
        return timespec(tv_sec: Int(sec), tv_nsec: Int(nano))
    }
    private static func metadata(_ request: [String: Any]) throws -> [String: Any] {
        guard let sourcePath = request["source"] as? String, let identity = request["identity"] as? [String: Any],
              let operation = request["operation"] as? String else { throw ArtifactIOError.request }
        let source = try metadataFile(sourcePath, identity: identity), before = try source.info()
        let fingerprint = try metadataFingerprint(source)
        if let expected = request["fingerprint"] as? String, fingerprint != expected { throw ArtifactIOError.metadata }
        if operation == "capture" { return ["fingerprint": fingerprint] }
        if operation == "verify" {
            if let ns = request["atime_ns"] {
                var times = [try accessTime(ns), before.st_mtimespec]
                guard futimens(source.value, &times) == 0, fchmod(source.value, before.st_mode & 0o7777) == 0 else { throw ArtifactIOError.metadata }
                let after = try source.info()
                guard after.st_atimespec.tv_sec == times[0].tv_sec, after.st_atimespec.tv_nsec == times[0].tv_nsec,
                      try metadataFingerprint(source) == fingerprint else { throw ArtifactIOError.metadata }
            }
            try checkPath(source, expected: sourcePath)
            return ["fingerprint": fingerprint]
        }
        guard operation == "copy", let destinationPath = request["destination"] as? String,
              let destinationIdentity = request["destination_identity"] as? [String: Any] else { throw ArtifactIOError.request }
        let destination = try metadataFile(destinationPath, identity: destinationIdentity)
        guard isDirectory(before) == isDirectory(try destination.info()),
              fcopyfile(source.value, destination.value, nil, copyfile_flags_t(COPYFILE_METADATA)) == 0 else { throw ArtifactIOError.metadata }
        // copyfile can retain inherited destination ACEs. Reconstructing a
        // partially removed tree must replace these with the exact source ACL.
        var sourceACL = acl_get_fd_np(source.value, ACL_TYPE_EXTENDED)
        if sourceACL == nil {
            guard errno == ENOENT else { throw ArtifactIOError.metadata }
            sourceACL = acl_init(0)
        }
        guard let exactACL = sourceACL else { throw ArtifactIOError.metadata }
        defer { acl_free(UnsafeMutableRawPointer(exactACL)) }
        guard acl_set_fd_np(destination.value, exactACL, ACL_TYPE_EXTENDED) == 0 else { throw ArtifactIOError.metadata }
        // copyfile may clear special bits; restore all POSIX permission bits and
        // explicitly preserve birth/access/modification timestamps at nanosecond precision.
        struct Times { var birth: timespec; var modified: timespec; var accessed: timespec }
        var times = Times(birth: before.st_birthtimespec, modified: before.st_mtimespec, accessed: try accessTime(request["atime_ns"]))
        var attrs = attrlist(); attrs.bitmapcount = UInt16(ATTR_BIT_MAP_COUNT)
        attrs.commonattr = attrgroup_t(ATTR_CMN_CRTIME | ATTR_CMN_MODTIME | ATTR_CMN_ACCTIME)
        guard fsetattrlist(destination.value, &attrs, &times, MemoryLayout<Times>.size, 0) == 0,
              fchmod(destination.value, before.st_mode & 0o7777) == 0,
              fsync(destination.value) == 0, try metadataFingerprint(destination) == fingerprint,
              same(before, try source.info()), try metadataFingerprint(source) == fingerprint else { throw ArtifactIOError.metadata }
        try checkPath(source, expected: sourcePath); try checkPath(destination, expected: destinationPath)
        return ["fingerprint": fingerprint]
    }
    static func handle(_ request: [String: Any]) throws -> [String: Any] {
        guard try integer(request["version"]) == 1, let action = request["action"] as? String else { throw ArtifactIOError.request }
        if action == "path-metadata" { return try metadata(request) }
        let (fd, path, info) = try root(request)
        switch action {
        case "stage": return try stage(request, root: fd, rootPath: path, rootStat: info)
        case "commit": return try commit(request, root: fd, rootPath: path, rootStat: info)
        case "inspect": return try inspect(request, root: fd, rootPath: path, rootStat: info)
        case "cancel": return try cancel(request, root: fd, rootPath: path, rootStat: info)
        case "archive-download": return try archiveDownload(request, root: fd, rootPath: path, rootStat: info)
        case "inspect-source": return try inspectSource(request, root: fd, rootPath: path, rootStat: info)
        case "verify": return try verify(request, root: fd, rootPath: path, rootStat: info)
        case "read":
            guard let leaf = request["path"] as? String, !leaf.contains("/"), let identity = request["expected_identity"] as? [String: Any] else { throw ArtifactIOError.request }
            let maximum = try integer(request["max_bytes"] ?? 50 * 1024 * 1024)
            guard maximum > 0, maximum <= 50 * 1024 * 1024 else { throw ArtifactIOError.limit }
            let (source, relative, before) = try target(request, root: fd, rootPath: path)
            try sourceIdentity(before, expected: identity)
            let data = try read(source, limit: Int(maximum))
            try checkRoot(fd, path: path, before: info); try checkPath(source, expected: path + "/" + relative)
            guard same(before, try source.info()) else { throw ArtifactIOError.hash }
            return ["status": "read", "bytes": data.count, "sha256": digest(data), "data_base64": data.base64EncodedString()]
        case "thumbnail":
            let (source, relative, before) = try target(request, root: fd, rootPath: path)
            guard isFile(before) else { throw ArtifactIOError.image }
            let data = try read(source, limit: chunkLimit), actual = digest(data)
            if let expected = try sha(request["sha256"]), expected != actual { throw ArtifactIOError.hash }
            var result = thumbnail(data); result["sha256"] = actual
            try checkRoot(fd, path: path, before: info); try checkPath(source, expected: path + "/" + relative)
            guard same(before, try source.info()) else { throw ArtifactIOError.hash }; return result
        default: throw ArtifactIOError.request
        }
    }
    static func readRequest() throws -> [String: Any] {
        guard CommandLine.arguments.count == 1 else { throw ArtifactIOError.request }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
            if n < 0 { if errno == EINTR { continue }; throw ArtifactIOError.io }; if n == 0 { break }
            guard data.count <= inputLimit - n else { throw ArtifactIOError.limit }; data.append(contentsOf: buffer.prefix(n))
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ArtifactIOError.request }; return value
    }
}

#if ARTIFACT_IO_CLI
@main
struct ArtifactFileAccessCLI {
    static func main() {
        do {
            let value = try ArtifactFileAccess.handle(ArtifactFileAccess.readRequest())
            let data = try ArtifactFileAccess.json(value)
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
        } catch {
            let code = (error as? ArtifactIOError)?.rawValue ?? ArtifactIOError.request.rawValue
            let data = try! ArtifactFileAccess.json(["error": ["code": code]])
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(1)
        }
    }
}
#endif
