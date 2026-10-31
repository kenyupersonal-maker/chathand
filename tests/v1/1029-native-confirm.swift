import Foundation

// 只运行纯函数；不创建窗口、不请求通知权限、不发鼠标键盘事件。
@main struct NativeConfirmationTests {
    static func main() {
        var checks = 0
        func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
        }
        func route(_ string: String) -> [String:String]? {
            guard let url = URL(string:string) else { return nil }
            return ClientNotifications.route(for:url)
        }
        expect(ClientNotifications.confirmCategory == "chathand.confirm", "confirmation category")
        expect(ClientNotifications.confirmDenyCategory == "chathand.confirm.deny", "deny-only category")
        expect(ClientNotifications.allowOnceAction == "allow_once", "allow identifier")
        expect(ClientNotifications.denyAction == "deny", "deny identifier")
        for section in ["commands", "browser", "desktop", "scope", "connection"] {
            expect(route("chathand://settings/"+section) == ["page":"settings","section":section], "settings route "+section)
        }
        expect(route("chathand://settings/commands/admin") == ["page":"settings","section":"commands","item":"admin"], "settings item only navigates")
        let confirm = "cf_0123456789abcdef"
        expect(route("chathand://confirm/"+confirm) == ["page":"home","confirm_id":confirm], "confirmation navigation")
        let task = "8bc542dd-f93e-478b-852d-7112f2bf00c8"
        expect(route("chathand://task/"+task) == ["page":"tasks","task_id":task], "task navigation")
        let invalid = [
            "https://settings/commands", "file:///confirm/"+confirm, "chathand://other/id",
            "chathand://settings", "chathand://settings/", "chathand://settings/unknown",
            "chathand://settings/commands/admin/extra", "chathand://settings/commands/",
            "chathand://confirm/", "chathand://task/", "chathand://task/a/b",
            "chathand://confirm/"+confirm+"?scope=once", "chathand://settings/scope?mode=full",
            "chathand://confirm/"+confirm+"#allow", "chathand://confirm//"+confirm,
            "chathand://user@confirm/"+confirm, "chathand://confirm:1234/"+confirm,
            "chathand://confirm/a%22b", "chathand://confirm/a%2Fb", "chathand://task/.."
        ]
        for value in invalid { expect(route(value) == nil, "untrusted or invalid navigation refused: "+value) }
        for value in ["chathand://settings/commands/always", "chathand://confirm/once", "chathand://task/deny"] {
            let keys = Set(route(value)?.keys.map { $0 } ?? [])
            expect(keys.isSubset(of:["page","section","item","task_id","confirm_id"]), "routing metadata cannot answer")
            expect(keys.isDisjoint(with:["scope","answer","allow","confirm","human","apply","route"]), "no approval fields")
        }
        expect(ClientNotifications.browserRepairTarget(kind:"browser_connection_lost")?["section"] == "browser", "old repair target remains")
        expect(ClientNotifications.browserRepairTarget(kind:"confirmation_required") == nil, "old repair does not claim confirmations")
        expect(ConfirmGuard.isHuman(via:"notification", windowInputAge:nil, hidClickAge:0.4, hidKeyAge:20), "notification recent mouse")
        expect(ConfirmGuard.isHuman(via:"notification", windowInputAge:nil, hidClickAge:20, hidKeyAge:0.4), "notification recent keyboard")
        expect(!ConfirmGuard.isHuman(via:"notification", windowInputAge:nil, hidClickAge:10, hidKeyAge:10), "notification without HID event refused")
        expect(!ConfirmGuard.isHuman(via:"window", windowInputAge:nil, hidClickAge:0.3, hidKeyAge:20), "window without local event refused")
        expect(ConfirmGuard.isHuman(via:"window", windowInputAge:0.3, hidClickAge:0.3, hidKeyAge:20), "window and recent HID accepted")
        expect(!ConfirmGuard.isHuman(via:"window", windowInputAge:0.3, hidClickAge:20, hidKeyAge:20), "programmatic window event alone refused")
        expect(!ConfirmGuard.isHuman(via:"unknown", windowInputAge:0, hidClickAge:0, hidKeyAge:0), "unknown origin refused")
        expect(ConfirmGuard.isHuman(via:"window", windowInputAge:1.5, hidClickAge:3, hidKeyAge:100), "specified limits inclusive")
        expect(!ConfirmGuard.isHuman(via:"window", windowInputAge:1.5001, hidClickAge:0, hidKeyAge:100), "old local event refused")
        expect(!ConfirmGuard.isHuman(via:"notification", windowInputAge:nil, hidClickAge:3.0001, hidKeyAge:3.0001), "old HID event refused")
        expect(!ConfirmGuard.isHuman(via:"window", windowInputAge:-1, hidClickAge:0, hidKeyAge:0), "negative local age refused")
        expect(!ConfirmGuard.isHuman(via:"window", windowInputAge:.nan, hidClickAge:0, hidKeyAge:0), "invalid local clock refused")
        expect(!ConfirmGuard.isHuman(via:"notification", windowInputAge:nil, hidClickAge:.nan, hidKeyAge:.infinity), "invalid HID clocks refused")
        expect(!ConfirmGuard.isHuman(via:"notification", windowInputAge:nil, hidClickAge:-1, hidKeyAge:20), "negative HID clock refused")
        print("PASS: \(checks) isolated native confirmation checks")
    }
}
