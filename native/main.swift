import Cocoa
import WebKit
import UserNotifications
import CryptoKit


/// A separate, memory-only key for permission undo. It is never given to the
/// renderer, a URL, an environment variable, a state file, or a log.
final class PermissionUndoProof {
    enum Failure: String, Error {
        case invalidReceipt = "UNDO_INVALID"
        case notHuman = "CONFIRM_NOT_HUMAN"
        case reusedInput = "NATIVE_OWNER_INPUT_USED"
        case invalidClock = "NATIVE_OWNER_PROOF_INVALID"
    }

    private let key: SymmetricKey
    private var lastConsumedInput: TimeInterval?

    init(keyData: Data? = nil) {
        precondition(keyData == nil || keyData?.count == 32)
        key = keyData.map { SymmetricKey(data: $0) } ?? SymmetricKey(size: .bits256)
    }

    // Native startup calls this once for the inherited stdin pipe. No bridge
    // action calls it, and no reply includes it.
    var startupKeyHex: String { key.withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() } }

    func issue(receiptID: String, actualButtonEvent: Bool, eventTimestamp: TimeInterval,
               windowInputAge: TimeInterval?, hidClickAge: TimeInterval, hidKeyAge: TimeInterval,
               nowMilliseconds: Int64, nonceData: Data? = nil) throws -> [String: Any] {
        guard receiptID.range(of: "^pr_[a-f0-9]{32}$", options: .regularExpression) != nil else { throw Failure.invalidReceipt }
        guard actualButtonEvent, eventTimestamp.isFinite, eventTimestamp >= 0,
              ConfirmGuard.isHuman(via: "window", windowInputAge: windowInputAge, hidClickAge: hidClickAge, hidKeyAge: hidKeyAge) else { throw Failure.notHuman }
        guard nowMilliseconds >= 0 else { throw Failure.invalidClock }
        if let previous = lastConsumedInput, eventTimestamp <= previous { throw Failure.reusedInput }
        if let nonceData, nonceData.count != 16 { throw Failure.invalidClock }
        let nonce: String
        if let nonceData { nonce = nonceData.map { String(format: "%02x", $0) }.joined() }
        else { nonce = SymmetricKey(size: .bits128).withUnsafeBytes { $0.map { String(format: "%02x", $0) }.joined() } }
        let message = "ChatHand.permissionUndo.v1\n\(receiptID)\n\(nowMilliseconds)\n\(nonce)"
        let signature = HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: key).map { String(format: "%02x", $0) }.joined()
        lastConsumedInput = eventTimestamp
        return ["v": 1, "issued_at": nowMilliseconds, "nonce": nonce, "signature": signature]
    }
}


/// JavaScript may request presentation of an existing server receipt. Only this
/// native button's actual event can issue an undo proof. There is no bridge
/// action for signing, activating the button, or changing its receipt binding.
final class PermissionUndoToast: NSObject {
    typealias API = (String, [String: Any]?, @escaping ([String: Any]) -> Void) -> Void
    private struct Binding {
        let id: String
        let deadline: TimeInterval
        let view: NSView
        let label: NSTextField
        let button: NSButton
    }
    private weak var window: NSWindow?
    private weak var web: WKWebView?
    private let signer: PermissionUndoProof
    private let api: API
    private var binding: Binding?
    private var pendingPresentation: UUID?
    private var expiry: Timer?
    private var applying = false

    init(window: NSWindow, web: WKWebView, signer: PermissionUndoProof, api: @escaping API) {
        self.window = window; self.web = web; self.signer = signer; self.api = api
        super.init()
    }

    deinit { expiry?.invalidate() }

    func present(receiptID: String, style: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        guard receiptID.range(of: "^pr_[a-f0-9]{32}$", options: .regularExpression) != nil else {
            completion(Self.error("UNDO_INVALID", LocalText.text("native.undo.invalid"))); return
        }
        guard !applying else { completion(Self.error("UNDO_PRESENTATION_BUSY", LocalText.text("native.undo.busy"))); return }
        if let current = binding, current.id == receiptID {
            // Repeated renderer requests neither extend the deadline nor rebind.
            completion(["ok": true, "presented": true]); return
        }
        let request = UUID(); pendingPresentation = request
        api("/api/permissions/undo-info", ["receipt_id": receiptID]) { [weak self] result in
            guard let self else { return }
            guard self.pendingPresentation == request, !self.applying else {
                completion(Self.error("UNDO_PRESENTATION_STALE", LocalText.text("native.undo.stale"))); return
            }
            self.pendingPresentation = nil
            guard result["ok"] as? Bool == true, result["receipt_id"] as? String == receiptID,
                  let message = result["message"] as? String, !message.isEmpty, message.count <= 240,
                  let serverRemaining = result["remaining_ms"] as? Double, serverRemaining.isFinite, serverRemaining > 0, serverRemaining <= 30000,
                  let expiresAt = result["expires_at"] as? Double, expiresAt.isFinite,
                  let web = self.web, let window = self.window else { self.remove(); completion(result["error"] == nil ? Self.error("UNDO_INVALID", LocalText.text("native.undo.unavailable")) : result); return }
            let remaining = min(serverRemaining, expiresAt - Date().timeIntervalSince1970 * 1000)
            guard remaining > 0 else { self.remove(); completion(Self.error("UNDO_EXPIRED", LocalText.text("native.undo.expired"))); return }
            // The old native button is removed; its immutable binding is never
            // edited. A fresh button is created only for this server-validated ID.
            self.remove()
            let toast = NSView(); toast.translatesAutoresizingMaskIntoConstraints = false; toast.wantsLayer = true
            let dark = (style["dark"] as? Bool) ?? (window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
            toast.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            let background = (Self.color(style["background"]) ?? (dark ? NSColor(calibratedWhite: 0.16, alpha: 1) : NSColor(calibratedWhite: 0.12, alpha: 1))).withAlphaComponent(1)
            let foreground = Self.readable(Self.color(style["foreground"]) ?? .white, on: background)
            let border = Self.color(style["border"]) ?? NSColor.white.withAlphaComponent(0.12)
            let accent = Self.readable(Self.color(style["accent"]) ?? foreground, on: background)
            let radius = Self.number(style["radius"], fallback: 14, range: 8...28)
            let fontSize = Self.number(style["font_size"], fallback: 13, range: 12...18)
            let bottom = Self.number(style["bottom"], fallback: 28, range: 8...64)
            toast.layer?.backgroundColor = background.cgColor; toast.layer?.borderColor = border.cgColor
            toast.layer?.borderWidth = 1; toast.layer?.cornerRadius = radius
            toast.layer?.shadowColor = NSColor.black.cgColor; toast.layer?.shadowOpacity = 0.14; toast.layer?.shadowRadius = 12; toast.layer?.shadowOffset = CGSize(width: 0, height: -3)
            let label = NSTextField(labelWithString: message); label.font = .systemFont(ofSize: fontSize); label.textColor = foreground
            label.lineBreakMode = .byTruncatingTail; label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let button = NSButton(title: LocalText.text("native.menu.undo"), target: self, action: #selector(self.pressed(_:)))
            button.isBordered = false; button.font = .systemFont(ofSize: fontSize, weight: .medium)
            button.attributedTitle = NSAttributedString(string: LocalText.text("native.menu.undo"), attributes: [.foregroundColor: accent, .font: NSFont.systemFont(ofSize: fontSize, weight: .medium)])
            button.setAccessibilityLabel(LocalText.text("native.undo.accessibility"))
            let stack = NSStackView(views: [label, button]); stack.orientation = .horizontal; stack.spacing = 16; stack.alignment = .centerY; stack.translatesAutoresizingMaskIntoConstraints = false
            toast.addSubview(stack); web.addSubview(toast)
            NSLayoutConstraint.activate([
                toast.centerXAnchor.constraint(equalTo: web.centerXAnchor), toast.bottomAnchor.constraint(equalTo: web.bottomAnchor, constant: -bottom),
                toast.leadingAnchor.constraint(greaterThanOrEqualTo: web.leadingAnchor, constant: 24), toast.trailingAnchor.constraint(lessThanOrEqualTo: web.trailingAnchor, constant: -24),
                stack.leadingAnchor.constraint(equalTo: toast.leadingAnchor, constant: 16), stack.trailingAnchor.constraint(equalTo: toast.trailingAnchor, constant: -16),
                stack.topAnchor.constraint(equalTo: toast.topAnchor, constant: 12), stack.bottomAnchor.constraint(equalTo: toast.bottomAnchor, constant: -12), button.widthAnchor.constraint(greaterThanOrEqualToConstant: 30)
            ])
            let deadline = ProcessInfo.processInfo.systemUptime + remaining / 1000
            self.binding = Binding(id: receiptID, deadline: deadline, view: toast, label: label, button: button)
            self.expiry = Timer.scheduledTimer(withTimeInterval: remaining / 1000, repeats: false) { [weak self] _ in if self?.applying != true { self?.remove() } }
            completion(["ok": true, "presented": true])
        }
    }

    @objc private func pressed(_ sender: NSButton) {
        guard !applying, let binding, binding.button === sender, let window,
              sender.window === window, let event = NSApp.currentEvent, event.window === window,
              ProcessInfo.processInfo.systemUptime < binding.deadline else { return }
        let actualEvent: Bool
        switch event.type {
        case .leftMouseUp:
            actualEvent = sender.bounds.contains(sender.convert(event.locationInWindow, from: nil))
        case .keyDown:
            actualEvent = window.firstResponder === sender && event.modifierFlags.intersection([.command, .control, .option]).isEmpty && [" ", "\r", "\n"].contains(event.charactersIgnoringModifiers ?? "")
        default: actualEvent = false
        }
        let proof: [String: Any]
        do {
            proof = try signer.issue(receiptID: binding.id, actualButtonEvent: actualEvent, eventTimestamp: event.timestamp,
                windowInputAge: ProcessInfo.processInfo.systemUptime - event.timestamp,
                hidClickAge: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .leftMouseDown),
                hidKeyAge: CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown),
                nowMilliseconds: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
        } catch { binding.label.stringValue = LocalText.text("native.click.unrecognized"); return }
        applying = true; expiry?.invalidate(); sender.isEnabled = false
        api("/api/permissions/undo", ["receipt_id": binding.id, "proof": proof]) { [weak self] result in
            guard let self, let current = self.binding, current.button === sender else { return }
            self.applying = false
            let success = result["ok"] as? Bool == true && result["restored"] as? Bool == true
            current.label.stringValue = success ? LocalText.text("native.undo.applied") : (result["error"] as? [String: Any])?["message"] as? String ?? LocalText.text("native.undo.unknown")
            current.button.isHidden = true
            self.expiry = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in self?.remove() }
        }
    }

    private func remove() { expiry?.invalidate(); expiry = nil; binding?.view.removeFromSuperview(); binding = nil }
    private static func error(_ code: String, _ message: String) -> [String: Any] { ["error": ["code": code, "message": message]] }
    private static func number(_ value: Any?, fallback: CGFloat, range: ClosedRange<CGFloat>) -> CGFloat {
        guard let number = value as? Double, number.isFinite else { return fallback }
        return min(range.upperBound, max(range.lowerBound, CGFloat(number)))
    }
    private static func color(_ value: Any?) -> NSColor? {
        guard let components = value as? [Double], [3, 4].contains(components.count), components.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { return nil }
        return NSColor(srgbRed: components[0], green: components[1], blue: components[2], alpha: components.count == 4 ? components[3] : 1)
    }
    private static func readable(_ candidate: NSColor, on background: NSColor) -> NSColor {
        let opaque = candidate.withAlphaComponent(1)
        func luminance(_ color: NSColor) -> Double {
            let rgb = color.usingColorSpace(.sRGB) ?? .black
            let components = [rgb.redComponent, rgb.greenComponent, rgb.blueComponent].map { value -> Double in
                let number = Double(value); return number <= 0.04045 ? number / 12.92 : pow((number + 0.055) / 1.055, 2.4)
            }
            return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722
        }
        let a = luminance(opaque), b = luminance(background)
        if (max(a, b) + 0.05) / (min(a, b) + 0.05) >= 4.5 { return opaque }
        return (b + 0.05) / 0.05 >= 1.05 / (b + 0.05) ? .black : .white
    }
}


/// Match the native area revealed by WKWebView elastic scrolling to the page.
/// The renderer may supply a color only; this path has no permission authority.
enum PageBackgroundSync {
    static func color(_ value: Any?) -> NSColor? {
        guard let values = value as? [Double], values.count == 4,
              values.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }),
              values[3] == 1 else { return nil }
        return NSColor(srgbRed: values[0], green: values[1], blue: values[2], alpha: 1)
    }

    static func synchronize(window: NSWindow?, web: WKWebView?, color: NSColor? = nil) {
        guard let window else { return }
        var resolved = color
        if resolved == nil {
            window.effectiveAppearance.performAsCurrentDrawingAppearance {
                resolved = NSColor.windowBackgroundColor.usingColorSpace(.sRGB)
            }
        }
        let background = (resolved ?? .windowBackgroundColor).withAlphaComponent(1)
        window.backgroundColor = background
        web?.underPageBackgroundColor = background
    }
}


// 1030: ask Launch Services first, then retain the former standard-location fallback.
private func chromeApplicationURL() -> URL? {
    if let located = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome"), FileManager.default.fileExists(atPath: located.path) { return located }
    return [URL(fileURLWithPath:"/Applications/Google Chrome.app"),FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Google Chrome.app")].first { FileManager.default.fileExists(atPath:$0.path) }
}

// Native shell loads only the bundled local UI. Chat websites always open externally.
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate, NSWindowDelegate, NSMenuDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var item: NSStatusItem!
    let emergencyStopHotKey = EmergencyStopHotKey()
    var zoomInMenuItem: NSMenuItem?
    var zoomInEqualMenuItem: NSMenuItem?
    var zoomOutMenuItem: NSMenuItem?
    var menuTracking = false
    var serviceAvailable = false
    var process: Process?
    private var rehearsalPageObserver: RehearsalPageObserver?
    private weak var attachedBackend: Process?
    private weak var stoppingStartupBackend: Process?
    private var backendGeneration = UUID()
    private var backendRecovery = BackendRecoveryPolicy()
    private var backendRecoveryInProgress = false
    private var ownerPipeWriter: FileHandle?
    private var instanceLease: InstanceLifecycle.Lease?
    private var startupLease: InstanceLifecycle.Lease?
    private let startupMigration = StartupMigration()
    private var migrationQuitPending = false
    private var termination = NativeTerminationCoordinator()
    private var quitCompletionScheduled = false
    private var instanceScope: InstanceLifecycle.Scope?
    private var priorBackend: InstanceLifecycle.Backend?
    private var relaunchProcess: Process?
    private var relaunchPipe: FileHandle?
    private var reopenHelperPreparing=false
    private var reopenHelperReady=false
    private var reopenHelperDeadline:TimeInterval=0
    private var reopenReadyReader:FileHandle?
    private var reopenReadyBytes=Data()
    private var instanceObservers: [NSObjectProtocol] = []
    private var uninstallInProgress = false
    private var uninstallAuditState: URL?
    // Metadata-only owner calls. No prompt, status payload, path or permission receipt is sent.
    private var onboardingPageObserved = false
    private var onboardingLaunchEnd: ((String, String) -> Void)?
    private var onboardingPending: [[String: Any]] = []
    private var onboardingSending = false
    private var onboardingRetryAfter: TimeInterval = 0
    private var onboardingDeliveryFailures = 0
    private var onboardingDeliveryState = "pending"
    private func onboardingTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    private func onboardingRecord(_ body: [String: Any]) {
        guard onboardingPending.count < 200 else {
            onboardingDeliveryFailures += 1; onboardingDeliveryState = "unconfirmed"; return
        }
        onboardingPending.append(body)
        onboardingFlush()
    }
    private func onboardingFlush() {
        guard interfaceKeyShared, !origin.isEmpty, !onboardingSending, !onboardingPending.isEmpty, ProcessInfo.processInfo.systemUptime >= onboardingRetryAfter else { return }
        onboardingSending = true
        let body = onboardingPending[0]
        api("/api/onboarding/event",body) { response in
            self.onboardingSending = false
            guard response["recorded"] as? Bool == true else {
                // Keep the original observation and timestamps; no false delivery success.
                self.onboardingDeliveryFailures += 1
                self.onboardingDeliveryState = "unconfirmed"
                self.onboardingRetryAfter = ProcessInfo.processInfo.systemUptime + 5
                return
            }
            self.onboardingPending.removeFirst()
            self.onboardingDeliveryState = self.onboardingPending.isEmpty ? "recorded" : "pending"
            self.onboardingRetryAfter = 0
            self.onboardingFlush()
        }
    }
    func onboardingBegin(_ step: String) -> (String, String) -> Void {
        let span = "o_" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24))
        let started = Date(), startedUptime = ProcessInfo.processInfo.systemUptime
        let base: [String: Any] = ["step":step,"actor":"unknown","source":"native","span":String(span)]
        var first = base; first.merge(["phase":"start","result":"pending","error_code":"NONE","wait_ms":0,"observed_at":onboardingTimestamp(started)]) { _,new in new }
        onboardingRecord(first)
        var ended = false
        return { result, code in
            guard !ended else { return }; ended = true
            var last = base
            last.merge(["phase":"end","result":result,"error_code":code,"wait_ms":min(604800000,max(0,Int((ProcessInfo.processInfo.systemUptime-startedUptime)*1000))),"observed_at":self.onboardingTimestamp(Date())]) { _,new in new }
            self.onboardingRecord(last)
        }
    }
    var ownsService = false
    let keepAwake = KeepAwake()
    var timer: Timer?
    var origin = ""
    var token = ""
    var lastEvent: Int? = nil
    var pollInFlight = false
    var eventInstance = ""
    var notifiedKeys: [String] = []
    private var networkChallengeNotifications = NetworkChallengeNotificationGate(delivered:UserDefaults.standard.stringArray(forKey:"ChatHandNetworkChallengeDelivered") ?? [])
    var lastOpen: [String: Date] = [:]
    var state: [String: Any] = [:]
    var lastWindowInput: (timestamp: TimeInterval, sourcePID: Int64)?
    var windowInputMonitor: Any?
    var notificationAuthorizationRequested = false
    var clientUIReady = false
    var pendingClientRoute: [String: String]?

    /// Key for changes only the window may make (switches, approvals). Lives only in memory: piped to the service on
    /// start and injected into the local main frame; never put in a URL/file/environment.
    let interfaceKey: String = { var bytes = [UInt8](repeating: 0, count: 32); arc4random_buf(&bytes, bytes.count); return bytes.map { String(format: "%02x", $0) }.joined() }()
    var interfaceKeyShared = false
    private let permissionUndoProof = PermissionUndoProof()
    private var permissionUndoToast: PermissionUndoToast?
    var shuttingDown = false
    var computerTimer: Timer?
    var lastComputerStatusData: Data?
    var computerPollInFlight = false
    var computerActionInFlight = false
    var appearanceObservation: NSKeyValueObservation?
    var lastStatusIconKey: String?
    var computerPermissionsAtLaunch: [String: Any] = [:]
    var chromeInstallPreparation: UUID?
    private var chromeInstallPreparationCancel: (() -> Void)?
    private let chromeAccessibilityWait = ChromeAccessibilityWait()
    private lazy var chromeWebStoreFlow = ChromeWebStoreFlow(authorized: { [weak self] in
        guard let self else { return false }
        return self.ownsService && self.interfaceKeyShared && !self.shuttingDown
    }, prepare: { [weak self] body, reply in
        guard let self else { reply(["error_code":"OWNED_WINDOW_REQUIRED"]); return }
        self.api("/api/browser/extension/prepare", body, completion:reply)
    }, launch: { request, reply in
        guard let chrome = chromeApplicationURL() else { reply(false); return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = request.arguments
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at:chrome, configuration:configuration) { _, error in
            DispatchQueue.main.async { reply(error == nil) }
        }
    })
    // Disabled: the production bridge below routes every local-install action to the Web Store.
    lazy var chromeHelperInstaller = ChromeHelperInstaller(runtime: packageURL, expectedFolder: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ChatHand/chrome-helper", isDirectory: true), origin: { [weak self] in self?.origin ?? "" }, api: { [weak self] route, body, done in
        guard let self, !self.shuttingDown else { done(["error": ["code": "CHROME_INSTALL_CANCELLED"]]); return }
        self.api(route, body, completion: done)
    }, adapter: { [unowned self] in
        let proof = self.chromePreflightProof
        self.chromePreflightProof = nil
        return ChromeInstallAXAdapter(runtime:self.packageURL, discoveryProof:proof)
    }, diagnostic: { [weak self] metadata in
        self?.api("/api/browser/extension/install/progress", metadata) { _ in }
    })
    private var clientFeaturesInitialized = false
    private func invalidateClientAppearance() {
        if clientFeaturesInitialized { clientFeatures.invalidateAppearance() }
    }
    lazy var clientFeatures: ClientFeatureCoordinator = {
        self.clientFeaturesInitialized = true
        return ClientFeatureCoordinator(api: { [weak self] route, body, done in
        guard let self = self else { done(["error": ["code": "LOCAL_NETWORK"]]); return }
        self.api(route, body, completion: done)
    }, appearanceAPI: { [weak self] route, body, done in
        guard let self else { done(["cancelled": true, "delivery_unconfirmed": true]); return }
        self.api(route, body, onExpired: { done(["cancelled": true, "delivery_unconfirmed": true]) }, completion: done)
    }, applyAppearance: { [weak self] mode in
        _ = ClientFeatures.setAppearance(mode: mode, window: self?.window)
        PageBackgroundSync.synchronize(window:self?.window,web:self?.web)
        if let window = self?.window {
            WindowChrome.place(window)
            DispatchQueue.main.async { WindowChrome.place(window) }
        }
    }, applyUIZoom: { [weak self] zoom in
        guard let self, let web = self.web, let window = self.window else { return }
        ClientFeatures.setUIZoom(zoom: zoom, web: web, window: window)
        self.refreshZoomMenu()
    })
    }()
    @available(macOS 14.0, *) lazy var permissionAssistant = PermissionAssistant()
    let stateURL: URL = {
        if let override=ProcessInfo.processInfo.environment["CHATHAND_STATE_DIR"] { return URL(fileURLWithPath:override) }
        if let override=ProcessInfo.processInfo.environment["KEN_BRIDGE_STATE_DIR"] { return URL(fileURLWithPath:override) }
        let base=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ChatHand")
        return base.appendingPathComponent("data")
    }()
    var packageURL: URL { Bundle.main.resourceURL!.appendingPathComponent("runtime") }

    func applicationDidFinishLaunching(_ n: Notification) {
        nativeRecord("launch", "APP_LAUNCH")
        let center=DistributedNotificationCenter.default()
        instanceObservers.append(center.addObserver(forName:Notification.Name("com.kenyu.chathand.show."+String(getpid())),object:nil,queue:.main){[weak self] note in
            if self?.deferReopenWhileQuitting(activate:note.userInfo?["activate"] as? Bool != false)==true {return}
            if note.userInfo?["activate"] as? Bool == false { self?.showAutomatically() } else { self?.show() }
        })
        instanceObservers.append(center.addObserver(forName:Notification.Name("com.kenyu.chathand.quit."+String(getpid())),object:nil,queue:.main){[weak self]_ in self?.quit()})
        onboardingLaunchEnd = onboardingBegin("first_launch_guidance")
        if #available(macOS 14.0, *) {
            computerPermissionsAtLaunch = permissionAssistant.status()
            permissionAssistant.onboardingBegin = { [weak self] step in self?.onboardingBegin(step) ?? { _,_ in } }
        }
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu(); let appMenu = NSMenu(); let root = NSMenuItem(); root.submenu = appMenu
        NativeLanguageMenu.add("native.menu.about",to:appMenu,action:#selector(about),shortcut:"")
        NativeLanguageMenu.add("native.menu.settings",to:appMenu,action:#selector(showSettings),shortcut:",")
        let uninstallItem = NativeLanguageMenu.add("native.uninstall.menu",to:appMenu,action:#selector(uninstallChatHand(_:)),shortcut:"")
        uninstallItem.target = self
        NativeLanguageMenu.add("native.menu.quit",to:appMenu,action:#selector(quit),shortcut:"q")
        menu.addItem(root)
        let editRoot=NSMenuItem();editRoot.identifier=NSUserInterfaceItemIdentifier("native.menu.edit"); let edit=NSMenu(title:LocalText.text("native.menu.edit"));editRoot.submenu=edit
        NativeLanguageMenu.add("native.menu.undo",to:edit,action:Selector(("undo:")),shortcut:"z")
        let redo=NativeLanguageMenu.add("native.menu.redo",to:edit,action:Selector(("redo:")),shortcut:"z");redo.keyEquivalentModifierMask=[.command,.shift]
        for (title,action,key) in [("native.menu.copy",#selector(NSText.copy(_:)),"c"),("native.menu.paste",#selector(NSText.paste(_:)),"v"),("native.menu.cut",#selector(NSText.cut(_:)),"x"),("native.menu.selectAll",#selector(NSText.selectAll(_:)),"a")] { NativeLanguageMenu.add(title,to:edit,action:action,shortcut:key) }
        let displayRoot=NSMenuItem(title:LocalText.text("native.menu.display"),action:nil,keyEquivalent:""),display=NSMenu(title:LocalText.text("native.menu.display"));displayRoot.identifier=NSUserInterfaceItemIdentifier("native.menu.display");displayRoot.submenu=display
        zoomInMenuItem=NativeLanguageMenu.add("native.menu.zoomIn",to:display,action:#selector(zoomIn),shortcut:"+");zoomInMenuItem?.target=self;zoomInMenuItem?.keyEquivalentModifierMask=[.command]
        zoomInEqualMenuItem=NativeLanguageMenu.add("native.menu.zoomIn",to:display,action:#selector(zoomIn),shortcut:"=");zoomInEqualMenuItem?.target=self;zoomInEqualMenuItem?.keyEquivalentModifierMask=[.command];zoomInEqualMenuItem?.isHidden=true;zoomInEqualMenuItem?.allowsKeyEquivalentWhenHidden=true
        zoomOutMenuItem=NativeLanguageMenu.add("native.menu.zoomOut",to:display,action:#selector(zoomOut),shortcut:"-");zoomOutMenuItem?.target=self;zoomOutMenuItem?.keyEquivalentModifierMask=[.command]
        let defaultZoom=NativeLanguageMenu.add("native.menu.zoomReset",to:display,action:#selector(resetZoom),shortcut:"0");defaultZoom.target=self;defaultZoom.keyEquivalentModifierMask=[.command]
        let windowRoot=NSMenuItem(title:LocalText.text("native.menu.window"),action:nil,keyEquivalent:""),windowMenu=NSMenu(title:LocalText.text("native.menu.window"));windowRoot.identifier=NSUserInterfaceItemIdentifier("native.menu.window");windowRoot.submenu=windowMenu
        NativeLanguageMenu.add("native.menu.closeWindow",to:windowMenu,action:#selector(NSWindow.performClose(_:)),shortcut:"w")
        NativeLanguageMenu.add("native.menu.minimize",to:windowMenu,action:#selector(NSWindow.performMiniaturize(_:)),shortcut:"m")
        menu.addItem(editRoot);menu.addItem(displayRoot);menu.addItem(windowRoot);NSApp.mainMenu = menu;NSApp.windowsMenu=windowMenu
        refreshZoomMenu()
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img=NSImage(named:"MenuBarIcon") {img.isTemplate=true;img.accessibilityDescription="ChatHand";item.button?.image=img;item.button?.imagePosition = .imageOnly}
        item.button?.toolTip="ChatHand"
        if #unavailable(macOS 26),let url=Bundle.main.url(forResource:"AppIcon-rounded-512",withExtension:"png"),let image=NSImage(contentsOf:url){NSApp.applicationIconImage=image}
        let statusMenu=NSMenu();statusMenu.delegate=self;statusMenu.autoenablesItems=false;item.menu=statusMenu
        refreshStatusMenu()
        emergencyStopHotKey.onPress={ [weak self] in self?.stopAutomation() }
        emergencyStopHotKey.register()
        ComputerControl.authorizeRequest = { [weak self] id, completion in
            guard let self, !self.shuttingDown else { completion(false); return }
            self.api("/api/computer/authorize", ["id":id]) { result in
                completion(!self.shuttingDown && result["authorized"] as? Bool == true)
            }
        }
        ComputerControl.onStop = { [weak self] in self?.stopAutomation() }
        UNUserNotificationCenter.current().delegate=self
        registerConfirmationNotifications()
        let available=NSScreen.main?.visibleFrame.size ?? NSSize(width:1280,height:860)
        let width=available.width<1280 ? max(980,available.width*0.9) : 1280
        let height=available.height<860 ? max(680,available.height*0.9) : 860
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:width,height:height),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title="ChatHand";window.contentMinSize=NSSize(width:980,height:680);window.center();window.delegate=self
        WindowChrome.configure(window)
        windowInputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp, .keyDown]) { [weak self] event in
            if let self, let window = self.window, event.window === window {
                self.lastWindowInput = (event.timestamp, event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1)

            }
            return event // 不吞掉系统事件，也不更改旧A的粘贴流程。
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.fillScreenIfFullScreen() }
        appearanceObservation = window.observe(\.effectiveAppearance, options: [.new]) { [weak self] observed, _ in
            guard self?.window === observed else { return }
            WindowChrome.place(observed)
            PageBackgroundSync.synchronize(window:observed,web:self?.web)
            DispatchQueue.main.async { WindowChrome.place(observed) }
        }
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self,name:"native")
        web=ChromeWebView(frame:window.contentView!.bounds,configuration:config);web.autoresizingMask=[.width,.height];web.navigationDelegate=self;web.uiDelegate=self
        // 1028：先放进窗口再按保存的界面大小调窗口。原来先调窗口（放大到 137.5%、150% 时窗口会被撑大）、后放网页，
        // 网页还是原来的尺寸，贴在左下角，窗口顶上和右边各空出一条白边（Ken 10/7 截图）。
        window.contentView!.addSubview(web)
        PageBackgroundSync.synchronize(window:window,web:web)
        rehearsalPageObserver = RehearsalPageObserver.attach(web:web,window:window,
            showWindow:{[weak self] in self?.show()},
            servicePID:{[weak self] in self?.process.map{Int($0.processIdentifier)}},ownerKeyReady:{[weak self] in self?.interfaceKeyShared == true && self?.ownsService == true})
        let savedZoom = ClientFeatures.savedUIZoom()
        ClientFeatures.setUIZoom(zoom: savedZoom, web: web, window: window, remember: false)
        web.frame = window.contentView!.bounds
        refreshZoomMenu()
        showAutomatically()
        nativeRecord("startup", "WINDOW_SHOWN")
        beginStartup()
    }
    var currentUIZoom: Double {
        if let web, let zoom=ClientFeatures.normalizedUIZoom(web.pageZoom) { return zoom }
        return ClientFeatures.savedUIZoom()
    }
    func refreshZoomMenu() {
        let zoom=currentUIZoom
        let canGrow=zoom < (ClientFeatures.uiZoomLevels.last ?? 1.5),canShrink=zoom > (ClientFeatures.uiZoomLevels.first ?? 1)
        zoomInMenuItem?.isEnabled=canGrow;zoomInEqualMenuItem?.isEnabled=canGrow;zoomOutMenuItem?.isEnabled=canShrink
    }
    func requestUIZoom(_ zoom: Double) {
        guard ClientFeatures.normalizedUIZoom(zoom) != nil else { return }
        clientFeatures.setUIZoom(zoom:zoom) { [weak self] response in
            guard let self, response["error"] == nil else { return }
            self.refreshZoomMenu()
            self.web.evaluateJavaScript("window.showZoom?.(\(zoom))",completionHandler:nil)
        }
    }
    @objc func zoomIn() {
        guard let index=ClientFeatures.uiZoomLevels.firstIndex(of:currentUIZoom),index+1<ClientFeatures.uiZoomLevels.count else { refreshZoomMenu();return }
        requestUIZoom(ClientFeatures.uiZoomLevels[index+1])
    }
    @objc func zoomOut() {
        guard let index=ClientFeatures.uiZoomLevels.firstIndex(of:currentUIZoom),index>0 else { refreshZoomMenu();return }
        requestUIZoom(ClientFeatures.uiZoomLevels[index-1])
    }
    @objc func resetZoom() { requestUIZoom(1.25) }
    func menuWillOpen(_ menu: NSMenu) { menu.removeAllItems();refreshStatusMenu();menuTracking=true }
    func menuDidClose(_ menu: NSMenu) { menuTracking=false }
    func refreshStatusMenu() {
        guard let menu=item?.menu else{return}
        let presentation=MenuBarState(snapshot:state,serviceAvailable:serviceAvailable)
        updateStatusIcon(presentation)
        guard !menuTracking && menu.numberOfItems == 0 else{return}
        menu.removeAllItems()
        func summary(_ title:String,_ detail:String) {
            let entry=NSMenuItem(title:title,action:nil,keyEquivalent:"")
            let view=NSView(frame:NSRect(x:0,y:0,width:360,height:52))
            let primary=NSTextField(labelWithString:title),secondary=NSTextField(labelWithString:detail)
            primary.font = .systemFont(ofSize:13,weight:.semibold);secondary.font = .systemFont(ofSize:11)
            primary.textColor = .labelColor;secondary.textColor = .secondaryLabelColor
            primary.frame=NSRect(x:14,y:29,width:332,height:18);secondary.frame=NSRect(x:14,y:9,width:332,height:16)
            for label in [primary,secondary] {label.lineBreakMode = .byTruncatingTail;view.addSubview(label)}
            view.toolTip=title+"\n"+detail;entry.view=view;menu.addItem(entry)
        }
        func action(_ title:String,_ selector:Selector,_ symbol:String?=nil)->NSMenuItem {
            let entry=menu.addItem(withTitle:title,action:selector,keyEquivalent:"");entry.target=self
            if let symbol {entry.image=NSImage(systemSymbolName:symbol,accessibilityDescription:title)}
            return entry
        }
        summary(presentation.connectionTitle,presentation.workspaceTitle)
        for task in presentation.tasks.prefix(3) {summary(task.title,task.detail)}
        if presentation.tasks.count>3 {_ = action(LocalText.text("native.menu.moreTasks", ["count": String(presentation.tasks.count-3)]),#selector(showTasks))}
        menu.addItem(.separator())
        let pause=action(presentation.accessEnabled ? LocalText.text("native.menu.pause") : LocalText.text("native.menu.resume"),#selector(togglePause),presentation.accessEnabled ? "pause" : "play")
        pause.isEnabled=serviceAvailable && (presentation.accessEnabled || presentation.isConnected)
        let stop=action(LocalText.text("native.menu.stop"),#selector(stopAutomation),"stop")
        stop.keyEquivalent="\u{1b}";stop.keyEquivalentModifierMask=[.control,.option]
        if emergencyStopHotKey.registrationStatus != 0 {stop.toolTip=LocalText.text("native.menu.stopTooltip")}
        menu.addItem(.separator())
        _ = action(LocalText.text("native.menu.repair"),#selector(checkAndRepair))
        if let title=presentation.updateMenuTitle {action(title,#selector(installUpdate(_:))).representedObject=presentation.updateVersion}
        _ = action(LocalText.text("native.menu.open"),#selector(userShow))
        _ = action(LocalText.text("native.menu.settings"),#selector(showSettings))
        _ = action(LocalText.text("native.uninstall.menu"),#selector(uninstallChatHand(_:)))
        _ = action(LocalText.text("native.menu.quit"),#selector(quit))
    }
    func refreshNativeLanguage() {
        if #available(macOS 14.0, *) { permissionAssistant.refreshLanguage() }
        if let menu = NSApp.mainMenu { NativeLanguageMenu.refresh(menu) }
        // Clear the cached status menu; normal status polls deliberately retain its items.
        // Language is changed from the settings window, outside status-menu tracking.
        item?.menu?.cancelTracking()
        menuTracking = false
        item?.menu?.removeAllItems()
        refreshStatusMenu()
        registerConfirmationNotifications()
    }
    func updateStatusIcon(_ presentation:MenuBarState) {
        guard let button=item?.button else { return }
        let buttonAppearance=button.effectiveAppearance
        let appearance=buttonAppearance.bestMatch(from:[.darkAqua,.aqua])?.rawValue ?? "default"
        let iconKey="\(presentation.indicator)|\(presentation.shortStatus)|\(presentation.connectionTitle)|\(appearance)"
        guard iconKey != lastStatusIconKey else { return }
        lastStatusIconKey=iconKey
        var labelColor=NSColor.labelColor
        buttonAppearance.performAsCurrentDrawingAppearance { labelColor=NSColor.labelColor.usingColorSpace(.deviceRGB)! }
        let idleColor=NSColor(srgbRed:0,green:214.0/255,blue:169.0/255,alpha:1)
        let connectingColor=NSColor(srgbRed:217.0/255,green:174.0/255,blue:36.0/255,alpha:1)
        let errorColor=NSColor(srgbRed:214.0/255,green:69.0/255,blue:69.0/255,alpha:1)
        let image=NSImage(size:NSSize(width:29,height:18),flipped:false){ rect in
            if let mark=NSImage(named:"MenuBarIcon") {
                let markRect=NSRect(x:0,y:0,width:18,height:18)
                mark.draw(in:markRect,from:.zero,operation:.sourceOver,fraction:1,respectFlipped:false,hints:nil)
                labelColor.setFill();markRect.fill(using:.sourceAtop)
            }
            let dot=NSBezierPath(ovalIn:NSRect(x:22,y:6,width:6,height:6))
            switch presentation.indicator {
            case .running:idleColor.setStroke();dot.lineWidth=1;dot.stroke()
            case .idle:idleColor.setFill();dot.fill()
            case .connecting:connectingColor.setFill();dot.fill()
            case .error:errorColor.setFill();dot.fill()
            case .offline:break
            }
            return true
        }
        image.isTemplate=false;image.accessibilityDescription=presentation.connectionTitle
        button.image=image;button.imagePosition=presentation.shortStatus.isEmpty ? .imageOnly : .imageLeft
        button.attributedTitle=NSAttributedString(string:presentation.shortStatus,attributes:[.font:NSFont.systemFont(ofSize:12),.foregroundColor:([LocalText.text("native.status.attention"),LocalText.text("native.status.error")].contains(presentation.shortStatus) ? errorColor : labelColor)])
        button.toolTip="ChatHand · "+presentation.connectionTitle
    }
    @objc func showSettings(){showPage("settings")}
    @objc func showTasks(){showPage("tasks")}
    @objc func checkAndRepair(){
        show();showPage("help")
        Task { @MainActor in
            self.api("/api/support/repair",["login_item_requires_approval":LoginItemService.status()["requires_approval"] as? Bool ?? false]){_ in self.poll()}
        }
    }
    @objc func installUpdate(_ sender:NSMenuItem){
        guard let version=sender.representedObject as? String else{return}
        show();api("/api/update/install",["version":version]){_ in self.poll()}
    }
    @objc func togglePause(){
        api("/api/state"){snapshot in
            guard snapshot["error"] == nil else{return}
            let current=MenuBarState(snapshot:snapshot)
            guard current.accessEnabled || current.isConnected else{self.showPage("conn");return}
            self.api("/api/access",["enabled":!current.accessEnabled]){_ in self.poll()}
        }
    }
    @objc func stopAutomation(){_ = chromeWebStoreFlow.cancel();cancelChromePreparation();chromeProfileDiscovery.cancel();chromeInstallContinuation=nil;chromeInstallPreparation=nil;chromeHelperInstaller.cancel();ComputerControl.stopped=true;api("/api/automation/stop",[:]){_ in self.poll()}}
    func currentComputerStatus() -> [String:Any] {
        var status = ComputerControl.status()
        if #available(macOS 14.0, *) { status.merge(setupComputerPermissionsStatus(), uniquingKeysWith: { _, new in new }) }
        return status
    }
    func publishComputerStatusIfChanged() {
        let status = currentComputerStatus()
        guard let data = try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys]), data != lastComputerStatusData else { return }
        api("/api/computer/heartbeat",status){response in if response["error"] == nil { self.lastComputerStatusData = data } }
    }
    func setComputerPolling(_ needed: Bool) {
        if !needed { computerTimer?.invalidate();computerTimer=nil;return }
        if computerTimer == nil {
            computerTimer=Timer.scheduledTimer(withTimeInterval:0.3,repeats:true){_ in self.pollComputer()}
            pollComputer()
        }
    }
    func computerRequestFinished(generation: UUID) {
        guard backendGeneration == generation else { return }
        computerActionInFlight=false;setComputerPolling(false);poll()
    }
    func pollComputer(){
        guard !computerPollInFlight && !computerActionInFlight && !shuttingDown else{return};computerPollInFlight=true
        let generation = backendGeneration
        api("/api/computer/heartbeat",currentComputerStatus()){_ in
            self.api("/api/computer/next",[:]){answer in
                self.computerPollInFlight=false
                guard let request=answer["request"] as? [String:Any],let id=request["id"] as? String else{self.setComputerPolling(false);return}
                self.computerActionInFlight=true
                self.api("/api/computer/authorize",["id":id]){authorization in
                    guard authorization["authorized"] as? Bool == true else{self.computerRequestFinished(generation:generation);return}
                    ComputerControl.execute(request){result in
                        DispatchQueue.main.async{
                            guard self.backendGeneration == generation else { return }
                            self.api("/api/computer/result",["id":id,"result":result]){_ in self.computerRequestFinished(generation:generation)}
                        }
                    }
                }
            }
        }
    }
    @objc func about(){showError("ChatHand " + BuildVersion.release,LocalText.text("native.about.body"))}
    // Keep the WKWebView, scroll position and drafts; only suspend its state stream.
    func setStreamWindowVisible(_ requested: Bool) {
        let visible=requested && window?.isVisible == true && window?.isMiniaturized == false && window?.occlusionState.contains(.visible) == true
        web?.evaluateJavaScript("window.__chathandWindowVisible=\(visible);window.dispatchEvent(new CustomEvent('chathand:window-visibility',{detail:{visible:\(visible)}}))", completionHandler: nil)
    }
    @objc func userShow(){if !deferReopenWhileQuitting(){show()}}
    @objc func show(){guard !shuttingDown else{return};window?.makeKeyAndOrderFront(nil);setStreamWindowVisible(true);NSApp.activate(ignoringOtherApps:true)}
    func showAutomatically() {
        guard !shuttingDown else{return}
        let activate=ClientFeatures.shouldActivateWindow(userRequested:false,appIsActive:NSApp.isActive,setupActivity:state["setup_activity"] as? [String:Any])
        if activate { window?.makeKeyAndOrderFront(nil) } else { window?.orderFront(nil) }
        setStreamWindowVisible(true)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { setStreamWindowVisible(false);sender.orderOut(nil);return false }
    func windowDidResize(_ n: Notification) { if let w = n.object as? NSWindow, w === window { WindowChrome.place(w) } }
    func windowDidBecomeKey(_ n: Notification) { if let w = n.object as? NSWindow, w === window { setStreamWindowVisible(true);WindowChrome.place(w); fillScreenIfFullScreen() } }
    func windowDidChangeBackingProperties(_ n: Notification) { if let w = n.object as? NSWindow, w === window { WindowChrome.place(w) } }
    func windowDidChangeOcclusionState(_ n: Notification) { if let w=n.object as? NSWindow,w === window { setStreamWindowVisible(w.isVisible && !w.isMiniaturized && w.occlusionState.contains(.visible)) } }
    func windowDidMiniaturize(_ n: Notification) { setStreamWindowVisible(false) }
    func windowDidDeminiaturize(_ n: Notification) { setStreamWindowVisible(window.isVisible && window.occlusionState.contains(.visible)) }
    func windowDidChangeScreen(_ n: Notification) { if let w = n.object as? NSWindow, w === window { WindowChrome.place(w) } }
    func windowWillEnterFullScreen(_ n: Notification) { pushWindowChrome(fullscreen: true) }
    func windowWillExitFullScreen(_ n: Notification) { WindowChrome.setButtonsVisible(window, false); pushWindowChrome(fullscreen: false) }
    func windowDidExitFullScreen(_ n: Notification) { WindowChrome.place(window); WindowChrome.setButtonsVisible(window, true) }
    // 1025：全屏时顶上偶尔多一条黑边，切一下桌面又好了（Ken 10/7）。像是窗口没铺满整块屏，露出了全屏背后的黑底。
    // 进全屏时要整块屏的大小；进完、切回这个桌面、窗口变成当前窗口时再核对一次，没铺满就补齐。
    func window(_ window: NSWindow, willUseFullScreenContentSize proposedSize: NSSize) -> NSSize { window.screen?.frame.size ?? proposedSize }
    // 1028：刚进全屏时系统还会再排一次窗口，顶上会留一条黑边（切走再切回来才没有，Ken 10/7）。进全屏后过一会儿再补两次。
    func windowDidEnterFullScreen(_ n: Notification) {
        fillScreenIfFullScreen()
        for delay in [0.3, 1.0] { DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.fillScreenIfFullScreen() } }
    }
    func fillScreenIfFullScreen() {
        guard let w = window, w.styleMask.contains(.fullScreen), let screen = w.screen else { return }
        if w.frame != screen.frame { w.setFrame(screen.frame, display: true) }
        if let webView = web, let content = w.contentView, webView.frame != content.bounds { webView.frame = content.bounds }
    }
    func pushWindowChrome(fullscreen: Bool) { web?.evaluateJavaScript("window.setWindowChrome && window.setWindowChrome({fullscreen:\(fullscreen)})", completionHandler: nil) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushWindowChrome(fullscreen: window.styleMask.contains(.fullScreen))
        guard let url = webView.url, url.scheme == "http", url.host == "127.0.0.1", url.port == URL(string:origin)?.port else { return }
        if !onboardingPageObserved {
            onboardingPageObserved = true
            // Only local page readiness is observed here; guidance completion stays unconfirmed.
            onboardingFlush()
            onboardingLaunchEnd?("unknown","HOST_UNCONFIRMED"); onboardingLaunchEnd = nil
        }
        clientUIReady = true
        setStreamWindowVisible(window.isVisible)
        applyPendingClientRoute()
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        if deferReopenWhileQuitting(activate:application.isActive){return}
        for url in urls { if let target = ClientNotifications.route(for:url) { showClientRoute(target) } }
    }
    func applicationWillTerminate(_ notification: Notification) {
        nativeRecord("exit", "APP_WILL_TERMINATE")
        closeOwnerPipe()
        for observer in instanceObservers {DistributedNotificationCenter.default().removeObserver(observer)};instanceObservers=[]
        startupMigration.cancel()
        instanceLease=nil;startupLease=nil
        _ = chromeWebStoreFlow.cancel()
        cancelChromePreparation();chromeProfileDiscovery.cancel();chromeDataAccessResume.cancel();chromeInstallContinuation=nil
        chromeInstallPreparation=nil
        chromeHelperInstaller.cancel()
        if let monitor = windowInputMonitor { NSEvent.removeMonitor(monitor); windowInputMonitor = nil }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{return false}
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool)->Bool{
        if deferReopenWhileQuitting(activate:sender.isActive){return false}
        // LaunchServices itself activates a user Dock/open request. An open -g
        // event must not override its background intent with NSApp.activate.
        if sender.isActive {show()} else {showAutomatically()};return true
    }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
        switch termination.requestSystemTermination(uninstalling:uninstallInProgress) {
        case .cancel:return .terminateCancel
        case .now:return .terminateNow
        case .later:
            // finishQuit runs asynchronously, after AppKit receives terminateLater.
            quit()
            return .terminateLater
        }
    }
    @objc func toggleConnection(){
        api("/api/state"){obj in
            let connection=obj["connection"] as? [String:Any] ?? [:]
            let automatic=connection["automatic"] as? [String:Any] ?? [:]
            let active=(automatic["desired"] as? Bool == true) && (obj["enabled"] as? Bool == true || automatic["phase"] as? String != "ready")
            self.api(active ? "/api/tunnel/stop" : "/api/connect/restore",[:]){r in
                if r["error"] != nil { self.showPage("conn") }
                self.poll()
            }
        }
    }
    @objc func quit(){
        nativeRecord("exit", "QUIT_REQUESTED")
        if uninstallInProgress { return }
        guard termination.beginCleanup() else { return }
        markInstanceQuitting()
        if shuttingDown{return};_ = chromeWebStoreFlow.cancel();cancelChromePreparation();chromeProfileDiscovery.cancel();chromeDataAccessResume.cancel();chromeInstallPreparation=nil;chromeHelperInstaller.cancel();shuttingDown=true;clientFeatures.close();emergencyStopHotKey.unregister();ComputerControl.stopped=true;keepAwake.update(false);timer?.invalidate();computerTimer?.invalidate()
        // Closing our private writer also covers an unavailable HTTP server.
        // An attached service owned by another App must not be terminated here.
        nativeRecord("exit", "OWNER_PIPE_CLOSING")
        closeOwnerPipe()
        if ownsService { api("/api/shutdown",[:]){_ in} }
        // A closing window must not leave its migration child behind or allow
        // an already-queued success callback to start a backend afterwards.
        if startupMigration.cancel() {migrationQuitPending=true;return}
        finishQuit()
    }
    private func markInstanceQuitting() {
        do {if try InstanceLifecycle.markOwnedLeasesQuitting()>0 {nativeRecord("exit","INSTANCE_MARKED_QUITTING")}}
        catch {nativeRecord("exit","INSTANCE_QUIT_MARK_FAILED")}
    }
    /// A real open request is the only trigger. Ordinary Quit never arms a helper.
    @discardableResult private func deferReopenWhileQuitting(activate:Bool = true) -> Bool {
        guard shuttingDown || termination.cleanupStarted else{return false}
        guard !uninstallInProgress else{return true}
        nativeRecord("exit","REOPEN_DURING_QUIT")
        if reopenHelperPreparing || reopenHelperReady || relaunchProcess?.isRunning==true {return true}
        reopenHelperPreparing=true;reopenHelperDeadline=ProcessInfo.processInfo.systemUptime+3
        relaunchChatHand(afterExitOnly:true,activate:activate){result in
            if result["relaunching"] as? Bool != true {
                self.reopenHelperPreparing=false;self.nativeRecord("exit","REOPEN_HELPER_FAILED")
            }
        }
        return true
    }
    private func finishQuit() {
        guard !quitCompletionScheduled else { return }
        quitCompletionScheduled = true
        markInstanceQuitting()
        let backendDeadline=ProcessInfo.processInfo.systemUptime+(ownsService ? 3:0)
        var backendTerminationRequested=false
        func completeWhenReady() {
            let now=ProcessInfo.processInfo.systemUptime
            if self.ownsService && self.process?.isRunning==true && now<backendDeadline {
                DispatchQueue.main.asyncAfter(deadline:.now()+0.025){completeWhenReady()};return
            }
            if !backendTerminationRequested && self.ownsService && self.process?.isRunning==true {backendTerminationRequested=true;self.process?.terminate()}
            if self.reopenHelperPreparing && !self.reopenHelperReady {
                if now<self.reopenHelperDeadline {DispatchQueue.main.asyncAfter(deadline:.now()+0.025){completeWhenReady()};return}
                self.nativeRecord("exit","REOPEN_HELPER_TIMEOUT")
                self.reopenHelperPreparing=false;self.reopenReadyReader?.readabilityHandler=nil
                try? self.relaunchPipe?.close();self.relaunchPipe=nil
            }
            self.nativeRecord("exit", "NATIVE_TERMINATE")
            switch self.termination.finishCleanup() {
            case .reply:NSApp.reply(toApplicationShouldTerminate:true)
            case .terminate:NSApp.terminate(nil)
            case .none:break
            }
        }
        // Always return terminateLater to AppKit before any reply can run.
        DispatchQueue.main.async{completeWhenReady()}
    }
    private func closeOwnerPipe() { try? ownerPipeWriter?.close(); ownerPipeWriter = nil }

    private func installerOwnsBackend() -> Bool {
        func record(_ name: String) -> [String: Any]? {
            let file = stateURL.appendingPathComponent(name)
            guard let a = try? FileManager.default.attributesOfItem(atPath: file.path),
                  a[.type] as? FileAttributeType == .typeRegular,
                  (a[.referenceCount] as? NSNumber)?.intValue == 1,
                  let size = a[.size] as? NSNumber, size.intValue <= 65536,
                  let data = try? Data(contentsOf: file) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        return BackendRecoveryPolicy.installerActive(state: state, pending: record("update-pending.json"), result: record("update-result.json"))
    }
    private func ownedBackendExited(_ exited: Process, generation: UUID) {
        guard backendGeneration == generation, process === exited, ownsService, !exited.isRunning,
              !shuttingDown, !uninstallInProgress else { return }
        nativeRecord("backend", "BACKEND_EXIT")
        timer?.invalidate(); timer = nil; setComputerPolling(false)
        ComputerControl.stopped = true
        _ = chromeWebStoreFlow.cancel()
        cancelChromePreparation();chromeProfileDiscovery.cancel();chromeInstallContinuation=nil; chromeInstallPreparation = nil; chromeHelperInstaller.cancel()
        pollInFlight = false; computerPollInFlight = false; computerActionInFlight = false
        clientUIReady = false; serviceAvailable = false; keepAwake.update(false)
        closeOwnerPipe(); attachedBackend = nil; stoppingStartupBackend = nil; process = nil; ownsService = false
        scheduleBackendRecovery()
    }
    private func scheduleBackendRecovery() {
        invalidateClientAppearance()
        let nextGeneration = UUID(); backendGeneration = nextGeneration
        onboardingSending = false; onboardingRetryAfter = 0
        guard !shuttingDown, !uninstallInProgress, !installerOwnsBackend() else {
            nativeRecord("recovery", "RECOVERY_SUPPRESSED"); backendRecoveryInProgress = false; return
        }
        guard let delay = backendRecovery.recoveryDelay(now: ProcessInfo.processInfo.systemUptime) else {
            backendRecoveryInProgress = false
            nativeRecord("recovery", "RECOVERY_EXHAUSTED")
            showError(LocalText.text("native.service.startFailed"), LocalText.text("native.service.checkLog")); return
        }
        backendRecoveryInProgress = true
        nativeRecord("recovery", "RECOVERY_SCHEDULED", attempt: backendRecovery.attemptCount)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.backendGeneration == nextGeneration, self.process?.isRunning != true,
                  !self.shuttingDown, !self.uninstallInProgress, !self.installerOwnsBackend() else { return }
            self.interfaceKeyShared = false
            do { try self.startService() }
            catch { self.scheduleBackendRecovery() }
        }
    }

    private let chromeDataAccessResume=ChromeDataAccessResume()
    private let chromeProfileDiscovery=ChromeProfileDiscovery()
    private var chromeDiscoveryProof: ChromeInstallDiscoveryProof?
    private var chromeDiscoveryProofSlot: ChromeInstallDiscoveryProofSlot?
    private var chromePreflightProof: ChromeInstallDiscoveryProof?
    private var chromeSettingsObserver:NSObjectProtocol?
    private var chromeSettingsGeneration:UUID?
    private var lastChromeInstallProfile:String?
    private var chromeInstallContinuation: ((@escaping ([String:Any])->Void)->Void)?
    private func cancelChromePreparation() {
        chromeDiscoveryProof = nil; chromePreflightProof = nil
        chromeDiscoveryProofSlot?.clear(); chromeDiscoveryProofSlot = nil
        let cancel = chromeInstallPreparationCancel
        chromeInstallPreparationCancel = nil
        chromeSettingsGeneration=nil
        chromeDataAccessResume.cancel()
        chromeAccessibilityWait.cancel()
        if #available(macOS 14.0, *) { permissionAssistant.finishAccessibilityOnly(granted:false) }
        cancel?()
    }
    private func observeChromeProfiles(preparation:UUID,completion:@escaping ([String:Any])->Void) {
        let deadline=ProcessInfo.processInfo.systemUptime+10
        chromeDiscoveryProof = nil; chromePreflightProof = nil
        chromeDiscoveryProofSlot?.clear()
        let proofSlot = ChromeInstallDiscoveryProofSlot()
        chromeDiscoveryProofSlot = proofSlot
        var finished=false
        func finish(_ result:[String:Any]) {
            guard !finished else{return};finished=true
            if result["ids"] != nil, self.chromeInstallPreparation == preparation, !self.shuttingDown {
                self.chromeDiscoveryProof = proofSlot.take()
            } else { proofSlot.clear(); if self.chromeInstallPreparation == preparation { self.chromeDiscoveryProof = nil } }
            if self.chromeDiscoveryProofSlot === proofSlot { self.chromeDiscoveryProofSlot = nil }
            completion(result)
        }
        DispatchQueue.main.asyncAfter(deadline:.now()+10){
            guard !finished else{return}
            guard self.chromeInstallPreparation == preparation else {finish(["error_code":"CHROME_INSTALL_CANCELLED"]);return}
            finish(["error_code":"CHROME_INSTALL_TIMEOUT"])
            self.chromeProfileDiscovery.cancel()
        }
        api("/api/browser/extension/install/profiles",["discovery_only":true]) { permission in
            guard !finished else{return}
            guard self.chromeInstallPreparation == preparation,!self.shuttingDown else {finish(["error_code":"CHROME_INSTALL_CANCELLED"]);return}
            guard permission["observe_allowed"] as? Bool == true else {finish(["error_code":"CHROME_INSTALL_PERMISSION_CHANGED"]);return}
            var opened=false
            var observedChromeURL:URL?
            func inspect(){
                guard !finished,self.chromeInstallPreparation == preparation,!self.shuttingDown else{finish(["error_code":"CHROME_INSTALL_CANCELLED"]);return}
                let remaining=deadline-ProcessInfo.processInfo.systemUptime
                guard remaining>0 else{finish(["error_code":"CHROME_INSTALL_TIMEOUT"]);return}
                self.chromeProfileDiscovery.start(timeout:remaining,read:{
                    let target=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.google.Chrome")
                    DispatchQueue.main.async{if !finished{observedChromeURL=target}}
                    do{return .success(try ChromeInstallAXAdapter.observedProfiles(runtime:self.packageURL,deadline:deadline,attempt:preparation,proof:{ proofSlot.store($0) }))}
                    catch{return .failure((error as? ChromeInstallCode) ?? .profile)}
                },completion:{ result in
                    guard !finished,self.chromeInstallPreparation == preparation,!self.shuttingDown else{finish(["error_code":"CHROME_INSTALL_CANCELLED"]);return}
                    switch result {
                    case .failure(let code):finish(["error_code":code.rawValue])
                    case .success(let ids):
                        if !ids.isEmpty {
                            if opened {NSApp.activate(ignoringOtherApps:true);DispatchQueue.main.asyncAfter(deadline:.now()+0.1){finish(["ids":ids])}}else{finish(["ids":ids])}
                        } else if !opened {
                            guard let chrome=observedChromeURL else{finish(["error_code":"CHROME_INSTALL_CHROME_UNAVAILABLE"]);return}
                            opened=true;let config=NSWorkspace.OpenConfiguration();config.activates=false
                            NSWorkspace.shared.open([URL(string:"chrome://version")!],withApplicationAt:chrome,configuration:config){_,error in
                                DispatchQueue.main.async{guard !finished else{return};if error != nil{finish(["error_code":"CHROME_INSTALL_CHROME_UNAVAILABLE"])}else{inspect()}}
                            }
                        } else {DispatchQueue.main.asyncAfter(deadline:.now()+0.25,execute:inspect)}
                    }
                })
            }
            inspect()
        }
    }
    @objc private func uninstallChatHand(_ sender: NSMenuItem) {
        // Menu selector only. No WK bridge action or server tool invokes this.
        guard !uninstallInProgress else { nativeRecord("uninstall", "UNINSTALL_BUSY"); return }
        guard !shuttingDown else { nativeRecord("uninstall", "APP_SHUTTING_DOWN"); return }
        nativeRecord("uninstall", "CONFIRM_SHOWN")
        let alert = NSAlert(); alert.messageText = LocalText.text("native.uninstall.title"); alert.informativeText = LocalText.text("native.uninstall.choice")
        alert.addButton(withTitle: LocalText.text("native.uninstall.keep")); alert.addButton(withTitle: LocalText.text("native.uninstall.delete")); alert.addButton(withTitle: LocalText.text("native.button.cancel"))
        let choice = alert.runModal()
        guard choice == .alertFirstButtonReturn || choice == .alertSecondButtonReturn else { nativeRecord("uninstall", "CONFIRM_CANCELLED"); return }
        nativeRecord("uninstall", "PLAN_STARTED")
        do {
            let plan = try ChatHandUninstallPlan(app: Bundle.main.bundleURL, home: FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath(), state: stateURL, deleteData: choice == .alertSecondButtonReturn, incremental: true)
            // An attached service is not ours to stop or uninstall underneath.
            guard ownsService || !serviceAvailable else { nativeRecord("uninstall", "SERVICE_NOT_OWNED"); throw ChatHandUninstallPlan.Failure.changed }
            uninstallInProgress = true
            Task { @MainActor in
                let audit = plan.auditState
                var auditFailure:String?
                do { try plan.prepareAudit(); uninstallAuditState=audit }
                catch { auditFailure=ChatHandUninstallPlan.reason(error) }
                let auditAvailable=auditFailure == nil
                @MainActor func record(_ stage:String,_ code:String) {
                    guard auditAvailable else { return }
                    NativeDiagnostics.record(in:audit,phase:"uninstall_"+stage,code:code,backendPID:process.map {Int($0.processIdentifier)},generation:backendGeneration.uuidString)
                }
                do {
                    record("plan","STARTED")
                    let exclusion:ChatHandUninstallPlan.UpgradeExclusion
                    do { exclusion = try plan.excludeUpgrade(); record("upgrade","LOCKED") }
                    catch { record("upgrade",ChatHandUninstallPlan.reason(error)); throw error }
                    defer { exclusion.release() }
                    // Revoke while the owner API and its device signer are still alive.
                    // The bounded coordinator always returns a categorical result;
                    // remote failure must not prevent the remaining local cleanup.
                    _ = await ChatHandUninstallRevoke.run(
                        deleteData:plan.deleteData,
                        ownerAvailable:ownsService && interfaceKeyShared,
                        request:{ endpoint,body,done in self.api(endpoint,body,completion:done) },
                        event:{ stage,code in record(stage,code) }
                    )
                    var loginRemoved=false,backendStopped=false
                    record("login","STARTED")
                    do { try await LoginItemService.removeForUninstall(); loginRemoved=true; record("login","REMOVED") }
                    catch { record("login",LoginItemService.uninstallReason(error)) }
                    record("backend","STARTED")
                    do { try await stopForUninstall(app:plan.app,event:{record("backend",$0)}); backendStopped=true; record("backend","STOPPED") }
                    catch {
                        let code:String
                        switch error as? ChatHandProcessOwnership.Failure {
                        case .stillRunning: code="BACKEND_TIMEOUT"
                        case .enumeration: code="PROCESS_ENUMERATION_FAILED"
                        case .signal: code="PROCESS_SIGNAL_FAILED"
                        default: code="BACKEND_STOP_FAILED"
                        }
                        record("backend",code)
                    }
                    var preferencesCleared=true
                    if plan.deleteData && backendStopped {
                        record("preferences","STARTED")
                        if Bundle.main.bundleIdentifier == BuildVersion.bundleID {
                            preferencesCleared=ChatHandUninstallPlan.clearPreferences(.standard,domain:BuildVersion.bundleID)
                        } else { preferencesCleared=false }
                        record("preferences",preferencesCleared ? "PREFERENCES_CLEARED" : "PREFERENCES_SYNC_FAILED")
                    }
                    // This shell uses a nonpersistent WK store. Stop in-flight
                    // callbacks and release it before removing on-disk caches.
                    web?.stopLoading(); web?.navigationDelegate=nil; web?.uiDelegate=nil
                    web?.configuration.userContentController.removeScriptMessageHandler(forName:"native")
                    web?.removeFromSuperview(); web=nil; rehearsalPageObserver=nil
                    window?.delegate=nil; window?.orderOut(nil)
                    record("window","CLOSED")
                    let stopped=backendStopped,login=loginRemoved,cleared=preferencesCleared,auditError=auditFailure
                    let report:ChatHandUninstallPlan.Report = await withCheckedContinuation { continuation in
                        DispatchQueue.global(qos:.userInitiated).async {
                            let result=plan.executeStages(backendStopped:stopped,loginRemoved:login,exclusion:exclusion,auditFailure:auditError,preferencesCleared:cleared,event:{stage,code in
                                // NativeDiagnostics.pending is main-thread-only.
                                DispatchQueue.main.async { record(stage,code) }
                            },dataAccess:{ fields in
                                DispatchQueue.main.async {
                                    if auditAvailable {NativeDiagnostics.record(in:audit,phase:fields["path_kind"] as? String == "native_host" ? "uninstall_host":"uninstall_host_backup",code:"CHROME_DATA_ACCESS_DENIED",backendPID:nil,generation:self.backendGeneration.uuidString,chromeAccess:fields)}
                                }
                            })
                            continuation.resume(returning:result)
                        }
                    }
                    var detail = report.complete ? LocalText.text("native.uninstall.chromeReminder") : LocalText.text("native.uninstall.failedBody")
                    let remaining=report.items.filter { $0.remaining }
                    let preserved=report.items.filter { $0.preserved }
                    if !remaining.isEmpty { detail += "\n\n"+LocalText.text("native.uninstall.remainingTitle")+"\n"+remaining.map { $0.url.path+" ["+$0.code+"]" }.joined(separator:"\n") }
                    if !loginRemoved { detail += "\n\nLogin Items [LOGIN_ITEM_REMAINS]" }
                    if !preserved.isEmpty { detail += "\n\n"+LocalText.text("native.uninstall.preservedTitle")+"\n"+preserved.map { $0.url.path+" ["+$0.code+"]" }.joined(separator:"\n") }
                    if !report.complete { detail += "\n\n"+LocalText.text("native.uninstall.retryHelp") }
                    if auditAvailable { detail += "\n\n"+LocalText.text("native.uninstall.auditTitle")+"\n"+audit.appendingPathComponent("diagnostics/native-events.jsonl").path }
                    if remaining.contains(where:{["host","host_backup"].contains($0.stage) && $0.code == "ACCESS_DENIED"}) {
                        detail += "\n\n"+LocalText.text("ui.chrome.dataAccess.uninstall")
                        let blocked=NSAlert();blocked.messageText=LocalText.text("native.uninstall.failed");blocked.informativeText=detail
                        blocked.addButton(withTitle:LocalText.text("ui.chrome.dataAccess.openSettings"));blocked.addButton(withTitle:LocalText.text("native.button.cancel"))
                        if blocked.runModal() == .alertFirstButtonReturn,let pane=URL(string:"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension"){NSWorkspace.shared.open(pane)}
                    } else {showError(LocalText.text(report.complete ? "native.uninstall.finished" : "native.uninstall.failed"),detail)}
                    uninstallInProgress = false
                    if report.complete || !FileManager.default.fileExists(atPath:plan.app.path) { shuttingDown=true; finishQuit() }
                } catch {
                    let code=ChatHandUninstallPlan.reason(error)
                    record("plan",code)
                    showError(LocalText.text("native.uninstall.failed"),LocalText.text("native.uninstall.failedBody")+"\n["+code+"]\n"+LocalText.text("native.uninstall.retryHelp"))
                    uninstallInProgress = false
                }
            }
        } catch {
            let code=ChatHandUninstallPlan.reason(error);nativeRecord("uninstall",code)
            showError(LocalText.text("native.uninstall.failed"),LocalText.text("native.uninstall.failedBody")+"\n["+code+"]")
        }
    }

    @MainActor private func stopForUninstall(app: URL, event:(String)->Void = {_ in}) async throws {
        _ = chromeWebStoreFlow.cancel()
        cancelChromePreparation();chromeProfileDiscovery.cancel();chromeDataAccessResume.cancel(); chromeInstallPreparation = nil; chromeHelperInstaller.cancel(); clientFeatures.close(); ComputerControl.stopped = true
        keepAwake.update(false); timer?.invalidate(); computerTimer?.invalidate()
        if ownsService { event("SHUTDOWN_REQUESTED"); api("/api/shutdown",[:]){_ in} }
        closeOwnerPipe(); event("OWNER_PIPE_CLOSED")
        // Give the server its normal queue/controller shutdown before removing
        // anything. A timeout leaves files in place and is not reported success.
        let deadline = ProcessInfo.processInfo.systemUptime + 15
        event("WAITING_BACKEND")
        while process?.isRunning == true && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        guard process?.isRunning != true else { throw ChatHandProcessOwnership.Failure.stillRunning }
        event("BACKEND_EXITED")
        let remaining = try ChatHandProcessOwnership.runtimeProcesses(app: app)
        for child in remaining { event("HELPER_TERM_REQUESTED"); try ChatHandProcessOwnership.terminate(child) }
        let helperDeadline = ProcessInfo.processInfo.systemUptime + 5
        while !(try ChatHandProcessOwnership.runtimeProcesses(app: app)).isEmpty && ProcessInfo.processInfo.systemUptime < helperDeadline { try await Task.sleep(nanoseconds: 100_000_000) }
        guard try ChatHandProcessOwnership.runtimeProcesses(app: app).isEmpty else { throw ChatHandProcessOwnership.Failure.stillRunning }
        serviceAvailable = false; ownsService = false; event("RUNTIME_EXITED")
    }
    func showError(_ title:String,_ detail:String){let a=NSAlert();a.messageText=title;a.informativeText=detail;a.addButton(withTitle:LocalText.text("native.button.ok"));a.runModal()}
    func observeSitePrompt(_ text: String) {
        guard interfaceKeyShared, ownsService, !text.isEmpty, text.utf8.count <= 256 * 1024 else { return }
        let digest = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        api("/api/site-b/enrollment/observe-prompt", ["prompt_sha256":digest]) { _ in }
    }
    func nativeRecord(_ phase: String, _ code: String, attempt: Int? = nil) {
        NativeDiagnostics.record(in: uninstallAuditState ?? stateURL, phase: phase, code: code, backendPID: process.map { Int($0.processIdentifier) }, generation: backendGeneration.uuidString, attempt: attempt)
    }
    func instanceRecord(_ phase: String, _ code: String, _ pid: Int32) {
        InstanceLifecycle.record(state:stateURL,phase:phase,code:code,build:BuildVersion.buildNumber,pid:pid)
    }
    private enum StartupResult {
        case ready(InstanceLifecycle.Lease,InstanceLifecycle.Lease,InstanceLifecycle.Scope,InstanceLifecycle.Backend?)
        case existing
        case failed(InstanceLifecycle.Lease?,String)
    }
    private func beginStartup() {
        let source=Bundle.main.bundleURL,state=stateURL,environment=ProcessInfo.processInfo.environment
        let package=packageURL,runner=startupMigration,build=BuildVersion.buildNumber
        let activateExisting=NSApp.isActive
        DispatchQueue.global(qos:.userInitiated).async {
            var coordination:URL?,gate:InstanceLifecycle.Lease?
            func record(_ phase:String,_ code:String,_ pid:Int32) {
                if let coordination {InstanceLifecycle.record(state:coordination,phase:phase,code:code,build:build,pid:pid)}
            }
            let result:StartupResult
            do {
                let (directory,scope)=try InstanceLifecycle.startupCoordination(state:state,source:source,environment:environment)
                coordination=directory
                // Freeze before either lease can ask an older native to exit:
                // its graceful shutdown may remove runtime.json first.
                let quitDeadline=ProcessInfo.processInfo.systemUptime+15
                let waitedStartup=try InstanceLifecycle.waitForRecordedQuittingOwner(state:directory,timeout:15,diagnostic:record)
                let waitedData=try InstanceLifecycle.waitForRecordedQuittingOwner(state:state,timeout:max(0,quitDeadline-ProcessInfo.processInfo.systemUptime),diagnostic:record)
                let frozen=try InstanceLifecycle.captureBackend(state:state,source:source,scope:scope,exitingOwnerObserved:waitedStartup || waitedData)
                gate=try InstanceLifecycle.claim(state:directory,source:source,build:build,scope:scope,activateExisting:activateExisting,diagnostic:record)
                if let gate {
                    // The bounded child checks explicit state overrides or the
                    // ordinary data/v05 path without modifying either.
                    // No data directory/lease exists before this succeeds.
                    record("migration","MIGRATION_BEGIN",getpid())
                    let migration=runner.run(executable:package.appendingPathComponent("bin/ChatHandNode"),script:package.appendingPathComponent("scripts/migrate-state.mjs"),directory:package){code,pid in record("migration",code,pid)}
                    record("migration",migration.code,migration.pid)
                    if !migration.succeeded || runner.isCancelled {
                        result = .failed(gate,runner.isCancelled ? "MIGRATION_CANCELLED":migration.code)
                    } else {
                        // Do not create the state directory until the helper
                        // has exited successfully and its exact PID is gone.
                        try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                        let finalScope=try InstanceLifecycle.Scope.validated(environment:environment,state:state,app:source)
                        if let lease=try InstanceLifecycle.claim(state:state,source:source,build:build,scope:finalScope,activateExisting:activateExisting,diagnostic:record) {
                            result = .ready(gate,lease,finalScope,frozen)
                        } else {result = .existing}
                    }
                } else {result = .existing}
            } catch {
                let code=(error as? InstanceLifecycle.Failure)?.code ?? "INSTANCE_START_FAILED"
                record("instance",code,getpid());result = .failed(gate,code)
            }
            DispatchQueue.main.async {
                // NativeDiagnostics.pending is main-thread-only. Worker records
                // use the separate target-external coordination receipt above.
                switch result {
                case let .ready(gate,lease,scope,frozen):
                    self.startupLease=gate;self.instanceLease=lease;self.instanceScope=scope;self.priorBackend=frozen
                    guard !self.shuttingDown,!runner.isCancelled else{self.completeMigrationQuit();return}
                    self.nativeRecord("startup","MIGRATION_READY")
                    do {try self.startService()} catch {self.showError(LocalText.text("native.start.failed"),error.localizedDescription)}
                case .existing:
                    self.shuttingDown=true;self.migrationQuitPending=false;self.finishQuit()
                case let .failed(gate,code):
                    self.startupLease=gate
                    guard !self.shuttingDown else{self.completeMigrationQuit();return}
                    self.nativeRecord("migration",code)
                    let message=LocalText.text(StartupMigration.messageKey(code:code))
                    self.showError(LocalText.text("native.start.failed"),message+"\n("+code+")")
                }
            }
        }
    }
    private func completeMigrationQuit() {
        if migrationQuitPending {migrationQuitPending=false;finishQuit()}
    }
    func relaunchChatHand(afterExitOnly:Bool = false, activate:Bool = true, completion: @escaping ([String:Any])->Void) {
        guard relaunchProcess?.isRunning != true, !uninstallInProgress else { completion(["error":"RELAUNCH_BUSY"]);return }
        do {
            let scope:InstanceLifecycle.Scope
            if let current=instanceScope {scope=current}
            else if afterExitOnly {scope=try InstanceLifecycle.Scope.validated(environment:ProcessInfo.processInfo.environment,state:stateURL,app:Bundle.main.bundleURL,beforeMigration:true)}
            else {throw InstanceLifecycle.Failure(code:"INSTANCE_SCOPE_MISSING")}
            let target=try InstanceLifecycle.relaunchTarget(environment:ProcessInfo.processInfo.environment,scope:scope)
            let requirement=try InstanceLifecycle.signatureRequirement(Bundle.main.bundleURL)
            guard InstanceLifecycle.trusted(target,requirement:requirement) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_SIGNATURE_UNKNOWN")}
            let helper=packageURL.appendingPathComponent("bin/ken-upgrade-control")
            guard FileManager.default.isExecutableFile(atPath:helper.path) else{throw InstanceLifecycle.Failure(code:"RELAUNCH_HELPER_MISSING")}
            let process=Process(),input=Pipe();process.executableURL=helper
            process.arguments=[afterExitOnly ? "reopen-after-exit":"relaunch",target.path,String(getpid()),stateURL.path]
            if afterExitOnly {process.arguments?.append(activate ? "1":"0")}
            process.environment=ProcessInfo.processInfo.environment
            let logRoot:URL
            if FileManager.default.fileExists(atPath:stateURL.path) {logRoot=stateURL}
            else {logRoot=try InstanceLifecycle.startupCoordination(state:stateURL,source:Bundle.main.bundleURL,environment:ProcessInfo.processInfo.environment).0}
            let logFD=Darwin.open(logRoot.appendingPathComponent("launcher.log").path,O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_CLOEXEC,mode_t(0o600))
            guard logFD>=0 else{throw InstanceLifecycle.Failure(code:"RELAUNCH_START_FAILED")}
            let log=FileHandle(fileDescriptor:logFD,closeOnDealloc:true);var logStat=stat()
            guard fstat(logFD,&logStat)==0,logStat.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),logStat.st_uid==getuid(),logStat.st_nlink==1,logStat.st_mode & 0o077==0 else{throw InstanceLifecycle.Failure(code:"RELAUNCH_START_FAILED")}
            process.standardInput=input;process.standardOutput=log;process.standardError=log
            if afterExitOnly {
                let ready=Pipe();process.standardOutput=ready;reopenReadyReader=ready.fileHandleForReading
                reopenReadyBytes=Data()
                ready.fileHandleForReading.readabilityHandler={ [weak self] reader in
                    let bytes=reader.availableData
                    DispatchQueue.main.async {
                        guard let self,self.reopenHelperPreparing else{return}
                        self.reopenReadyBytes.append(bytes)
                        guard self.reopenReadyBytes.count<=1024 else {self.reopenHelperPreparing=false;reader.readabilityHandler=nil;self.nativeRecord("exit","REOPEN_HELPER_FAILED");return}
                        if self.reopenReadyBytes.starts(with:Data("ready\n".utf8)) {
                            reader.readabilityHandler=nil
                            do {try self.relaunchPipe?.write(contentsOf:Data("go\n".utf8));try self.relaunchPipe?.close();self.relaunchPipe=nil
                                self.reopenHelperReady=true;self.reopenHelperPreparing=false;self.nativeRecord("exit","REOPEN_HELPER_READY")
                            }catch{self.reopenHelperPreparing=false;self.nativeRecord("exit","REOPEN_HELPER_FAILED")}
                        } else if bytes.isEmpty {reader.readabilityHandler=nil;self.reopenHelperPreparing=false;self.nativeRecord("exit","REOPEN_HELPER_FAILED")}
                    }
                }
            }
            try process.run();relaunchProcess=process;relaunchPipe=input.fileHandleForWriting
            try? input.fileHandleForReading.close()
            instanceRecord("relaunch","RELAUNCH_REQUESTED",getpid())
            completion(["relaunching":true])
            // Give the existing local frame its reply before any owner is asked to exit.
            if !afterExitOnly {DispatchQueue.main.asyncAfter(deadline:.now()+0.25) {
                try? self.relaunchPipe?.write(contentsOf:Data("go\n".utf8));try? self.relaunchPipe?.close();self.relaunchPipe=nil
            }}
        } catch {
            let code=(error as? InstanceLifecycle.Failure)?.code ?? "RELAUNCH_START_FAILED"
            instanceRecord("relaunch",code,getpid());completion(["error":code])
        }
    }
    func startService() throws {
        nativeRecord("startup", "SERVICE_START")
        guard let scope=instanceScope else {throw InstanceLifecycle.Failure(code:"INSTANCE_SCOPE_MISSING")}
        try InstanceLifecycle.shutdownOrphan(state:stateURL,source:Bundle.main.bundleURL,scope:scope,prior:priorBackend,diagnostic:instanceRecord)
        priorBackend=nil
        let node=packageURL.appendingPathComponent("bin/ChatHandNode")
        guard FileManager.default.isExecutableFile(atPath:node.path) else {throw NSError(domain:"KenBridge",code:1,userInfo:[NSLocalizedDescriptionKey:LocalText.text("native.service.nodeMissing")])}
        try FileManager.default.createDirectory(at:stateURL,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let logURL=stateURL.appendingPathComponent("launcher.log")
        // Snapshot the prior launch and append; never truncate launcher evidence.
        let previousLog=stateURL.appendingPathComponent("launcher.log.previous")
        func ordinaryLog(_ url: URL) throws {
            var st=stat()
            guard lstat(url.path,&st)==0,st.st_mode & mode_t(S_IFMT)==mode_t(S_IFREG),st.st_uid==getuid(),st.st_nlink==1 else { throw NSError(domain:"ChatHandLauncherLog",code:1) }
        }
        if FileManager.default.fileExists(atPath:logURL.path) {
            try ordinaryLog(logURL)
            if FileManager.default.fileExists(atPath:previousLog.path) { try ordinaryLog(previousLog); try FileManager.default.removeItem(at:previousLog) }
            try FileManager.default.copyItem(at:logURL,to:previousLog)
        } else { FileManager.default.createFile(atPath:logURL.path,contents:nil,attributes:[.posixPermissions:0o600]) }
        let log=try FileHandle(forWritingTo:logURL)
        try log.seekToEnd()
        let p=Process();p.executableURL=node;p.arguments=[packageURL.appendingPathComponent("app/server.mjs").path];p.currentDirectoryURL=packageURL
        invalidateClientAppearance()
        let generation = UUID(); backendGeneration = generation
        onboardingSending = false; onboardingRetryAfter = 0
        p.terminationHandler = { [weak self] exited in DispatchQueue.main.async { self?.ownedBackendExited(exited, generation: generation) } }
        // Do not pass model/provider secrets to the daemon environment.
        var env=["HOME":FileManager.default.homeDirectoryForCurrentUser.path,"PATH":"/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", "LANG":"en_US.UTF-8","CHATHAND_STATE_DIR":stateURL.path,"KEN_BRIDGE_STATE_DIR":stateURL.path,"KEN_BRIDGE_OWNER_PID":String(ProcessInfo.processInfo.processIdentifier)]
        env.merge(try RehearsalBackendPaths.environment(source:ProcessInfo.processInfo.environment,statePath:stateURL.path,appPath:Bundle.main.bundleURL.path)) { _, rehearsal in rehearsal }
        for key in ["HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","NO_PROXY","https_proxy","http_proxy","all_proxy","no_proxy"] { if let value=ProcessInfo.processInfo.environment[key]{env[key]=value} }
        if CommandLine.arguments.contains("--upgrade-verification"){env["KEN_BRIDGE_UPGRADE_VERIFY"]="1"}
        env["CHATHAND_SYSTEM_LOCALE"]=LocalText.systemLocale
        env["CHATHAND_UI_KEY_STDIN"]="1"
        env["CHATHAND_OWNER_PIPE"]="stdin-v1"
        let keyPipe=Pipe()
        p.environment=env;p.standardInput=keyPipe;p.standardOutput=log;p.standardError=log;try p.run();process=p;ownsService=true
        let startupKeys:[String:Any] = ["v":2,"ui_key":interfaceKey,"owner_key":permissionUndoProof.startupKeyHex]
        var startupData=try JSONSerialization.data(withJSONObject:startupKeys);startupData.append(0x0a)
        // Only this App owns the write descriptor; exec'ed helpers cannot keep
        // the service alive after the App exits. Server integration: stdin-v1.
        _ = fcntl(keyPipe.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC)
        ownerPipeWriter = keyPipe.fileHandleForWriting
        try? keyPipe.fileHandleForReading.close()
        keyPipe.fileHandleForWriting.write(startupData);interfaceKeyShared=true
        observeBackendStartup(p, generation:generation, identity:try? InstanceLifecycle.identity(p.processIdentifier))
    }
    private func observeBackendStartup(_ p: Process, generation: UUID, identity: InstanceLifecycle.Identity?) {
        let deadline = ProcessInfo.processInfo.systemUptime + 20
        timer=Timer.scheduledTimer(withTimeInterval:0.25,repeats:true){timer in
            guard self.backendGeneration == generation, self.process === p, self.ownsService,
                  self.stoppingStartupBackend !== p, !self.shuttingDown, !self.uninstallInProgress else { timer.invalidate(); return }
            if !p.isRunning {
                timer.invalidate();self.nativeRecord("startup", "STARTUP_BACKEND_EXIT")
                self.ownedBackendExited(p, generation:generation)
            } else if ProcessInfo.processInfo.systemUptime >= deadline {
                timer.invalidate();self.nativeRecord("startup", "INITIAL_START_TIMEOUT")
                self.stopStartupBackend(p, generation:generation, identity:identity)
            } else if let r=self.readRuntime(),let pid=r["pid"] as? Int,pid==Int(p.processIdentifier) {
                timer.invalidate();self.attachedBackend=p;self.backendRecovery.attached();self.backendRecoveryInProgress=false;self.attach(r)
            }
        }
    }
    private func stopStartupBackend(_ p: Process, generation: UUID, identity: InstanceLifecycle.Identity?) {
        guard backendGeneration == generation, process === p, ownsService,
              !shuttingDown, !uninstallInProgress, !installerOwnsBackend() else { return }
        stoppingStartupBackend=p;interfaceKeyShared=false
        closeOwnerPipe()
        let started = ProcessInfo.processInfo.systemUptime
        var signaled: Int32 = 0
        // EOF first gives only our child a graceful stop. If necessary, signal
        // only its frozen kernel identity; never enumerate or kill shared PIDs.
        timer=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){timer in
            guard self.backendGeneration == generation, self.process === p, self.ownsService,
                  !self.shuttingDown, !self.uninstallInProgress else { timer.invalidate(); return }
            if !p.isRunning { timer.invalidate();self.ownedBackendExited(p, generation:generation);return }
            if self.installerOwnsBackend() { timer.invalidate();self.nativeRecord("recovery", "RECOVERY_SUPPRESSED");return }
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            if elapsed >= 4 {
                timer.invalidate();self.backendRecoveryInProgress=false
                self.nativeRecord("startup", "STARTUP_STOP_UNCONFIRMED")
                self.showError(LocalText.text("native.service.startFailed"),LocalText.text("native.service.checkLog"));return
            }
            let signal: Int32 = elapsed >= 2 ? SIGKILL : elapsed >= 1 ? SIGTERM : 0
            guard signal != 0, signal != signaled else { return }
            guard let identity, let current=try? InstanceLifecycle.identity(p.processIdentifier), current == identity else {
                timer.invalidate();self.backendRecoveryInProgress=false
                self.nativeRecord("startup", "STARTUP_IDENTITY_UNKNOWN")
                self.showError(LocalText.text("native.service.startFailed"),LocalText.text("native.service.checkLog"));return
            }
            guard Darwin.kill(identity.pid,signal) == 0 || errno == ESRCH else {
                timer.invalidate();self.backendRecoveryInProgress=false
                self.nativeRecord("startup", "STARTUP_STOP_DENIED")
                self.showError(LocalText.text("native.service.startFailed"),LocalText.text("native.service.checkLog"));return
            }
            signaled=signal
            self.nativeRecord("startup", signal == SIGTERM ? "STARTUP_TERM_SENT" : "STARTUP_KILL_SENT")
        }
    }
    func rawRuntime()->[String:Any]? {
        let file=stateURL.appendingPathComponent("runtime.json")
        guard let attrs=try? FileManager.default.attributesOfItem(atPath:file.path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              let size=attrs[.size] as? NSNumber,size.intValue<65536,
              let d=try? Data(contentsOf:file),let r=(try? JSONSerialization.jsonObject(with:d)) as? [String:Any] else{return nil}
        return r
    }
    func readRuntime()->[String:Any]? {guard let r=rawRuntime(),RuntimeDescriptor.accepts(r) else{return nil};return r}
    func attach(_ r:[String:Any]) {nativeRecord("startup", "SERVICE_ATTACHED");origin=r["ui_origin"] as! String;token=r["admin_token"] as! String
        onboardingFlush() // First owner handshake has origin + the memory-only UI credential.
        timer?.invalidate(); pollInFlight = false
        clientUIReady = false
        // Credentials enter only the current local main frame, never its URL or AXURL.
        // User scripts survive reload; a new attach replaces the previous process keys.
        guard let pageURL=NativePageBootstrap.install(web:web,origin:origin,token:token,uiKey:interfaceKeyShared ? interfaceKey : "") else { showError(LocalText.text("native.window.connectionFailed"),LocalText.text("native.window.invalidAddress"));return }
        web.load(URLRequest(url:pageURL))
        lastComputerStatusData=nil
        timer=Timer.scheduledTimer(withTimeInterval:2,repeats:true){_ in self.poll()};poll()
    }
    func api(_ endpoint:String,_ body:[String:Any]?=nil,onExpired:(() -> Void)?=nil,timeout:TimeInterval=40,locale:String?=nil,completion:@escaping([String:Any])->Void){
        guard let u=URL(string:origin+endpoint),u.host=="127.0.0.1" else{DispatchQueue.main.async{completion(["error":["code":"NOT_RUNNING","message":LocalText.text("native.service.notRunning")]])};return}
        var r=URLRequest(url:u);r.httpMethod=body==nil ? "GET":"POST";r.setValue("Bearer "+token,forHTTPHeaderField:"Authorization");if interfaceKeyShared {r.setValue(interfaceKey,forHTTPHeaderField:"X-ChatHand-UI")};r.setValue("application/json",forHTTPHeaderField:"Content-Type");r.timeoutInterval=timeout
        if endpoint == "/api/native/state", let locale = locale, ["zh","en"].contains(locale) { r.setValue(locale,forHTTPHeaderField:"X-ChatHand-UI-Locale") }
        if let b=body {r.httpBody=try? JSONSerialization.data(withJSONObject:b)}
        let generation = backendGeneration, requestOrigin = origin
        URLSession.shared.dataTask(with:r){data,response,error in
            let obj=data.flatMap{try? JSONSerialization.jsonObject(with:$0)} as? [String:Any] ?? ["error":["code":"LOCAL_NETWORK","message":LocalText.text("native.service.noResponse")]]
            DispatchQueue.main.async{guard self.backendGeneration == generation, self.origin == requestOrigin else { onExpired?(); return };completion(obj)}
        }.resume()
    }
    private var setupCompletionFocus = SetupCompletionFocus()
    func poll(){
        onboardingFlush() // Retry unconfirmed metadata with a five-second backoff.
        guard !pollInFlight else{return};pollInFlight=true
        api("/api/native/state",locale:LocalText.systemLocale){obj in
        self.pollInFlight=false
        guard !self.shuttingDown, !self.uninstallInProgress else { return }
        guard obj["error"]==nil else{self.clientFeatures.serviceUnavailable();self.serviceAvailable=false;self.refreshStatusMenu();self.keepAwake.update(false);self.setComputerPolling(false);return};self.state=obj;self.serviceAvailable=true;self.refreshStatusMenu()
        self.clientFeatures.synchronize(state: obj)
        if self.setupCompletionFocus.consume(obj["setup_activity"] as? [String:Any]) { self.show() }
        self.publishComputerStatusIfChanged()
        self.setComputerPolling(((obj["computer"] as? [String:Any])?["pending"] as? Int ?? 0) > 0 || self.computerActionInFlight)
        self.requestNotificationAuthorizationIfNeeded(obj["settings"] as? [String:Any] ?? [:])
        self.applyPendingClientRoute()
        self.keepAwake.update(obj["keep_awake"] as? Bool == true)
        if (obj["lifecycle"] as? [String:Any])?["exit_requested"] as? Bool == true { self.quit();return }
        let events=obj["events"] as? [[String:Any]] ?? [];let newest=events.compactMap{$0["id"] as? Int}.max() ?? 0
        let instance=obj["instance_id"] as? String ?? "legacy"
        if self.eventInstance != instance {self.eventInstance=instance;self.lastEvent=newest;self.notifiedKeys=[];self.presentNetworkChallenge(obj);return}
        self.presentNetworkChallenge(obj)
        let before=self.lastEvent;self.lastEvent=max(before ?? 0,newest)
        guard let since=before else{return}
        let notificationsOn = (obj["settings"] as? [String:Any])?["notifications"] as? Bool != false
        for e in events where (e["id"] as? Int ?? 0)>since {
            if notificationsOn || e["kind"] as? String == "confirmation_closed" { self.notify(e) }
        }
    }}
    func presentNetworkChallenge(_ snapshot:[String:Any]) {
        guard (snapshot["settings"] as? [String:Any])?["notifications"] as? Bool != false,
              let installation=snapshot["installation_id"] as? String,
              let notice=snapshot["network_challenge_notification"] as? [String:Any], let episode=notice["episode"] as? Int, episode>0 else { return }
        let key=installation+":"+String(episode)
        switch networkChallengeNotifications.next(key:key,nowMS:Date().timeIntervalSince1970*1000) {
        case .none: return
        case .acknowledge: api("/api/network-challenge/notification/ack",["episode":episode]) { _ in }
        case .deliver: notify(["kind":"network_challenge","id":episode,"challenge_episode":episode,"challenge_key":key])
        }
    }
    func notify(_ event:[String:Any]){
        guard let kind=event["kind"] as? String,["approval","task_finished","connection_lost","permission_required","browser_connection_lost","update_requested","task_stalled","task_continuation","confirmation_required","confirmation_closed","network_challenge"].contains(kind) else{return}
        if kind == "confirmation_closed", let id = event["confirm_id"] as? String {
            let identifiers = ["kb-confirm-" + id]
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers:identifiers)
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers:identifiers)
            return
        }
        // 同一请求只发新的确认通知；旧 permission_required 事件仍留作兼容和审计。
        let confirmations = state["confirmations"] as? [[String:Any]] ?? []
        if kind == "permission_required", let requested = event["permission_id"] as? String,
           confirmations.contains(where: { ($0["item"] as? [String:Any])?["id"] as? String == requested && $0["task_id"] as? String == event["task_id"] as? String && $0["state"] as? String == "waiting" }) { return }
        if kind == "confirmation_required", let id = event["confirm_id"] as? String,
           confirmations.first(where: { $0["id"] as? String == id && $0["state"] as? String == "waiting" }) == nil { return }
        let task=event["task_id"] as? String ?? "unknown"
        let identity=kind=="task_finished" ? task : String(describing:event["id"] ?? "unknown")
        let key=kind == "network_challenge" ? "network_challenge:"+(event["challenge_key"] as? String ?? identity) : eventInstance+":"+kind+":"+identity
        guard !notifiedKeys.contains(key) else{return}
        notifiedKeys.append(key);if notifiedKeys.count>1000{notifiedKeys.removeFirst(notifiedKeys.count-1000)}
        let admin=event["admin"] as? Bool == true
        let c=UNMutableNotificationContent()
        switch kind {
        case "confirmation_required":
            let confirmation = confirmations.first { $0["id"] as? String == event["confirm_id"] as? String }
            c.title = ClientNotifications.confirmationTitle(item: confirmation?["item"] as? [String:Any])
            c.body = event["body"] as? String ?? LocalText.text("native.notification.capability.body")
            let scopes = event["scopes"] as? [String] ?? []
            c.categoryIdentifier = scopes.contains("always") ? ClientNotifications.confirmCategory : ClientNotifications.confirmDenyCategory
        case "permission_required":
            c.title=LocalText.text("native.notification.permission.title")
            c.body=(event["permission_id"] as? String)=="admin" ? LocalText.text("native.notification.admin.body") : LocalText.text("native.notification.schedule.body")
        case "approval" where admin:
            c.title=LocalText.text("native.notification.adminConfirm.title")
            c.body=LocalText.text("native.notification.adminConfirm.body")
        case "approval":
            c.title=LocalText.text("native.notification.taskConfirm.title");c.body=LocalText.text("native.notification.taskConfirm.body")
        case "update_requested":
            c.title=LocalText.text("native.notification.update.title")
            c.body=LocalText.text("native.notification.update.body")
        case "browser_connection_lost":
            c.title=ClientNotifications.browserConnectionLostTitle
            c.body=ClientNotifications.browserConnectionLostBody
        case "task_continuation":
            c.title=LocalText.text("native.notification.taskReminder.title")
            c.body=String(ClientNotifications.continuationBody(event).prefix(200))
        case "task_stalled":
            // 1026：对话里的卡片要 ChatGPT 自己调出来，不一定有；回复停住时用通知兜底（Ken 10/7 实测）。
            c.title=LocalText.text("native.notification.stalled.title")
            let name=(event["title"] as? String ?? "").prefix(40)
            c.body=name.isEmpty ? LocalText.text("native.notification.stalled.body") : LocalText.text("native.notification.stalled.namedBody", ["name": String(name)])
        case "network_challenge":
            c.title=LocalText.text("native.notification.networkChallenge.title")
            c.body=LocalText.text("native.notification.networkChallenge.body")
        case "connection_lost":
            c.title=LocalText.text("native.notification.cloudDown.title")
            c.body=(event["proxy"] as? String)=="direct" ? LocalText.text("native.notification.cloudDirect.body") : LocalText.text("native.notification.cloudDown.body")
        default:
            c.title=LocalText.text("native.notification.finished.title");c.body=LocalText.text("native.notification.finished.body")
        }
        c.userInfo=["kind":kind,"admin":admin,"conversation_id":event["conversation_id"] as? String ?? "","permission_id":event["permission_id"] as? String ?? ""]
        var identifier = "kb-" + key
        if kind == "confirmation_required" {
            guard let id = event["confirm_id"] as? String, id.range(of:"^cf_[a-f0-9]{16}$", options:.regularExpression) != nil else { return }
            c.userInfo["confirm_id"] = id
            identifier = "kb-confirm-" + id
        }
        let trigger: UNNotificationTrigger? = kind == "confirmation_required" ? UNTimeIntervalNotificationTrigger(timeInterval:30,repeats:false) : nil
        let req=UNNotificationRequest(identifier:identifier,content:c,trigger:trigger)
        UNUserNotificationCenter.current().add(req){error in
            if kind == "network_challenge", let episode=event["challenge_episode"] as? Int, let challengeKey=event["challenge_key"] as? String {
                DispatchQueue.main.async {
                    self.networkChallengeNotifications.completed(key:challengeKey,succeeded:error == nil,nowMS:Date().timeIntervalSince1970*1000)
                    if error == nil {
                        UserDefaults.standard.set(self.networkChallengeNotifications.delivered,forKey:"ChatHandNetworkChallengeDelivered")
                        self.api("/api/network-challenge/notification/ack",["episode":episode]) { _ in }
                    } else { self.notifiedKeys.removeAll { $0 == key } }
                }
            }
        }
    }

    func registerConfirmationNotifications() {
        let always = UNNotificationAction(identifier:ClientNotifications.allowAlwaysAction, title:LocalText.text("native.notification.allow"), options:[])
        let deny = UNNotificationAction(identifier:ClientNotifications.denyAction, title:LocalText.text("native.notification.deny"), options:[])
        let full = UNNotificationCategory(identifier:ClientNotifications.confirmCategory, actions:[always,deny], intentIdentifiers:[], options:[])
        let denyOnly = UNNotificationCategory(identifier:ClientNotifications.confirmDenyCategory, actions:[deny], intentIdentifiers:[], options:[])
        UNUserNotificationCenter.current().setNotificationCategories([full,denyOnly])
    }
    func requestNotificationAuthorizationIfNeeded(_ settings: [String:Any]) {
        guard !notificationAuthorizationRequested, settings["notifications"] as? Bool != false else { return }
        notificationAuthorizationRequested = true
        UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound,.badge]) { _,_ in }
    }
    func confirmationInput(via: String) -> [String:Any] {
        let click = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType:.leftMouseDown)
        let key = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType:.keyDown)
        let age = lastWindowInput.map { ProcessInfo.processInfo.systemUptime - $0.timestamp }
        let human = ConfirmGuard.isHuman(via:via, windowInputAge:age, hidClickAge:click, hidKeyAge:key)
        let pid: Int64 = via == "window" ? (lastWindowInput?.sourcePID ?? -1) : (NSApp.currentEvent?.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1)
        var input: [String:Any] = ["human":human,"source_pid":pid]
        if let age, age.isFinite { input["window_age_s"] = age } else { input["window_age_s"] = NSNull() }
        if click.isFinite { input["hid_click_s"] = click } else { input["hid_click_s"] = NSNull() }
        if key.isFinite { input["hid_key_s"] = key } else { input["hid_key_s"] = NSNull() }
        return input
    }
    func answerConfirmation(_ id: String, scope: String, via: String, completion: @escaping ([String:Any]) -> Void) {
        guard id.range(of:"^cf_[a-f0-9]{16}$", options:.regularExpression) != nil,
              ["always","deny"].contains(scope), ["window","notification"].contains(via) else {
            completion(["error":["code":"ARG_INVALID","message":LocalText.text("native.confirm.invalid")]]); return
        }
        let input: [String:Any] = scope == "deny" ? ["human":false] : confirmationInput(via:via)
        api("/api/confirm/answer", ["id":id,"scope":scope,"via":via,"input":input], completion:completion)
    }
    func showClientRoute(_ target: [String:String]) {
        pendingClientRoute = target
        applyPendingClientRoute()
    }
    func applyPendingClientRoute() {
        guard clientUIReady, let target = pendingClientRoute, let web, !web.isLoading, window != nil,
              let bytes = try? JSONSerialization.data(withJSONObject:target), let payload = String(data:bytes,encoding:.utf8) else { return }
        pendingClientRoute = nil
        show()
        let script = "(()=>{const target=\(payload);if(!window.showPage)return false;window.showPage(target.page,target.section);if(target.confirm_id){window.dispatchEvent(new CustomEvent('confirmationRequested',{detail:{id:target.confirm_id,confirm_id:target.confirm_id,message:target.message||''}}));}else if(target.task_id){if(window.openDrawer)window.openDrawer('task',target.task_id);}else if(target.page==='settings'){window.dispatchEvent(new CustomEvent('permissionItemRequested',{detail:target}));}return true;})()"
        web.evaluateJavaScript(script) { [weak self] result,error in
            if error != nil || result as? Bool != true { self?.pendingClientRoute = self?.pendingClientRoute ?? target }
        }
    }
    func showConfirmation(_ id: String, message: String = "") {
        showClientRoute(["page":"home","confirm_id":id,"message":message])
    }
    func confirmationFollowUp(_ result: [String:Any], id: String) {
        guard result["state"] as? String == "allowed", result["ai_waiting"] as? Bool == false,
              (state["settings"] as? [String:Any])?["notifications"] as? Bool != false else { return }
        let name = (result["item"] as? [String:Any])?["name"] as? String ?? LocalText.text("native.capability.unnamed")
        let c = UNMutableNotificationContent()
        c.title = LocalText.text("native.notification.allowed.title", ["name": name])
        c.body = LocalText.text("native.notification.allowed.body")
        c.userInfo = ["kind":"confirmation_followup","confirm_id":id]
        let request = UNNotificationRequest(identifier:"kb-confirm-followup-"+id, content:c, trigger:nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
    func notifyComputerPermissions(_ status:[String:Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: status),
              let payload = String(data: bytes, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('computerPermissionsUpdated',{detail:\(payload)}))", completionHandler: nil)
    }
    @available(macOS 14.0, *)
    func setupComputerPermissionsStatus() -> [String: Any] {
        var current = permissionAssistant.status()
        let newlyGranted = ["accessibility", "screen_recording"].contains { key in
            computerPermissionsAtLaunch[key] as? Bool != true && current[key] as? Bool == true
        }
        current["needs_restart"] = newlyGranted
        return current
    }
    func hasActiveTask() -> Bool {
        guard let tasks = state["tasks"] as? [[String:Any]], let jobs = state["jobs"] as? [[String:Any]] else { return true }
        if tasks.contains(where: { ["active", "pending_approval"].contains($0["status"] as? String ?? "") }) { return true }
        return jobs.contains(where: { ($0["process_alive"] as? Bool == true) || ($0["cleanup_pending"] as? Bool == true) })
    }
    @available(macOS 14.0, *)
    func restartAfterPermissions(completion: @escaping ([String:Any]) -> Void) {
        api("/api/state") { snapshot in
            guard snapshot["error"] == nil else {
                completion(["restart":false,"reason":"state_unavailable","message":LocalText.text("native.restart.stateUnknown")])
                return
            }
            self.state = snapshot
            guard !self.hasActiveTask() else {
                completion(["restart":false,"reason":"task_busy","message":LocalText.text("native.restart.busy")])
                return
            }
            self.confirmAndRestartAfterPermissions(completion: completion)
        }
    }
    @available(macOS 14.0, *)
    private func confirmAndRestartAfterPermissions(completion: @escaping ([String:Any]) -> Void) {
        let status = permissionAssistant.status()
        guard status["complete"] as? Bool == true else {
            completion(["restart":false,"reason":"permissions_incomplete","permissions":status])
            return
        }
        // The current instance still owns its lease here. The relaunch helper
        // confirms the old native/backend processes have exited before opening
        // a fresh instance; opening first makes that contender wake us and exit.
        relaunchChatHand { result in
            guard result["relaunching"] as? Bool == true else {
                completion(["restart":false,"reason":"launch_failed","error":result["error"] as? String ?? "RELAUNCH_START_FAILED"])
                return
            }
            completion(["restart":true])
        }
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification,withCompletionHandler completionHandler:@escaping(UNNotificationPresentationOptions)->Void){completionHandler([.banner,.list])}
    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse,withCompletionHandler completionHandler:@escaping()->Void){
        DispatchQueue.main.async{let d=response.notification.request.content.userInfo
            let kind=d["kind"] as? String
            if kind == "confirmation_required" || kind == "confirmation_followup" {
                guard let id = d["confirm_id"] as? String else { completionHandler(); return }
                let action = response.actionIdentifier
                if kind == "confirmation_required" && [ClientNotifications.allowAlwaysAction,ClientNotifications.denyAction].contains(action) {
                    let scope = action == ClientNotifications.allowAlwaysAction ? "always" : "deny"
                    self.answerConfirmation(id, scope:scope, via:"notification") { result in
                        let error = result["error"] as? [String:Any]
                        if error?["code"] as? String == "CONFIRM_NOT_HUMAN" {
                            self.showConfirmation(id, message:LocalText.text("native.click.unrecognized"))
                        } else if error != nil {
                            self.showConfirmation(id, message:error?["message"] as? String ?? LocalText.text("native.click.failed"))
                        } else {
                            self.confirmationFollowUp(result, id:id)
                        }
                        completionHandler()
                    }
                } else { self.showConfirmation(id);completionHandler() }
                return
            }
            if let target=ClientNotifications.networkChallengeTarget(kind:kind) {
                self.showClientRoute(target)
            }
            else if let script=ClientNotifications.browserRepairScript(kind:kind) {
                self.show();self.web.evaluateJavaScript(script,completionHandler:nil)
            }
            else if kind == "permission_required" {
                let requested=d["permission_id"] as? String ?? ""
                if ["admin","autostart"].contains(requested) { self.showPermissionItem(requested) }
                else { self.showPage("settings") }
            }
            else if kind == "connection_lost" || kind == "update_requested" || kind == "task_stalled" || (kind == "approval" && d["admin"] as? Bool == true){self.showPage("home")}
            else if kind == "approval"{self.showPage("tasks")}else if let id=d["conversation_id"] as? String,!id.isEmpty{self.openConversation(id)}else{self.showPage("tasks")};completionHandler()
        }
    }
    func showPage(_ page:String){show();let payload=String(data:try! JSONSerialization.data(withJSONObject:[page]),encoding:.utf8)!;web.evaluateJavaScript("window.showPage && window.showPage(\(payload)[0])",completionHandler:nil)}
    func showPermissionItem(_ id: String) {
        show()
        let data: [String: String] = ["page":"settings", "section":"commands", "item":id]
        guard let bytes=try? JSONSerialization.data(withJSONObject:data),let payload=String(data:bytes,encoding:.utf8) else{return}
        web.evaluateJavaScript("(()=>{const target=\(payload);window.showPage && window.showPage(target.page,target.section);window.dispatchEvent(new CustomEvent('permissionItemRequested',{detail:target}));})()",completionHandler:nil)
    }
    func openConversation(_ id:String){api("/api/state"){obj in
        let settings=obj["settings"] as? [String:Any] ?? [:];let chats=settings["conversations"] as? [[String:Any]] ?? []
        guard let c=chats.first(where:{$0["id"] as? String==id}),let u=c["url"] as? String else{self.showPage("tasks");return}
        self.focusURL(u,browser:settings["browser"] as? String ?? "chrome"){result in if result["error"] != nil {self.showPage("tasks");self.showError(LocalText.text("native.browser.returnFailed"),LocalText.text("native.browser.returnBody"))}}
    }}
    func pasteRuntimeKey(tunnelID: String, completion: @escaping ([String:Any]) -> Void) {
        NativeCredentialPaste.runtime(tunnelID:tunnelID,authorized:interfaceKeyShared && ownsService,
            changeCount:{NSPasteboard.general.changeCount},read:{NSPasteboard.general.string(forType:.string)},clear:{NSPasteboard.general.clearContents()},
            submit:{body,done in self.api("/api/setup/key",body,completion:done)},completion:completion)
    }
    func revealSiteTemplate(completion: @escaping ([String:Any]) -> Void) {
        let localPinFile = packageURL.appendingPathComponent("site-template/local-template-pin.json")
        let useLocal = FileManager.default.fileExists(atPath: localPinFile.path) ||
            (try? FileManager.default.destinationOfSymbolicLink(atPath: localPinFile.path)) != nil
        let source = packageURL.appendingPathComponent(useLocal ? "site-template/chathand-site-template-1060-local.zip" : "site-template/chathand-site-template.zip")
        let pinFile = useLocal ? localPinFile : packageURL.appendingPathComponent("connectors/site-template-pin.json")
        func regularFile(_ url: URL, maxBytes: Int) -> Bool {
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) == nil,
                  let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                  attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = attributes[.size] as? NSNumber,
                  size.int64Value > 0 && size.int64Value <= Int64(maxBytes) else { return false }
            return true
        }
        func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        guard regularFile(pinFile, maxBytes: 4096), regularFile(source, maxBytes: 50 * 1024 * 1024),
              let pinData = try? Data(contentsOf: pinFile), pinData.count <= 4096,
              let pin = (try? JSONSerialization.jsonObject(with: pinData)) as? [String:Any],
              pin["format"] as? String == (useLocal ? "chathand-site-template-local-pin" : "chathand-site-template-pin"),
              pin["version"] as? Int == 1,
              !useLocal || (pin["source_kind"] as? String == "bundled_local" &&
                  pin["template_file"] as? String == "chathand-site-template-1060-local.zip" && pin["template_url"] == nil &&
                  Set(pin.keys) == Set(["format","version","source_kind","template_file","template_version","template_sha256","manifest_sha256"])),
              let templateVersion = pin["template_version"] as? String,
              templateVersion.range(of: "^[A-Za-z0-9._-]{1,80}$", options: .regularExpression) != nil,
              let manifestSHA = pin["manifest_sha256"] as? String,
              manifestSHA.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let expected = pin["template_sha256"] as? String,
              expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let sourceData = try? Data(contentsOf: source), sourceData.count <= 50 * 1024 * 1024 else {
            completion(["revealed":false,"error_code":"B_TEMPLATE_UNVERIFIED"]);return
        }
        let actual = digest(sourceData)
        guard actual == expected else { completion(["revealed":false,"error_code":"B_TEMPLATE_MISMATCH"]);return }
        do {
            let folder = try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            var destination = folder.appendingPathComponent(source.lastPathComponent)
            func occupied(_ url: URL) -> Bool {
                FileManager.default.fileExists(atPath: url.path) ||
                    (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil
            }
            if occupied(destination),
               !(regularFile(destination, maxBytes: 50 * 1024 * 1024) && (try? Data(contentsOf: destination)) == sourceData) {
                var found = false
                for n in 2...99 {
                    let candidate = folder.appendingPathComponent(useLocal ? "chathand-site-template-1060-local-\(n).zip" : "chathand-site-template-\(n).zip")
                    if !occupied(candidate) { destination = candidate;found = true;break }
                    if regularFile(candidate, maxBytes: 50 * 1024 * 1024) && (try? Data(contentsOf: candidate)) == sourceData { destination = candidate;found = true;break }
                }
                if !found { completion(["revealed":false,"error_code":"B_TEMPLATE_FILE_COLLISION"]);return }
            }
            if !occupied(destination) { try FileManager.default.copyItem(at: source, to: destination) }
            guard regularFile(destination, maxBytes: 50 * 1024 * 1024), let final = try? Data(contentsOf: destination), digest(final) == expected else {
                completion(["revealed":false,"error_code":"B_TEMPLATE_MISMATCH"]);return
            }
            NSWorkspace.shared.activateFileViewerSelecting([destination])
            completion(["revealed":true,"file_name":destination.lastPathComponent,"source_kind":useLocal ? "bundled_local" : "remote","template_sha256":expected])
        } catch { completion(["revealed":false,"error_code":"B_TEMPLATE_REVEAL_FAILED"]) }
    }
    func pasteSiteGrant(completion: @escaping ([String:Any]) -> Void) {
        NativeCredentialPaste.site(authorized:interfaceKeyShared && ownsService,
            changeCount:{NSPasteboard.general.changeCount},read:{NSPasteboard.general.string(forType:.string)},clear:{NSPasteboard.general.clearContents()},
            submit:{body,done in self.api("/api/site-b/enrollment/import",body,completion:done)},completion:completion)
    }
    func safeChat(_ raw:String)->String? {
        guard var u=URLComponents(string:raw),u.scheme=="https",u.user==nil,u.password==nil,u.port==nil,let h=u.host,
              ["chatgpt.com","chat.openai.com","claude.ai","gemini.google.com","chat.qwen.ai","www.qianwen.com","kimi.com","www.kimi.com","chat.deepseek.com","www.doubao.com","yuanbao.tencent.com","chatglm.cn"].contains(h),raw.count<2048 else{return nil}
        u.query=nil;u.fragment=nil;return u.string
    }
    func quote(_ s:String)->String {return "\""+s.replacingOccurrences(of:"\\",with:"\\\\").replacingOccurrences(of:"\"",with:"\\\"").replacingOccurrences(of:"\n",with:" ").replacingOccurrences(of:"\r",with:" ")+"\""}
    func focusURL(_ raw:String,browser:String,completion:@escaping([String:Any])->Void){
        guard let url=safeChat(raw) else{completion(["error":"CHAT_URL_INVALID"]);return}
        if let last=lastOpen[url],Date().timeIntervalSince(last)<1.5{completion(["status":"coalesced"]);return};lastOpen[url]=Date()
        if !["chrome","safari"].contains(browser) {completion(["error":"DEFAULT_BROWSER_NO_DEDUP","message":LocalText.text("native.browser.defaultUnsupported")]);return}
        let isSafari=browser=="safari", app=isSafari ? "com.apple.Safari":"com.google.Chrome"
        let js="""
        on normalizeURL(s)
            set AppleScript's text item delimiters to "#"
            set s to text item 1 of s
            set AppleScript's text item delimiters to "?"
            set s to text item 1 of s
            set AppleScript's text item delimiters to ""
            if s starts with "https://chat.openai.com/" then set s to "https://chatgpt.com/" & text 25 thru -1 of s
            if s ends with "/" then set s to text 1 thru -2 of s
            return s
        end normalizeURL
        with timeout of 15 seconds
        tell application id \(quote(app))
            repeat with w in windows
                set i to 0
                repeat with t in tabs of w
                    set i to i + 1
                    if my normalizeURL(URL of t as text) is my normalizeURL(\(quote(url))) then
                        \(isSafari ? "set current tab of w to t" : "set active tab index of w to i")
                        set index of w to 1
                        activate
                        return "focused_existing"
                    end if
                end repeat
            end repeat
            if (count of windows) is 0 then \(isSafari ? "make new document" : "make new window")
            tell front window to make new tab with properties {URL:\(quote(url))}
            \(isSafari ? "set current tab of front window to last tab of front window" : "set active tab index of front window to (count of tabs of front window)")
            activate
            return "opened_new"
        end tell
        end timeout
        """
        DispatchQueue.main.async {var err:NSDictionary?;let result=NSAppleScript(source:js)?.executeAndReturnError(&err)
            DispatchQueue.main.async{if let e=err{completion(["error":"BROWSER_AUTOMATION_DENIED_OR_FAILED","code":e[NSAppleScript.errorNumber] ?? 0])}else{completion(["status":result?.stringValue ?? "opened"])}}
        }
    }
    func capture(_ browser:String,completion:@escaping([String:Any])->Void){
        let app=browser=="safari" ? "com.apple.Safari":"com.google.Chrome", tab=browser=="safari" ? "current tab":"active tab"
        let titleProperty = browser == "safari" ? "name" : "title"
        let source="tell application id \(quote(app))\nif (count of windows) is 0 then error \"No browser window\"\nreturn {URL of \(tab) of front window, \(titleProperty) of \(tab) of front window}\nend tell"
        DispatchQueue.main.async{var err:NSDictionary?;let d=NSAppleScript(source:source)?.executeAndReturnError(&err);DispatchQueue.main.async{
            if err != nil{completion(["error":"BROWSER_PERMISSION","message":LocalText.text("native.browser.permission")])}else if let url=d?.atIndex(1)?.stringValue,self.safeChat(url) != nil{completion(["url":url,"title":d?.atIndex(2)?.stringValue ?? LocalText.text("native.conversation.unnamed")])}else{completion(["error":"NOT_CHAT_PAGE","message":LocalText.text("native.browser.notChat")])}
        }}
    }
    func reply(_ id:String,_ data:[String:Any]) {guard let d=try? JSONSerialization.data(withJSONObject:["id":id,"result":data]),let text=String(data:d,encoding:.utf8) else{return};web.evaluateJavaScript("window.nativeReply && window.nativeReply(\(text))",completionHandler:nil)}
    // 1043: fixed private helper. No caller-controlled executable or argv.
    func artifactFileCheck(_ request: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        let executable = packageURL.appendingPathComponent("bin/ChatHandArtifactIO")
        DispatchQueue.global(qos: .userInitiated).async {
            var result: [String: Any] = ["error": ["code": "ARTIFACT_IO_FAILED"]]
            let process = Process(), input = Pipe(), output = Pipe()
            let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
            defer { deadline.cancel(); DispatchQueue.main.async { completion(result) } }
            do {
                let payload = try JSONSerialization.data(withJSONObject: request)
                guard payload.count <= 65536,
                      executable.resolvingSymlinksInPath().path == executable.path,
                      let attrs = try? FileManager.default.attributesOfItem(atPath: executable.path),
                      attrs[.type] as? FileAttributeType == .typeRegular,
                      (attrs[.referenceCount] as? NSNumber)?.intValue == 1 else { return }
                process.executableURL = executable; process.arguments = []
                process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
                try input.fileHandleForWriting.write(contentsOf: payload); try input.fileHandleForWriting.close()
                var received = Data()
                while let chunk = try output.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
                    guard received.count <= 2 * 1024 * 1024 - chunk.count else { process.terminate(); return }; received.append(chunk)
                }
                process.waitUntilExit()
                guard let decoded = try JSONSerialization.jsonObject(with: received) as? [String: Any] else { return }
                if let error = decoded["error"] as? [String: Any], let code = error["code"] as? String,
                   code.range(of: "^(ARTIFACT_[A-Z_]{1,48}|FILE_GONE)$", options: .regularExpression) != nil { result = ["error": ["code": code]]; return }
                guard process.terminationStatus == 0 else { return }; result = decoded
            } catch { if process.isRunning { process.terminate() } }
        }
    }
    func artifactOpenBinding(_ authorization: [String: Any]) -> Data? {
        let fields = ["root", "root_identity", "relative_path", "sha256", "identity", "is_directory", "epoch", "revision"]
        guard authorization["authorized"] as? Bool == true, authorization["root"] is String,
              authorization["root_identity"] is [String: Any], authorization["relative_path"] is String,
              authorization["is_directory"] is Bool, authorization["epoch"] != nil, authorization["revision"] != nil else { return nil }
        return try? JSONSerialization.data(withJSONObject: authorization.filter { fields.contains($0.key) }, options: [.sortedKeys])
    }
    func artifactVerifyRequest(_ authorization: [String: Any], proof: [String: Any]? = nil) -> [String: Any] {
        var body: [String: Any] = ["version": 1, "action": "verify", "root": authorization["root"] ?? "", "root_identity": authorization["root_identity"] ?? [:], "path": authorization["relative_path"] ?? "", "is_directory": authorization["is_directory"] ?? false]
        if let hash = proof?["sha256"] as? String ?? authorization["sha256"] as? String { body["sha256"] = hash }
        if let identity = proof?["identity"] as? [String: Any] ?? authorization["identity"] as? [String: Any] { body["identity"] = identity }
        return body
    }
    func openArtifact(_ action: String, taskID: String, path: String, completion: @escaping ([String: Any]) -> Void) {
        guard !taskID.isEmpty, !path.isEmpty, path.utf8.count < 4096, !shuttingDown else { completion(["error": "NOT_RECORDED"]); return }
        let kind = action == "openTaskFile" ? "open" : action == "revealTaskFile" ? "reveal" : "quicklook"
        let query: [String: Any] = ["task_id": taskID, "path": path, "action": kind]
        func failure(_ result: [String: Any]) -> [String: Any] {
            let code = (result["error"] as? [String: Any])?["code"] as? String
            return ["error": code == "FILE_GONE" ? "FILE_GONE" : "ARTIFACT_OPEN_DENIED"]
        }
        api("/api/artifacts/authorize-open", query) { authorization in
            guard let binding = self.artifactOpenBinding(authorization), !self.shuttingDown else { completion(failure(authorization)); return }
            self.artifactFileCheck(self.artifactVerifyRequest(authorization)) { proof in
                guard proof["verified"] as? Bool == true, !self.shuttingDown else { completion(failure(proof)); return }
                // Hashing or a workspace change may invalidate the first authorization.
                // The server owns this check; opening a verified artifact adds no extra consent.
                self.api("/api/artifacts/authorize-open", query) { fresh in
                    guard self.artifactOpenBinding(fresh) == binding, !self.shuttingDown else { completion(["error": "ARTIFACT_OPEN_DENIED"]); return }
                    self.artifactFileCheck(self.artifactVerifyRequest(fresh, proof: proof)) { final in
                        guard final["verified"] as? Bool == true, !self.shuttingDown,
                              let root = fresh["root"] as? String, let relative = final["relative_path"] as? String else { completion(failure(final)); return }
                        // Hashing may itself take time. Recheck the server's
                        // live scope immediately before handing the path to macOS.
                        self.api("/api/artifacts/authorize-open", query) { live in
                            guard self.artifactOpenBinding(live) == binding, !self.shuttingDown else { completion(["error": "ARTIFACT_OPEN_DENIED"]); return }
                            let target = URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent(relative)
                            if action == "quickLookTaskFile" {
                                let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage"); process.arguments = ["-p", target.path]
                                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                                do { try process.run(); completion(["ok": true]) } catch { completion(["error": "PREVIEW_FAILED"]) }; return
                            }
                            if action == "revealTaskFile" {
                                // A package directory (e.g. .app) must be
                                // revealed, never launched via the folder shortcut.
                                if final["is_directory"] as? Bool == true, final["needs_confirmation"] as? Bool != true { completion(NSWorkspace.shared.open(target) ? ["ok": true] : ["error": "OPEN_FAILED"]) }
                                else { NSWorkspace.shared.activateFileViewerSelecting([target]); completion(["ok": true]) }; return
                            }
                            completion(NSWorkspace.shared.open(target) ? ["ok": true] : ["error": "OPEN_FAILED"])
                        }
                    }
                }
            }
        }
    }
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
        guard message.frameInfo.isMainFrame,let page=message.frameInfo.request.url,page.scheme=="http",page.host=="127.0.0.1",page.port==URL(string:origin)?.port,let m=message.body as? [String:Any],let id=m["id"] as? String,let action=m["action"] as? String else{return}
        let data=m["data"] as? [String:Any] ?? [:];let done:([String:Any])->Void={self.reply(id,$0)}
        // All former helper-folder and AX installer entries now open the same store flow.
        // Keeping the old switch below does not leave it reachable from the production bridge.
        if ChromeWebStoreOpeningPolicy.openActions.contains(action) {
            guard data.keys.allSatisfy({ ["profile_id", "wait_for_accessibility"].contains($0) }),
                  data["profile_id"] == nil || data["profile_id"] is String else { done(["error_code":"ARG_INVALID"]); return }
            chromeWebStoreFlow.open(profileID:data["profile_id"] as? String, completion:done)
            return
        }
        if action == "extensionCancel" {
            guard data.isEmpty else { done(["error_code":"ARG_INVALID"]); return }
            _ = chromeWebStoreFlow.cancel()
            api("/api/browser/extension/store/cancel", [:], completion:done)
            return
        }
        if action == "openChromeDataAccessSettings" {
            done(["error_code":"CHROME_LOCAL_INSTALL_DISABLED", "distribution":"chrome_web_store"])
            return
        }
        // Repair and setup share the same personal-click, focus and lease gates.
        let repairExtension = action == "extensionRepair"
        switch repairExtension ? "extensionSetup" : action {
        case "relaunchChatHand":
            guard data.isEmpty else{done(["error":"ARG_INVALID"]);return}
            relaunchChatHand(completion:done)
        case "getLocalTextCatalogs":
            done(["preference":LocalText.preference,"locale":LocalText.systemLocale,"source":LocalText.localeSource,"catalogs":["zh":LocalText.catalog.chinese,"en":LocalText.catalog.english]])
        case "setLanguage":
            let result = LocalText.languagePreferences.setLanguage(data["language"])
            if result["ok"] as? Bool == true { refreshNativeLanguage()
                // Keep the running helper in sync without restarting connections.
                api("/api/native/state",onExpired:{done(result)},timeout:1,locale:LocalText.systemLocale){ _ in done(result) }
                return
            }
            done(result)
        case "getSystemLocale":
            done(["locale":LocalText.systemLocale,"source":LocalText.localeSource])
        case "pageBackground":
            guard let color=PageBackgroundSync.color(data["color"]) else {done(["error_code":"ARG_INVALID"]);return}
            PageBackgroundSync.synchronize(window:window,web:web,color:color);done(["ok":true])
        case "permissionUndoPresent":
            guard interfaceKeyShared && ownsService else {done(["error":["code":"NATIVE_OWNER_AUTH_REQUIRED","message":LocalText.text("native.owner.reopen")]]);return}
            if permissionUndoToast == nil {permissionUndoToast=PermissionUndoToast(window:window,web:web,signer:permissionUndoProof,api:{[weak self] endpoint,body,callback in self?.api(endpoint,body,completion:callback)})}
            permissionUndoToast?.present(receiptID:data["receipt_id"] as? String ?? "",style:data["style"] as? [String:Any] ?? [:],completion:done)
        case "permissionUndo":
            done(["error":["code":"NATIVE_OWNER_BUTTON_REQUIRED","message":LocalText.text("native.owner.undoButton")]])
        case "confirmAnswer":
            answerConfirmation(data["id"] as? String ?? "", scope:data["scope"] as? String ?? "", via:"window", completion:done)
        case "checkpointAction":
            guard let task = data["task_id"] as? String, !task.isEmpty,
                  let seq = data["checkpoint_seq"] as? Int, seq > 0,
                  let choice = data["choice"] as? String, ["1","2","3","4"].contains(choice) else {
                done(["error":["code":"ARG_INVALID","message":LocalText.text("native.confirm.options")]]);return
            }
            let input = confirmationInput(via:"window")
            guard input["human"] as? Bool == true else {
                done(["error":["code":"CONFIRM_NOT_HUMAN","message":LocalText.text("native.click.unrecognized")]]);return
            }
            api("/api/checkpoint/action",["task_id":task,"checkpoint_seq":seq,"choice":choice,"via":"window","input":input],completion:done)
        case "activateChatGPT":
            guard data.isEmpty else {done(["error_code":"ARG_INVALID"]);return}
            done(ClientFeatures.activateChatGPT())
        case "openSetupDesktop":
            guard data.isEmpty else {done(["error_code":"ARG_INVALID"]);return}
            SetupConversation.showDesktop(completion: done)
        case "openChatGPT":
            let prompt = data["prompt"] as? String ?? ""
            ClientFeatures.openChatGPT(prompt: prompt, work: data["mode"] as? String == "work") { response in
                if response["opened"] as? String == "web" || response["copied"] as? Bool == true { self.observeSitePrompt(prompt) }
                done(response)
            }
        case "setAppearance":
            let expiresAt = (data["expires_at"] as? NSNumber).flatMap { value -> Date? in
                guard CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
                return Date(timeIntervalSince1970: value.doubleValue / 1000)
            }
            if data["expires_at"] != nil && expiresAt == nil { done(["error_code": "ARG_INVALID"]); return }
            clientFeatures.setAppearance(mode: data["mode"] as? String ?? "system", expiresAt: expiresAt, completion: done)
        case "windowChrome":
            var scaled = data
            for key in ["zones", "holes"] {
                if let rects = data[key] as? [[NSNumber]] { scaled[key] = rects.map { $0.map { $0.doubleValue * web.pageZoom } } }
            }
            (web as? ChromeWebView)?.setDragAreas(scaled)
        case "getSetupConversationStatus":done(SetupConversation.status())
        case "openSetupConversation":
            if data["status"] as? Bool == true {done(SetupConversation.status())}
            else {
                let end = onboardingBegin("setup_conversation")
                SetupConversation.open(prompt:data["prompt"] as? String ?? "") { result in
                    // Dispatch accepted never proves the host sent a message or ran setup.
                    end(result["opened"] as? Bool == true ? "unknown" : "failed",result["opened"] as? Bool == true ? "HOST_UNCONFIRMED" : "LOCAL_FAILED")
                    done(result)
                }
            }
        case "getLoginItemStatus":
            Task { @MainActor in done(LoginItemService.status()) }
        case "openLoginItemsSettings":
            Task { @MainActor in done(LoginItemService.openSettings()) }
        case "setLoginItemEnabled":
            guard let raw=data["enabled"] as? NSNumber, CFGetTypeID(raw) == CFBooleanGetTypeID() else{done(["error_code":"ARG_INVALID","message":LocalText.text("native.argument.boolean")]);return}
            Task { @MainActor in done(await LoginItemService.setEnabled(raw.boolValue)) }
        case "getNativeStatus":
            Task { @MainActor in done(["login_item":LoginItemService.status(),"emergency_shortcut":self.emergencyStopHotKey.status,"min_window_content_size":["width":980,"height":680]]) }
        case "extensionSetup":
            guard confirmationInput(via:"window")["human"] as? Bool == true else {
                api("/api/browser/extension/install/progress",["native_event":"stopped","stage":"preparing","code":"CONFIRM_NOT_HUMAN","elapsed_ms":0,"target_is_default":NSNull()]){_ in}
                done(["error":["code":"CONFIRM_NOT_HUMAN"],"manual_available":true]);return
            }
            guard data["profile_id"] == nil || data["profile_id"] is String else {done(["error":["code":"CHROME_INSTALL_PROFILE_UNKNOWN"]]);return}
            guard ownsService,interfaceKeyShared,!shuttingDown else {done(["error":["code":"CHROME_INSTALL_PERMISSION_CHANGED"]]);return}
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier else {done(["error":["code":"CHROME_INSTALL_USER_INTERRUPTED"]]);return}
            func beginAttempt(app:AppDelegate,chosen:String?,intentDeadline:TimeInterval,waitForAccessibility:Bool,repair:Bool,resumingRecovery:Bool = false,done:@escaping ([String:Any])->Void) {
            var stage = "preparing", stageStartedAt = ProcessInfo.processInfo.systemUptime
            var resumedIntentDeadline = intentDeadline
            var waitingAcknowledged = false
            var bridgeAcknowledged = false, attemptAccepted = false, stoppedReported = false
            var preparationInputMonitors: [Any] = []
            func stopPreparationInputMonitoring() {
                for monitor in preparationInputMonitors { NSEvent.removeMonitor(monitor) }
                preparationInputMonitors=[]
            }
            let preparation = UUID()
            let defaultTarget: Any = chosen.flatMap { ChromeInstallLease.validProfile($0) ? ($0 == "Default") : nil } as Any? ?? NSNull()
            // Keep pre-lease status in causal order even if URLSession would
            // otherwise deliver started/running/profile-choice out of order.
            var pendingProgress: [([String:Any], (([String:Any])->Void)?)] = []
            var progressInFlight = false
            func sendNextProgress() {
                guard !progressInFlight,!pendingProgress.isEmpty else {return}
                progressInFlight=true
                let (metadata,completion)=pendingProgress.removeFirst()
                app.api("/api/browser/extension/install/progress",metadata) { response in
                    progressInFlight=false
                    completion?(response)
                    sendNextProgress()
                }
            }
            func reportProgress(_ metadata:[String:Any], completion:(([String:Any])->Void)? = nil) {
                pendingProgress.append((metadata,completion))
                sendNextProgress()
            }
            func progress(_ event:String,_ code:String? = nil, detail:ChromeInstallFailureDetail? = nil, completion:(([String:Any])->Void)? = nil) {
                guard attemptAccepted else {return}
                if event == "stopped" {
                    guard !stoppedReported else {return}
                    stoppedReported=true
                } else if stoppedReported {return}
                let elapsed = max(0,min(stage == "waiting_accessibility" ? 300000:90000,Int((ProcessInfo.processInfo.systemUptime-stageStartedAt)*1000)))
                var metadata:[String:Any] = ["native_event":event,"stage":stage,"elapsed_ms":elapsed,"target_is_default":defaultTarget,"attempt_id":preparation.uuidString]
                if let code {metadata["code"]=code}
                if event == "stopped",stage == "preparing",let detail,detail.matches(code) {
                    metadata["detail_code"]=detail.code.rawValue
                    if let axError=detail.axError {metadata["ax_error"]=axError}
                    if let fallback=detail.fallbackCode {metadata["fallback_code"]=fallback.rawValue}
                    if let context=detail.windowContext {for (key,value) in context.metadata {metadata[key]=value}}
                }
                reportProgress(metadata,completion:completion)
            }
            func deliver(_ result:[String:Any]) {
                guard !stoppedReported else {return}
                guard bridgeAcknowledged else {bridgeAcknowledged=true;done(result);return}
                if let code=(result["error"] as? [String:Any])?["code"] as? String ?? result["error_code"] as? String {
                    progress("stopped",code,detail:ChromeInstallFailureDetail(metadata:result))
                    return
                }
                // The bridge has already returned started; profile choice travels
                // through the existing status poll without replaying that reply.
                if result["choose_profile"] as? Bool == true {
                    reportProgress([
                        "native_event":"choose_profile","choose_profile":true,
                        "profiles":result["profiles"] ?? [],"selected_profile":result["selected_profile"] ?? "",
                        "repair":repair,"attempt_id":preparation.uuidString
                    ])
                    // Profile choice is idle for a new human click but remains
                    // cancellable when the user switches to manual or quits.
                    app.chromeInstallPreparationCancel = { progress("stopped","CHROME_INSTALL_CANCELLED") }
                }
            }
            func rejectInstall(_ code: String, manual: Bool = false) {
                stopPreparationInputMonitoring()
                if app.chromeInstallPreparation == preparation || app.chromeInstallPreparation == nil {
                    app.chromeDiscoveryProof=nil;app.chromePreflightProof=nil
                    app.chromeDiscoveryProofSlot?.clear();app.chromeDiscoveryProofSlot=nil
                }
                if app.chromeInstallPreparation == preparation { app.chromeInstallPreparation=nil }
                if app.chromeInstallPreparation == nil { app.chromeInstallPreparationCancel=nil }
                progress("stopped",code)
                var result: [String:Any] = ["error":["code":code]]
                if manual { result["manual_available"] = true }
                if !bridgeAcknowledged { bridgeAcknowledged=true;done(result) }
            }
            guard !app.chromeHelperInstaller.active,!app.chromeAccessibilityWait.active, app.chromeInstallPreparation == nil else { rejectInstall("CHROME_INSTALL_BUSY");return }
            guard chosen == nil || ChromeInstallLease.validProfile(chosen!) else { rejectInstall("CHROME_INSTALL_PROFILE_UNKNOWN");return }
            if resumingRecovery {
                let cancelChoice=app.chromeInstallPreparationCancel
                app.chromeInstallPreparationCancel=nil
                cancelChoice?()
            } else {app.cancelChromePreparation()}
            app.chromeInstallContinuation={ [weak app] newDone in
                guard let app,!app.shuttingDown else {newDone(["error":["code":"CHROME_INSTALL_CANCELLED"]]);return}
                guard ProcessInfo.processInfo.systemUptime <= resumedIntentDeadline else {newDone(["error":["code":"CHROME_DATA_ACCESS_TIMEOUT"]]);return}
                beginAttempt(app:app,chosen:chosen,intentDeadline:resumedIntentDeadline,waitForAccessibility:false,repair:repair,resumingRecovery:true,done:newDone)
            }
            app.chromeInstallPreparation = preparation
            app.chromeInstallPreparationCancel = { [weak app] in
                guard let app,app.chromeInstallPreparation == preparation else {return}
                app.chromeInstallPreparation=nil
                rejectInstall("CHROME_INSTALL_CANCELLED")
            }
            func acceptAttempt(waiting:Bool, continuation:@escaping ()->Void) {
                guard app.chromeInstallPreparation == preparation,!app.shuttingDown,!attemptAccepted else {return}
                attemptAccepted=true;bridgeAcknowledged=true
                stage=waiting ? "waiting_accessibility":"preparing";stageStartedAt=ProcessInfo.processInfo.systemUptime
                // Reply within the bridge budget, then poll status. Neither the
                // permission UI nor discovery/lease creation may overtake started.
                if waiting {done(["started":true,"phase":"waiting_accessibility"])}
                else {done(["started":true,"phase":"preparing","attempt_id":preparation.uuidString])}
                let inputBeforeStart=app.lastWindowInput?.timestamp
                var startFinished=false
                DispatchQueue.main.asyncAfter(deadline:.now()+10) {
                    guard !startFinished,app.chromeInstallPreparation == preparation else {return}
                    startFinished=true;rejectInstall("CHROME_INSTALL_TIMEOUT")
                }
                progress("started",completion:{ response in
                    guard !startFinished,app.chromeInstallPreparation == preparation,!app.shuttingDown else {return}
                    startFinished=true
                    guard response["error"] == nil,response["recorded"] as? Bool == true,response["discarded"] as? Bool != true else {
                        rejectInstall("CHROME_INSTALL_PERMISSION_CHANGED");return
                    }
                    guard app.ownsService,app.interfaceKeyShared,app.lastWindowInput?.timestamp == inputBeforeStart,
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier else {
                        rejectInstall("CHROME_INSTALL_USER_INTERRUPTED");return
                    }
                    guard ProcessInfo.processInfo.systemUptime <= resumedIntentDeadline else {rejectInstall("CHROME_DATA_ACCESS_TIMEOUT");return}
                    continuation()
                })
            }
            func discoverProfiles() {
            guard app.chromeInstallPreparation == preparation,!app.shuttingDown else {return}
            // Permission-pane clicks belong to the wait, not the installer input baseline.
            let inputTime=app.lastWindowInput?.timestamp
            app.observeChromeProfiles(preparation:preparation) { [self = app] observed in
            guard self.chromeInstallPreparation == preparation else {return}
            guard !self.shuttingDown,self.lastWindowInput?.timestamp == inputTime else {
                self.chromeInstallPreparation=nil
                rejectInstall("CHROME_INSTALL_CANCELLED");return
            }
            if let code=observed["error_code"] as? String {app.chromeInstallPreparation=nil;rejectInstall(code,manual:true);return}
            app.api("/api/browser/extension/install/profiles",["observed_profile_ids":observed["ids"] ?? []]) { response in
                guard app.chromeInstallPreparation == preparation else {return}
                guard !app.shuttingDown, app.lastWindowInput?.timestamp == inputTime,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier else {
                    app.chromeInstallPreparation=nil
                    rejectInstall("CHROME_INSTALL_USER_INTERRUPTED");return
                }
                stopPreparationInputMonitoring()
                app.chromeInstallPreparation=nil;app.chromeInstallPreparationCancel=nil
                guard ProcessInfo.processInfo.systemUptime <= resumedIntentDeadline else {rejectInstall("CHROME_DATA_ACCESS_TIMEOUT");return}
                guard response["error"] == nil, let profiles = response["profiles"] as? [[String:Any]], !profiles.isEmpty, profiles.count <= 100,
                      profiles.allSatisfy({ p in guard let id=p["id"] as? String, ChromeInstallLease.validProfile(id),let name=p["name"] as? String,name.count<=160 else{return false};return true }),
                      Set(profiles.compactMap{$0["id"] as? String}).count == profiles.count else {
                    rejectInstall("CHROME_INSTALL_PROFILE_UNKNOWN", manual:true);return
                }
                if let chosen {
                    guard profiles.contains(where:{$0["id"] as? String == chosen}) else { rejectInstall("CHROME_INSTALL_PROFILE_UNKNOWN");return }
                    app.chromePreflightProof=app.chromeDiscoveryProof?.selected(chosen,attempt:preparation,now:ProcessInfo.processInfo.systemUptime)
                    app.chromeDiscoveryProof=nil
                    defer {app.chromePreflightProof=nil}
                    app.lastChromeInstallProfile=chosen; app.chromeHelperInstaller.start(profileID:chosen,repair:repair,completion:deliver)
                } else if profiles.count == 1, let id=profiles[0]["id"] as? String {
                    app.chromePreflightProof=app.chromeDiscoveryProof?.selected(id,attempt:preparation,now:ProcessInfo.processInfo.systemUptime)
                    app.chromeDiscoveryProof=nil
                    defer {app.chromePreflightProof=nil}
                    app.lastChromeInstallProfile=id; app.chromeHelperInstaller.start(profileID:id,repair:repair,completion:deliver)
                } else {
                    app.chromeDiscoveryProof=nil;app.chromePreflightProof=nil
                    let view=profiles.map { p in ["id":p["id"]!,"name":p["name"]!,"installed":p["installed"] as? Bool == true,"enabled":p["enabled"] as? Bool == true] as [String:Any] }
                    deliver(["choose_profile":true,"profiles":view,"selected_profile":response["selected_profile"] as? String ?? "","repair":repair])
                }
            }
            }
            }
            func waitForTrust() {
                app.chromeAccessibilityWait.start(onWaiting:{
                    guard app.chromeInstallPreparation == preparation,!app.shuttingDown else {return}
                    waitingAcknowledged=true
                    if #available(macOS 14.0, *) {
                        app.permissionAssistant.onboardingBegin = { [weak app] step in app?.onboardingBegin(step) ?? { _,_ in } }
                        let permissions=app.permissionAssistant.requestAccessibilityOnly()
                        app.notifyComputerPermissions(permissions)
                    }
                },onGranted:{},completion:{ result in
                    guard app.chromeInstallPreparation == preparation,!app.shuttingDown else {return}
                    switch result {
                    case .success:
                        if #available(macOS 14.0, *),waitingAcknowledged {app.permissionAssistant.finishAccessibilityOnly(granted:true)}
                        resumedIntentDeadline=ProcessInfo.processInfo.systemUptime+120
                        stage="preparing";stageStartedAt=ProcessInfo.processInfo.systemUptime
                        progress("running")
                        if waitingAcknowledged {
                            // Start the interruption baseline when authorization
                            // resumes installation, including profile discovery.
                            let mask: NSEvent.EventTypeMask = [.keyDown,.leftMouseDown,.rightMouseDown,.otherMouseDown,.mouseMoved,.scrollWheel,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged]
                            func interrupted() {
                                guard app.chromeInstallPreparation == preparation else {return}
                                app.chromeProfileDiscovery.cancel()
                                rejectInstall("CHROME_INSTALL_USER_INTERRUPTED")
                            }
                            guard let global=NSEvent.addGlobalMonitorForEvents(matching:mask,handler:{ _ in interrupted() }) else {rejectInstall("CHROME_INSTALL_USER_INTERRUPTED");return}
                            preparationInputMonitors.append(global)
                            guard let local=NSEvent.addLocalMonitorForEvents(matching:mask,handler:{ event in interrupted();return event }) else {rejectInstall("CHROME_INSTALL_USER_INTERRUPTED");return}
                            preparationInputMonitors.append(local)
                            NSApp.activate(ignoringOtherApps:true)
                            DispatchQueue.main.asyncAfter(deadline:.now()+0.1,execute:discoverProfiles)
                        } else {discoverProfiles()}
                    case .failure(let code):
                        if #available(macOS 14.0, *),waitingAcknowledged {app.permissionAssistant.finishAccessibilityOnly(granted:false)}
                        app.chromeInstallPreparation=nil
                        rejectInstall(code.rawValue,manual:true)
                    }
                })
            }
            func preflightAttempt(waiting:Bool) {
                // Check the same backend Browser/Computer Use gate before opening
                // an attempt or permission guidance. Discovery-only never reads Chrome files.
                let inputBeforeGate=app.lastWindowInput?.timestamp
                var gateFinished=false
                DispatchQueue.main.asyncAfter(deadline:.now()+10) {
                    guard !gateFinished,app.chromeInstallPreparation == preparation else {return}
                    gateFinished=true;app.chromeInstallPreparation=nil;rejectInstall("CHROME_INSTALL_TIMEOUT")
                }
                app.api("/api/browser/extension/install/profiles",["discovery_only":true]) { permission in
                    guard !gateFinished,app.chromeInstallPreparation == preparation else {return}
                    gateFinished=true
                    guard !app.shuttingDown,app.lastWindowInput?.timestamp == inputBeforeGate,
                          NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier else {
                        app.chromeInstallPreparation=nil;rejectInstall("CHROME_INSTALL_USER_INTERRUPTED");return
                    }
                    guard permission["observe_allowed"] as? Bool == true else {
                        app.chromeInstallPreparation=nil;rejectInstall("CHROME_INSTALL_PERMISSION_CHANGED");return
                    }
                    acceptAttempt(waiting:waiting) {
                        if waiting {waitForTrust()} else {discoverProfiles()}
                    }
                }
            }
            if waitForAccessibility && !AXIsProcessTrusted() {preflightAttempt(waiting:true)}
            else {preflightAttempt(waiting:false)}
            }
            beginAttempt(app:self,chosen:data["profile_id"] as? String,intentDeadline:ProcessInfo.processInfo.systemUptime+120,waitForAccessibility:data["wait_for_accessibility"] as? Bool == true,repair:repairExtension,done:done)
        case "openChromeDataAccessSettings":
            let settingsEntry=ProcessInfo.processInfo.systemUptime
            guard ownsService,interfaceKeyShared,!shuttingDown else{done(["error_code":"OWNED_WINDOW_REQUIRED"]);return}
            let continuation=chromeInstallContinuation
            cancelChromePreparation();chromeProfileDiscovery.cancel();chromeInstallPreparation=nil;chromeHelperInstaller.cancel()
            let recovery=UUID()
            chromeSettingsGeneration=recovery
            api("/api/browser/extension/install/status",[:]) { status in
                guard self.chromeSettingsGeneration == recovery,!self.shuttingDown,self.ownsService,self.interfaceKeyShared else {done(["error_code":"CHROME_INSTALL_CANCELLED"]);return}
                // A repair action can recover registration without a prior installer intent.
                let resumeInstall=status["code"] as? String == "CHROME_DATA_ACCESS_DENIED" && continuation != nil
                guard let pane=URL(string:"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension") else{done(["error_code":"CHROME_SETTINGS_UNAVAILABLE"]);return}
                let remaining=120-(ProcessInfo.processInfo.systemUptime-settingsEntry)
                guard remaining>0 else{done(["error_code":"CHROME_DATA_ACCESS_TIMEOUT"]);return}
                self.chromeDataAccessResume.start(timeout:remaining,retry:{ reply in
                    guard !self.shuttingDown,self.ownsService,self.interfaceKeyShared else{reply(["error_code":"OWNED_WINDOW_REQUIRED"]);return}
                    self.api("/api/browser/extension/install/profiles",["discovery_only":true]) { permission in
                        guard self.chromeSettingsGeneration == recovery,self.chromeDataAccessResume.active,!self.shuttingDown else{return}
                        guard permission["observe_allowed"] as? Bool == true else{reply(["error_code":"CHROME_INSTALL_PERMISSION_CHANGED"]);return}
                        self.api("/api/browser/extension/prepare",["retry_after_permission":true]) { result in
                            guard self.chromeSettingsGeneration == recovery,self.chromeDataAccessResume.active,!self.shuttingDown else{return}
                            if result["error"] != nil || result["error_code"] != nil {reply(result);return}
                            if resumeInstall,let continuation {continuation(reply)}else{reply(["repaired":true])}
                        }
                    }
                },completion:{ result in
                    if result["error"] != nil || result["error_code"] != nil {self.cancelChromePreparation();self.chromeInstallContinuation=nil;self.chromeInstallPreparation=nil;self.chromeProfileDiscovery.cancel();self.chromeHelperInstaller.cancel()}
                    if self.chromeSettingsGeneration == recovery {self.chromeSettingsGeneration=nil}
                    if let observer=self.chromeSettingsObserver{NSWorkspace.shared.notificationCenter.removeObserver(observer);self.chromeSettingsObserver=nil}
                    done(result)
                })
                self.chromeSettingsGeneration=recovery
                self.chromeSettingsObserver=NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main){[weak self] note in
                    guard let self,let app=note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,app.processIdentifier == getpid() else{return}
                    self.chromeDataAccessResume.returnedToApp()
                }
                if !NSWorkspace.shared.open(pane){self.chromeDataAccessResume.cancel()}
            }
        case "extensionCancel":
            cancelChromePreparation();chromeProfileDiscovery.cancel();chromeDataAccessResume.cancel();chromeInstallContinuation=nil
            chromeInstallPreparation=nil
            chromeHelperInstaller.cancel(completion:done)
        case "revealChromeHelper":
            let folder=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ChatHand/chrome-helper",isDirectory:true)
            var isDirectory: ObjCBool=false
            guard FileManager.default.fileExists(atPath:folder.path,isDirectory:&isDirectory),isDirectory.boolValue else { done(["error":["code":"HELPER_FOLDER_MISSING","message":LocalText.text("native.chrome.folderMissing")]]);return }
            NSWorkspace.shared.activateFileViewerSelecting([folder]);done(["revealed":true])
        case "extensionManual":
            cancelChromePreparation();chromeProfileDiscovery.cancel();chromeDataAccessResume.cancel();chromeInstallContinuation=nil
            chromeInstallPreparation=nil
            chromeHelperInstaller.cancel()
            api("/api/browser/extension/prepare",[:]){r in
                if let address=r["store_url"] as? String,let url=URL(string:address),
                   url.scheme == "https", ["chromewebstore.google.com", "chrome.google.com"].contains(url.host ?? ""), let chrome=chromeApplicationURL(){
                    let configuration=NSWorkspace.OpenConfiguration()
                    NSWorkspace.shared.open([url],withApplicationAt:chrome,configuration:configuration){_,_ in}
                }
                else if let folder=r["extension_folder"] as? String{NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath:folder)])}
                done(r)
            }
        case "extensionSettings":
            ChromeExtensionsPageOpener.open(applicationURL:chromeApplicationURL(),completion:done)
        case "installSetupSkill":api("/api/setup/skill",[:],completion:done)
        case "importSetupKey":pasteRuntimeKey(tunnelID: data["tunnel_id"] as? String ?? "", completion: done)
        case "chromeSetup":
            guard let browserURL=chromeApplicationURL() else{done(["error":"CHROME_NOT_INSTALLED"]);return}
            let config=NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.open([URL(string:"chrome://inspect/#remote-debugging")!],withApplicationAt:browserURL,configuration:config){_,error in DispatchQueue.main.async{done(error == nil ? ["opened":true,"permission_auto_granted":false]:["error":"CHROME_SETUP_OPEN_FAILED"])}}
        case "reconnectBrowserHelper":
            // Chrome 开着，ChatHand 助手（扩展）会自己连回来；没开就在后台打开它，不抢前台
            guard let chrome=chromeApplicationURL() else{done(["error":"CHROME_NOT_INSTALLED"]);return}
            let config=NSWorkspace.OpenConfiguration();config.activates=false
            NSWorkspace.shared.openApplication(at:chrome,configuration:config){_,error in DispatchQueue.main.async{done(error == nil ? ["opened":true]:["error":"CHROME_OPEN_FAILED"])}}
        case "chromeUpdate":
            let download=URL(string:"https://www.google.com/chrome/")!
            guard let browserURL=chromeApplicationURL() else {
                NSWorkspace.shared.open(download);done(["opened":"download"]);return
            }
            let config=NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.open([URL(string:"chrome://settings/help")!],withApplicationAt:browserURL,configuration:config){_,error in
                DispatchQueue.main.async{
                    if error == nil { done(["opened":"chrome_update"]) }
                    else { NSWorkspace.shared.open(download);done(["opened":"download_fallback"]) }
                }
            }
        case "computerPermissions":
            if #available(macOS 14.0, *) {
                permissionAssistant.onboardingBegin = { [weak self] step in self?.onboardingBegin(step) ?? { _,_ in } }
                let permissions = permissionAssistant.requestPermissions { status in
                    self.notifyComputerPermissions(status)
                }
                done(permissions)
            } else { done(["error":"MACOS_VERSION_UNSUPPORTED"]) }
        case "repairPermissions":
            if #available(macOS 14.0, *) { permissionAssistant.repairPermissions(completion: done) }
            else { done(["error":"MACOS_VERSION_UNSUPPORTED"]) }
        case "restartAfterPermissions":
            if #available(macOS 14.0, *) { restartAfterPermissions(completion: done) }
            else { done(["error":"MACOS_VERSION_UNSUPPORTED"]) }
        case "pairRelay":api("/api/relay/pair",data,completion:done)
        case "restoreRelay":api("/api/relay/restore",[:],completion:done)
        case "forgetRelay":api("/api/relay/forget",[:],completion:done)
        case "pasteRuntimeKey":
            guard interfaceKeyShared && ownsService else { done(["saved":false,"received":false,"reason_code":"NATIVE_OWNER_AUTH_REQUIRED","error_code":"NATIVE_OWNER_AUTH_REQUIRED"]); return }
            pasteRuntimeKey(tunnelID: data["tunnel_id"] as? String ?? "", completion: done)
        case "pasteSiteGrant":
            guard interfaceKeyShared && ownsService else {
                done(["accepted":false,"error_code":"NATIVE_OWNER_AUTH_REQUIRED"]);return
            }
            pasteSiteGrant(completion: done)
        case "revealPluginIcon":
            guard interfaceKeyShared && ownsService else { done(["error":"NATIVE_OWNER_AUTH_REQUIRED"]); return }
            guard data.isEmpty else { done(["error":"ARG_INVALID"]); return }
            do {
                let destination = try PluginIconExport.copy(source: packageURL.appendingPathComponent("ui/assets/app/ChatHand-plugin-icon.png"), downloads: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true))
                NSWorkspace.shared.activateFileViewerSelecting([destination]); done(["revealed":true,"file_name":destination.lastPathComponent])
            } catch { done(["error": (error as? PluginIconExport.Failure)?.rawValue ?? "PLUGIN_ICON_REVEAL_FAILED"]) }
        case "revealSiteTemplate":
            guard interfaceKeyShared && ownsService else { done(["revealed":false,"error_code":"NATIVE_OWNER_AUTH_REQUIRED"]);return }
            guard data.isEmpty else {
                done(["revealed":false,"error_code":"ARG_INVALID"]);return
            }
            revealSiteTemplate(completion: done)
        case "openTaskFile","revealTaskFile","quickLookTaskFile":
            // File identity and live workspace scope are checked before every open.
            openArtifact(action, taskID: data["task_id"] as? String ?? "", path: data["path"] as? String ?? "", completion: done)
        case "revealWorkspace":
            api("/api/state"){obj in
                guard let project=obj["project"] as? [String:Any],let p=project["path"] as? String else{done(["error":"WORKSPACE_MISSING"]);return}
                NSWorkspace.shared.open(URL(fileURLWithPath:p,isDirectory:true));done(["ok":true])
            }
        case "chooseReleaseDMG":
            // A local DMG source only comes from the user's actual macOS file picker,
            // never a guessed Downloads path or a renderer-provided 'verified' flag.
            guard interfaceKeyShared && ownsService && data.isEmpty else {
                done(["error_code":"NATIVE_OWNER_AUTH_REQUIRED"]);return
            }
            let p = NSOpenPanel()
            p.canChooseDirectories = false
            p.canChooseFiles = true
            p.allowsMultipleSelection = false
            p.allowedFileTypes = ["dmg"]
            if p.runModal() != .OK {done(["cancelled":true]);return}
            guard let u = p.url, u.isFileURL, u.pathExtension.lowercased() == "dmg",
                  let info = try? u.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey]),
                  info.isRegularFile == true, info.isSymbolicLink != true,
                  let size = info.fileSize, size > 0, size <= 8_589_934_592 else {
                done(["error_code":"RELEASE_LOCAL_PAYLOAD_INVALID"]);return
            }
            done(["path":u.path,"payload_type":"dmg","user_selected":true,
                  "signature_verified":false,"installed":false])
        case "chooseFolder": let p=NSOpenPanel();p.canChooseDirectories=true;p.canChooseFiles=false;p.allowsMultipleSelection=false;done(p.runModal() == .OK ? ["path":p.url!.path]:["cancelled":true])
        case "captureTab":capture(data["browser"] as? String ?? "chrome",completion:done)
        case "focusURL":focusURL(data["url"] as? String ?? "",browser:data["browser"] as? String ?? "chrome",completion:done)
        case "openPrivacySettings":
            // Opens a fixed macOS Settings pane only; the user must personally approve.
            guard let pane=URL(string:"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension") else{
                done(["error_code":"F5_SETTINGS_UNAVAILABLE"]);return
            }
            let opened=NSWorkspace.shared.open(pane)
            if opened { done(["opened":true,"user_confirmation_required":true]) }
            else { done(["opened":false,"error_code":"F5_SETTINGS_UNAVAILABLE","user_confirmation_required":true]) }
        case "approvedF5TerminalCommand":
            // Documentation-approved optional command, not executable by this UI.
            // Never guess a user-custom installation path or operate on a DMG.
            let installed=Bundle.main.bundleURL.standardizedFileURL.path
            guard installed=="/Applications/ChatHand.app" else{
                done(["error_code":"F5_TARGET_NOT_VERIFIED"]);return
            }
            done(["command":"xattr -dr com.apple.quarantine /Applications/ChatHand.app",
                  "target":installed,"approved_source":"ChatHand installation help",
                  "executed":false,"user_must_run":true])
        case "openExternal":
            guard let raw=data["url"] as? String,let u=URL(string:raw),u.scheme=="https",u.user==nil,u.password==nil else{done(["error":"URL_INVALID"]);return}
            api("/api/native/state") { state in
                let snapshot=state["error"]==nil ? state:self.state
                let settings=snapshot["settings"] as? [String:Any] ?? [:]
                let missing=settings["chatgpt_app_missing"] as? [String:Any] ?? [:]
                if missing["reason"] as? String == "refresh_not_found",let detail=settings["chatgpt_app_detail_url"] as? String,raw==detail {done(["error":"CHATGPT_APP_MISSING"]);return}
                NSWorkspace.shared.open(u);done(["ok":true])
            }
        case "notifications":UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound,.badge]){allowed,error in DispatchQueue.main.async{done(["granted":allowed])}}
        case "configureTunnel":api("/api/connect",data,completion:done)
        case "restoreTunnel":api("/api/connect/restore",[:],completion:done)
        case "forgetTunnel":api("/api/tunnel/forget",[:],completion:done)
        case "saveDownload":
            guard let filename = data["filename"] as? String, filename.hasSuffix(".json"), !filename.hasPrefix("."), filename.count <= 120,
                  !filename.contains("/"), !filename.contains("\\"),
                  let text = data["text"] as? String, text.utf8.count <= 5_000_000 else { done(["error":"SAVE_INVALID"]); return }
            do {
                let folder = try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let temporary = folder.appendingPathComponent(".chathand-download-" + UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: temporary) }
                try Data(text.utf8).write(to: temporary, options: .atomic)
                let stem = String(filename.dropLast(5))
                var number = 1
                while true {
                    let name = number == 1 ? filename : stem + " \(number).json"
                    let target = folder.appendingPathComponent(name)
                    if FileManager.default.fileExists(atPath: target.path) { number += 1; continue }
                    do {
                        try FileManager.default.moveItem(at: temporary, to: target)
                        done(["saved":true,"name":name]); break
                    } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileWriteFileExistsError {
                        number += 1
                    }
                }
            } catch { done(["error":"SAVE_FAILED"]) }
        case "copyText":
            let text = data["text"] as? String ?? ""
            NSPasteboard.general.clearContents()
            let copied = NSPasteboard.general.setString(text,forType:.string)
            if copied { observeSitePrompt(text) }; done(["copied":copied])
        case "exportConfig":let node=packageURL.appendingPathComponent("bin/node").path,adapter=packageURL.appendingPathComponent("app/stdio.mjs").path
            let config:[String:Any]=["mcpServers":["chathand":["command":node,"args":[adapter]]]];let text=String(data:try! JSONSerialization.data(withJSONObject:config,options:.prettyPrinted),encoding:.utf8)!;NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string);done(["copied":true])
        default:done(["error":"NATIVE_ACTION_UNKNOWN"])
        }
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        guard let u=navigationAction.request.url else{decisionHandler(.cancel);return}
        if u.scheme=="http",u.host=="127.0.0.1",u.port==URL(string:origin)?.port {decisionHandler(.allow)}else{decisionHandler(.cancel)}
    }
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){showError("ChatHand",message);completionHandler()}
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){let a=NSAlert();a.messageText=LocalText.text("native.confirm.title");a.informativeText=message;a.addButton(withTitle:LocalText.text("native.button.confirm"));a.addButton(withTitle:LocalText.text("native.button.cancel"));completionHandler(a.runModal() == .alertFirstButtonReturn)}
}
if CommandLine.arguments.contains("--computer-status") { let d=try! JSONSerialization.data(withJSONObject:ComputerControl.status());print(String(data:d,encoding:.utf8)!);exit(0) }
if CommandLine.arguments.contains("--self-check") {
    let metadata:[String:Any] = ["version":BuildVersion.release,"runtime_api":BuildVersion.runtimeAPI,"bundle_id":BuildVersion.bundleID]
    let bytes=try! JSONSerialization.data(withJSONObject:metadata,options:[.sortedKeys])
    print(String(data:bytes,encoding:.utf8)!);exit(0)
}
let app=NSApplication.shared
let delegate=AppDelegate()
app.delegate=delegate
app.run()
