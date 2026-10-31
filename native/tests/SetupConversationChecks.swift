import Foundation

@main struct SetupConversationChecks {
    static func main() {
        precondition(SetupConversation.promptURL("") == nil)
        precondition(SetupConversation.promptURL(" \n ") == nil)
        precondition(SetupConversation.promptURL(String(repeating:"a",count:16_385)) == nil)
        let prompt="帮我安装 ChatHand。C++ & a=b?x#1\n第二行 /路径/"
        let url=SetupConversation.promptURL(prompt)!
        let parts=URLComponents(url:url,resolvingAgainstBaseURL:false)!
        precondition(parts.scheme == "codex" && parts.host == "new" && parts.path.isEmpty)
        precondition(parts.queryItems?.count == 2)
        precondition(parts.queryItems?.first(where: { $0.name == "prompt" })?.value == prompt)
        precondition(parts.queryItems?.first(where: { $0.name == "mode" })?.value == "codex")
        precondition(parts.percentEncodedQuery!.contains("%2B%2B"))
        let status=SetupConversation.status()
        precondition(status["auto_sent"] as? Bool == false)
        print("PASS: blank/oversize rejection, Codex mode, exact Unicode and special-character prompt, read-only installed-app status; no URL opened")
    }
}
