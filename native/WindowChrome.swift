import Cocoa
import WebKit

/// Window chrome: no title row. The page runs up to the top edge; the three window buttons sit over the
/// page's top-left corner. In full screen the buttons are gone and the page
/// folds that space away (it is told through `window.setWindowChrome`).
enum WindowChrome {
    /// Center of the close button, from the window's top-left corner (points).
    static let closeCenter = CGPoint(x: 22, y: 22)

    static func configure(_ window: NSWindow) {
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        place(window)
    }

    /// Put the three buttons where the page expects them (same approach as Electron's trafficLightPosition:
    /// size the title-bar container so the buttons are vertically centred on `closeCenter.y`, then place them).
    /// AppKit lays the title bar out again after resizes and full-screen changes, so this also runs from those
    /// window notifications.
    static func place(_ window: NSWindow) {
        guard !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview?.superview else { return }
        let width = close.frame.width, height = close.frame.height
        let gap = max(4, mini.frame.minX - close.frame.maxX)
        let marginY = max(0, closeCenter.y - height / 2)
        var frame = container.frame
        frame.size.height = height + 2 * marginY
        frame.origin.y = window.frame.height - frame.size.height
        if container.frame != frame { container.frame = frame }
        var x = closeCenter.x - width / 2
        for button in [close, mini, zoom] {
            let origin = NSPoint(x: x, y: marginY)
            if button.frame.origin != origin { button.setFrameOrigin(origin) }
            x += width + gap
        }
    }

    /// Hide the buttons while leaving full screen so they do not jump, then place and show them again.
    static func setButtonsVisible(_ window: NSWindow, _ visible: Bool) {
        window.standardWindowButton(.closeButton)?.superview?.superview?.isHidden = !visible
    }

    /// What the system wants on a title-bar double click: zoom (default), minimize, or nothing.
    static func doubleClick(_ window: NSWindow) {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? ""
        switch action {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default:
            if action.isEmpty && UserDefaults.standard.bool(forKey: "AppleMiniaturizeOnDoubleClick") { window.performMiniaturize(nil) }
            else { window.performZoom(nil) }
        }
    }
}

/// The web view also acts as the window's title bar: inside the areas the page marks with `data-drag`
/// (minus anything clickable inside them) a mouse-down moves the window instead of reaching the page.
/// The page reports those rectangles whenever its layout changes (`windowChrome` message).
final class ChromeWebView: WKWebView {
    private var zones: [NSRect] = []
    private var holes: [NSRect] = []

    func setDragAreas(_ data: [String: Any]) {
        func rects(_ key: String) -> [NSRect] {
            guard let list = data[key] as? [[Any]] else { return [] }
            return list.prefix(64).compactMap { item in
                let n = item.compactMap { ($0 as? NSNumber)?.doubleValue }
                guard n.count == 4, n[2] > 0, n[3] > 0, n.allSatisfy({ $0.isFinite && abs($0) < 100_000 }) else { return nil }
                return NSRect(x: n[0], y: n[1], width: n[2], height: n[3])
            }
        }
        zones = rects("zones")
        holes = rects("holes")
    }

    /// Point in page coordinates (CSS px from the top-left; page zoom is 1).
    private func pagePoint(_ event: NSEvent) -> NSPoint {
        let p = convert(event.locationInWindow, from: nil)
        return NSPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)
    }

    private func dragsWindow(_ event: NSEvent) -> Bool {
        guard let window, !window.styleMask.contains(.fullScreen), !zones.isEmpty else { return false }
        let p = pagePoint(event)
        return zones.contains { $0.contains(p) } && !holes.contains { $0.contains(p) }
    }

    override func mouseDown(with event: NSEvent) {
        guard dragsWindow(event), let window else { super.mouseDown(with: event); return }
        if event.clickCount == 2 { WindowChrome.doubleClick(window); return }
        window.performDrag(with: event)
    }

    // An inactive window can be dragged on the first click, like a normal title bar.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        if let event, dragsWindow(event) { return true }
        return super.acceptsFirstMouse(for: event)
    }
}
