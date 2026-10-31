import Foundation
import CoreFoundation
#if canImport(AppKit)
import AppKit
#endif

/// Shared flat JSON catalogs. Bundle resources are explicit; cwd is never a source.
struct LocalTextCatalog {
    let chinese: [String: String]
    let english: [String: String]
    var diagnostic: (String, String) -> Void = { code, key in
        fputs("[i18n] \(code) \(key)\n", stderr)
    }
    init(directory: URL, diagnostic: ((String, String) -> Void)? = nil) {
        func read(_ language: String) -> [String: String] {
            guard let bytes = try? Data(contentsOf: directory.appendingPathComponent(language + ".json")),
                  let table = try? JSONDecoder().decode([String: String].self, from: bytes) else { return [:] }
            return table
        }
        chinese = read("zh"); english = read("en")
        if let diagnostic { self.diagnostic = diagnostic }
    }
    func text(_ key: String, _ parameters: [String: String] = [:], locale: String = "zh") -> String {
        guard let chinese = chinese[key], !chinese.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            diagnostic("I18N_KEY_MISSING", key); return key
        }
        let english = english[key] ?? ""
        let sentence = LocalText.normalize(locale) == "en" && !english.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? english : chinese
        guard let regex = try? NSRegularExpression(pattern: "\\{([A-Za-z][A-Za-z0-9_]*)\\}") else { return sentence }
        // Replace backwards against the original string: parameter contents are literal.
        let output = NSMutableString(string: sentence)
        for match in regex.matches(in: sentence, range: NSRange(sentence.startIndex..., in: sentence)).reversed() {
            let name = (sentence as NSString).substring(with: match.range(at: 1))
            if let value = parameters[name] { output.replaceCharacters(in: match.range, with: value) }
        }
        return output as String
    }
}
/// Stored in the stable App preference domain, independent of the installed version/path.
/// Read the app domain explicitly: ordinary defaults lookup inherits global AppleLanguages
/// and cannot distinguish a first launch from an explicit per-app selection.
final class LanguagePreferences {
    static let appDomain = "com.kenyu.chathand"
    private let defaults: UserDefaults
    private let domain: String
    private let systemLanguages: () -> [String]
    init(defaults: UserDefaults, domain: String, systemLanguages: @escaping () -> [String]) {
        self.defaults = defaults; self.domain = domain; self.systemLanguages = systemLanguages
    }
    /// Injected factories let tests prove bundle/helper routing without accessing
    /// or writing the actual App's standard defaults.
    static func defaultsForApplication(bundleIdentifier: String?, standard: () -> UserDefaults,
                                       suite: (String) -> UserDefaults?) -> UserDefaults {
        if bundleIdentifier == appDomain { return standard() }
        return suite(appDomain)!
    }
    static func live() -> LanguagePreferences {
        observeStartup(.liveEnter)
        let defaults = defaultsForApplication(bundleIdentifier: Bundle.main.bundleIdentifier,
                                              standard: { .standard }, suite: { UserDefaults(suiteName: $0) })
        observeStartup(.defaultsReady)
        return LanguagePreferences(defaults: defaults, domain: appDomain, systemLanguages: globalLanguages)
    }
    private enum StartupCode: String {
        case liveEnter = "LANGUAGE_LIVE_ENTER"
        case defaultsReady = "LANGUAGE_DEFAULTS_READY"
        case globalReadEnter = "LANGUAGE_GLOBAL_READ_ENTER"
        case globalReadReturn = "LANGUAGE_GLOBAL_READ_RETURN"
        case appReadEnter = "LANGUAGE_APP_READ_ENTER"
        case appReadReturn = "LANGUAGE_APP_READ_RETURN"
    }
    private static let startupLock = NSLock()
    private static var observedStartup = Set<String>()
    /// Metadata only, once per phase, and only in an isolated rehearsal. This
    /// observes the normal preference path; no alternate access or sandbox bypass.
    private static func observeStartup(_ code: StartupCode) {
        guard ProcessInfo.processInfo.environment["CHATHAND_REHEARSAL_ROOT"] != nil else { return }
        startupLock.lock()
        let first = observedStartup.insert(code.rawValue).inserted
        startupLock.unlock()
        if first { fputs("[language-startup] \(code.rawValue)\n", stderr) }
    }
    private var appLanguages: Any? {
        Self.observeStartup(.appReadEnter)
        let languages = defaults.persistentDomain(forName: domain)?["AppleLanguages"]
        Self.observeStartup(.appReadReturn)
        return languages
    }
    static func globalLanguages() -> [String] {
        // Locale.preferredLanguages is cached and may include this app's override.
        // Read the actual global domain, never the current application's search list.
        observeStartup(.globalReadEnter)
        let languages = CFPreferencesCopyValue("AppleLanguages" as CFString, kCFPreferencesAnyApplication,
                                               kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String] ?? []
        observeStartup(.globalReadReturn)
        return languages
    }
    var preference: String {
        guard let languages = appLanguages as? [String],
              let first = languages.first else { return "system" }
        return LocalText.normalize(first)
    }
    var locale: String { preference == "system" ? LocalText.normalize(systemLanguages().first) : preference }
    func setLanguage(_ raw: Any?) -> [String: Any] {
        guard let value = raw as? String, ["system", "zh", "en"].contains(value) else {
            return ["error_code": "ARG_INVALID"]
        }
        let previous = appLanguages
        if value == "system" { defaults.removeObject(forKey: "AppleLanguages") }
        else { defaults.set([value], forKey: "AppleLanguages") }
        guard defaults.synchronize() else {
            if let previous { defaults.set(previous, forKey: "AppleLanguages") }
            else { defaults.removeObject(forKey: "AppleLanguages") }
            _ = defaults.synchronize()
            return ["error_code": "PREFERENCE_SAVE_FAILED"]
        }
        return ["ok": true, "preference": preference, "locale": locale]
    }
}

#if canImport(AppKit)
/// Retain native menu objects, targets, shortcuts and enabled state while replacing titles.
/// IDs carry catalog keys so language changes refresh every existing submenu in place.
enum NativeLanguageMenu {
    @discardableResult
    static func add(_ key: String, to menu: NSMenu, action: Selector?, shortcut: String = "") -> NSMenuItem {
        let item = menu.addItem(withTitle: LocalText.text(key), action: action, keyEquivalent: shortcut)
        item.identifier = NSUserInterfaceItemIdentifier(key)
        return item
    }
    static func refresh(_ menu: NSMenu) {
        for item in menu.items {
            if let key = item.identifier?.rawValue, key.hasPrefix("native.") {
                item.title = LocalText.text(key)
                item.submenu?.title = item.title
            }
            if let submenu = item.submenu { refresh(submenu) }
        }
    }
}
#endif

enum LocalText {
    static func normalize(_ locale: String?) -> String {
        guard let locale, locale.count <= 128 else { return "zh" }
        let clean = locale.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "_", with: "-").lowercased()
        return clean.range(of: "^en(?:-[a-z0-9]+)*$", options: .regularExpression) != nil ? "en" : "zh"
    }
    // The historical name is kept for all native/helper call sites. It now returns
    // the effective App language; cards and Chrome extension UI have separate policies.
    static var languagePreferences = LanguagePreferences.live()
    static var preference: String { languagePreferences.preference }
    static var systemLocale: String { languagePreferences.locale }
    static var localeSource: String { preference == "system" ? "system_preferred_languages" : "app_language_preference" }
    static func resourceDirectory(bundle: Bundle = .main, executable: URL? = Bundle.main.executableURL) -> URL {
        var candidates: [URL] = []
        if let resources = bundle.resourceURL { candidates.append(resources.appendingPathComponent("locales", isDirectory: true)) }
        if let executable {
            let folder = executable.standardizedFileURL.deletingLastPathComponent()
            if folder.lastPathComponent == "bin" {
                candidates.append(folder.deletingLastPathComponent().appendingPathComponent("locales", isDirectory: true))
            }
            if folder.lastPathComponent == "MacOS" {
                candidates.append(folder.deletingLastPathComponent().appendingPathComponent("Resources/locales", isDirectory: true))
            }
        }
        return candidates.first { candidate in
            FileManager.default.fileExists(atPath: candidate.appendingPathComponent("zh.json").path)
        } ?? candidates.first ?? URL(fileURLWithPath: "/__chathand_missing_locale_resources__", isDirectory: true)
    }
    static let catalog = LocalTextCatalog(directory: resourceDirectory())
    static func text(_ key: String, _ parameters: [String: String] = [:]) -> String {
        catalog.text(key, parameters, locale: systemLocale)
    }
}
