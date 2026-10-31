import AppKit
import Foundation

@main struct SmallNativeChecks {
    static func main() {
        var checks = 0
        func check(_ value: @autoclosure () -> Bool, _ label: String) { checks += 1; if !value() { fputs("FAIL: \(label)\n", stderr); exit(1) } }
        for prompt in ["整理文件", "hello + & ? # =", "line one\nline two", "@ChatHand 做一件事"] {
            let url = ClientFeatures.promptURL(prompt)!
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            check(components.scheme == "https" && components.host == "chatgpt.com" && components.path == "/", "official chat mode link")
            check(components.queryItems?.count == 1 && components.queryItems?.first?.value == prompt, "lossless prompt encoding")
            check(components.queryItems?.first?.name == "q", "only prompt, never auto send")
            let work = URLComponents(url: ClientFeatures.promptURL(prompt, work: true)!, resolvingAgainstBaseURL: false)!
            check(work.queryItems?.map(\.name) == ["surface", "prompt"], "work entry has no send flag")
            check(work.queryItems?.first?.value == "work" && work.queryItems?.last?.value == prompt, "work lossless prompt")
        }
        for prompt in ["", " \n"] { check(ClientFeatures.promptURL(prompt)?.absoluteString == "https://chatgpt.com/", "empty opens homepage without clipboard") }
        check(ClientFeatures.promptURL(String(repeating: "x", count: 16385)) == nil, "oversized prompt rejected")
        for success in [true, false] {
            var copied = false; var opened = [URL](); var result = [String: Any]()
            let env = ClientFeatures.ChatEnvironment(openURL: { opened.append($0); return success }, copy: { _ in copied = true; return true })
            ClientFeatures.openChatGPT(prompt: "fixture + 中文", environment: env) { result = $0 }
            check((result["opened"] as? String == "web") == success, "web dispatch result")
            check(result["prefilled"] as? Bool == false && result["prefill_requested"] as? Bool == success, "dispatch never proves prefill")
            check(result["copied"] as? Bool == !success && copied == !success, "copy only when opening fails")
            check(result["auto_sent"] as? Bool == false, "never auto send")
            check(opened.count == 1 && opened.first?.host == "chatgpt.com", "one official web dispatch")
        }
        var blankCopies = 0, blankResult = [String: Any]()
        ClientFeatures.openChatGPT(prompt: "", environment: .init(openURL: { _ in false }, copy: { _ in blankCopies += 1; return true })) { blankResult = $0 }
        check(blankCopies == 0 && blankResult["copied"] as? Bool == false, "blank failure never clears clipboard")
        for (mode, name) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] { check(ClientFeatures.appearanceName(mode) == name, "appearance mapping") }
        check(ClientFeatures.appearanceName("system") == nil, "system follows OS")
        let key = "sk-" + String(repeating: "a", count: 17)
        for (text, expected) in [(key, true), ("sk-short", false), (key + "\n", false), (key + " ", false), ("normal text", false)] { check(ClientFeatures.validRuntimeKey(text) == expected, "existing key format") }

        for scenario in ["success", "clipboard_changed", "failed", "expired", "replaced"] {
            var date = Date(timeIntervalSince1970: 100), count = 1, reads = 0, clears = 0, submits = 0
            var text = "unrelated text"
            var completion: (([String: Any]) -> Void)?
            let watcher = ClipboardKeyWatcher(changeCount: { count }, read: { reads += 1; return text }, clear: { clears += 1 }, submit: { tunnel, submitted, done in submits += 1; check(tunnel == "tunnel_abcdefgh" && submitted == key, "existing key API body"); completion = done }, now: { date })
            check(watcher.start(tunnelID: "tunnel_abcdefgh", requestID: "fixture-1", schedule: false), "start watch")
            watcher.tick(); check(reads == 0, "do not read unchanged clipboard")
            count += 1; watcher.tick(); check(reads == 1 && submits == 0, "ignore unrelated content")
            watcher.tick(); check(reads == 1, "do not reread unchanged non-key")
            text = key; count += 1; watcher.tick(); watcher.tick(); check(submits == 1, "one pending key submission")
            if scenario == "clipboard_changed" { text = "new user clipboard"; count += 1 }
            if scenario == "expired" { date = date.addingTimeInterval(600); watcher.tick() }
            if scenario == "replaced" { _ = watcher.start(tunnelID: "tunnel_ijklmnop", requestID: "fixture-2", schedule: false) }
            if scenario == "success" { watcher.synchronize(["active": false, "received": true, "request": NSNull()]); check(watcher.active, "keep callback alive after server success") }
            completion?(["saved": scenario != "failed"])
            check(clears == (scenario == "success" ? 1 : 0), "clear only still-same successful key")
            if scenario == "success" || scenario == "clipboard_changed" { check(watcher.received && !watcher.active && watcher.last4 == "aaaa", "redacted received state") }
            if scenario == "failed" { check(watcher.active && !watcher.received, "failure waits for next change"); watcher.tick(); check(submits == 1, "no retry loop") }
            if scenario == "expired" { check(!watcher.active && !watcher.received, "ten minute expiry") }
            if scenario == "replaced" { check(watcher.active && !watcher.received, "ignore old async completion") }
            watcher.stop(); check(!watcher.active, "stop timers")
        }
        let synced = ClipboardKeyWatcher(changeCount: { 0 }, read: { fatalError("must not read") }, clear: {}, submit: { _, _, _ in })
        synced.synchronize(["request": ["id": "sync", "tunnel_id": "tunnel_abcdefgh", "expires_at": Date().addingTimeInterval(10).timeIntervalSince1970 * 1000]])
        check(synced.active, "start from native polling response")
        synced.synchronize(["active": false, "received": false, "request": NSNull()]); check(!synced.active, "stop from server cancellation")
        var routes = [String](), responses = [([String: Any]) -> Void](), modes = [String]()
        var count = 0, clipboardReads = 0, clears = 0
        let fakeAPI: ClientFeatureCoordinator.API = { route, body, done in
            routes.append(route); responses.append(done)
            if route == "/api/setup/key" { check(body["api_key"] as? String == key && body["tunnel_id"] as? String == "tunnel_abcdefgh", "coordinator key API") }
            if route == "/api/settings" { check(body["appearance"] as? String == "system", "appearance persists via authenticated API") }
        }
        let watched = ClipboardKeyWatcher(changeCount: { count }, read: { clipboardReads += 1; return key }, clear: { clears += 1 }, submit: { tunnel, key, done in fakeAPI("/api/setup/key", ["tunnel_id":tunnel,"api_key":key], done) })
        let coordinator = ClientFeatureCoordinator(api: fakeAPI, watcher: watched, applyAppearance: { modes.append($0) })
        let inactive: [String: Any] = ["settings": ["appearance":"dark"], "setup": ["key_watch": ["active":false], "open_items": []]]
        coordinator.synchronize(state: inactive); coordinator.synchronize(state: inactive)
        check(modes == ["dark"] && clipboardReads == 0, "startup appearance cached and idle count only")
        count += 1 // key copied before the next native poll: it must not be missed.
        let active: [String: Any] = ["settings": ["appearance":"light"], "setup": ["key_watch": ["active":true]]]
        coordinator.synchronize(state: active); coordinator.synchronize(state: active)
        check(routes == ["/api/setup/await-key/status"], "one authenticated status poll in flight")
        let pendingRequest: [String: Any] = ["request": ["id":"coordinator-1","tunnel_id":"tunnel_abcdefgh","expires_at":Date().addingTimeInterval(60).timeIntervalSince1970 * 1000]]
        responses[0](pendingRequest); watched.tick()
        check(routes.last == "/api/setup/key" && clipboardReads == 1, "fast clipboard copy reaches existing key API")
        responses[1](["saved":true]); check(clears == 1 && !watched.active, "key success clears and stops")
        coordinator.setAppearance(mode: "invalid") { check($0["error_code"] as? String == "ARG_INVALID", "invalid native appearance") }
        check(routes.count == 2, "invalid mode does not mutate settings")
        coordinator.setAppearance(mode: "system") { check($0["mode"] as? String == "system", "appearance mode response") }
        responses[2](["ok":true]); check(modes == ["dark","light","system"], "appearance changes apply after save")
        coordinator.synchronize(state: active); let stale = responses.last!
        coordinator.serviceUnavailable(); stale(pendingRequest); check(!watched.active, "stale status cannot restart watch after service loss")
        coordinator.synchronize(state: active); check(routes.last == "/api/setup/await-key/status", "watch can resync after service recovery")
        let late = responses.last!; coordinator.close(); late(pendingRequest); coordinator.synchronize(state: inactive)
        check(!watched.active, "close blocks late callbacks and stops watch")
        let siteLine = "{\"format\":\"chathand-site-v2\",\"site_origin\":\"https://private-a.chatgpt.site\",\"site_id\":\"privateSiteA\",\"service_credential\":\"" + String(repeating: "s", count: 48) + "\"}"
        for scenario in ["quick-copy", "accepted-before-callback", "explicit-stop"] {
            var date = Date(timeIntervalSince1970: 100), changeCount = 0, reads = 0, clears = 0, sends = 0
            var completion: (([String: Any]) -> Void)?
            let siteWatcher = ClipboardSiteWatcher(changeCount: { changeCount }, read: { reads += 1; return siteLine },
                clear: { clears += 1 }, submit: { id, body, done in
                    sends += 1; check(id == "site-watch-1", "site watch ID bound")
                    check(body["site_id"] as? String == "privateSiteA", "strict site payload")
                    completion = done
                }, now: { date })
            siteWatcher.observeClipboardCount()
            check(reads == 0, "idle Site observer reads no clipboard content")
            changeCount += 1 // Copied after UI watch request but before native sees the lease.
            check(siteWatcher.start(id: "site-watch-1", expiresAt: date.addingTimeInterval(60), schedule: false), "site watch starts")
            siteWatcher.tick();check(reads == 1 && sends == 1, "quick Site copy is submitted once")
            if scenario == "accepted-before-callback" {
                siteWatcher.synchronize(["watching": false])
                check(siteWatcher.active, "accepted watch remains until its callback")
            }
            if scenario == "explicit-stop" {
                siteWatcher.synchronize(["watching": false, "stopped_id": "site-watch-1"])
                check(!siteWatcher.active, "explicit stop invalidates pending Site import")
            }
            completion?(["accepted": true])
            check(clears == (scenario == "explicit-stop" ? 0 : 1), "only current accepted Site copy clears")
            check(!siteWatcher.active, "Site watch stops after acceptance or explicit stop")
            date = date.addingTimeInterval(61)
        }
        print("PASS: \(checks) isolated native checks; no workspace open or real clipboard access")
    }
}
