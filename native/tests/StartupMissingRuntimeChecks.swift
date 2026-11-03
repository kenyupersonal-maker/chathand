import AppKit

@main struct StartupMissingRuntimeChecks {
    static func main() throws {
        _=NSApplication.shared
        let root=URL(fileURLWithPath:CommandLine.arguments[1]),catalogs=URL(fileURLWithPath:CommandLine.arguments[2])
        let script=root.appendingPathComponent("check.mjs")
        try Data("process.exit(0);".utf8).write(to:script)
        for kind in ["missing","not-executable"] {
            let executable=root.appendingPathComponent("ChatHandNode-"+kind)
            let original=Data("SYNTHETIC_NON_EXECUTABLE_RUNTIME".utf8)
            if kind == "not-executable" {try original.write(to:executable);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:executable.path)}
            let runner=StartupMigration(),lock=NSLock()
            var result: StartupMigration.Result?,diagnostics=[String]()
            DispatchQueue.global().async {
                let value=runner.run(executable:executable,script:script,directory:root){code,_ in diagnostics.append(code)}
                lock.lock();result=value;lock.unlock()
            }
            var received: StartupMigration.Result?
            let deadline=Date().addingTimeInterval(3)
            while received == nil && Date()<deadline {
                lock.lock();received=result;lock.unlock()
                if received == nil {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
            }
            let failure=received!
            precondition(failure.code == "SERVICE_NODE_MISSING" && !failure.succeeded && failure.pid == 0)
            precondition(!diagnostics.contains("MIGRATION_CHILD_STARTED"))
            precondition(StartupFailureAlert.reason(failure.code) == "nodeMissing")
            for language in ["zh","en"] {
                let text=(try JSONSerialization.jsonObject(with:Data(contentsOf:catalogs.appendingPathComponent(language+".json")))) as! [String:String]
                let (alert,actions)=StartupFailureAlert.make(code:failure.code,canRetry:true,text:{text[$0] ?? $0})
                precondition(alert.informativeText == text["native.startupFailure.nodeMissing"]!+"\n(SERVICE_NODE_MISSING)")
                precondition(actions.map{$0.rawValue} == ["download","log","quit"])
                precondition(alert.buttons.first!.title == text["native.startupFailure.action.download"])
            }
            if kind == "not-executable" {let saved=try Data(contentsOf:executable);precondition(saved == original)}
            else {precondition(!FileManager.default.fileExists(atPath:executable.path))}
            print("PASS: "+kind+" preflight -> SERVICE_NODE_MISSING -> download,log,quit")
        }
    }
}
