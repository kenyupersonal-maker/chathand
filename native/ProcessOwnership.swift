import Foundation
import Darwin

/// Only executable paths and kernel start times are inspected; never argv/env.
enum ChatHandProcessOwnership {
    struct Identity: Equatable {
        let pid: Int32
        let path: String
        let startedSeconds: UInt64
        let startedMicroseconds: UInt64
    }
    static func identity(_ pid: Int32) -> Identity? {
        // PROC_PIDPATHINFO_MAXSIZE is a C expression macro, unavailable to Swift.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        var info = proc_bsdinfo()
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout.size(ofValue: info))) == MemoryLayout.size(ofValue: info) else { return nil }
        return Identity(pid: pid, path: String(cString: buffer), startedSeconds: info.pbi_start_tvsec, startedMicroseconds: info.pbi_start_tvusec)
    }
    static func runtimeProcesses(app: URL) throws -> [Identity] {
        let root = app.appendingPathComponent("Contents/Resources/runtime/bin").path
        let names = ["ChatHandNode", "node", "ChatHandBrowserHost", "ken-browser-host", "ChatHandDocumentReader", "ken-document-reader", "ChatHandArtifactIO", "ken-artifact-io", "ChatHandTunnel", "tunnel-client", "ChatHandCloudflared", "cloudflared"]
        let allowed = Set(names.map { root + "/" + $0 })
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { throw Failure.enumeration }
        var pids = [Int32](repeating: 0, count: Int(count) + 256)
        let bytes = Int32(pids.count * MemoryLayout<Int32>.size)
        let actual = proc_listallpids(&pids, bytes)
        guard actual >= 0, actual < pids.count else { throw Failure.enumeration }
        return pids.prefix(Int(actual)).compactMap(identity).filter { $0.pid > 1 && $0.pid != getpid() && allowed.contains($0.path) }
    }
    enum Failure: Error { case enumeration, signal, stillRunning }
    static func terminate(_ observed: Identity) throws {
        guard identity(observed.pid) == observed else { return }
        guard kill(observed.pid, SIGTERM) == 0 || errno == ESRCH else { throw Failure.signal }
    }
}
