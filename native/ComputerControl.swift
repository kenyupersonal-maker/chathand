import Cocoa
import ApplicationServices
import ScreenCaptureKit
import Vision

/// All AppKit/AX work enters through execute on the main queue. Tests exercise
/// only the pure rules below; they never execute, capture, post events or prompt.
final class ComputerControl {
    private static let controlLock = NSLock()
    private static var stopFlag = false
    private static var generation: UInt64 = 0
    static var stopped: Bool {
        get { controlLock.lock(); defer { controlLock.unlock() }; return stopFlag }
        set {
            controlLock.lock()
            stopFlag = newValue
            if newValue { generation &+= 1 }
            controlLock.unlock()
        }
    }
    /// main.swift must wire these to /api/computer/authorize and stopAutomation.
    /// A missing authorization hook fails closed before any mutating operation.
    static var authorizeRequest: ((String, @escaping (Bool) -> Void) -> Void)?
    static var onStop: (() -> Void)?
    static let eventTag: Int64 = 0x4348415448414E44

    struct AXEntry {
        let element: AXUIElement?
        let role: String
        let name: String
        let frame: CGRect
        let sensitive: Bool
        let source: String
    }
    struct AXSnapshot {
        let at: Date
        let bundle: String
        let pid: pid_t
        let window: AXUIElement?
        let windowToken: UInt64?
        let frame: CGRect
        let processStart: B2TargetClick.ProcessStart?
        let clickIdentity: B2TargetClick.Identity?
        var entries: [String: AXEntry]
        let text: String
        let title: String
        var interactionSurface: InteractionSurface? = nil
    }
    struct Target {
        let app: NSRunningApplication
        let window: AXUIElement
        let frame: CGRect
        var bundle: String { app.bundleIdentifier ?? "" }
        var windowID: String { "w\(axIdentity(window))" }
        var title: String { stringAttr(window, kAXTitleAttribute as String) ?? "" }
    }
    struct ControlFailure: Error {
        let code: String
        let message: String
        let uncertain: Bool
        let extraDetails: [String: Any]
        init(_ code: String, _ message: String, uncertain: Bool = false, details: [String: Any] = [:]) {
            self.code = code; self.message = message; self.uncertain = uncertain
            self.extraDetails = details
        }
        var payload: [String: Any] {
            var details = extraDetails
            details["delivery_unconfirmed"] = uncertain; details["do_not_replay"] = uncertain
            if uncertain { details["delivery_status"] = "posted_unconfirmed" }
            return ["code": code, "message": message,
             "recovery": ["automatic_retry": false, "next_action": "computer_observe"],
             "details": details]
        }
    }

    static let axLock = NSLock()
    static var axSnapshots: [String: AXSnapshot] = [:]
    static let interactiveRoles: Set<String> = [
        "AXButton","AXCheckBox","AXRadioButton","AXTextField","AXTextArea","AXComboBox",
        "AXPopUpButton","AXMenuButton","AXMenuItem","AXLink","AXSlider","AXDisclosureTriangle",
        "AXIncrementor","AXTabGroup","AXToolbarButton","AXRow","AXCell"
    ]

    static func appInfo(_ app: NSRunningApplication?) -> [String: Any] {
        guard let app else { return [:] }
        return ["bundle_id": app.bundleIdentifier ?? "", "name": app.localizedName ?? "",
                "pid": Int(app.processIdentifier)]
    }
    static func status() -> [String: Any] {
        ["screen_recording": CGPreflightScreenCaptureAccess(),
         "accessibility": AXIsProcessTrusted(), "accessibility_elements": true,
         "front_app": appInfo(NSWorkspace.shared.frontmostApplication),
         "background_ax": true, "target_window_capture": true, "stopped": stopped]
    }
    static func error(_ code: String, _ message: String) -> [String: Any] {
        ["error": ControlFailure(code, message).payload]
    }
    static func requestPermissions() {
        let a = NSAlert()
        a.messageText = LocalText.text("native.computer.permissionTitle")
        a.informativeText = LocalText.text("native.computer.permissionBody")
        a.addButton(withTitle: LocalText.text("native.computer.permissionOpen"))
        a.addButton(withTitle: LocalText.text("native.button.cancel"))
        guard a.runModal() == .alertFirstButtonReturn else { return }
        _ = CGRequestScreenCaptureAccess()
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    static func rawStringAttr(_ element: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
              let raw = value else { return nil }
        return raw as? String
    }
    static func stringAttr(_ element: AXUIElement, _ attr: String) -> String? {
        rawStringAttr(element, attr)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
              let raw = value else { return nil }
        return (raw as? NSNumber)?.boolValue
    }
    static func elementsAttr(_ element: AXUIElement, _ attr: String) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
              let raw = value else { return [] }
        return raw as? [AXUIElement] ?? []
    }
    static func children(_ element: AXUIElement) -> [AXUIElement] {
        elementsAttr(element, kAXChildrenAttribute as String)
    }
    static func elementAttr(_ element: AXUIElement, _ attr: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(raw, to: AXUIElement.self)
    }
    static func pointAttr(_ element: AXUIElement, _ attr: CFString) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let ax = unsafeBitCast(raw, to: AXValue.self)
        var point = CGPoint.zero
        return AXValueGetValue(ax, .cgPoint, &point) ? point : nil
    }
    static func sizeAttr(_ element: AXUIElement, _ attr: CFString) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr, &value) == .success,
              let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let ax = unsafeBitCast(raw, to: AXValue.self)
        var size = CGSize.zero
        return AXValueGetValue(ax, .cgSize, &size) ? size : nil
    }
    static func elementFrame(_ element: AXUIElement) -> CGRect? {
        guard let p = pointAttr(element, kAXPositionAttribute as CFString),
              let s = sizeAttr(element, kAXSizeAttribute as CFString),
              s.width > 0, s.height > 0, s.width.isFinite, s.height.isFinite,
              p.x.isFinite, p.y.isFinite else { return nil }
        return CGRect(origin: p, size: s)
    }
    static func axIdentity(_ element: AXUIElement) -> UInt64 { UInt64(bitPattern: Int64(CFHash(element))) }
    static func focusedWindow(_ app: NSRunningApplication) -> AXUIElement? {
        elementAttr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedWindowAttribute as String)
    }
    static func sameWindow(_ first: AXUIElement?, _ second: AXUIElement?) -> Bool {
        if let first, let second { return CFEqual(first, second) }
        return first == nil && second == nil
    }
    static func windows(_ app: NSRunningApplication) -> [AXUIElement] {
        elementsAttr(AXUIElementCreateApplication(app.processIdentifier), kAXWindowsAttribute as String)
    }
    // 1047: a parent AXWindow and its attached AXSheet are different AX objects.
    // Keep the parent as the capture/revalidation identity, and pin the exact
    // observed input surface separately. Never broaden sameWindow/B2 eligibility.
    struct SurfaceNodeFacts {
        let id: UInt64
        let pid: pid_t
        let role: String
        let parentID: UInt64?
        let windowID: UInt64?
        let frame: CGRect
    }
    struct InteractionSurface {
        let elements: [AXUIElement] // root window, then zero to four attached sheets
        let facts: [SurfaceNodeFacts]
        let processStart: B2TargetClick.ProcessStart
        var element: AXUIElement { elements[elements.count-1] }
        var frame: CGRect { facts[facts.count-1].frame }
        var isSheet: Bool { elements.count > 1 }
    }
    static func validSurfaceChain(_ nodes: [SurfaceNodeFacts], pid: pid_t) -> Bool {
        guard pid > 0, !nodes.isEmpty, nodes.count <= 5,
              let root = nodes.first, root.role == "AXWindow",
              Set(nodes.map { $0.id }).count == nodes.count else { return false }
        for (index, node) in nodes.enumerated() {
            let f = node.frame
            guard node.pid == pid, f.minX.isFinite, f.minY.isFinite,
                  f.width.isFinite, f.height.isFinite, f.width > 0, f.height > 0 else { return false }
            if index > 0 {
                guard node.role == "AXSheet", node.parentID == nodes[index-1].id,
                      node.windowID == root.id,
                      root.frame.insetBy(dx: -4, dy: -4).contains(f) else { return false }
            }
        }
        return true
    }
    static func strictElementArray(_ e: AXUIElement, _ key: String) -> [AXUIElement]? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &raw) == .success,
              let raw else { return nil }
        return raw as? [AXUIElement]
    }
    static func directSheetIndices(_ childRoles: [String?]?) -> [Int]? {
        guard let childRoles, childRoles.allSatisfy({ $0 != nil }) else { return nil }
        return childRoles.indices.filter { childRoles[$0] == "AXSheet" }
    }
    static func directSheets(_ e: AXUIElement) -> [AXUIElement]? {
        // A failed AXSheets read is NOT evidence of absence. A successful
        // AXChildren read is required; positive AXSheets entries are checked too.
        guard let children = strictElementArray(e, kAXChildrenAttribute as String) else { return nil }
        guard let indices = directSheetIndices(children.map { stringAttr($0, kAXRoleAttribute as String) }) else { return nil }
        var sheets = indices.map { children[$0] }
        if let advertised = strictElementArray(e, "AXSheets") {
            for sheet in advertised where !sheets.contains(where: { CFEqual($0, sheet) }) {
                sheets.append(sheet)
            }
        }
        return sheets
    }
    static func captureInteractionSurface(_ target: Target) -> InteractionSurface? {
        let pid = target.app.processIdentifier
        guard !target.app.isTerminated, let start = B2TargetClick.processStart(pid),
              stringAttr(target.window, kAXRoleAttribute as String) == "AXWindow",
              let rootFrame = elementFrame(target.window), framesMatch(rootFrame, target.frame) else { return nil }
        var elements = [target.window]
        var facts: [SurfaceNodeFacts] = []
        for depth in 0..<5 {
            let current = elements[elements.count-1]
            var owner: pid_t = 0
            guard AXUIElementGetPid(current, &owner) == .success, owner == pid,
                  let frame = elementFrame(current), let role = stringAttr(current, kAXRoleAttribute as String) else { return nil }
            let parent = elementAttr(current, kAXParentAttribute as String)
            let ownerWindow = elementAttr(current, kAXWindowAttribute as String)
            if depth > 0 {
                // Positive, bidirectional ownership, not title/role coincidence.
                guard let parent, CFEqual(parent, elements[depth-1]),
                      let ownerWindow, CFEqual(ownerWindow, target.window) else { return nil }
            }
            facts.append(SurfaceNodeFacts(id: axIdentity(current), pid: owner, role: role,
                parentID: parent.map { axIdentity($0) }, windowID: ownerWindow.map { axIdentity($0) }, frame: frame))
            guard let sheets = directSheets(current), sheets.count <= 1 else { return nil }
            if sheets.isEmpty {
                guard validSurfaceChain(facts, pid: pid) else { return nil }
                return InteractionSurface(elements: elements, facts: facts, processStart: start)
            }
            guard depth < 4, let sheet = sheets.first,
                  !elements.contains(where: { CFEqual($0, sheet) }) else { return nil }
            elements.append(sheet)
        }
        return nil
    }
    static func sameInteractionSurface(_ first: InteractionSurface, _ second: InteractionSurface) -> Bool {
        guard first.processStart == second.processStart,
              first.elements.count == second.elements.count else { return false }
        for index in first.elements.indices {
            guard CFEqual(first.elements[index], second.elements[index]),
                  first.facts[index].pid == second.facts[index].pid,
                  framesMatch(first.facts[index].frame, second.facts[index].frame) else { return false }
        }
        return true
    }
    static func interactionSurfaceCurrent(_ surface: InteractionSurface, target: Target) -> Bool {
        guard !target.app.isTerminated,
              windows(target.app).contains(where: { CFEqual($0, target.window) }),
              let live = captureInteractionSurface(target) else { return false }
        return sameInteractionSurface(surface, live)
    }
    static func elementBelongsToSurface(_ element: AXUIElement, surface: InteractionSurface, pid: pid_t) -> Bool {
        var current: AXUIElement? = element
        var seen: [AXUIElement] = []
        for _ in 0..<32 {
            guard let e = current, !seen.contains(where: { CFEqual($0, e) }) else { return false }
            var owner: pid_t = 0
            guard AXUIElementGetPid(e, &owner) == .success, owner == pid else { return false }
            if CFEqual(e, surface.element) { return true }
            seen.append(e); current = elementAttr(e, kAXParentAttribute as String)
        }
        return false
    }
    static func foregroundSurfaceProblem(targetPID: pid_t?, frontPID: pid_t?,
                                         surfaceCurrent: Bool, focusMatches: Bool) -> String? {
        guard let targetPID, targetPID > 0, frontPID == targetPID else { return "front_app_changed" }
        guard surfaceCurrent else { return "surface_changed" }
        return focusMatches ? nil : "focused_surface_changed"
    }
    static func foregroundFailure(_ code: String, _ message: String, attempted: Int,
                                   reason: String? = nil, details: [String: Any] = [:]) -> ControlFailure {
        var d = details
        d["foreground_input_events"] = max(0, min(100000, attempted))
        if let reason { d["focus_reason"] = reason }
        return ControlFailure(code, message, uncertain: attempted > 0, details: d)
    }

    static func windowContextProblem(expectedBundle: String, expectedPID: pid_t,
                                     expectedWindowToken: UInt64?, actualBundle: String,
                                     actualPID: pid_t, actualWindowToken: UInt64?) -> String? {
        expectedBundle == actualBundle && expectedPID == actualPID &&
        expectedWindowToken == actualWindowToken ? nil : "COMPUTER_WINDOW_STALE"
    }
    static func framesMatch(_ first: CGRect, _ second: CGRect, tolerance: CGFloat = 4) -> Bool {
        abs(first.minX-second.minX) <= tolerance && abs(first.minY-second.minY) <= tolerance &&
        abs(first.width-second.width) <= tolerance && abs(first.height-second.height) <= tolerance
    }
    static func imageRect(_ frame: CGRect, window: CGRect, width: Int, height: Int) -> CGRect {
        CGRect(x: (frame.minX-window.minX)/window.width*CGFloat(width),
               y: (frame.minY-window.minY)/window.height*CGFloat(height),
               width: frame.width/window.width*CGFloat(width), height: frame.height/window.height*CGFloat(height))
    }
    static func ocrRect(_ normalized: CGRect, window: CGRect) -> CGRect {
        CGRect(x: window.minX+normalized.minX*window.width,
               y: window.minY+(1-normalized.maxY)*window.height,
               width: normalized.width*window.width, height: normalized.height*window.height)
    }
    static func frameInfo(_ frame: CGRect) -> [String: Any] {
        ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
    }
    static func requestIsCurrent(token: UInt64, liveGeneration: UInt64, stopped: Bool,
                                 deadline: TimeInterval, now: TimeInterval) -> Bool {
        !stopped && token == liveGeneration && deadline > now
    }
    static func shouldRestoreForeground(targetPID: pid_t?, currentPID: pid_t?,
                                        targetWindowToken: UInt64?, currentWindowToken: UInt64?,
                                        originalAvailable: Bool, usedForeground: Bool) -> Bool {
        usedForeground && originalAvailable && targetPID != nil && targetPID == currentPID &&
        targetWindowToken != nil && targetWindowToken == currentWindowToken
    }
    static func inputAllowedForBundle(_ bundle: String, selfBundleID: String?) -> Bool {
        !["com.kenyu.chathand","com.kenyu.kenbridge","com.apple.notificationcenterui"].contains(bundle) && (selfBundleID == nil || bundle != selfBundleID)
    }
    static func chatGPTAllowedForBundle(_ bundle: String, allowed: Bool) -> Bool {
        !["com.openai.codex", "com.openai.chat"].contains(bundle) || allowed
    }
    static func checkChatGPT(_ bundle: String, _ args: [String:Any]) throws {
        guard chatGPTAllowedForBundle(bundle, allowed: args["chatgpt_self_allowed"] as? Bool == true) else {
            throw ControlFailure("HIGH_RISK_DISABLED", LocalText.text("native.computer.selfRisk"), details:["id":"chatgpt_self"])
        }
    }
    static func elementName(_ element: AXUIElement) -> String {
        for attr in [kAXTitleAttribute as String, kAXDescriptionAttribute as String, "AXPlaceholderValue",
                     kAXHelpAttribute as String, "AXIdentifier"] {
            if let value = stringAttr(element, attr), !value.isEmpty { return String(value.prefix(180)) }
        }
        return ""
    }
    static func sensitiveName(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["password","passcode","one-time","otp","密码","验证码","助记词","private key","verification code"].contains { lower.contains($0) }
    }
    static func isSensitive(_ element: AXUIElement, name: String) -> Bool {
        stringAttr(element, kAXSubroleAttribute as String) == "AXSecureTextField" ||
        stringAttr(element, kAXRoleAttribute as String) == "AXSecureTextField" || sensitiveName(name)
    }
    static func consequentialName(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["submit","send","pay","purchase","buy now","checkout","sign in","log in","delete",
                "提交","发送","付款","支付","购买","下单","登录","登入","删除","卸载"].contains { lower.contains($0) }
    }
    // Pure facts contain AX metadata only: never read a secure field's value.
    struct SettingsNodeFacts {
        var role: String = ""
        var subrole: String = ""
        var name: String = ""
        var identifier: String = ""
        var selected: Bool = false
        var children: [SettingsNodeFacts] = []
        var secure: Bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }
        var navigation: Bool {
            ["AXOutline", "AXList", "AXTable"].contains(role) || subrole == "AXSidebar" ||
            ["sidebar", "navigation"].contains { identifier.lowercased().contains($0) }
        }
    }
    static func passwordPageName(_ value: String) -> Bool {
        let lower = value.lowercased()
        return ["密码", "密碼", "password", "touch id", "touchid"].contains { lower.contains($0) }
    }
    static func selectedPasswordPage(_ node: SettingsNodeFacts, inNavigation: Bool = false,
                                     selectedNavigation: Bool = false) -> Bool {
        let navigation = inNavigation || node.navigation
        let selected = selectedNavigation || (navigation && !node.navigation && node.selected)
        // Only a selected navigation item's metadata, or an actual content heading,
        // can identify the page. Unselected sidebar labels are never page evidence.
        let heading = !navigation && (node.role == "AXHeading" || node.subrole == "AXHeading")
        if (selected || heading) && (passwordPageName(node.name) || passwordPageName(node.identifier)) { return true }
        return node.children.contains { selectedPasswordPage($0, inNavigation: navigation, selectedNavigation: selected) }
    }
    static func hasSecureField(_ node: SettingsNodeFacts) -> Bool {
        node.secure || node.children.contains { hasSecureField($0) }
    }
    static func securityProblem(bundle: String, title: String, settings: SettingsNodeFacts? = nil,
                                targetSecure: Bool = false, focusedSecure: Bool = false,
                                currentSheetSecure: Bool = false) -> Bool {
        if ["com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.LocalAuthentication.UIAgent"].contains(bundle) { return true }
        guard bundle == "com.apple.systempreferences" else { return false }
        return passwordPageName(title) || settings.map { selectedPasswordPage($0) } == true ||
               targetSecure || focusedSecure || currentSheetSecure
    }
    static func settingsFacts(_ root: AXUIElement) -> SettingsNodeFacts {
        var remaining = 700
        var seen = Set<UInt64>()
        func read(_ element: AXUIElement, depth: Int, selected: Bool = false) -> SettingsNodeFacts {
            guard depth <= 16, remaining > 0, seen.insert(axIdentity(element)).inserted else { return SettingsNodeFacts() }
            remaining -= 1
            let selectedChildren = elementsAttr(element, "AXSelectedChildren") + elementsAttr(element, "AXSelectedRows")
            return SettingsNodeFacts(role: stringAttr(element, kAXRoleAttribute as String) ?? "",
                subrole: stringAttr(element, kAXSubroleAttribute as String) ?? "",
                name: elementName(element), identifier: stringAttr(element, "AXIdentifier") ?? "",
                selected: selected || boolAttr(element, "AXSelected") == true,
                children: children(element).prefix(remaining).map { child in
                    read(child, depth: depth + 1, selected: selectedChildren.contains { CFEqual($0, child) })
                })
        }
        return read(root, depth: 0)
    }
    static func isSecureRole(_ element: AXUIElement) -> Bool {
        stringAttr(element, kAXRoleAttribute as String) == "AXSecureTextField" ||
        stringAttr(element, kAXSubroleAttribute as String) == "AXSecureTextField"
    }
    static func securityProblem(_ target: Target, element: AXUIElement? = nil) -> Bool {
        guard target.bundle == "com.apple.systempreferences" else {
            return securityProblem(bundle: target.bundle, title: target.title)
        }
        let surface = captureInteractionSurface(target)
        let focused = elementAttr(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedUIElementAttribute as String)
        let focusedSecure = focused.map { focus in
            isSecureRole(focus) && (surface.map { elementBelongsToSurface(focus, surface: $0, pid: target.app.processIdentifier) } ??
                sameWindow(elementAttr(focus, kAXWindowAttribute as String), target.window))
        } ?? false
        return securityProblem(bundle: target.bundle, title: target.title, settings: settingsFacts(target.window),
            targetSecure: element.map { isSecureRole($0) } ?? false, focusedSecure: focusedSecure,
            currentSheetSecure: surface.map { $0.isSheet && hasSecureField(settingsFacts($0.element)) } ?? false)
    }
    static func checkSystemPassword(_ target: Target, element: AXUIElement? = nil) throws {
        guard !securityProblem(target, element: element) else {
            throw ControlFailure("LOCAL_USER_REQUIRED", LocalText.text("native.computer.systemConfirmation"))
        }
    }

    static func target(_ args: [String: Any]) throws -> Target {
        guard AXIsProcessTrusted() else { throw ControlFailure("ACCESSIBILITY_REQUIRED", LocalText.text("native.computer.accessibility")) }
        let app: NSRunningApplication?
        if let bundle = args["bundle_id"] as? String {
            let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated && $0.activationPolicy == .regular }
            if let id = args["window_id"] as? String {
                let exact = candidates.filter { running in windows(running).contains { "w\(axIdentity($0))" == id } }
                guard exact.count <= 1 else {
                    throw ControlFailure("COMPUTER_WINDOW_AMBIGUOUS", LocalText.text("native.computer.windowAmbiguous"))
                }
                app = exact.first
            } else { app = candidates.first }
        } else { app = NSWorkspace.shared.frontmostApplication }
        guard let app, !app.isTerminated, app.bundleIdentifier != nil else {
            throw ControlFailure("APP_NOT_AVAILABLE", LocalText.text("native.computer.appMissing"))
        }
        try checkChatGPT(app.bundleIdentifier ?? "", args)
        let available = windows(app)
        let window: AXUIElement?
        if let id = args["window_id"] as? String {
            window = available.first { "w\(axIdentity($0))" == id }
        } else {
            window = focusedWindow(app) ?? (available.count == 1 ? available.first : nil)
        }
        guard let window, available.contains(where: { CFEqual($0, window) }),
              boolAttr(window, kAXMinimizedAttribute as String) != true,
              let frame = elementFrame(window) else {
            throw ControlFailure("COMPUTER_WINDOW_MISSING", LocalText.text("native.computer.windowMissing"))
        }
        let result = Target(app: app, window: window, frame: frame)
        if let requested = args["display_id"] as? NSNumber {
            guard NSScreen.screens.contains(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == requested.uint32Value }) else {
                throw ControlFailure("DISPLAY_MISSING", LocalText.text("native.computer.displayMissing"))
            }
            guard CGDisplayBounds(requested.uint32Value).intersects(frame) else {
                throw ControlFailure("COMPUTER_WINDOW_MISSING", LocalText.text("native.computer.displayMismatch"))
            }
        }
        guard !available.contains(where: { !CFEqual($0, window) && boolAttr($0, "AXModal") == true }) else {
            throw ControlFailure("COMPUTER_WINDOW_STALE", LocalText.text("native.computer.modalChanged"))
        }
        guard !securityProblem(result) else {
            throw ControlFailure("LOCAL_USER_REQUIRED", LocalText.text("native.computer.systemConfirmation"))
        }
        return result
    }
    static func listWindows() -> [[String: Any]] {
        guard AXIsProcessTrusted() else { return [] }
        var result: [[String: Any]] = []
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
            for window in windows(app) {
                guard result.count < 160, let frame = elementFrame(window) else { continue }
                result.append(["window_id": "w\(axIdentity(window))", "bundle_id": app.bundleIdentifier ?? "",
                               "pid": Int(app.processIdentifier), "title": String((stringAttr(window, kAXTitleAttribute as String) ?? "").prefix(180)),
                               "frame": frameInfo(frame), "minimized": boolAttr(window, kAXMinimizedAttribute as String) ?? false,
                               "active": app.isActive])
            }
        }
        return result
    }

    static func observe(_ target: Target, maxNodes: Int = 700, pixelWidth: Int? = nil,
                        pixelHeight: Int? = nil, includeWindows: Bool = true,
                        capturedIdentity: B2TargetClick.Identity? = nil,
                        capturingScreenshot: Bool = false) throws -> [String: Any] {
        let processStart = B2TargetClick.processStart(target.app.processIdentifier)
        let interactionSurface = captureInteractionSurface(target)
        let liveIdentity = B2TargetClick.snapshotIdentity(target)
        let clickIdentity = capturingScreenshot ? capturedIdentity : liveIdentity
        if let capturedIdentity, liveIdentity != capturedIdentity {
            throw ControlFailure("TARGET_CHANGED", LocalText.text("native.computer.observeChanged"))
        }
        guard let liveFrame = elementFrame(target.window), framesMatch(target.frame, liveFrame),
              !target.app.isTerminated, windows(target.app).contains(where: { CFEqual($0, target.window) }) else {
            throw ControlFailure("COMPUTER_WINDOW_STALE", LocalText.text("native.computer.windowChanged"))
        }
        let width = pixelWidth ?? max(1, Int(target.frame.width)), height = pixelHeight ?? max(1, Int(target.frame.height))
        var entries: [String: AXEntry] = [:], publicElements: [[String: Any]] = [], lines: [String] = []
        var visited = 0, totalText = 0, truncated = false
        var seen = Set<UInt64>()
        func walk(_ element: AXUIElement, depth: Int) {
            if visited >= maxNodes || depth > 14 || totalText >= 14000 { truncated = true; return }
            let identity = axIdentity(element)
            guard !seen.contains(identity) else { return }; seen.insert(identity); visited += 1
            let role = stringAttr(element, kAXRoleAttribute as String) ?? "AXUnknown"
            let name = elementName(element), sensitive = isSensitive(element, name: name)
            let interactive = interactiveRoles.contains(role)
            let value = sensitive ? "" : String((rawStringAttr(element, kAXValueAttribute as String) ?? "").prefix(1200))
            let readable = role == "AXStaticText" ? (value.isEmpty ? name : value) : value
            if interactive || role == "AXStaticText" || !name.isEmpty || !readable.isEmpty {
                var ref = ""
                if let frame = elementFrame(element), frame.intersects(target.frame) {
                    ref = "a\(entries.count+1)"
                    entries[ref] = AXEntry(element: element, role: role, name: name, frame: frame, sensitive: sensitive, source: "ax")
                    let publicFrame = imageRect(frame, window: target.frame, width: width, height: height)
                    publicElements.append(["ref": ref, "role": role, "name": sensitive ? "" : name,
                                           "value": value, "text": sensitive ? "" : readable, "source": "ax",
                                           "interactive": interactive, "enabled": boolAttr(element, kAXEnabledAttribute as String) ?? true,
                                           "sensitive": sensitive, "consequential": consequentialName(name), "frame": frameInfo(publicFrame)])
                }
                let line = String(repeating: "  ", count: min(depth,8)) + "\(ref.isEmpty ? "" : "[\(ref)] ")\(role) \(sensitive ? "[安全输入框]" : name) \(readable)"
                let bounded = String(line.prefix(max(0, 14000-totalText)))
                lines.append(bounded); totalText += bounded.count
            }
            for child in children(element) { walk(child, depth: depth+1) }
        }
        walk(target.window, depth: 0)
        guard let after = elementFrame(target.window), framesMatch(target.frame, after),
              B2TargetClick.processStart(target.app.processIdentifier) == processStart,
              clickIdentity == nil || B2TargetClick.snapshotIdentity(target) == clickIdentity else {
            throw ControlFailure("COMPUTER_WINDOW_STALE", LocalText.text("native.computer.readTreeMoved"))
        }
        let tree = lines.joined(separator: "\n"), id = UUID().uuidString
        let snapshot = AXSnapshot(at: Date(), bundle: target.bundle, pid: target.app.processIdentifier,
                                  window: target.window, windowToken: axIdentity(target.window), frame: target.frame,
                                  processStart: processStart, clickIdentity: clickIdentity,
                                  entries: entries, text: tree, title: target.title,
                                  interactionSurface: interactionSurface.flatMap { captured in
                                      guard let live = captureInteractionSurface(target), sameInteractionSurface(captured, live) else { return nil }
                                      return captured
                                  })
        axLock.lock()
        axSnapshots = axSnapshots.filter { Date().timeIntervalSince($0.value.at) < 30 }
        axSnapshots[id] = snapshot
        if axSnapshots.count > 20, let oldest = axSnapshots.min(by: { $0.value.at < $1.value.at })?.key { axSnapshots.removeValue(forKey: oldest) }
        axLock.unlock()
        var payload: [String: Any] = [
            "native_snapshot_id": id, "target_bundle": target.bundle, "target_pid": Int(target.app.processIdentifier),
            "front_bundle": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "", "front_app": appInfo(NSWorkspace.shared.frontmostApplication),
            "window_id": target.windowID, "window_title": target.title, "frame": frameInfo(target.frame),
            "elements": publicElements, "tree": tree, "text": String(publicElements.compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n").prefix(14000)),
            "truncated": truncated, "ttlMs": 0, "cacheScope": "private", "untrusted_content": true
        ]
        if includeWindows { payload["windows"] = listWindows() }
        if let clickIdentity {
            payload["target_cg_window_id"] = Int(clickIdentity.windowID)
            payload["target_process_start"] = ["seconds": clickIdentity.start.seconds, "microseconds": clickIdentity.start.microseconds,
                                               "source": "proc_pidinfo_PROC_PIDTBSDINFO"]
        }
        return payload
    }
    static func lookupSnapshot(snapshotID: String, bundle: String, pid: pid_t) -> AXSnapshot? {
        axLock.lock(); defer { axLock.unlock() }
        guard let snap = axSnapshots[snapshotID], snap.bundle == bundle, snap.pid == pid,
              Date().timeIntervalSince(snap.at) < 30 else {
            axSnapshots.removeValue(forKey: snapshotID); return nil
        }
        return snap
    }
    static func invalidateSnapshot(_ id: String?) {
        guard let id else { return }; axLock.lock(); axSnapshots.removeValue(forKey: id); axLock.unlock()
    }
    static func elementProblem(expectedRole: String, expectedName: String, liveRole: String?, liveName: String,
                               enabled: Bool?, frame: CGRect?) -> String? {
        guard liveRole == expectedRole, liveName == expectedName, let frame,
              frame.origin.x.isFinite, frame.origin.y.isFinite, frame.width.isFinite, frame.height.isFinite,
              frame.width > 0, frame.height > 0 else { return "COMPUTER_ELEMENT_STALE" }
        return enabled == false ? "COMPUTER_ELEMENT_DISABLED" : nil
    }
    enum SemanticPressResult { case unavailable, performed, unconfirmed }
    static func semanticPress(supported: Bool, perform: () -> AXError) -> SemanticPressResult {
        guard supported else { return .unavailable }
        // Never fall back to coordinates once AXPress has been attempted.
        return perform() == .success ? .performed : .unconfirmed
    }
    enum AXTextResult { case unavailable, verified, unconfirmed }
    static func verifyTextReadback(sensitive: Bool, read: () -> String?, expected: String) throws {
        // Dispatched secure input stays uncertain; never request its value.
        guard !sensitive, read() == expected else {
            throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.textDispatchedUnknown"), uncertain: true)
        }
    }
    static func axTextResult(settable: Bool, sensitive: Bool = false, set: () -> AXError, read: () -> String?, expected: String) -> AXTextResult {
        guard settable else { return .unavailable }
        guard set() == .success else { return .unconfirmed }
        // A secure value is never read back. A posted write remains uncertain and is not replayed.
        do {
            try verifyTextReadback(sensitive: sensitive, read: read, expected: expected)
            return .verified
        } catch { return .unconfirmed }
    }

    struct CaptureWindowFacts {
        let id: CGWindowID
        let pid: pid_t?
        let layer: Int
        let frame: CGRect
        let title: String?
    }
    /// AX and ScreenCaptureKit may display different titles for the SAME Chrome
    /// window (AX appends " - Google Chrome"). A proven CG ID is the identity;
    /// a title must never redirect an exact-ID capture to another window.
    static func captureWindowMatches(_ window: CaptureWindowFacts, targetPID: pid_t,
                                     targetFrame: CGRect, targetTitle: String,
                                     identity: B2TargetClick.Identity?) -> Bool {
        if let identity {
            return identity.pid == targetPID && identity.frame == targetFrame &&
                   window.id == identity.windowID && window.pid == identity.pid &&
                   window.layer == 0 && window.frame == identity.frame
        }
        // Without exact identity preserve the existing strict title and bounded
        // frame heuristic; do not admit a Chrome suffix or alternate window.
        return window.pid == targetPID && window.layer == 0 &&
               framesMatch(window.frame, targetFrame, tolerance: 8) &&
               (window.title == nil || window.title!.isEmpty || window.title == targetTitle)
    }
    static func captureSelectionProblem(count: Int, identityKnown: Bool) -> String? {
        count == 1 ? nil : identityKnown ? "TARGET_CHANGED" : count == 0 ? "COMPUTER_WINDOW_MISSING" : "COMPUTER_WINDOW_AMBIGUOUS"
    }
    static func matchingCaptureWindows(_ candidates: [SCWindow], target: Target,
                                       identity: B2TargetClick.Identity? = nil) -> [SCWindow] {
        candidates.filter { window in
            captureWindowMatches(CaptureWindowFacts(id: window.windowID, pid: window.owningApplication?.processID,
                                                   layer: window.windowLayer, frame: window.frame, title: window.title),
                                 targetPID: target.app.processIdentifier, targetFrame: target.frame,
                                 targetTitle: target.title, identity: identity)
        }
    }
    @MainActor static func captureImage(_ target: Target) async throws -> CGImage {
        try await captureImageWithIdentity(target).0
    }
    @MainActor static func captureImageWithIdentity(_ target: Target) async throws -> (CGImage, B2TargetClick.Identity?) {
        let identity = B2TargetClick.snapshotIdentity(target)
        let start = B2TargetClick.processStart(target.app.processIdentifier)
        guard CGPreflightScreenCaptureAccess() else { throw ControlFailure("SCREEN_RECORDING_REQUIRED", LocalText.text("native.computer.screenPermission")) }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        if let identity, B2TargetClick.snapshotIdentity(target) != identity {
            throw ControlFailure("TARGET_CHANGED", LocalText.text("native.computer.captureTargetChanged"))
        }
        let matches = matchingCaptureWindows(content.windows, target: target, identity: identity)
        guard matches.count == 1, let window = matches.first else {
            throw ControlFailure(captureSelectionProblem(count: matches.count, identityKnown: identity != nil) ?? "COMPUTER_WINDOW_MISSING",
                                 LocalText.text("native.computer.captureAmbiguous"))
        }
        if let identity, window.windowID != identity.windowID {
            throw ControlFailure("TARGET_CHANGED", LocalText.text("native.computer.captureIdMismatch"))
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        let scale = max(1, Double(filter.pointPixelScale))
        config.width = max(1, min(1440, Int(window.frame.width*scale)))
        config.height = max(1, Int(Double(config.width)*window.frame.height/window.frame.width))
        config.showsCursor = false; config.capturesAudio = false
        if #available(macOS 14.2, *) { config.ignoreShadowsSingleWindow = true }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard let live = elementFrame(target.window), framesMatch(target.frame, live),
              !target.app.isTerminated, B2TargetClick.processStart(target.app.processIdentifier) == start,
              identity == nil || B2TargetClick.snapshotIdentity(target) == identity else {
            throw ControlFailure(identity == nil ? "COMPUTER_WINDOW_STALE" : "TARGET_CHANGED", LocalText.text("native.computer.captureMoved"))
        }
        return (image, identity)
    }
    static func recognize(_ image: CGImage, target: Target) throws -> [(String, CGRect)] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans","zh-Hant","en-US"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.012
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).prefix(100).compactMap { result in
            guard let candidate = result.topCandidates(1).first, candidate.confidence >= 0.45 else { return nil }
            return (String(candidate.string.prefix(180)), ocrRect(result.boundingBox, window: target.frame))
        }
    }
    @MainActor static func screenshot(_ target: Target, ocr: Bool) async throws -> [String: Any] {
        let (image, identity) = try await captureImageWithIdentity(target)
        var payload = try observe(target, pixelWidth: image.width, pixelHeight: image.height,
                                  capturedIdentity: identity, capturingScreenshot: true)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.76]),
              data.count < 3*1024*1024 else { throw ControlFailure("IMAGE_TOO_LARGE", LocalText.text("native.computer.captureTooLarge")) }
        payload["image_base64"] = data.base64EncodedString(); payload["mimeType"] = "image/jpeg"
        payload["width"] = image.width; payload["height"] = image.height; payload["capture_scope"] = "target_window"
        if ocr {
            var elements = payload["elements"] as? [[String: Any]] ?? []
            let observations = try recognize(image, target: target)
            let snapshotID = payload["native_snapshot_id"] as? String ?? ""
            axLock.withLock {
              if var snapshot = axSnapshots[snapshotID] {
                for (index, item) in observations.enumerated() {
                    let ref = "o\(index+1)", sensitive = sensitiveName(item.0)
                    snapshot.entries[ref] = AXEntry(element: nil, role: "OCRText", name: item.0, frame: item.1, sensitive: sensitive, source: "ocr")
                    elements.append(["ref": ref, "role": "OCRText", "name": sensitive ? "" : item.0,
                                     "text": sensitive ? "" : item.0, "value": "", "source": "ocr",
                                     "enabled": true, "interactive": true, "sensitive": sensitive,
                                     "consequential": consequentialName(item.0),
                                     "frame": frameInfo(imageRect(item.1, window: target.frame, width: image.width, height: image.height))])
                }
                axSnapshots[snapshotID] = snapshot
              }
            }
            payload["elements"] = elements; payload["ocr_languages"] = ["zh-Hans","zh-Hant","en-US"]
        }
        return payload
    }

    final class StopTarget: NSObject {
        @objc func pressed() {
            ComputerControl.stopped = true
            ComputerControl.onStop?()
        }
    }
    @MainActor final class AuthorizationWait {
        let continuation: CheckedContinuation<Bool, Never>
        var completed = false
        var timer: Timer?
        init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }
        func finish(_ value: Bool) {
            guard !completed else { return }
            completed = true; timer?.invalidate(); timer = nil
            continuation.resume(returning: value)
        }
    }
    @MainActor final class Session {
        let requestID: String
        let deadline: TimeInterval
        let token: UInt64
        let original: NSRunningApplication?
        let originalWindow: AXUIElement?
        let originalMinimized: Bool?
        var targetApp: NSRunningApplication?
        var targetWindow: AXUIElement?
        var foregroundTarget: Target?
        var foregroundSurface: InteractionSurface?
        var foregroundInputEvents = 0
        var activatedTarget = false
        var foregroundNotice: String?
        var foregroundSeconds: Int?
        var panel: NSPanel?
        var panelLabel: NSTextField?
        let buttonTarget = StopTarget()
        init(_ request: [String: Any]) {
            requestID = request["id"] as? String ?? ""
            deadline = ((request["expires_at"] as? NSNumber)?.doubleValue ?? 0)/1000
            original = NSWorkspace.shared.frontmostApplication
            originalWindow = original.flatMap { focusedWindow($0) }
            originalMinimized = originalWindow.flatMap { boolAttr($0, kAXMinimizedAttribute as String) }
            controlLock.lock(); generation &+= 1; token = generation; stopFlag = false; controlLock.unlock()
        }
        var valid: Bool {
            controlLock.withLock {
                requestIsCurrent(token:token,liveGeneration:generation,stopped:stopFlag,
                                 deadline:deadline,now:Date().timeIntervalSince1970)
            }
        }
        func check() throws {
            guard valid else {
                throw foregroundFailure("COMPUTER_REQUEST_EXPIRED", LocalText.text("native.computer.requestExpired"), attempted: foregroundInputEvents)
            }
        }
        func authorize() async throws {
            try check()
            guard let hook = ComputerControl.authorizeRequest, !requestID.isEmpty else {
                throw ControlFailure("NATIVE_STEP_AUTHORIZATION_REQUIRED", LocalText.text("native.computer.stepAuthorizationMissing"))
            }
            let authorized: Bool = await withCheckedContinuation { continuation in
                let reply = AuthorizationWait(continuation)
                let timer = Timer(timeInterval: min(2, max(0.01, deadline-Date().timeIntervalSince1970)), repeats: false) { _ in
                    Task { @MainActor in reply.finish(false) }
                }
                reply.timer = timer
                RunLoop.main.add(timer, forMode: .common)
                hook(requestID) { value in
                    Task { @MainActor in reply.finish(value) }
                }
            }
            try check()
            guard authorized else { throw foregroundFailure("TASK_REVOKED", LocalText.text("native.computer.taskRevoked"), attempted: foregroundInputEvents) }
        }
        func show(target: Target?) {
            targetApp = target?.app
            let screen = NSScreen.screens.first { screen in
                guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                      let target else { return false }
                return CGDisplayBounds(number.uint32Value).intersects(target.frame)
            } ?? NSScreen.main
            guard let screen else { return }
            let width: CGFloat = 420
            let frame = CGRect(x: screen.visibleFrame.midX-width/2, y: screen.visibleFrame.maxY-42, width: width, height: 34)
            let p = NSPanel(contentRect: frame, styleMask: [.borderless,.nonactivatingPanel], backing: .buffered, defer: false)
            p.level = .statusBar; p.isFloatingPanel = true; p.hidesOnDeactivate = false
            p.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
            p.backgroundColor = .windowBackgroundColor; p.isOpaque = false; p.hasShadow = true
            p.contentView?.wantsLayer = true; p.contentView?.layer?.cornerRadius = 12
            let label = NSTextField(labelWithString: target?.app.localizedName.map { LocalText.text("native.computer.controllingApp", ["name": $0]) } ?? LocalText.text("native.computer.controllingDesktop"))
            label.font = .systemFont(ofSize: 12); label.frame = CGRect(x: 12, y: 8, width: 335, height: 18)
            let button = NSButton(title: LocalText.text("native.computer.stop"), target: buttonTarget, action: #selector(StopTarget.pressed))
            button.bezelStyle = .rounded; button.frame = CGRect(x: 351, y: 3, width: 62, height: 28)
            p.contentView?.addSubview(label); p.contentView?.addSubview(button); p.orderFrontRegardless(); panel = p
            panelLabel = label
        }
        func confirm(_ title: String, detail: String, button: String = LocalText.text("native.computer.allowOnce")) throws {
            try check()
            let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
            alert.addButton(withTitle: button); alert.addButton(withTitle: LocalText.text("native.button.cancel"))
            let timer = Timer(timeInterval: 0.15, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if !self.valid { NSApp.abortModal(); alert.window.orderOut(nil) }
                }
            }
            RunLoop.main.add(timer, forMode: .common)
            RunLoop.main.add(timer, forMode: .modalPanel)
            NSApp.activate(ignoringOtherApps: true)
            let response = alert.runModal()
            timer.invalidate(); alert.window.orderOut(nil)
            try check()
            guard response == .alertFirstButtonReturn else { throw ControlFailure("COMPUTER_FOREGROUND_CANCELLED", LocalText.text("native.computer.foregroundCancelled")) }
        }
        func foreground(_ target: Target, estimatedSeconds: Int = 1, observedSurface: InteractionSurface? = nil) async throws {
            targetApp = target.app; targetWindow = target.window; foregroundTarget = target
            guard let surface = observedSurface ?? captureInteractionSurface(target),
                  interactionSurfaceCurrent(surface, target: target) else {
                throw foregroundFailure("FOCUS_CHANGED", LocalText.text("native.computer.inputWindowChanged"),
                                        attempted: foregroundInputEvents, reason: "surface_changed")
            }
            foregroundSurface = surface
            guard inputAllowedForBundle(target.bundle,selfBundleID:Bundle.main.bundleIdentifier),
                  !securityProblem(target) else {
                throw ControlFailure("LOCAL_USER_REQUIRED", LocalText.text("native.computer.foregroundSystem"))
            }
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier,
               sameWindow(surface.element, focusedWindow(target.app)) { return }
            foregroundSeconds = max(1, estimatedSeconds)
            foregroundNotice = LocalText.text("native.computer.foregroundDuration", ["seconds": String(foregroundSeconds!)])
            panelLabel?.stringValue = LocalText.text("native.computer.foregroundStop", ["seconds": String(foregroundSeconds!)])
            try await authorize()
            NSApp.yieldActivation(to: target.app)
            guard target.app.activate(options: []) else { throw ControlFailure("COMPUTER_FOCUS_FAILED", LocalText.text("native.computer.activationFailed")) }
            activatedTarget = true
            guard AXUIElementPerformAction(target.window, kAXRaiseAction as CFString) == .success else {
                throw ControlFailure("COMPUTER_FOCUS_FAILED", LocalText.text("native.computer.windowActivationFailed"))
            }
            await ComputerControl.pause(0.18)
            try checkForeground()
        }
        func checkForeground(releasingMouse: Bool = false) throws {
            if !releasingMouse { try check() }
            let reason = foregroundSurfaceProblem(targetPID: targetApp?.processIdentifier,
                frontPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                surfaceCurrent: foregroundTarget.flatMap { target in
                    foregroundSurface.map { interactionSurfaceCurrent($0, target: target) }
                } ?? false,
                focusMatches: targetApp.flatMap { app in
                    foregroundSurface.map { sameWindow($0.element, focusedWindow(app)) }
                } ?? false)
            guard reason == nil, let targetApp, let targetWindow else {
                throw foregroundFailure("FOCUS_CHANGED", LocalText.text("native.computer.foregroundChanged"),
                                        attempted: foregroundInputEvents, reason: reason ?? "surface_changed")
            }
            guard inputAllowedForBundle(targetApp.bundleIdentifier ?? "", selfBundleID:Bundle.main.bundleIdentifier),
                  !securityProblem(Target(app: targetApp, window: targetWindow, frame: elementFrame(targetWindow) ?? .zero)) else {
                throw ControlFailure("LOCAL_USER_REQUIRED", LocalText.text("native.computer.selfOrSystemTarget"))
            }
        }
        @discardableResult func finish() async -> Bool {
            panel?.orderOut(nil); panel = nil; panelLabel = nil
            let frontApp = NSWorkspace.shared.frontmostApplication
            let liveWindow = frontApp.flatMap { focusedWindow($0) }
            let originalAvailable = original.map { !$0.isTerminated } == true && originalWindow.map { window in
                original.map { windows($0).contains(where: { CFEqual($0,window) }) } == true &&
                boolAttr(window,kAXMinimizedAttribute as String) == originalMinimized
            } == true
            let surfaceRestoreSafe = foregroundTarget.flatMap { target in
                foregroundSurface.map { interactionSurfaceCurrent($0, target: target) }
            } ?? false
            guard surfaceRestoreSafe, let original, let originalWindow,
                  shouldRestoreForeground(targetPID:targetApp?.processIdentifier,currentPID:frontApp?.processIdentifier,
                                          targetWindowToken:(foregroundSurface?.element ?? targetWindow).map { axIdentity($0) },currentWindowToken:liveWindow.map { axIdentity($0) },
                                          originalAvailable:originalAvailable,usedForeground:activatedTarget) else { return false }
            if frontApp?.processIdentifier == original.processIdentifier && sameWindow(originalWindow,liveWindow) { return true }
            // Restoring the user's original window does not send input to it.
            guard AXUIElementPerformAction(originalWindow,kAXRaiseAction as CFString) == .success else { return false }
            NSApp.yieldActivation(to: original)
            guard original.activate(options: []) else { return false }
            await ComputerControl.pause(0.18)
            return NSWorkspace.shared.frontmostApplication?.processIdentifier == original.processIdentifier &&
                   sameWindow(originalWindow,focusedWindow(original))
        }
    }

    static func pause(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(max(0,seconds)*1_000_000_000))
    }
    @MainActor static func sendMouse(_ type: CGEventType, point: CGPoint, session: Session, button: CGMouseButton = .left, count: Int64 = 1, releasingMouse: Bool = false) throws -> Bool {
        guard let event = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return false }
        event.setIntegerValueField(.mouseEventClickState, value: count)
        event.setIntegerValueField(.eventSourceUserData, value: eventTag)
        try session.checkForeground(releasingMouse:releasingMouse && type == .leftMouseUp)
        session.foregroundInputEvents += 1
        event.post(tap: .cghidEventTap); return true
    }
    static func keySpec(_ key: String) -> (CGKeyCode, CGEventFlags)? {
        let parts = key.split(separator: "+").map(String.init)
        let codes: [String: CGKeyCode] = ["Enter":36,"Tab":48,"Escape":53,"Space":49,"Backspace":51,"Delete":117,
            "ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,"Home":115,"End":119,"PageUp":116,
            "PageDown":121,"A":0,"C":8,"V":9,"X":7,"Z":6,"L":37,"W":13,"S":1,"F":3]
        guard let last = parts.last, let code = codes[last] else { return nil }
        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            switch modifier {
            case "Command": flags.insert(.maskCommand)
            case "Control": flags.insert(.maskControl)
            case "Option": flags.insert(.maskAlternate)
            case "Shift": flags.insert(.maskShift)
            default: return nil
            }
        }
        return (code, flags)
    }
    @MainActor static func sendKey(_ key: String, session: Session) throws {
        guard let (code, flags) = keySpec(key) else { throw ControlFailure("KEY_UNSUPPORTED", LocalText.text("native.computer.keyUnsupported")) }
        try session.check()
        for down in [true,false] {
            guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: code, keyDown: down) else {
                throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.keyUnconfirmed"), uncertain: true)
            }
            event.flags = flags; event.setIntegerValueField(.eventSourceUserData, value: eventTag)
            try session.checkForeground()
            session.foregroundInputEvents += 1
            event.post(tap: .cghidEventTap)
        }
    }
    @MainActor static func unicode(_ text: String, session: Session) async throws {
        // Split by Character to avoid breaking emoji/surrogate pairs.
        for (index,character) in text.enumerated() {
            if index % 16 == 0 { try await session.authorize() }
            try session.check()
            try session.checkForeground()
            let units = Array(String(character).utf16)
            for down in [true,false] {
                guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 0, keyDown: down) else {
                    throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.textUnconfirmed"), uncertain: true)
                }
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                event.setIntegerValueField(.eventSourceUserData, value: eventTag)
                try session.checkForeground()
                session.foregroundInputEvents += 1
                event.post(tap: .cghidEventTap)
            }
            await pause(0.002)
        }
    }
    static func revalidate(_ args: [String: Any]) throws -> (Target, AXSnapshot, AXEntry?) {
        let stored = (args["native_snapshot_id"] as? String).flatMap { id in axLock.withLock { axSnapshots[id] } }
        let hasExactSnapshot = stored.map { $0.clickIdentity != nil && Date().timeIntervalSince($0.at) < 30 } == true
        let target: Target
        do { target = try self.target(args) }
        catch let failure as ControlFailure {
            if hasExactSnapshot && ["APP_NOT_AVAILABLE", "COMPUTER_WINDOW_MISSING", "COMPUTER_WINDOW_STALE", "COMPUTER_WINDOW_AMBIGUOUS"].contains(failure.code) {
                throw ControlFailure("TARGET_CHANGED", LocalText.text("native.computer.processOrWindowChanged"))
            }
            throw failure
        }
        guard let id = args["native_snapshot_id"] as? String,
              let snapshot = lookupSnapshot(snapshotID: id, bundle: target.bundle, pid: target.app.processIdentifier),
              sameWindow(snapshot.window, target.window), framesMatch(snapshot.frame, target.frame) else {
            throw ControlFailure(hasExactSnapshot ? "TARGET_CHANGED" : "COMPUTER_WINDOW_STALE", LocalText.text("native.computer.snapshotMismatch"))
        }
        if let start = snapshot.processStart, B2TargetClick.processStart(target.app.processIdentifier) != start {
            throw ControlFailure("TARGET_CHANGED", LocalText.text("native.computer.processRestarted"))
        }
        if let expected = snapshot.clickIdentity, B2TargetClick.snapshotIdentity(target) != expected {
            throw ControlFailure("TARGET_CHANGED", LocalText.text("native.computer.windowIdentityChanged"))
        }
        guard let surface = snapshot.interactionSurface, interactionSurfaceCurrent(surface, target: target) else {
            throw ControlFailure("COMPUTER_WINDOW_STALE", LocalText.text("native.computer.attachmentChanged"))
        }
        let ref = args["element_ref"] as? String
        let entry = ref.flatMap { snapshot.entries[$0] }
        if ref != nil && entry == nil { throw ControlFailure("COMPUTER_ELEMENT_STALE", LocalText.text("native.computer.elementStale")) }
        if let entry, let element = entry.element {
            guard elementBelongsToSurface(element, surface: surface, pid: target.app.processIdentifier) else {
                throw ControlFailure("COMPUTER_ELEMENT_STALE", LocalText.text("native.computer.elementSurfaceMismatch"))
            }
            let live = elementFrame(element)
            if let issue = elementProblem(expectedRole: entry.role, expectedName: entry.name,
                                          liveRole: stringAttr(element, kAXRoleAttribute as String), liveName: elementName(element),
                                          enabled: boolAttr(element, kAXEnabledAttribute as String), frame: live) {
                throw ControlFailure(issue, LocalText.text("native.computer.elementChanged"))
            }
            guard let live, framesMatch(entry.frame, live), live.intersects(target.frame) else {
                throw ControlFailure("COMPUTER_ELEMENT_STALE", LocalText.text("native.computer.elementMoved"))
            }
        }
        try checkSystemPassword(target, element: entry?.element)
        return (target,snapshot,entry)
    }
    @MainActor static func perform(_ args: [String: Any], session: Session) async throws -> [String: Any] {
        try await session.authorize()
        let (target,snapshot,entry) = try revalidate(args)
        guard let surface = snapshot.interactionSurface else {
            throw ControlFailure("COMPUTER_WINDOW_STALE", LocalText.text("native.computer.inputIdentityUnknown"))
        }
        guard inputAllowedForBundle(target.bundle,selfBundleID:Bundle.main.bundleIdentifier) else {
            throw ControlFailure("LOCAL_USER_REQUIRED", LocalText.text("native.computer.selfControl"))
        }
        let operation = args["action"] as? String ?? ""
        let ref = args["element_ref"] as? String ?? ""
        guard ["click","double_click","right_click","move","drag","scroll","type","key"].contains(operation) else {
            throw ControlFailure("COMPUTER_ACTION_UNKNOWN", LocalText.text("native.computer.actionUnknown"))
        }
        try checkSystemPassword(target, element: entry?.element)
        if ["type","key"].contains(operation) {
            if entry?.source == "ocr" { throw ControlFailure("ELEMENT_ACTION_UNSUPPORTED", LocalText.text("native.computer.ocrInputUnsupported")) }
        }
        if operation == "click", let element = entry?.element {
            var names: CFArray?
            let supported = AXUIElementCopyActionNames(element, &names) == .success &&
                            ((names as? [String])?.contains(kAXPressAction as String) == true)
            switch semanticPress(supported: supported, perform: { AXUIElementPerformAction(element, kAXPressAction as CFString) }) {
            case .performed: return ["performed":operation,"method":"accessibility_press","element_ref":ref,"background":true]
            case .unconfirmed: throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.axPressUnconfirmed"), uncertain:true)
            case .unavailable: break
            }
        }
        if operation == "type", let element = entry?.element {
            guard let text = args["text"] as? String, text.count <= 4096 else { throw ControlFailure("ARG_INVALID", LocalText.text("native.computer.inputLimit")) }
            var settable = DarwinBoolean(false)
            let canSet = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
            switch axTextResult(settable: canSet, sensitive: entry?.sensitive == true || isSensitive(element, name: elementName(element)), set: { AXUIElementSetAttributeValue(element,kAXValueAttribute as CFString,text as CFString) },
                                read: { rawStringAttr(element,kAXValueAttribute as String) }, expected: text) {
            case .verified: return ["performed":operation,"method":"accessibility_value","element_ref":ref,"background":true,"verified":true]
            case .unconfirmed: throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.axValueUnconfirmed"), uncertain:true)
            case .unavailable: break
            }
        }
        if let entry, entry.source == "ocr" {
            let recognized = try recognize(try await captureImage(target), target: target)
            try await session.authorize()
            guard recognized.contains(where: { $0.0 == entry.name && framesMatch($0.1,entry.frame,tolerance:8) }) else {
                throw ControlFailure("COMPUTER_ELEMENT_STALE", LocalText.text("native.computer.ocrChanged"))
            }
        }
        var point = CGPoint(x:(args["x"] as? NSNumber)?.doubleValue ?? .nan,
                            y:(args["y"] as? NSNumber)?.doubleValue ?? .nan)
        if let entry { point = CGPoint(x:entry.frame.midX,y:entry.frame.midY) }
        if ["click","double_click","right_click","move","drag","scroll"].contains(operation) {
            guard point.x.isFinite, point.y.isFinite, target.frame.contains(point), surface.frame.contains(point) else {
                throw ControlFailure("COORDINATES_INVALID", LocalText.text("native.computer.coordinateOutside"))
            }
        }
        if operation == "click" {
            let receipt: B2TargetClick.Receipt?
            do {
                receipt = try await B2TargetClick.attempt(target, snapshot: snapshot, point: point, check: {
                    try await session.authorize()
                    _ = try revalidate(args)
                    guard inputAllowedForBundle(target.bundle, selfBundleID: Bundle.main.bundleIdentifier),
                          !securityProblem(target) else {
                        throw ControlFailure("LOCAL_USER_REQUIRED", LocalText.text("native.computer.backgroundSystem"))
                    }
                    try checkSystemPassword(target, element: entry?.element)
                })
            } catch let failure as B2TargetClick.Failure {
                throw B2TargetClick.controlFailure(failure)
            }
            if let receipt {
                return try B2TargetClick.postedReceipt(receipt)
            }
        }
        let estimatedSeconds = operation == "type" ? max(1, Int(ceil(Double((args["text"] as? String ?? "").count)*0.004+0.5))) : 1
        try await session.foreground(target,estimatedSeconds:estimatedSeconds,observedSurface:surface)
        try await session.authorize()
        _ = try revalidate(args)
        try session.checkForeground()
        if surface.isSheet, ["type","key"].contains(operation), entry?.element == nil {
            guard let responder = elementAttr(AXUIElementCreateApplication(target.app.processIdentifier), kAXFocusedUIElementAttribute as String),
                  elementBelongsToSurface(responder, surface: surface, pid: target.app.processIdentifier) else {
                throw ControlFailure("COMPUTER_ELEMENT_FOCUS_FAILED", LocalText.text("native.computer.focusUnknown"))
            }
        }
        if ["type","key"].contains(operation) {
            try checkSystemPassword(target, element: entry?.element)
            if let element = entry?.element {
                guard AXUIElementSetAttributeValue(element,kAXFocusedAttribute as CFString,kCFBooleanTrue) == .success else {
                    throw ControlFailure("COMPUTER_ELEMENT_FOCUS_FAILED", LocalText.text("native.computer.focusFailed"))
                }
                try checkSystemPassword(target, element: entry?.element)
            }
        }
        try session.check()
        var method = entry == nil ? "window_coordinates" : entry!.source == "ocr" ? "ocr_revalidated" : "accessibility_center_fallback"
        if ["click","double_click","right_click"].contains(operation) {
            let right = operation == "right_click", button: CGMouseButton = right ? .right : .left
            for index in 1...(operation == "double_click" ? 2 : 1) {
                try await session.authorize()
                guard try sendMouse(right ? .rightMouseDown : .leftMouseDown,point:point,session:session,button:button,count:Int64(index)),
                      try sendMouse(right ? .rightMouseUp : .leftMouseUp,point:point,session:session,button:button,count:Int64(index)) else {
                    throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.mouseUnknown"), uncertain:true)
                }
                await pause(0.04)
            }
        } else if operation == "move" {
            guard try sendMouse(.mouseMoved,point:point,session:session) else { throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",LocalText.text("native.computer.mouseMoveUnknown"),uncertain:true) }
        } else if operation == "drag" {
            let end = CGPoint(x:(args["to_x"] as? NSNumber)?.doubleValue ?? .nan,y:(args["to_y"] as? NSNumber)?.doubleValue ?? .nan)
            guard end.x.isFinite,end.y.isFinite,target.frame.contains(end),surface.frame.contains(end) else { throw ControlFailure("COORDINATES_INVALID",LocalText.text("native.computer.dragOutside")) }
            guard try sendMouse(.leftMouseDown,point:point,session:session) else { throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",LocalText.text("native.computer.dragStartUnknown"),uncertain:true) }
            var last = point
            // Cleanup still verifies the original foreground; never release into a different App.
            defer { _ = try? sendMouse(.leftMouseUp,point:last,session:session,releasingMouse:true) }
            for i in 1...12 {
                try await session.authorize()
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.app.processIdentifier else {
                    throw ControlFailure("FOCUS_CHANGED",LocalText.text("native.computer.dragFocusChanged"),uncertain:true)
                }
                let fraction = Double(i)/12
                last = CGPoint(x:point.x+(end.x-point.x)*fraction,y:point.y+(end.y-point.y)*fraction)
                guard try sendMouse(.leftMouseDragged,point:last,session:session) else { throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",LocalText.text("native.computer.dragUnknown"),uncertain:true) }
                await pause(0.02)
            }
        } else if operation == "scroll" {
            let amount = (args["amount"] as? NSNumber)?.int32Value ?? 400
            guard abs(Int(amount)) <= 2000 else { throw ControlFailure("ARG_INVALID",LocalText.text("native.computer.scrollLimit")) }
            guard try sendMouse(.mouseMoved,point:point,session:session),
                  let event = CGEvent(scrollWheelEvent2Source:CGEventSource(stateID:.hidSystemState),units:.pixel,wheelCount:1,wheel1:-amount,wheel2:0,wheel3:0) else {
                throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",LocalText.text("native.computer.scrollUnknown"),uncertain:true)
            }
            event.setIntegerValueField(.eventSourceUserData,value:eventTag)
            try session.checkForeground()
            session.foregroundInputEvents += 1
            event.post(tap:.cghidEventTap)
        } else if operation == "type" {
            guard let text = args["text"] as? String,text.count <= 4096 else { throw ControlFailure("ARG_INVALID",LocalText.text("native.computer.inputTooLong")) }
            if entry?.element != nil { try sendKey("Command+A",session:session) }
            try await unicode(text,session:session)
            guard let element = entry?.element else {
                throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED", LocalText.text("native.computer.textDispatchedUnknown"), uncertain:true)
            }
            try verifyTextReadback(sensitive: entry?.sensitive == true || isSensitive(element, name: elementName(element)),
                                   read: { rawStringAttr(element,kAXValueAttribute as String) }, expected: text)
            method = "unicode_events"
        } else if operation == "key" {
            try sendKey(args["key"] as? String ?? "",session:session); method = "tagged_key_events"
        }
        await pause(0.12)
        try session.check()
        return ["performed":operation,"method":method,"element_ref":ref,"background":false]
    }

    /// A completed B2 recipe has already attempted target-only events.
    /// Any later observation or authorization failure MUST remain uncertain,
    /// even if the original guard's error used the default uncertain=false.
    /// Pure injectable closures also let the native tests cover this late edge
    /// without starting a desktop service or posting a real input event.
    @MainActor static func postStepReadback(_ step: [String: Any],
                                           perform: ([String: Any]) async throws -> [String: Any],
                                           observe: ([String: Any]) async throws -> [String: Any],
                                           check: () throws -> Void) async throws -> [String: Any] {
        var result = try await perform(step)
        let dispatchedB2 = result["method"] as? String == "background_target_click"
        var observationCompleted = false
        do {
            result["observation"] = try await observe(step)
            observationCompleted = true
            try check()
        } catch {
            let original = error as? ControlFailure
            if dispatchedB2 {
                throw ControlFailure(original?.code ?? "COMPUTER_ACTION_UNCONFIRMED",
                                     LocalText.text("native.computer.backgroundLateUnknown"),
                                     uncertain: true,
                                     details: ["method":"background_target_click", "background":true,
                                               "attempted_target_channels":result["attempted_target_channels"] ?? 10,
                                               "target_focus_records":result["target_focus_records"] ?? 2])
            }
            if !observationCompleted {
                throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",
                                     LocalText.text("native.computer.readbackFailed"), uncertain:true)
            }
            if let original { throw original }
            throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",
                                 LocalText.text("native.computer.lateCheckUnknown"), uncertain:true)
        }
        return result
    }

    @MainActor static func runBatch(_ steps: [[String: Any]],
                                   foregroundEvents: () -> Int = { 0 },
                                   perform: ([String: Any]) async throws -> [String: Any]) async throws -> [String: Any] {
        let ids = steps.compactMap { $0["step_id"] as? String }
        guard !steps.isEmpty, steps.count <= 10, ids.count == steps.count,
              ids.allSatisfy({ !$0.isEmpty && $0.count <= 96 }), Set(ids).count == steps.count else {
            throw ControlFailure("ARG_INVALID", LocalText.text("native.computer.batchInvalid"))
        }
        let batchStartEvents = foregroundEvents()
        var receipts: [[String:Any]] = [], failure: ControlFailure?, stopReason: String?
        for (index,step) in steps.enumerated() {
            let stepStartEvents = foregroundEvents()
            do {
                let result = try await perform(step)
                if result["method"] as? String == "background_target_click" ||
                   result["delivery_status"] as? String == "posted_unconfirmed" {
                    // Even a malformed native B2 receipt must stop the batch
                    // as an error. Otherwise the RPC layer would return
                    // isError=false despite an uncertain attempted click.
                    guard result["method"] as? String == "background_target_click",
                          result["background"] as? Bool == true,
                          result["delivery_status"] as? String == "posted_unconfirmed",
                          result["delivery_unconfirmed"] as? Bool == true,
                          result["do_not_replay"] as? Bool == true,
                          result["verified"] as? Bool == false,
                          result["completed"] as? Bool == false,
                          result["automatic_retry"] as? Bool == false,
                          result["attempted_target_channels"] as? Int == 10,
                          result["target_focus_records"] as? Int == 2,
                          result["error"] == nil, result["failure"] == nil,
                          result["success"] == nil, result["performed"] == nil else {
                        throw ControlFailure("COMPUTER_ACTION_UNCONFIRMED",
                            LocalText.text("native.computer.backgroundReceiptIncomplete"),
                            uncertain:true,
                            details:["method":"background_target_click","background":true])
                    }
                    receipts.append(["step_id":ids[index],"index":index,
                                     "status":"posted_unconfirmed","result":result])
                    stopReason = "posted_unconfirmed"
                    break
                }
                receipts.append(["step_id":ids[index],"index":index,"status":"performed","result":result])
            } catch {
                let original = (error as? ControlFailure) ?? ControlFailure("COMPUTER_ACTION_UNCONFIRMED",LocalText.text("native.computer.stepUnknown"),uncertain:true)
                let sent = max(0, foregroundEvents() - stepStartEvents)
                // Session guards carry request-wide provenance. Rebase only
                // tagged foreground failures to this step, including zero;
                // untagged AX/B2 uncertainty still belongs to the current step.
                let e = sent > 0 || original.extraDetails["foreground_input_events"] is Int ? foregroundFailure(original.code, original.message,
                    attempted:sent, details:original.extraDetails) : original
                receipts.append(["step_id":ids[index],"index":index,"status":"failed_or_unconfirmed","error":e.payload])
                failure = e; break
            }
        }
        let attempted = receipts.count
        for index in attempted..<steps.count {
            receipts.append(["step_id":ids[index],"index":index,"status":"not_attempted"])
        }
        var output: [String:Any] = ["completed":failure == nil && stopReason == nil,
                                    "receipts":receipts,"remaining_steps":steps.count-attempted]
        let sent = max(0, foregroundEvents() - batchStartEvents)
        if sent > 0 { output["foreground_input_events"] = min(100000, sent) }
        if let failure {
            output["failure"] = failure.payload
            if sent > 0 {
                var details = failure.extraDetails
                details["batch_stopped"] = true
                details["remaining_steps"] = steps.count - attempted
                output["error"] = foregroundFailure(failure.code, failure.message,
                    attempted:sent, details:details).payload
            } else if failure.extraDetails["method"] as? String == "background_target_click",
               failure.extraDetails["background"] as? Bool == true {
                // Only an actual B2 dispatch failure becomes an error RPC.
                // Keep the existing code and exact attempted-vs-unknown state;
                // never turn a failed late guard into a normal posted stop.
                var details = failure.extraDetails
                details["batch_stopped"] = true
                details["remaining_steps"] = steps.count - attempted
                output["error"] = ControlFailure(failure.code, failure.message,
                                                  uncertain:failure.uncertain,
                                                  details:details).payload
            }
        }
        if let stopReason {
            output["stop_reason"] = stopReason
            output["delivery_status"] = "posted_unconfirmed"
            output["do_not_replay"] = true
            output["verified"] = false
            output["next_action"] = "computer_screenshot"
        }
        return output
    }

    static func changes(before: AXSnapshot?, after: [String: Any], initialWindows: [[String: Any]]) -> [String: Any] {
        let windows = after["windows"] as? [[String: Any]] ?? []
        let oldIDs = Set(initialWindows.compactMap { $0["window_id"] as? String })
        let newWindows = windows.filter { !oldIDs.contains($0["window_id"] as? String ?? "") }
        let tree = after["tree"] as? String ?? ""
        return ["new_windows":newWindows,"dialogs":newWindows.filter { ($0["title"] as? String ?? "").isEmpty == false },
                "title":after["window_title"] ?? "", "title_changed":before?.title != after["window_title"] as? String,
                "text_changed":before?.text != tree,
                "text_excerpt":String((after["text"] as? String ?? "").prefix(2000)),
                "front_app":appInfo(NSWorkspace.shared.frontmostApplication),
                "focused_element":focusedElementInfo(bundleID:after["target_bundle"] as? String)]
    }
    static func focusedElementInfo(bundleID: String?) -> [String: Any] {
        guard let bundleID, let app = NSRunningApplication.runningApplications(withBundleIdentifier:bundleID).first,
              let e = elementAttr(AXUIElementCreateApplication(app.processIdentifier),kAXFocusedUIElementAttribute as String) else { return [:] }
        let name = elementName(e), sensitive = isSensitive(e,name:name)
        return ["role":stringAttr(e,kAXRoleAttribute as String) ?? "", "name":sensitive ? "" : name,"sensitive":sensitive]
    }
    @MainActor static func latestObservation(_ args: [String: Any], includeImage: Bool) async throws -> [String: Any] {
        let target = try self.target(args)
        if let id = args["native_snapshot_id"] as? String {
            guard let snapshot = axLock.withLock({ axSnapshots[id] }),
                  windowContextProblem(expectedBundle:snapshot.bundle,expectedPID:snapshot.pid,expectedWindowToken:snapshot.windowToken,
                                       actualBundle:target.bundle,actualPID:target.app.processIdentifier,actualWindowToken:axIdentity(target.window)) == nil,
                  snapshot.processStart == nil || B2TargetClick.processStart(target.app.processIdentifier) == snapshot.processStart,
                  snapshot.clickIdentity == nil || B2TargetClick.snapshotIdentity(target) == snapshot.clickIdentity else {
                throw ControlFailure("COMPUTER_WINDOW_STALE", LocalText.text("native.computer.readbackTargetGone"))
            }
        }
        if includeImage { return try await screenshot(target,ocr:false) }
        return try observe(target)
    }

    @MainActor static func openPath(_ args: [String: Any], session: Session) async throws -> [String: Any] {
        guard let supplied = args["path"] as? String,supplied.hasPrefix("/"),!supplied.contains("\0"),
              let identity = args["identity"] as? [String:Any] else { throw ControlFailure("PATH_INVALID",LocalText.text("native.computer.openPathInvalid")) }
        let url = URL(fileURLWithPath:supplied).resolvingSymlinksInPath().standardizedFileURL
        func validate() throws {
            guard URL(fileURLWithPath:supplied).resolvingSymlinksInPath().standardizedFileURL.path == supplied else { throw ControlFailure("FILE_CHANGED",LocalText.text("native.computer.openPathChanged")) }
            let attributes = try FileManager.default.attributesOfItem(atPath:url.path)
            guard (attributes[.systemFileNumber] as? NSNumber)?.uint64Value == (identity["inode"] as? NSNumber)?.uint64Value,
                  (attributes[.systemNumber] as? NSNumber)?.uint64Value == (identity["device"] as? NSNumber)?.uint64Value,
                  (attributes[.size] as? NSNumber)?.uint64Value == (identity["size"] as? NSNumber)?.uint64Value,
                  let modified = attributes[.modificationDate] as? Date,
                  abs(modified.timeIntervalSince1970*1000-((identity["mtime_ms"] as? NSNumber)?.doubleValue ?? -.infinity)) < 2 else {
                throw ControlFailure("FILE_CHANGED",LocalText.text("native.computer.openFileChanged"))
            }
        }
        try validate(); try await session.authorize()
        try validate()
        let config = NSWorkspace.OpenConfiguration(); config.activates = false
        let opened: NSRunningApplication = try await withCheckedThrowingContinuation { continuation in
            NSWorkspace.shared.open(url,configuration:config) { app,error in
                if let error { continuation.resume(throwing:error) }
                else if let app { continuation.resume(returning:app) }
                else { continuation.resume(throwing:ControlFailure("COMPUTER_OPEN_UNCONFIRMED",LocalText.text("native.computer.openUnconfirmed"),uncertain:true)) }
            }
        }
        return ["opened":true,"path":supplied,"application":appInfo(opened),"local_confirmed":false,
                "administrator_password":LocalText.text("native.computer.systemConfirmation"),"activation_requested":false]
    }

    static func execute(_ request: [String: Any], done: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async {
            Task { @MainActor in
                let action = request["action"] as? String ?? "", args = request["args"] as? [String:Any] ?? [:]
                if action == "applications" {
                    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { app -> [String:Any]? in
                        guard let id = app.bundleIdentifier else { return nil }
                        return ["bundle_id":id,"name":app.localizedName ?? id,"active":app.isActive,"pid":Int(app.processIdentifier)]
                    }
                    done(["applications":apps,"front_app":appInfo(NSWorkspace.shared.frontmostApplication),"ttlMs":1000,"cacheScope":"private"]); return
                }
                if action == "observe" || action == "screenshot" {
                    do {
                        let target = try self.target(args)
                        if action == "observe" { done(try observe(target,maxNodes:min(700,max(1,(args["max_nodes"] as? Int) ?? 700)))) }
                        else { done(try await screenshot(target,ocr:args["ocr"] as? Bool != false)) }
                    } catch let e as ControlFailure {
                        if action == "observe", ["COMPUTER_WINDOW_MISSING","COMPUTER_WINDOW_AMBIGUOUS"].contains(e.code) {
                            done(["windows":listWindows(),"observation_unavailable":true,"failure":e.payload,"ttlMs":0,"cacheScope":"private"])
                        } else { done(["error":e.payload]) }
                    }
                    catch { done(self.error("SCREEN_CAPTURE_FAILED",LocalText.text("native.computer.captureFailed"))) }
                    return
                }
                guard ["action","batch","focus","open_path"].contains(action) else { done(self.error("COMPUTER_ACTION_UNKNOWN",LocalText.text("native.computer.actionMissing"))); return }
                let session = Session(request)
                var output: [String:Any] = [:]
                let initialWindows = listWindows()
                var observationArgs = args
                var before: AXSnapshot?
                if let id = args["native_snapshot_id"] as? String {
                    before = axLock.withLock { axSnapshots[id] }
                }
                do {
                    try session.check()
                    let initialArgs = action == "batch" ? ((args["steps"] as? [[String:Any]])?.first ?? args) : args
                    let initialTarget = action == "open_path" ? nil : try (action == "focus" ? self.target(initialArgs) : revalidate(initialArgs).0)
                    session.show(target:initialTarget)
                    if action == "open_path" {
                        output = try await openPath(args,session:session)
                    } else if action == "focus", let target = initialTarget {
                        try await session.authorize(); try await session.foreground(target)
                        output = ["focused":true,"bundle_id":target.bundle,"observation":try observe(target)]
                    } else if action == "batch" {
                        guard let steps = args["steps"] as? [[String:Any]] else {
                            throw ControlFailure("ARG_INVALID",LocalText.text("native.computer.batchInvalid"))
                        }
                        observationArgs = steps.first ?? args
                        if let id = observationArgs["native_snapshot_id"] as? String {
                            before = axLock.withLock { axSnapshots[id] }
                        }
                        output = try await runBatch(steps, foregroundEvents: { session.foregroundInputEvents }) { step in
                            try await postStepReadback(step,
                                perform: { try await perform($0,session:session) },
                                observe: { try await latestObservation($0,includeImage:false) },
                                check: { try session.check() })
                        }
                    } else {
                        output = try await perform(args,session:session)
                    }
                    if action == "action" || action == "batch" {
                        if let observed = try? await latestObservation(observationArgs,includeImage:args["include_screenshot"] as? Bool == true && session.valid) {
                            output["observation"] = observed; output["changes"] = changes(before:before,after:observed,initialWindows:initialWindows)
                        } else {
                            // Window-closing actions still report new windows rather than silently inventing success.
                            output["windows"] = listWindows(); output["observation_unavailable"] = true
                        }
                    }
                } catch {
                    let originalFailure = (error as? ControlFailure) ?? ControlFailure("COMPUTER_ACTION_UNCONFIRMED",LocalText.text("native.computer.nativeUnknown"),uncertain:true)
                    let failure = session.foregroundInputEvents > 0 ?
                        foregroundFailure(originalFailure.code, originalFailure.message, attempted:session.foregroundInputEvents, details:originalFailure.extraDetails) : originalFailure
                    output = ["error":failure.payload]
                    if action == "action" || action == "batch",
                       let observed = try? await latestObservation(observationArgs,includeImage:false) {
                        output["observation"] = observed; output["changes"] = changes(before:before,after:observed,initialWindows:initialWindows)
                    }
                }
                if let notice = session.foregroundNotice {
                    output["foreground_notice"] = notice
                    output["foreground_estimated_seconds"] = session.foregroundSeconds
                }
                if session.foregroundInputEvents > 0 {
                    output["foreground_input_events"] = min(100000, session.foregroundInputEvents)
                }
                output["front_restored"] = await session.finish()
                output["front_app"] = appInfo(NSWorkspace.shared.frontmostApplication)
                done(output)
            }
        }
    }
}
