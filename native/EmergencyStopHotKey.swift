import Carbon
import Foundation

/// Carbon hot keys work without observing global keyboard events or requesting AX access.
final class EmergencyStopHotKey {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private(set) var registrationStatus: OSStatus = OSStatus(eventHotKeyInvalidErr)
    var onPress: (() -> Void)?
    private static let signature: OSType = 0x43485354 // CHST

    @discardableResult func register() -> Bool {
        unregister()
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let install = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let result = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            guard result == noErr, id.signature == EmergencyStopHotKey.signature, id.id == 1 else { return OSStatus(eventNotHandledErr) }
            let owner = Unmanaged<EmergencyStopHotKey>.fromOpaque(context).takeUnretainedValue()
            owner.onPress?()
            return noErr
        }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard install == noErr else { registrationStatus = install; return false }
        registrationStatus = RegisterEventHotKey(UInt32(kVK_Escape), UInt32(controlKey | optionKey), EventHotKeyID(signature: Self.signature, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        if registrationStatus != noErr, let handler { RemoveEventHandler(handler); self.handler = nil }
        return registrationStatus == noErr
    }
    func unregister() {
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        if let handler { RemoveEventHandler(handler); self.handler = nil }
    }
    var status: [String: Any] { ["shortcut": "⌃⌥⎋", "registered": hotKey != nil, "error_code": Int(registrationStatus), "requires_accessibility": false] }
    deinit { unregister() }
}
