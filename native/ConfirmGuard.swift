import Foundation

/// 1029：只判定最近有没有用户输入；纯函数，不请求权限、不生成事件。
/// source_pid 本版只记录，不能当作真假输入的判断条件。
enum ConfirmGuard {
    static func isHuman(via: String, windowInputAge: Double?, hidClickAge: Double, hidKeyAge: Double) -> Bool {
        // 无效或倒退的时钟不能构成放行证据。一个有效的近期输入即可。
        let recentHID = [hidClickAge, hidKeyAge].contains { $0.isFinite && $0 >= 0 && $0 <= 3 }
        switch via {
        case "notification":
            return recentHID
        case "window":
            guard let age = windowInputAge, age.isFinite, age >= 0, age <= 1.5 else { return false }
            return recentHID
        default:
            return false
        }
    }
}
