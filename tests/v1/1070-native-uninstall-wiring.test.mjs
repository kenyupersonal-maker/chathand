import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('1070 menu uninstall awaits bounded revoke after ownership locking and before backend shutdown',()=>{
 const main=fs.readFileSync(new URL('../../native/main.swift',import.meta.url),'utf8');
 const menu=main.slice(main.indexOf('@objc private func uninstallChatHand'),main.indexOf('@MainActor private func stopForUninstall'));
 const revoke=menu.indexOf('await ChatHandUninstallRevoke.run('),lock=menu.indexOf('try plan.excludeUpgrade()'),stop=menu.indexOf('try await stopForUninstall(');
 assert.ok(lock>=0&&revoke>lock&&stop>revoke);
 const call=menu.slice(revoke,menu.indexOf('var loginRemoved=',revoke));
 assert.match(call,/deleteData:plan\.deleteData/);
 assert.match(call,/ownerAvailable:ownsService && interfaceKeyShared/);
 assert.match(call,/self\.api\(endpoint,body,completion:done\)/);
 assert.match(call,/record\(stage,code\)/);
 assert.doesNotMatch(call,/throw|guard|state\[/);
 assert.match(menu,/phase:"uninstall_"\+stage/);
 assert.match(menu,/plan\.executeStages\(backendStopped:stopped,loginRemoved:login,exclusion:exclusion/);
});
