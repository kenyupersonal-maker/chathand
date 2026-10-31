import Foundation
import AppKit
@main struct NativeIntegrationEvidence {
    static func main() throws {
        var results = [[String:Any]]()
        for (prompt, webSuccess, copySuccess) in [
            ("fixture 中文",true,false),
            ("fixture 中文",false,true),
            ("fixture 中文",false,false),
            ("",true,true)
        ] {
            var sideEffects=0
            let environment=ClientFeatures.ChatEnvironment(openURL:{_ in sideEffects+=1;return webSuccess},copy:{_ in sideEffects+=1;return copySuccess})
            var result=[String:Any]()
            ClientFeatures.openChatGPT(prompt:prompt,environment:environment){result=$0}
            if prompt.isEmpty {precondition(sideEffects==1);precondition(result["opened"] as? String == "web");precondition(result["prefill_requested"] as? Bool == false)}
            else if webSuccess {precondition(result["opened"] as? String == "web");precondition(result["prefilled"] as? Bool == false)}
            else {precondition(result["error_code"] as? String == "CHATGPT_OPEN_FAILED")}
            results.append(result)
        }
        let target=ClientNotifications.browserRepairTarget(kind:"browser_connection_lost")!
        precondition(target == ["page":"settings","section":"browser","reason":"connection_lost"])
        for kind in [nil,"permission_required","unknown"] {precondition(ClientNotifications.browserRepairTarget(kind:kind)==nil)}
        let script=ClientNotifications.browserRepairScript(kind:"browser_connection_lost")!
        precondition(script.contains("browserRepairRequested"))
        let output:[String:Any]=["source":"injected native ChatEnvironment only; no live workspace or clipboard", "openChatGPT":results,"notification_target":target,"notification_script":script,"notification_title":ClientNotifications.browserConnectionLostTitle,"notification_body":ClientNotifications.browserConnectionLostBody]
        print(String(data:try JSONSerialization.data(withJSONObject:output,options:[.prettyPrinted,.sortedKeys]),encoding:.utf8)!)
    }
}
