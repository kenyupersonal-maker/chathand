import Foundation

@main struct StartupDiagnosticsChecks {
    static func main() throws {
        let state=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        let statuses: [Int32] = [1,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,255]
        var expected: [String] = []
        for status in statuses {
            guard let code=NativeDiagnostics.startupFailureCode(reason:.exit,status:status) else {fatalError("nonzero exit missing")}
            expected.append(code)
            NativeDiagnostics.record(in:state,phase:"startup",code:code,backendPID:4242,generation:"synthetic-generation")
        }
        precondition(NativeDiagnostics.startupFailureCode(reason:.exit,status:0)==nil)
        for status in statuses + [0,9,15] {
            precondition(NativeDiagnostics.startupFailureCode(reason:.uncaughtSignal,status:status)==nil)
        }
        let bytes=try Data(contentsOf:state.appendingPathComponent("diagnostics/native-events.jsonl"))
        let text=String(decoding:bytes,as:UTF8.self)
        let rows=try text.split(separator:"\n").map {try JSONSerialization.jsonObject(with:Data($0.utf8)) as! [String:Any]}
        precondition(rows.compactMap{$0["code"] as? String}==expected)
        let allowed=Set(["at","phase","code","build","native_pid","backend_pid","generation"])
        for row in rows {precondition(Set(row.keys)==allowed)}
        precondition(!text.contains(state.path) && !text.contains("PRIVATE_SYNTHETIC"))
        print("PASS: fixed startup categories persisted with categorical fields only")
    }
}
