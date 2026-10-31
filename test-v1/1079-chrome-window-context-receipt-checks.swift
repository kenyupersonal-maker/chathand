final class CancelStub {
    var calls=0
    func cancel() { calls += 1 }
    func finishAccessibilityOnly(granted:Bool) { calls += 1 }
}
final class Lifecycle {
    var chromeDiscoveryProof: ChromeInstallDiscoveryProof?, chromePreflightProof: ChromeInstallDiscoveryProof?
    var chromeDiscoveryProofSlot: ChromeInstallDiscoveryProofSlot?
    var chromeInstallPreparationCancel:(()->Void)?, chromeSettingsGeneration:UUID?
    let chromeDataAccessResume=CancelStub(), chromeAccessibilityWait=CancelStub(), permissionAssistant=CancelStub()
/* PRODUCTION_CANCEL */
    func cancel() {cancelChromePreparation()}
}
@main struct Checks {
    static var checks = 0
    static func expect(_ value: Bool, _ label: String) { precondition(value,label); checks += 1 }
    static func main() throws {
        let root=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("runtime")
        for name in ChromeInstallSource.files {let file=root.appendingPathComponent("browser-extension/"+name);try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true);try Data(("synthetic:"+name).utf8).write(to:file)}
        for relation in ChromeInstallWindowRelation.allCases {
            var context=ChromeInstallEmptyWindowContext(relation:relation)
            context.minimized=true;context.main=false;context.focused=true;context.appActive=false;context.appHidden=true;context.subrole = .standard
            let detail=ChromeInstallFailureDetail(.sheetsAXError,axError:-25205,fallbackCode:.childrenEmpty,windowContext:context)!
            let adapter=PreflightAdapter();adapter.wanted=detail
            var notes:[[String:Any]]=[]
            let installer=ChromeHelperInstaller(runtime:root,expectedFolder:root.appendingPathComponent("helper"),origin:{"http://127.0.0.1:1234"},api:{_,_,_ in preconditionFailure("empty preflight must not acquire lease")},adapter:{adapter},diagnostic:{notes.append($0)})
            var reply:[String:Any]=[:];installer.start(profileID:"Profile 4"){reply=$0}
            let bridge=Bridge();bridge.deliver(reply)
            for fields in [reply,notes.last!,bridge.reports.first!] {
                expect(fields["window_relation"] as? String == relation.rawValue,"controller reply, preflightNote and acknowledged progress retain typed relation")
                expect(fields["empty_window_minimized"] as? Bool == true && fields["empty_window_main"] as? Bool == false && fields["empty_window_focused"] as? Bool == true,"three Boolean window fields survive")
                expect(fields["app_active"] as? Bool == false && fields["app_hidden"] as? Bool == true && fields["window_subrole"] as? String == "STANDARD","finite app state and subrole survive")
                expect(fields["detail_code"] as? String == "SHEETS_AX_ERROR" && fields["fallback_code"] as? String == "CHILDREN_EMPTY","original receipt preserved")
            }
            expect(adapter.failureDetail == nil && adapter.closes == 1,"detail captured before close clears it")
        }
        var base:[String:Any]=["detail_code":"SHEETS_AX_ERROR","ax_error":-25205,"fallback_code":"CHILDREN_EMPTY","window_relation":"OTHER","error":["code":ChromeInstallCode.sheet.rawValue]]
        for key in ["empty_window_minimized","empty_window_main","empty_window_focused","app_active","app_hidden"] {
            for value:Any in [1,0,"true",NSNull(),[true]] {
                var fields=base;fields[key]=value
                let decoded=ChromeInstallFailureDetail(metadata:fields)!
                expect(decoded.windowContext?.metadata[key] == nil && decoded.windowContext?.relation == .other,"only actual Boolean accepted; invalid optional field alone dropped")
                let bridge=Bridge();bridge.deliver(fields)
                expect(bridge.reports.first?["detail_code"] as? String == "SHEETS_AX_ERROR" && bridge.reports.first?[key] == nil,"bad optional never hides primary stop")
            }
        }
        for value:Any in ["private-subrole",true,NSNull()] {var fields=base;fields["window_subrole"]=value;expect(ChromeInstallFailureDetail(metadata:fields)?.windowContext?.subrole == nil,"only finite subrole metadata retained")}
        for value:Any in ["private-window",true,1,NSNull()] {var fields=base;fields["window_relation"]=value;fields["app_active"]=true;let decoded=ChromeInstallFailureDetail(metadata:fields);expect(decoded?.windowContext == nil && decoded?.fallbackCode == .childrenEmpty,"invalid relation discards context, preserves primary detail")}
        for fallback in ["DEADLINE","CHILDREN_INVALID"] {var fields=base;fields["fallback_code"]=fallback;expect(ChromeInstallFailureDetail(metadata:fields)?.windowContext == nil,"context only for exact empty fallback")}
        for ax in [-25204,0] {var fields=base;fields["ax_error"]=ax;expect(ChromeInstallFailureDetail(metadata:fields)?.windowContext == nil,"context requires exact original unsupported error")}
        let later=Bridge();later.stage="opening_chrome";later.deliver(base);expect(later.reports.first?["window_relation"] == nil,"preparing only")
        let wrong=Bridge();var fields=base;fields["error"]=["code":ChromeInstallCode.target.rawValue];wrong.deliver(fields);expect(wrong.reports.first?["window_relation"] == nil,"exact main code required")
        base["window_id"]=123;base["pid"]=321;base["reference"]="PRIVATE_REF";base["profile_path"]="PRIVATE_PATH";base["window_title"]="PRIVATE_TITLE";base["url"]="PRIVATE_URL"
        let safe=Bridge();safe.deliver(base)
        let encoded=String(decoding:try JSONSerialization.data(withJSONObject:safe.reports),as:UTF8.self)
        expect(!encoded.contains("PRIVATE_") && safe.reports.first?["window_id"] == nil && safe.reports.first?["pid"] == nil,"raw identity, paths and text cannot cross typed projection")
        let allowed=Set(["native_event","stage","elapsed_ms","target_is_default","attempt_id","code","detail_code","ax_error","fallback_code","window_relation"])
        expect(Set(safe.reports.first!.keys).isSubset(of:allowed),"unrecognized metadata excluded")
        let lifecycle=Lifecycle(),slot=ChromeInstallDiscoveryProofSlot(),attempt=UUID(),ref=NSObject()
        let proof=ChromeInstallDiscoveryProof(attempt:attempt,observedAt:100,anchors:[.init(pid:1,epoch:100,windowID:11,reference:ref,profileID:"Profile 4")])
        lifecycle.chromeDiscoveryProof=proof;lifecycle.chromePreflightProof=proof;lifecycle.chromeDiscoveryProofSlot=slot;slot.store(proof)
        var canceled=false;lifecycle.chromeInstallPreparationCancel={canceled=true;expect(lifecycle.chromeDiscoveryProof == nil && lifecycle.chromePreflightProof == nil && lifecycle.chromeDiscoveryProofSlot == nil,"actual cancel clears proof before downstream cancellation")}
        lifecycle.cancel();expect(canceled && lifecycle.chromeInstallPreparationCancel == nil,"original preparation cancellation retained")
        slot.store(proof);expect(slot.take() == nil,"actual cancellation closes background slot against late result")
        print("PASS: \(checks) window context receipt checks; synthetic controller and actual main extracts")
    }
}
