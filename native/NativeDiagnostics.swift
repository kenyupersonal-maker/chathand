import Foundation
import Darwin

/// Categorical native receipts only. No URLs, clipboard bytes or exception text.
enum NativeDiagnostics {
    private static var pending: [[String: Any]] = []
    static func safe(_ url: URL) throws -> stat {
        var value = stat()
        guard lstat(url.path, &value) == 0, value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), value.st_uid == getuid(), value.st_nlink == 1 else { throw Failure.unsafe }
        return value
    }
    enum Failure: Error { case unsafe }
    static func record(in state: URL, phase: String, code: String, backendPID: Int?, generation: String, attempt: Int? = nil, chromeAccess: [String:Any]? = nil) {
        guard phase.range(of: "^[a-z_]{1,24}$", options: .regularExpression) != nil,
              code.range(of: "^[A-Z][A-Z0-9_]{0,63}$", options: .regularExpression) != nil else { return }
        var row: [String: Any] = ["at":ISO8601DateFormatter().string(from: Date()), "phase":phase, "code":code, "build":BuildVersion.buildNumber, "native_pid":Int(getpid()), "generation":generation]
        if let backendPID { row["backend_pid"] = backendPID }; if let attempt { row["attempt"] = attempt }
        if code == "CHROME_DATA_ACCESS_DENIED",let fields=chromeAccess,
           fields["flow"] as? String == "uninstall",["read","remove","list"].contains(fields["operation"] as? String ?? ""),
           ["native_host","native_host_backup"].contains(fields["path_kind"] as? String ?? ""),fields["accessor_role"] as? String == "native",
           fields["pid"] as? Int == Int(getpid()),["EACCES","EPERM","UNKNOWN"].contains(fields["errno"] as? String ?? ""),fields["os_attribution"] as? String == "unknown" {
            for key in ["flow","operation","path_kind","accessor_role","pid","errno","os_attribution"]{row[key]=fields[key]}
        }
        // Do not create a destination before the legacy migration has decided
        // whether it must populate it. Keep early startup metadata in memory.
        guard FileManager.default.fileExists(atPath: state.path) else { if pending.count < 100 { pending.append(row) }; return }
        let rows = pending + [row]; pending = []
        for row in rows { persist(row, in: state) }
    }
    private static func persist(_ row: [String: Any], in state: URL) {
        do {
            let fm = FileManager.default, dir = state.appendingPathComponent("diagnostics", isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var st = stat(); guard lstat(dir.path, &st) == 0, st.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), st.st_uid == getuid(), st.st_mode & 0o077 == 0 else { return }
            let file = dir.appendingPathComponent("native-events.jsonl")
            if fm.fileExists(atPath: file.path) {
                let existing = try safe(file)
                if existing.st_size > 512 * 1024 {
                    let old = dir.appendingPathComponent("native-events.jsonl.previous")
                    if fm.fileExists(atPath: old.path) { _ = try safe(old); try fm.removeItem(at: old) }
                    try fm.moveItem(at: file, to: old)
                }
            }
            let fd = Darwin.open(file.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600)); guard fd >= 0 else { return }
            defer { Darwin.close(fd) }; var opened = stat()
            guard fstat(fd, &opened) == 0, opened.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), opened.st_uid == getuid(), opened.st_nlink == 1, opened.st_mode & 0o077 == 0 else { return }
            var data = try JSONSerialization.data(withJSONObject: row); data.append(10)
            data.withUnsafeBytes { bytes in if let base = bytes.baseAddress { _ = Darwin.write(fd, base, bytes.count) } }
        } catch { }
    }
}
