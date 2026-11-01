import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('1069 native setup URL is navigation-only, network notifications retry with backoff and persist delivery watermarks',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1069-network-native-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'main.swift'),binary=path.join(root,'checks');
 fs.writeFileSync(source,`import Foundation
@main struct Checks {static func main(){
 func check(_ value:Bool){if !value {exit(1)}}
 check(ClientNotifications.route(for:URL(string:"chathand://setup/openai")!) == ["page":"setup","section":"openai"])
 for url in ["chathand://setup/site","chathand://setup/openai/","chathand://setup/openai?allow=true","chathand://setup/openai#allow","https://setup/openai"] {check(ClientNotifications.route(for:URL(string:url)!) == nil)}
 check(ClientNotifications.networkChallengeTarget(kind:"network_challenge") == ["page":"setup","section":"openai"])
 check(ClientNotifications.networkChallengeTarget(kind:"connection_lost") == nil)
 var gate=NetworkChallengeNotificationGate()
 check(gate.next(key:"fixture:1",nowMS:1) == .deliver)
 check(gate.next(key:"fixture:1",nowMS:2) == .none)
 gate.completed(key:"fixture:1",succeeded:false,nowMS:3)
 check(gate.next(key:"fixture:1",nowMS:30_002) == .none)
 check(gate.next(key:"fixture:1",nowMS:30_003) == .deliver)
 gate.completed(key:"fixture:1",succeeded:true,nowMS:30_004)
 check(gate.next(key:"fixture:1",nowMS:30_005) == .none)
 check(gate.next(key:"fixture:1",nowMS:60_004) == .acknowledge)
 var restarted=NetworkChallengeNotificationGate(delivered:gate.delivered)
 check(restarted.next(key:"fixture:1",nowMS:60_005) == .acknowledge)
 check(restarted.next(key:"fixture:2",nowMS:60_006) == .deliver)
 print("PASS")
}}`);
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/LocalText.swift','native/ClientNotifications.swift',source,'-o',binary],{encoding:'utf8',timeout:90000});assert.equal(compile.status,0,compile.stderr);const ran=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(ran.status,0,ran.stderr);assert.match(ran.stdout,/PASS/);
});
test('1069 native wiring routes the notification through showClientRoute, acknowledges only accepted delivery, and respects disabled notifications',()=>{const source=fs.readFileSync(new URL('../../native/main.swift',import.meta.url),'utf8');assert.match(source,/if let target=ClientNotifications.networkChallengeTarget\(kind:kind\)\s*\{\s*self.showClientRoute\(target\)/);assert.match(source,/func presentNetworkChallenge[\s\S]*?\["notifications"\] as\? Bool != false/);assert.match(source,/if error == nil \{[\s\S]*?\/api\/network-challenge\/notification\/ack/);assert.match(source,/else \{ self.notifiedKeys.removeAll/);});
// 1083（Claude，Ken 10/28）：网络验证那条系统通知说清是 Cloudflare 网络验证、常见于代理或 VPN（原来写的是「VPS」）；英文照现在的文案规矩用弯引号、标题大写。
test('1069 network notification copy names the Cloudflare network check and a proxy or VPN (Ken 10/28)',()=>{const zh=JSON.parse(fs.readFileSync(new URL('../../locales/zh.json',import.meta.url))),en=JSON.parse(fs.readFileSync(new URL('../../locales/en.json',import.meta.url)));assert.equal(zh['native.notification.networkChallenge.title'],'ChatGPT 无法连接这台 Mac');assert.equal(en['native.notification.networkChallenge.title'],'ChatGPT Can’t Reach This Mac');assert.equal(zh['native.notification.networkChallenge.body'],'Site 连接被 Cloudflare 网络验证拦截，常见于使用代理或 VPN 时。点击改用 OpenAI 通道。');assert.equal(en['native.notification.networkChallenge.body'],'Cloudflare’s network check is blocking Site, often due to a proxy or VPN. Click to use the OpenAI Tunnel.');});
