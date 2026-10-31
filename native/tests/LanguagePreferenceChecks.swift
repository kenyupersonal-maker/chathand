import Foundation
import AppKit

@main
struct LanguagePreferenceChecks {
    static func main() throws {
        let domain = "invalid.chathand.language-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain); _ = defaults.synchronize() }
        var osLanguages = ["en-US"]
        func fresh() -> LanguagePreferences {
            LanguagePreferences(defaults: UserDefaults(suiteName: domain)!, domain: domain, systemLanguages: { osLanguages })
        }
        // Both factories return this isolated suite. Never invoke the real
        // UserDefaults.standard factory while testing the same-bundle branch.
        var standardCalls = 0, suiteCalls = 0
        let standardFactory: () -> UserDefaults = { standardCalls += 1; return defaults }
        let suiteFactory: (String) -> UserDefaults? = { requestedDomain in
            precondition(requestedDomain == LanguagePreferences.appDomain)
            suiteCalls += 1; return defaults
        }
        precondition(LanguagePreferences.defaultsForApplication(bundleIdentifier: LanguagePreferences.appDomain, standard: standardFactory, suite: suiteFactory) === defaults)
        precondition(standardCalls == 1 && suiteCalls == 0)
        precondition(LanguagePreferences.defaultsForApplication(bundleIdentifier: "invalid.chathand.test-helper", standard: standardFactory, suite: suiteFactory) === defaults)
        precondition(standardCalls == 1 && suiteCalls == 1)
        precondition(LanguagePreferences.defaultsForApplication(bundleIdentifier: nil, standard: standardFactory, suite: suiteFactory) === defaults)
        precondition(standardCalls == 1 && suiteCalls == 2)
        let preferences = fresh()
        LocalText.languagePreferences = preferences
        precondition(preferences.preference == "system" && preferences.locale == "en")
        // Unrelated preferences survive removal of the per-app language override.
        defaults.set("preserved", forKey: "unrelated")
        for (preference, locale) in [("zh", "zh"), ("en", "en"), ("system", "en")] {
            let response = preferences.setLanguage(preference)
            precondition(response["ok"] as? Bool == true)
            precondition(response["preference"] as? String == preference && response["locale"] as? String == locale)
            let reloaded = fresh()
            precondition(reloaded.preference == preference && reloaded.locale == locale)
            if preference == "system" { precondition(defaults.persistentDomain(forName: domain)?["AppleLanguages"] == nil) }
            else { precondition(defaults.persistentDomain(forName: domain)?["AppleLanguages"] as? [String] == [preference]) }
        }
        precondition(defaults.string(forKey: "unrelated") == "preserved")
        // Strict validation: no normalization, coercion or accidental reset on malformed input.
        _ = preferences.setLanguage("en")
        for invalid: Any? in [nil, "", "EN", " en", "en-US", "System", 1, true, ["en"], ["language": "zh"]] {
            precondition(preferences.setLanguage(invalid)["error_code"] as? String == "ARG_INVALID")
            precondition(fresh().preference == "en" && fresh().locale == "en")
        }
        // Explicit choices do not follow OS changes; system reads the OS provider each time,
        // including after an app override was selected (no cached Locale fallback).
        osLanguages = ["zh-Hant-TW"]
        precondition(preferences.locale == "en")
        _ = preferences.setLanguage("system")
        precondition(preferences.locale == "zh")
        osLanguages = ["en-GB"]
        precondition(preferences.locale == "en")
        osLanguages = ["fr-FR"]
        precondition(preferences.locale == "zh")
        defaults.set(["en-US"], forKey: "AppleLanguages")
        precondition(fresh().preference == "en") // macOS Language & Region per-app setting.

        // Refresh the actual NSMenu object in place. Existing targets, shortcuts,
        // enabled/hidden states and nested menu ownership must survive the update.
        _ = preferences.setLanguage("zh")
        let menu = NSMenu(), submenu = NSMenu()
        let root = NativeLanguageMenu.add("native.menu.display", to: menu, action: nil)
        root.submenu = submenu
        let item = NativeLanguageMenu.add("native.menu.zoomIn", to: submenu, action: Selector(("zoomIn")), shortcut: "+")
        let target = NSObject(); item.target = target; item.isEnabled = false; item.isHidden = true
        item.keyEquivalentModifierMask = [.command, .shift]
        let literal = submenu.addItem(withTitle: "User content", action: nil, keyEquivalent: "")
        precondition(item.title == LocalText.catalog.text("native.menu.zoomIn", locale: "zh"))
        _ = preferences.setLanguage("en"); NativeLanguageMenu.refresh(menu)
        precondition(menu.items[0] === root && submenu.items[0] === item)
        precondition(root.title == LocalText.catalog.text("native.menu.display", locale: "en") && submenu.title == root.title)
        precondition(item.title == LocalText.catalog.text("native.menu.zoomIn", locale: "en"))
        precondition(item.target === target && item.action == Selector(("zoomIn")) && item.keyEquivalent == "+")
        precondition(!item.isEnabled && item.isHidden && item.keyEquivalentModifierMask == [.command, .shift])
        precondition(literal.title == "User content")
        osLanguages = ["zh-Hans"]
        _ = preferences.setLanguage("system"); NativeLanguageMenu.refresh(menu)
        precondition(item.title == LocalText.catalog.text("native.menu.zoomIn", locale: "zh"))

        // Notification consumers cannot retain a title from an earlier language.
        let connectionSnapshot: [String:Any] = ["enabled":true, "connection":["display":["title":"已连接", "connected":true]]]
        precondition(MenuBarState(snapshot:connectionSnapshot).connectionTitle == "已连接")
        let chinese = ClientNotifications.browserConnectionLostTitle
        _ = preferences.setLanguage("en")
        precondition(MenuBarState(snapshot:connectionSnapshot).connectionTitle == LocalText.catalog.text("native.connection.ready", locale:"en"))
        precondition(chinese != ClientNotifications.browserConnectionLostTitle)
        precondition(ClientNotifications.browserConnectionLostTitle == LocalText.catalog.text("native.notification.browserLost.title", locale: "en"))
        let capabilityName = LocalText.catalog.chinese["permissions.capability.browser.name"]!
        precondition(ClientNotifications.confirmationTitle(item: ["id": "browser", "name": capabilityName]) == LocalText.catalog.text("notification.confirmation.request", ["name": LocalText.catalog.english["permissions.capability.browser.name"]!], locale: "en"))
        let userName = "My custom item"
        precondition(ClientNotifications.confirmationTitle(item: ["id": "custom", "name": userName]).contains(userName))
        let oldBody = LocalText.catalog.text("notification.task.manualContinue", ["title": "My task"], locale: "zh")
        precondition(ClientNotifications.continuationBody(["body": oldBody, "title": "My task"]) == LocalText.catalog.text("notification.task.manualContinue", ["title": "My task"], locale: "en"))
        precondition(ClientNotifications.continuationBody(["body": "Literal user content"]) == "Literal user content")
        print("PASS: isolated language persistence, strict arguments, fresh OS language, actual native menu refresh and notifications")
    }
}
