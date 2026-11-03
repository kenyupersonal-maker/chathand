import AppKit

@main struct StartupAccessDeniedChecks {
    static func main() throws {
        _=NSApplication.shared
        let args=CommandLine.arguments,root=URL(fileURLWithPath:args[1]),runner=StartupMigration(),lock=NSLock()
        var result: StartupMigration.Result?,codes=[String]()
        DispatchQueue.global().async {
            let value=runner.run(executable:URL(fileURLWithPath:args[2]),script:URL(fileURLWithPath:args[3]),directory:root){code,_ in codes.append(code)}
            lock.lock();result=value;lock.unlock()
        }
        var received: StartupMigration.Result?
        let deadline=Date().addingTimeInterval(3)
        while received == nil && Date()<deadline {lock.lock();received=result;lock.unlock();if received == nil {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}}
        let failure=received!
        precondition(!failure.succeeded && failure.pid>0 && failure.code == "STARTUP_ACCESS_DENIED")
        precondition(codes.contains("MIGRATION_CHILD_STARTED") && codes.contains("MIGRATION_CHILD_GONE"))
        precondition(StartupFailureAlert.reason(failure.code) == "access")
        for language in ["zh","en"] {
            let text=(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:args[4]).appendingPathComponent(language+".json")))) as! [String:String]
            let (alert,actions)=StartupFailureAlert.make(code:failure.code,canRetry:true,text:{text[$0] ?? $0})
            precondition(alert.informativeText == text["native.startupFailure.access"]!+"\n(STARTUP_ACCESS_DENIED)")
            precondition(actions.map{$0.rawValue} == ["dataFolder","log","quit"])
            precondition(alert.buttons.first!.title == text["native.startupFailure.action.dataFolder"])
        }
        print("PASS: restricted settings -> preflight 75/STARTUP_ACCESS_DENIED -> access dataFolder,log,quit")
    }
}
