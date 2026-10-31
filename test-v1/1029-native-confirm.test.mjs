// 1029 J：编译并运行 Foundation 纯函数，另检查原生接线。不会启动 ChatHandShell。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const section=(s,start,end)=>{const a=s.indexOf(start),b=s.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,'source anchors '+start);return s.slice(a,b);};

test('native confirmation guard and navigation pass isolated Foundation checks',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1029-confirm-swift-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const binary=path.join(root,'checks'),cache=process.env.CHATHAND_TEST_SWIFT_CACHE||path.join(root,'module-cache');fs.mkdirSync(cache,{recursive:true});
 const env={...process.env,CHATHAND_STATE_DIR:path.join(root,'state'),CLANG_MODULE_CACHE_PATH:cache};
 const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',cache,'native/LocalText.swift','native/ClientNotifications.swift','native/ConfirmGuard.swift','test-v1/1029-native-confirm.swift','-o',binary],{encoding:'utf8',timeout:90000,env});
 assert.equal(compile.status,0,(compile.error?.code||'')+' '+compile.stderr);
 const run=spawnSync(binary,[],{encoding:'utf8',timeout:5000,env});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: \d+ isolated native confirmation checks/);console.log(run.stdout.trim());
});

test('native bridge owns confirmation answers and records source PID without using it to permit',()=>{
 const main=read('native/main.swift'),guard=read('native/ConfirmGuard.swift'),input=section(main,'    func confirmationInput(', '    func answerConfirmation(');
 assert.match(main,/case "confirmAnswer":\s*answerConfirmation\([^\n]*via:"window"/);assert.match(main,/NSEvent\.addLocalMonitorForEvents\(matching: \[\.leftMouseUp, \.keyDown\]\)/);assert.match(main,/event\.window === window/);assert.match(main,/return event \/\/ 不吞掉系统事件/);
 assert.match(input,/secondsSinceLastEventType\(\.hidSystemState, eventType:\.leftMouseDown\)/);assert.match(input,/secondsSinceLastEventType\(\.hidSystemState, eventType:\.keyDown\)/);assert.match(input,/"source_pid":pid/);assert.match(input,/let human = ConfirmGuard\.isHuman\(via:via, windowInputAge:age, hidClickAge:click, hidKeyAge:key\)/);
 assert.doesNotMatch(section(guard,'    static func isHuman','\n}'),/source_pid|sourcePID|eventSourceUnixProcessID/);assert.doesNotMatch(read('ui/app.js'),/\/api\/confirm\/answer/);
 const answer=section(main,'    func answerConfirmation(', '    func showClientRoute(');assert.match(answer,/scope == "deny" \? \["human":false\] : confirmationInput\(via:via\)/);assert.match(answer,/api\("\/api\/confirm\/answer"/);
 assert.match(read('app/server.mjs'),/event:'confirmation_input',[^\n]*input/);
});

test('notification categories, cleanup, safe fallback and inactive-turn reminder are wired',()=>{
 const main=read('native/main.swift');
 const registration=section(main,'    func registerConfirmationNotifications(', '    func confirmationInput(');assert.match(registration,/actions:\[always,deny\]/);assert.match(registration,/actions:\[deny\]/);assert.match(registration,/!notificationAuthorizationRequested/);assert.match(registration,/settings\["notifications"\] as\? Bool != false/);assert.match(registration,/requestAuthorization/);
 const notify=section(main,'    func notify(_ event:', '    func registerConfirmationNotifications(');assert.match(notify,/"confirmation_required","confirmation_closed"/);assert.match(notify,/removeDeliveredNotifications\(withIdentifiers:identifiers\)/);assert.match(notify,/removePendingNotificationRequests/);assert.match(notify,/scopes\.contains\("always"\) \? ClientNotifications\.confirmCategory : ClientNotifications\.confirmDenyCategory/);assert.match(notify,/identifier = "kb-confirm-" \+ id/);assert.match(notify,/c\.userInfo\["confirm_id"\] = id/);
 const handling=section(main,'    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive', '    func showPage(');assert.match(handling,/via:"notification"/);assert.match(handling,/CONFIRM_NOT_HUMAN/);assert.match(handling,/LocalText\.text\("native\.click\.unrecognized"\)/);assert.match(handling,/ClientNotifications\.denyAction/);
 const follow=section(main,'    func confirmationFollowUp(', '    func notifyComputerPermissions(');assert.match(follow,/result\["ai_waiting"\] as\? Bool == false/);assert.match(follow,/LocalText\.text\("native\.notification\.allowed\.body"\)/);assert.doesNotMatch(follow,/categoryIdentifier/);
 const poll=section(main,'    func poll(){','    func notify(');assert.match(poll,/notificationsOn \|\| e\["kind"\] as\? String == "confirmation_closed"/);
});

test('deep links only route and defer until the local UI is ready',()=>{
 const main=read('native/main.swift'),nativeRoute=section(main,'    func application(_ application: NSApplication, open urls:', '    func applicationWillTerminate('),navigate=section(main,'    func showClientRoute(', '    func confirmationFollowUp(');
 assert.match(nativeRoute,/ClientNotifications\.route\(for:url\)/);assert.doesNotMatch(nativeRoute,/api\(|answerConfirmation|confirmAnswer/);assert.doesNotMatch(navigate,/api\(|answerConfirmation|confirmAnswer/);assert.match(navigate,/guard clientUIReady/);assert.match(navigate,/JSONSerialization\.data\(withJSONObject:target\)/);assert.match(navigate,/confirmationRequested/);assert.match(navigate,/permissionItemRequested/);assert.match(navigate,/window\.openDrawer\('task',target\.task_id\)/);
 assert.match(read('native/Package.swift'),/"ConfirmGuard.swift"/);
 const plist=read('native/Info.plist');assert.match(plist,/<key>CFBundleURLTypes<\/key>/);assert.match(plist,/<key>CFBundleURLSchemes<\/key><array><string>chathand<\/string>/);
 const check=spawnSync(process.execPath,['scripts/generate-version.mjs','--check'],{encoding:'utf8',timeout:10000});assert.equal(check.status,0,check.stderr);assert.match(check.stdout,/VERSION_FILES_MATCH/);
});
