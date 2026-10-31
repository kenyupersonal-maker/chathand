import Foundation

@main struct NativeWatchChecks {
    static func main() {
        var now=Date(timeIntervalSince1970:100),count=0,reads=0,clears=0,sends=0
        var callbacks:[([String:Any])->Void]=[]
        let payload="{\"format\":\"chathand-site-v2\",\"site_origin\":\"https://fixture.chatgpt.site\",\"site_id\":\"fixture-site\",\"service_credential\":\""+String(repeating:"s",count:48)+"\"}"
        func makeWatcher() -> ClipboardSiteWatcher {
            ClipboardSiteWatcher(changeCount:{count},read:{reads+=1;return payload},clear:{clears+=1},submit:{_,_,done in sends+=1;callbacks.append(done)},now:{now})
        }
        let watcher=makeWatcher()
        precondition(watcher.start(id:"watch-A",expiresAt:now.addingTimeInterval(900),schedule:false))
        now=now.addingTimeInterval(899)
        watcher.synchronize(["watching":true,"watch_id":"watch-A","expires_at":now.addingTimeInterval(900).timeIntervalSince1970*1000])
        now=now.addingTimeInterval(2);count+=1;watcher.tick()
        precondition(watcher.active && sends==1 && reads==1) // original expiry passed; real progress renewed it
        watcher.synchronize(["watching":false,"stopped_id":"watch-A","stopped_reason":"route_changed"])
        callbacks[0](["accepted":true,"phase":"pairing"])
        let readsAtStop=reads;count+=1;watcher.tick()
        precondition(!watcher.active && clears==0 && reads==readsAtStop && sends==1)
        let restarted=makeWatcher()
        restarted.synchronize(["watching":false,"stopped_id":"watch-A","stopped_reason":"route_changed"])
        restarted.tick();precondition(!restarted.active && reads==readsAtStop) // authoritative stopped state after restart
        precondition(watcher.start(id:"watch-B",expiresAt:now.addingTimeInterval(900),schedule:false))
        watcher.synchronize(["watching":true,"watch_id":"watch-B","expires_at":now.addingTimeInterval(5).timeIntervalSince1970*1000])
        now=now.addingTimeInterval(5);count+=1;watcher.tick()
        precondition(!watcher.active && reads==readsAtStop) // shortened deadline applies at its exact boundary
        precondition(watcher.start(id:"watch-C",expiresAt:now.addingTimeInterval(900),schedule:false))
        watcher.synchronize(["watching":true,"watch_id":"watch-C","expires_at":now.timeIntervalSince1970*1000])
        precondition(!watcher.active) // an expired server lease stops immediately, without clipboard access
        for intent in ["setup","repair","add"] {
            for locale in ["zh","en"] {
                let prompt="\(intent) / \(locale): 这件事要在这台 Mac 上的桌面 ChatGPT 本机会话里做。C++ & a=b?x#1\nDo not send automatically."
                let parts=URLComponents(url:SetupConversation.promptURL(prompt)!,resolvingAgainstBaseURL:false)!
                precondition(parts.queryItems?.map(\.name)==["prompt","mode"] && parts.queryItems?.first?.value==prompt
                    && parts.queryItems?.last?.value=="codex")
            }
        }
        print("PASS: renewed/shortened watch deadlines, authoritative stop/restart and stale callback isolation; six unsent draft roundtrips; no real clipboard, URL dispatch or permissions")
    }
}
