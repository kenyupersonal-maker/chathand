import Foundation
import Darwin

/// Owns only the read-only format-check child launched by this instance. All
/// waits and pipe draining happen on the startup worker, never on the AppKit thread.
final class StartupMigration {
    private static let runTimeout: TimeInterval = 9
    private static let termTimeout: TimeInterval = 1
    private static let killTimeout: TimeInterval = 2

    struct Result {
        let code: String
        let pid: Int32
        let succeeded: Bool
    }

    static func messageKey(code: String) -> String {
        code == "DATA_FORMAT_NEWER" ? "native.migration.dataNewer" :
        code == "DATA_FORMAT_UNSUPPORTED" ? "native.migration.dataUnsupported" :
        code == "MIGRATION_TIMEOUT" ? "native.migration.timeout" :
        code == "MIGRATION_LAUNCH_FAILED" ? "native.migration.launchFailed" :
        "native.migration.failed"
    }

    private let lock=NSLock()
    private var cancelled=false
    private var active=false

    /// Returns whether a launched/launching child still needs bounded cleanup.
    @discardableResult func cancel() -> Bool {
        lock.lock();defer{lock.unlock()};cancelled=true;return active
    }
    var isCancelled: Bool {lock.lock();defer{lock.unlock()};return cancelled}

    func run(executable: URL, script: URL, directory: URL, diagnostic: (String,Int32)->Void) -> Result {
        precondition(!Thread.isMainThread)
        lock.lock()
        guard !cancelled else{lock.unlock();return Result(code:"MIGRATION_CANCELLED",pid:0,succeeded:false)}
        active=true;lock.unlock()
        defer {lock.lock();active=false;lock.unlock()}

        let process=Process(),errorPipe=Pipe(),outputPipe=Pipe(),started=ProcessInfo.processInfo.systemUptime
        let deadline=started+Self.runTimeout
        process.executableURL=executable;process.arguments=[script.path];process.currentDirectoryURL=directory
        process.standardInput=FileHandle.nullDevice;process.standardOutput=outputPipe;process.standardError=errorPipe
        let fd=errorPipe.fileHandleForReading.fileDescriptor,flags=fcntl(errorPipe.fileHandleForReading.fileDescriptor,F_GETFL)
        let outputFD=outputPipe.fileHandleForReading.fileDescriptor,outputFlags=fcntl(outputPipe.fileHandleForReading.fileDescriptor,F_GETFL)
        guard flags>=0,fcntl(fd,F_SETFL,flags|O_NONBLOCK)==0,outputFlags>=0,fcntl(outputFD,F_SETFL,outputFlags|O_NONBLOCK)==0 else{return Result(code:"MIGRATION_PIPE_FAILED",pid:0,succeeded:false)}
        do {try process.run()} catch {return Result(code:"MIGRATION_LAUNCH_FAILED",pid:0,succeeded:false)}
        let pid=process.processIdentifier
        diagnostic("MIGRATION_CHILD_STARTED",pid)
        var stderr=Data()

        // Drain both pipes without waiting for EOF (including a writer
        // inherited by an unexpected descendant), retaining only the bounded
        // stderr prefix needed for exact 73/74 code recognition.
        func drain() {
            var buffer=[UInt8](repeating:0,count:16384)
            for stream in [fd,outputFD] {for _ in 0..<8 {
                let n=Darwin.read(stream,&buffer,buffer.count)
                guard n>0 else{break}
                if stream==fd && stderr.count<512 {stderr.append(contentsOf:buffer.prefix(min(n,512-stderr.count)))}
            }}
        }
        let observed=try? InstanceLifecycle.identity(pid)
        func gone() -> Bool { (try? InstanceLifecycle.alive(pid)) == false }
        func signalExact(_ signal: Int32) -> Bool {
            if gone(){return true}
            guard let observed,let current=try? InstanceLifecycle.identity(pid),current==observed else{return false}
            return Darwin.kill(pid,signal)==0 || errno==ESRCH
        }
        func pauseForChild() {
            var items=[pollfd(fd:fd,events:Int16(POLLIN),revents:0),pollfd(fd:outputFD,events:Int16(POLLIN),revents:0)]
            items.withUnsafeMutableBufferPointer{_=poll($0.baseAddress,nfds_t($0.count),20)}
        }
        func wait(until limit: TimeInterval) -> Bool {
            repeat {
                drain()
                if !process.isRunning && gone(){return true}
                pauseForChild()
            } while ProcessInfo.processInfo.systemUptime<limit
            drain();return !process.isRunning && gone()
        }

        while process.isRunning && ProcessInfo.processInfo.systemUptime<deadline && !isCancelled {
            drain();pauseForChild()
        }
        drain()
        if !process.isRunning && wait(until:min(deadline,ProcessInfo.processInfo.systemUptime+0.2)) {
            diagnostic("MIGRATION_CHILD_GONE",pid)
            let raw=String(data:stderr,encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines)
            let formatCode: String? = process.terminationReason == .exit && process.terminationStatus==73 && raw=="DATA_FORMAT_NEWER" ? "DATA_FORMAT_NEWER" : process.terminationReason == .exit && process.terminationStatus==74 && raw=="DATA_FORMAT_UNSUPPORTED" ? "DATA_FORMAT_UNSUPPORTED" : nil
            if let formatCode {diagnostic(formatCode,pid)}
            return Result(code:isCancelled ? "MIGRATION_CANCELLED" : formatCode ?? (process.terminationStatus==0 ? "MIGRATION_COMPLETE":"MIGRATION_CHILD_FAILED"),pid:pid,succeeded:!isCancelled && process.terminationStatus==0)
        }

        let reason=isCancelled ? "MIGRATION_CANCELLED":"MIGRATION_TIMEOUT"
        diagnostic(reason,pid)
        guard signalExact(SIGTERM) else{return Result(code:"MIGRATION_CHILD_IDENTITY_UNKNOWN",pid:pid,succeeded:false)}
        diagnostic("MIGRATION_TERM_SENT",pid)
        if !wait(until:ProcessInfo.processInfo.systemUptime+Self.termTimeout) {
            guard signalExact(SIGKILL) else{return Result(code:"MIGRATION_CHILD_IDENTITY_UNKNOWN",pid:pid,succeeded:false)}
            diagnostic("MIGRATION_KILL_SENT",pid)
            guard wait(until:ProcessInfo.processInfo.systemUptime+Self.killTimeout) else{return Result(code:"MIGRATION_CHILD_EXIT_TIMEOUT",pid:pid,succeeded:false)}
        }
        diagnostic("MIGRATION_CHILD_GONE",pid)
        return Result(code:reason,pid:pid,succeeded:false)
    }
}
