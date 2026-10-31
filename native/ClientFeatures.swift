import AppKit
import Foundation
import WebKit
import CoreFoundation

/// All native hooks run on the main thread. Tests inject every external action.
enum ClientFeatures {
    /// Automatic presentation never switches away from the user's current app.
    /// Explicit menu/Dock interaction retains normal window activation.
    static func shouldActivateWindow(userRequested: Bool, appIsActive: Bool, setupActivity: [String: Any]?, nowMS: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        if userRequested { return true }
        guard let activity = setupActivity else { return false }
        let last = (activity["last_at"] as? NSNumber)?.doubleValue ?? 0
        let configuring = activity["active"] as? Bool == true && last <= nowMS && nowMS - last < 900_000
        return appIsActive && !configuring
    }
    /// Lookup is injected so tests never open or activate a user's ChatGPT.
    static func activateChatGPT(find: () -> (() -> Bool)? = {
        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            !$0.isTerminated && $0.bundleIdentifier == "com.openai.chat"
        }) else { return nil }
        return { app.activate(options: []) }
    }) -> [String: Any] {
        guard let activate = find() else { return ["activated": false] }
        return ["activated": activate()]
    }
    static let uiZoomKey = "ChatHandUIZoom"
    static let uiZoomLevels: [Double] = [1, 1.125, 1.25, 1.375, 1.5]
    static func normalizedUIZoom(_ zoom: Double) -> Double? { uiZoomLevels.contains(zoom) ? zoom : nil }
    static func savedUIZoom(defaults: UserDefaults = .standard) -> Double {
        guard let number = defaults.object(forKey: uiZoomKey) as? NSNumber,
              let zoom = normalizedUIZoom(number.doubleValue) else { return 1.25 }
        return zoom
    }
    static func setUIZoom(zoom: Double, web: WKWebView, window: NSWindow, remember: Bool = true) {
        guard let factor = normalizedUIZoom(zoom) else { return }
        web.pageZoom = factor
        if remember { UserDefaults.standard.set(factor, forKey: uiZoomKey) }
        let visible = (window.screen ?? NSScreen.main)?.visibleFrame ?? window.frame
        let minimum = NSSize(width: min(980 * factor, visible.width), height: min(680 * factor, visible.height))
        window.contentMinSize = minimum
        let old = window.frame
        let required = window.frameRect(forContentRect: NSRect(origin: .zero, size: minimum)).size
        let width = min(visible.width, max(old.width, required.width))
        let height = min(visible.height, max(old.height, required.height))
        let x = max(visible.minX, min(old.minX, visible.maxX - width))
        let top = max(visible.minY + height, min(old.maxY, visible.maxY))
        let next = NSRect(x: x, y: top - height, width: width, height: height)
        if next != old { window.setFrame(next, display: true) }
        WindowChrome.place(window)
    }
    static func promptURL(_ prompt: String, work: Bool = false) -> URL? {
        guard prompt.utf8.count <= 16_384 else { return nil }
        var c = URLComponents()
        c.scheme = "https"; c.host = "chatgpt.com"; c.path = "/"
        var items = work ? [URLQueryItem(name: "surface", value: "work")] : []
        if !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            items.append(URLQueryItem(name: work ? "prompt" : "q", value: prompt))
        }
        if !items.isEmpty { c.queryItems = items }
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.url
    }
    struct ChatEnvironment {
        var openURL: (URL) -> Bool
        var copy: (String) -> Bool
        static var live: ChatEnvironment {
            let workspace = NSWorkspace.shared
            return ChatEnvironment(
                openURL: { workspace.open($0) },
                copy: { text in NSPasteboard.general.clearContents(); return NSPasteboard.general.setString(text, forType: .string) })
        }
    }
    static func openChatGPT(prompt: String, work: Bool = false, environment: ChatEnvironment = .live, completion: @escaping ([String: Any]) -> Void) {
        guard let url = promptURL(prompt, work: work) else { completion(["error_code": "CHATGPT_PROMPT_INVALID", "prefilled": false, "copied": false]); return }
        let hasPrompt = !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // These official web entry points were observed to fill without sending.
        // Dispatch alone cannot confirm what the destination UI did.
        if environment.openURL(url) {
            completion(["opened": "web", "prefilled": false, "prefill_requested": hasPrompt,
                        "mode": work ? "work" : "chat", "copied": false, "auto_sent": false])
        } else {
            let copied = hasPrompt && environment.copy(prompt)
            completion(["error_code": "CHATGPT_OPEN_FAILED", "prefilled": false,
                        "prefill_requested": false, "copied": copied, "auto_sent": false])
        }
    }
    static func appearanceName(_ mode: String) -> NSAppearance.Name? {
        switch mode { case "light": return .aqua; case "dark": return .darkAqua; default: return nil }
    }
    static func setAppearance(mode: String, window: NSWindow? = nil) -> [String: Any] {
        guard ["light", "dark", "system"].contains(mode) else { return ["error_code": "ARG_INVALID"] }
        let appearance = appearanceName(mode).flatMap { NSAppearance(named: $0) }
        NSApp.appearance = appearance; window?.appearance = appearance
        return ["mode": mode]
    }
    static func validRuntimeKey(_ text: String) -> Bool {
        guard let range = text.range(of: "^sk-[A-Za-z0-9_-]{17,}$", options: .regularExpression) else { return false }
        return range == text.startIndex..<text.endIndex
    }
}

/// Manual credential receipt has authenticated-window authority, not HID or
/// trusted-event authority. Every clipboard/API action is injected for tests.
enum NativeCredentialPaste {
    typealias Submit = ([String:Any], @escaping ([String:Any])->Void)->Void
    private static func flag(_ value:Any?) -> Bool {
        guard let number=value as? NSNumber,CFGetTypeID(number)==CFBooleanGetTypeID() else{return false}
        return number.boolValue
    }
    private static func error(_ response:[String:Any],allowed:Set<String>,fallback:String)->String {
        let raw=(response["error"] as? [String:Any])?["code"] as? String ?? response["error_code"] as? String
        return raw.flatMap {allowed.contains($0) ? $0:nil} ?? fallback
    }
    static func runtime(tunnelID:String,authorized:Bool,changeCount:@escaping ()->Int,read:@escaping ()->String?,clear:@escaping ()->Void,
                        submit:Submit,completion:@escaping ([String:Any])->Void) {
        func fail(_ code:String,_ legacy:String? = nil) {completion(["saved":false,"received":false,"clipboard_cleared":false,"error_code":legacy ?? code,"reason_code":code])}
        guard authorized else{fail("NATIVE_OWNER_AUTH_REQUIRED");return}
        guard tunnelID.range(of:"^tunnel_[A-Za-z0-9_-]{8,100}$",options:.regularExpression) != nil else{fail("TUNNEL_ID_INVALID");return}
        let count=changeCount()
        guard let key=read(),key.utf8.count<=8192,ClientFeatures.validRuntimeKey(key) else{fail("CLIPBOARD_NOT_A_KEY","CLIPBOARD_KEY_INVALID");return}
        submit(["tunnel_id":tunnelID,"api_key":key]) {response in
            guard flag(response["saved"]),flag(response["received"]),flag(response["storage_verified"]) else {
                let code=error(response,allowed:Set(["ARG_INVALID","KEY_INVALID","TUNNEL_ID_INVALID","TUNNEL_RUNTIME_MISSING","TUNNEL_NOT_FOUND","CREDENTIAL_BACKEND_UNSUPPORTED","CREDENTIAL_STORE_UNSAFE","CREDENTIAL_STORE_CORRUPT","CREDENTIAL_STORE_VERSION","CREDENTIAL_STORE_EXISTS","CREDENTIAL_BUSY","CREDENTIAL_CHANGED","CREDENTIAL_CONFLICT","CREDENTIAL_WRITE_VERIFY_FAILED","CREDENTIAL_SAVE_FAILED","KEY_SAVE_FAILED","LOCAL_AUTH_REQUIRED","UI_KEY_REQUIRED","LOCAL_NETWORK","SETUP_KEY_FAILED"]),fallback:"SETUP_KEY_FAILED")
                fail(code);return
            }
            let same=changeCount()==count && read()==key
            if same {clear()}
            let connected=flag(response["connected"])
            completion(["saved":true,"received":true,"storage_verified":true,"clipboard_cleared":same,"configured":flag(response["configured"]),"connected":connected,"reason_code":connected ? "KEY_SAVED":"KEY_SAVED_CONNECTION_PENDING"])
        }
    }
    private static func origin(_ value:Any?)->String? {
        guard let text=value as? String,text.utf8.count<=2048,let url=URLComponents(string:text),url.scheme=="https",url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,
              url.path.isEmpty || url.path=="/",let host=url.host,!host.isEmpty,url.url?.absoluteString==text else{return nil}
        return text.hasSuffix("/") ? String(text.dropLast()):text
    }
    static func site(authorized:Bool,changeCount:@escaping ()->Int,read:@escaping ()->String?,clear:@escaping ()->Void,
                     submit:Submit,completion:@escaping ([String:Any])->Void) {
        func fail(_ code:String,_ legacy:String? = nil) {completion(["accepted":false,"received":false,"clipboard_cleared":false,"error_code":legacy ?? code,"reason_code":code])}
        guard authorized else{fail("NATIVE_OWNER_AUTH_REQUIRED");return}
        let count=changeCount()
        guard let text=read(),text.utf8.count<=8192,let bytes=text.data(using:.utf8),let parsed=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any],let inputOrigin=origin(parsed["site_origin"]) else{fail("CLIPBOARD_NOT_A_KEY","B_CLIPBOARD_GRANT_INVALID");return}
        let legacy=Set(parsed.keys)==Set(["site_id","site_origin","enrollment_grant"]) && parsed["site_id"] is String && parsed["enrollment_grant"] is String
        guard legacy || ClipboardSiteWatcher.payload(text) != nil else{fail("CLIPBOARD_NOT_A_KEY","B_CLIPBOARD_GRANT_INVALID");return}
        submit(parsed) {response in
            guard flag(response["accepted"]) else{
                let code=error(response,allowed:Set(["B_GRANT_EXPIRED","B_ORIGIN_INVALID","B_PAIRING_INVALID","B_PAIRING_INPUT","B_PAIRING_INTENT_MISSING","B_PAIRING_ATTEMPT_EXPIRED","B_PAIRING_BINDING","B_PAIRING_BINDING_STALE","B_PAIRING_MISSING","B_PAIRING_SIGNATURE","B_PAIR_RECOVERY_PENDING","B_PAIR_RECOVERY_UNCONFIRMED","B_SITE_COMMIT_PENDING","B_SITE_TARGET_UNVERIFIED","B_SITE_TRANSPORT_UNAVAILABLE","B_TEMPLATE_MISMATCH","B_TEMPLATE_UNVERIFIED","LOCAL_AUTH_REQUIRED","UI_KEY_REQUIRED","LOCAL_NETWORK"]),fallback:"B_IMPORT_FAILED")
                fail(code);return
            }
            let phase=response["phase"] as? String ?? (legacy ? "awaiting_pairing":"")
            guard legacy ? phase=="awaiting_pairing" : ["pairing","credential_updated"].contains(phase),
                  let outputOrigin=origin(response["origin"] ?? (legacy ? parsed["site_origin"]:nil)),outputOrigin==inputOrigin else{fail("B_IMPORT_RESPONSE_INVALID");return}
            let same=changeCount()==count && read()==text
            if same {clear()}
            // Accepted is receipt, never proof that asynchronous pairing passed.
            completion(["accepted":true,"received":true,"clipboard_cleared":same,"reason_code":"CODE_ACCEPTED","phase":phase,"origin":outputOrigin])
        }
    }
}

/// No key in status, storage, diagnostics or process arguments. Only an in-memory
/// authenticated /api/setup/key body. Never bypass the OS paste permission prompt.
final class ClipboardKeyWatcher {
    typealias Submit = (String, String, @escaping ([String: Any]) -> Void) -> Void
    private let changeCount: () -> Int
    private let read: () -> String?
    private let clear: () -> Void
    private let submit: Submit
    private let now: () -> Date
    private let onState: ([String: Any]) -> Void
    private var timer: Timer?
    private var requestID: String?
    private var tunnelID = ""
    private var deadline = Date.distantPast
    private var lastCount = 0
    private var idleCount: Int?
    private var pending = false
    private(set) var active = false
    private(set) var received = false
    private(set) var last4: String?

    init(changeCount: @escaping () -> Int, read: @escaping () -> String?, clear: @escaping () -> Void,
         submit: @escaping Submit, now: @escaping () -> Date = Date.init, onState: @escaping ([String: Any]) -> Void = { _ in }) {
        self.changeCount = changeCount; self.read = read; self.clear = clear
        self.submit = submit; self.now = now; self.onState = onState
    }
    convenience init(submit: @escaping Submit, onState: @escaping ([String: Any]) -> Void = { _ in }) {
        self.init(changeCount: { NSPasteboard.general.changeCount }, read: { NSPasteboard.general.string(forType: .string) },
                  clear: { NSPasteboard.general.clearContents() }, submit: submit, onState: onState)
    }
    var status: [String: Any] { ["active": active, "received": received, "last4": last4 as Any? ?? NSNull()] }
    // Cache only changeCount while idle, so a fast copy between the UI request
    // and the next native poll is still recognized as a clipboard change.
    func observeClipboardCount() { if !active { idleCount = changeCount() } }
    /// Consume the UI-authenticated POST /api/setup/await-key/status response.
    /// A server success can arrive before the key API callback; keep that pending
    /// callback alive so it can clear the still-same clipboard.
    func synchronize(_ response: [String: Any]) {
        guard response["error"] == nil else { return }
        if let request = response["request"] as? [String: Any],
           let id = request["id"] as? String, let tunnel = request["tunnel_id"] as? String,
           let milliseconds = request["expires_at"] as? NSNumber {
            _ = start(tunnelID: tunnel, requestID: id, expiresAt: Date(timeIntervalSince1970: milliseconds.doubleValue / 1000))
        } else if response["received"] as? Bool != true { stop() }
    }
    @discardableResult func start(tunnelID: String, requestID: String, expiresAt: Date? = nil, schedule: Bool = true) -> Bool {
        guard tunnelID.range(of: "^tunnel_[A-Za-z0-9_-]{8,100}$", options: .regularExpression) != nil, !requestID.isEmpty else { return false }
        if self.requestID == requestID { return active }
        stop(); self.requestID = requestID; self.tunnelID = tunnelID
        deadline = min(expiresAt ?? now().addingTimeInterval(600), now().addingTimeInterval(600))
        guard deadline > now() else { self.requestID = nil; return false }
        lastCount = idleCount ?? changeCount(); idleCount = nil; pending = false; active = true; received = false; last4 = nil; onState(status)
        if schedule { timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() } }
        return true
    }
    func tick() {
        guard active else { return }
        if now() >= deadline { stop(); return }
        guard !pending else { return }
        let count = changeCount(); guard count != lastCount else { return }; lastCount = count
        guard let key = read(), ClientFeatures.validRuntimeKey(key) else { return }
        pending = true; let generation = requestID
        submit(tunnelID, key) { [weak self] response in
            guard let self = self, self.active, self.requestID == generation else { return }
            self.pending = false
            guard self.now() < self.deadline else { self.stop(); return }
            guard response["saved"] as? Bool == true else { return }
            // Never clear unrelated clipboard content written during the request.
            if self.changeCount() == count, self.read() == key { self.clear() }
            self.received = true; self.last4 = String(key.suffix(4)); self.stop()
        }
    }
    func stop() { timer?.invalidate(); timer = nil; active = false; pending = false; requestID = nil; tunnelID = ""; onState(status) }
    deinit { timer?.invalidate() }
}

/// Site credentials stay in native memory and go straight to the owner/UI
/// endpoint. A stopped or expired watch cannot clear a later clipboard copy.
final class ClipboardSiteWatcher {
    typealias Submit = (String, [String: Any], @escaping ([String: Any]) -> Void) -> Void
    private let changeCount: () -> Int
    private let read: () -> String?
    private let clear: () -> Void
    private let submit: Submit
    private let now: () -> Date
    private let diagnostic: (String, String, String?) -> Void
    private var timer: Timer?
    private var watchID: String?
    private var deadline = Date.distantPast
    private var lastCount = 0
    private var pending = false
    private var epoch = 0
    private(set) var active = false

    init(changeCount: @escaping () -> Int, read: @escaping () -> String?, clear: @escaping () -> Void,
         submit: @escaping Submit, now: @escaping () -> Date = Date.init,
         diagnostic: @escaping (String, String, String?) -> Void = { _,_,_ in }) {
        self.changeCount = changeCount; self.read = read; self.clear = clear; self.submit = submit; self.now = now
        self.lastCount = changeCount(); self.diagnostic = diagnostic
    }
    convenience init(submit: @escaping Submit, diagnostic: @escaping (String, String, String?) -> Void = { _,_,_ in }) {
        self.init(changeCount: { NSPasteboard.general.changeCount }, read: { NSPasteboard.general.string(forType: .string) },
                  clear: { NSPasteboard.general.clearContents() }, submit: submit, diagnostic: diagnostic)
    }
    static func payload(_ text: String) -> [String: Any]? {
        guard text.utf8.count <= 8192, let bytes = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              Set(object.keys) == Set(["format","site_origin","site_id","service_credential"]),
              object["format"] as? String == "chathand-site-v2",
              let siteID = object["site_id"] as? String,
              siteID.range(of: "^[A-Za-z0-9_-]{4,128}$", options: .regularExpression) != nil,
              let bearer = object["service_credential"] as? String,
              bearer.count >= 32 && bearer.count <= 4096,
              bearer.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              let origin = object["site_origin"] as? String,
              let url = URLComponents(string: origin), url.scheme == "https", url.user == nil,
              url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let host = url.host, host.hasSuffix(".chatgpt.site"),
              url.url?.absoluteString == origin else { return nil }
        return object
    }
    func synchronize(_ watch: [String: Any]?) {
        guard watch?["watching"] as? Bool == true,
              let id = watch?["watch_id"] as? String,
              let expires = watch?["expires_at"] as? NSNumber else {
            if watch?["stopped_id"] as? String == watchID {
                let reason = watch?["stopped_reason"] as? String ?? "stopped"
                stop(reason: reason == "paired" ? "WATCH_PAIRED" : reason == "expired" ? "WATCH_EXPIRED" : reason == "no_pending" ? "NO_PENDING" : "WATCH_STOPPED"); return
            }
            // The accepted import clears server watch state before its callback
            // reaches native code. Keep only that in-flight lease until callback.
            if pending && active && now() < deadline { return }
            stop(); return
        }
        _ = start(id: id, expiresAt: Date(timeIntervalSince1970: expires.doubleValue / 1000))
    }
    @discardableResult func start(id: String, expiresAt: Date, schedule: Bool = true) -> Bool {
        guard !id.isEmpty else { stop(); return false }
        if watchID == id {
            // The server renews this same watch only on real setup progress.
            // Its current expiry may extend or shorten the native timer lease.
            guard active, expiresAt > now() else { stop(reason: "WATCH_EXPIRED"); return false }
            deadline = expiresAt
            return true
        }
        stop(); watchID = id; deadline = expiresAt
        guard deadline > now() else { diagnostic("rejected", "WATCH_EXPIRED", nil); watchID = nil; return false }
        pending = false; active = true; diagnostic("started", "WATCH_STARTED", nil)
        if schedule { timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() } }
        return true
    }
    func observeClipboardCount() {
        if !active && !pending { lastCount = changeCount() }
    }
    func tick() {
        guard active else { return }
        if now() >= deadline { stop(reason: "WATCH_EXPIRED"); return }
        guard !pending else { return }
        let count = changeCount(); guard count != lastCount else { return }; lastCount = count
        guard let value = read() else { diagnostic("rejected", "INVALID_FORMAT", nil); return }
        guard let body = Self.payload(value) else {
            let parsed = value.data(using: .utf8).flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            let reason = parsed?["format"] as? String == "chathand-site-v2" && parsed?["site_origin"] is String ? "INVALID_ORIGIN" : "INVALID_FORMAT"
            diagnostic("rejected", reason, nil); return
        }
        guard let id = watchID else { diagnostic("rejected", "NO_PENDING", nil); return }
        pending = true; let currentEpoch = epoch
        submit(id, body) { [weak self] response in
            guard let self = self, self.active, self.epoch == currentEpoch, self.watchID == id else { return }
            self.pending = false
            guard self.now() < self.deadline else { self.stop(reason: "WATCH_EXPIRED"); return }
            guard response["accepted"] as? Bool == true else {
                let raw = (response["error"] as? [String: Any])?["code"] as? String ?? response["error_code"] as? String
                self.diagnostic("rejected", "PAIR_FAILED", raw); return
            }
            if self.changeCount() == count, self.read() == value { self.clear() }
            self.diagnostic("accepted", "CODE_ACCEPTED", nil)
            // The import accepted the code; asynchronous pairing is still pending.
            // A real server phase stays leased until its authoritative stop state.
            // The pre-phase local callback contract is retained without claiming paired.
            if response["phase"] == nil { self.stop(reason: "WATCH_STOPPED") }
        }
    }
    func stop(reason: String = "WATCH_STOPPED") { if active { diagnostic("stopped", reason, nil) }; timer?.invalidate(); timer = nil; active = false; pending = false; watchID = nil; epoch += 1 }
    deinit { timer?.invalidate() }
}

/// One owner for startup/poll appearance, authenticated watch requests and teardown.
/// Injected API/clipboard/appearance actions also exercise the production wiring.
final class ClientFeatureCoordinator {
    typealias API = (String, [String: Any], @escaping ([String: Any]) -> Void) -> Void
    private let api: API
    private let appearanceAPI: API
    private let appearanceNow: () -> Date
    let watcher: ClipboardKeyWatcher
    let siteWatcher: ClipboardSiteWatcher
    private let applyAppearance: (String) -> Void
    private let applyUIZoom: (Double) -> Void
    private var appearance: String?
    private var uiZoom: Double?
    private var watchPollInFlight = false
    private var closed = false
    private var generation = 0

    // Logical intent may expire while its physical write still owns the serial flight.
    private final class AppearanceWrite {
        let sequence: Int, generation: Int
        let mode: String, deadline: Date
        var completion: (([String: Any]) -> Void)?
        init(sequence: Int, generation: Int, mode: String, deadline: Date, completion: @escaping ([String: Any]) -> Void) {
            self.sequence = sequence; self.generation = generation; self.mode = mode; self.deadline = deadline; self.completion = completion
        }
        func finish(_ response: [String: Any]) { let done = completion; completion = nil; done?(response) }
    }
    private var appearanceSequence = 0
    private var appearanceQueued: AppearanceWrite?
    private var appearanceFlight: AppearanceWrite?

    init(api: @escaping API, appearanceAPI: API? = nil, appearanceNow: @escaping () -> Date = Date.init, watcher: ClipboardKeyWatcher? = nil, applyAppearance: @escaping (String) -> Void, applyUIZoom: @escaping (Double) -> Void = { _ in }) {
        self.api = api; self.appearanceAPI = appearanceAPI ?? api; self.appearanceNow = appearanceNow; self.applyAppearance = applyAppearance; self.applyUIZoom = applyUIZoom
        self.watcher = watcher ?? ClipboardKeyWatcher(submit: { tunnel, key, done in
            api("/api/setup/key", ["tunnel_id": tunnel, "api_key": key], done)
        })
        self.siteWatcher = ClipboardSiteWatcher(submit: { watchID, payload, done in
            api("/api/site-b/enrollment/watch/import", ["watch_id": watchID, "payload": payload], done)
        }, diagnostic: { phase, reason, code in
            var body: [String: Any] = ["phase": phase, "reason": reason]
            if let code { body["error_code"] = code }
            api("/api/site-b/enrollment/watch/event", body) { _ in }
        })
    }
    func synchronize(state: [String: Any]) {
        guard !closed else { return }
        guard state["error"] == nil else { serviceUnavailable(); return }
        siteWatcher.synchronize((state["site_b"] as? [String: Any])?["enrollment_watch"] as? [String: Any])
        siteWatcher.observeClipboardCount()
        let settings = state["settings"] as? [String: Any] ?? [:]
        let mode = settings["appearance"] as? String ?? "system"
        if !hasAppearanceIntent, ["light", "dark", "system"].contains(mode), appearance != mode {
            applyAppearance(mode); appearance = mode
        }
        let zoom = (settings["ui_zoom"] as? NSNumber)?.doubleValue ?? 1.25
        if ClientFeatures.normalizedUIZoom(zoom) != nil, uiZoom != zoom {
            applyUIZoom(zoom); uiZoom = zoom
        }
        let watch = (state["setup"] as? [String: Any])?["key_watch"] as? [String: Any] ?? [:]
        guard watch["active"] as? Bool == true || watcher.active else { watcher.observeClipboardCount(); return }
        guard !watchPollInFlight else { return }
        watchPollInFlight = true; let current = generation
        api("/api/setup/await-key/status", [:]) { [weak self] response in
            guard let self = self, !self.closed, current == self.generation else { return }
            self.watchPollInFlight = false
            if response["error"] != nil { self.watcher.stop(); return }
            self.watcher.synchronize(response)
        }
    }
    private var hasAppearanceIntent: Bool {
        [appearanceQueued, appearanceFlight].compactMap { $0 }.contains {
            $0.completion != nil && $0.sequence == appearanceSequence && $0.generation == generation && appearanceNow() < $0.deadline
        }
    }
    func setAppearance(mode: String, expiresAt: Date? = nil, completion: @escaping ([String: Any]) -> Void) {
        guard !closed, ["light", "dark", "system"].contains(mode) else { completion(["error_code": "ARG_INVALID"]); return }
        let now = appearanceNow(), deadline = min(expiresAt ?? now.addingTimeInterval(30), now.addingTimeInterval(30))
        guard deadline.timeIntervalSince1970.isFinite, now < deadline else { completion(["error_code": "NATIVE_TIMEOUT"]); return }
        appearanceSequence += 1
        let request = AppearanceWrite(sequence: appearanceSequence, generation: generation, mode: mode, deadline: deadline, completion: completion)
        let previous = appearanceQueued
        appearanceQueued = request
        previous?.finish(["superseded": true])
        appearanceFlight?.finish(["superseded": true, "delivery_unconfirmed": true])
        pumpAppearance()
    }
    private func pumpAppearance() {
        guard !closed, appearanceFlight == nil, let request = appearanceQueued else { return }
        appearanceQueued = nil
        guard request.sequence == appearanceSequence, request.generation == generation else { request.finish(["cancelled": true]); return }
        guard appearanceNow() < request.deadline else { request.finish(["error_code": "NATIVE_TIMEOUT"]); return }
        appearanceFlight = request
        appearanceAPI("/api/settings", ["appearance": request.mode]) { [weak self, request] response in
            guard let self, self.appearanceFlight === request else { return }
            // Only a real API completion releases the physical write barrier. A client
            // generation change says nothing about whether the server persisted it.
            self.appearanceFlight = nil
            if self.closed || request.generation != self.generation || response["cancelled"] as? Bool == true {
                request.finish(["cancelled": true, "delivery_unconfirmed": true])
            } else if request.sequence != self.appearanceSequence {
                request.finish(["superseded": true, "delivery_unconfirmed": true])
            } else if self.appearanceNow() >= request.deadline {
                request.finish(["error_code": "NATIVE_TIMEOUT", "delivery_unconfirmed": true])
            } else if response["error"] != nil || response["error_code"] != nil {
                request.finish(response)
            } else {
                self.applyAppearance(request.mode); self.appearance = request.mode
                request.finish(["mode": request.mode])
            }
            self.pumpAppearance()
        }
    }
    func serviceUnavailable() {
        generation += 1; watchPollInFlight = false; watcher.stop(); siteWatcher.stop()
        invalidateAppearance()
    }
    func invalidateAppearance() {
        appearanceSequence += 1
        let queued = appearanceQueued; appearanceQueued = nil
        queued?.finish(["cancelled": true])
        appearanceFlight?.finish(["cancelled": true, "delivery_unconfirmed": true])
    }
    func setUIZoom(zoom: Double, completion: @escaping ([String: Any]) -> Void) {
        guard !closed, ClientFeatures.normalizedUIZoom(zoom) != nil else { completion(["error_code": "ARG_INVALID"]); return }
        applyUIZoom(zoom); uiZoom = zoom
        api("/api/settings", ["ui_zoom": zoom]) { [weak self] response in
            guard let self = self, !self.closed else { completion(["error_code": "LOCAL_NETWORK"]); return }
            guard response["error"] == nil else { completion(response); return }
            completion(["zoom": zoom])
        }
    }
    func close() { closed = true; serviceUnavailable() }
}

/// Consume only completions written during this native client's lifetime.
/// The startup watermark also covers a completion arriving before the first poll.
struct SetupCompletionFocus {
    private let startedAtMS: Double
    private var lastFinished: Double = 0
    init(startedAtMS: Double = Date().timeIntervalSince1970 * 1000) { self.startedAtMS = startedAtMS }
    mutating func consume(_ activity: [String: Any]?, nowMS: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        let finished = (activity?["finished_at"] as? NSNumber)?.doubleValue ?? 0
        defer { if finished <= nowMS { lastFinished = max(lastFinished, finished) } }
        guard finished > lastFinished, finished >= startedAtMS, finished > 0, finished <= nowMS, nowMS - finished < 900_000,
              activity?["active"] as? Bool != true, let last = (activity?["last_at"] as? NSNumber)?.doubleValue, last <= finished else { return false }
        return true
    }
}
