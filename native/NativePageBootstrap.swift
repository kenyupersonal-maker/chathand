import Foundation
import WebKit

/// In-memory main-frame bootstrap. Its local URL is safe for AX and screenshots.
enum NativePageBootstrap {
    static func install(web: WKWebView, origin: String, token: String, uiKey: String) -> URL? {
        guard let url=URL(string:origin+"/"),url.scheme=="http",url.host=="127.0.0.1",let port=url.port,port>0,
              url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,url.path=="/",
              let data=try? JSONSerialization.data(withJSONObject:["token":token,"uiKey":uiKey]),
              let payload=String(data:data,encoding:.utf8),
              let originData=try? JSONSerialization.data(withJSONObject:[origin]),
              let originArray=String(data:originData,encoding:.utf8) else { return nil }
        let source="if(location.origin===(\(originArray))[0]){Object.defineProperty(window,'__CHATHAND_AUTH__',{value:\(payload),configurable:true});}"
        web.configuration.userContentController.removeAllUserScripts()
        web.configuration.userContentController.addUserScript(WKUserScript(source:source,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        return url
    }
}
