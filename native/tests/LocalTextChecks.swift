import Foundation

@main
struct LocalTextChecks {
    static func main() throws {
        // Resource/presentation checks must not depend on or alter real app preferences.
        let domain = "invalid.chathand.catalog-tests." + UUID().uuidString
        LocalText.languagePreferences = LanguagePreferences(defaults: UserDefaults(suiteName: domain)!, domain: domain, systemLanguages: { ["zh-Hans"] })
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        var diagnostics = [(String, String)]()
        let catalog = LocalTextCatalog(directory: directory, diagnostic: { diagnostics.append(($0, $1)) })
        precondition(LocalText.normalize("en_US") == "en")
        precondition(LocalText.normalize("zh-Hant") == "zh")
        precondition(LocalText.normalize("fr") == "zh")
        precondition(catalog.text("test.empty", ["name":"<b>{other}</b>"], locale:"en") == "你好，<b>{other}</b>。")
        precondition(catalog.text("test.missingEnglish", locale:"en") == "关闭。")
        precondition(catalog.text("test.english", ["name":"{other}","other":"NO"], locale:"en") == "Hello, {other}.")
        precondition(catalog.text("test.english", locale:"en") == "Hello, {name}.")
        precondition(catalog.text("missing", ["secret":"not-logged"]) == "missing")
        precondition(diagnostics.count == 1 && diagnostics[0].0 == "I18N_KEY_MISSING" && diagnostics[0].1 == "missing")
        precondition(LocalText.text("native.menu.quit") == "退出 ChatHand")
        let state = MenuBarState(snapshot: ["enabled":true,"connection":["ready":true,"healthy":true],"project":["name":"demo"],"update":["status":"available","version":"1.2.3"]])
        precondition(state.connectionTitle == "ChatGPT 已连接")
        precondition(state.workspaceTitle == "文件范围：demo")
        precondition(state.updateMenuTitle == "更新到 1.2.3…")
        print("PASS: 13 native locale/resource/presentation checks")
    }
}
