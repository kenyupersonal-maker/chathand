import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('1062 native language uses isolated preferences, persistence and real menu/notification consumers',{skip:process.platform!=='darwin',timeout:120000},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1062-language-'));
 try{
  const directory=path.join(temp,'runtime/bin');fs.mkdirSync(directory,{recursive:true});
  fs.cpSync(path.join(root,'locales'),path.join(temp,'runtime/locales'),{recursive:true});
  const binary=path.join(directory,'LanguageChecks');
  const compile=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-framework','Cocoa','native/LocalText.swift','native/ClientNotifications.swift','native/MenuBarState.swift','native/tests/LanguagePreferenceChecks.swift','-o',binary],{cwd:root,encoding:'utf8',timeout:90000});
  assert.equal(compile.status,0,compile.stderr);
  const result=spawnSync(binary,[],{cwd:'/',encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS: isolated language persistence/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('1062 bridge refreshes cached native menus and notification actions without service restart',()=>{
 const main=fs.readFileSync(path.join(root,'native/main.swift'),'utf8');
 const bridge=main.slice(main.indexOf('case "setLanguage":'),main.indexOf('case "getSystemLocale":'));
 assert.match(bridge,/setLanguage\(data\["language"\]\)/);
 assert.match(bridge,/result\["ok"\].*refreshNativeLanguage\(\)/);
 assert.doesNotMatch(bridge,/startService\(|stopService\(|terminate\(|restartService\(/);
 const refresh=main.slice(main.indexOf('func refreshNativeLanguage()'),main.indexOf('func updateStatusIcon'));
 assert.match(refresh,/NativeLanguageMenu.refresh\(menu\)/);
 assert.match(refresh,/menu\?\.removeAllItems\(\)/);
 assert.match(refresh,/refreshStatusMenu\(\)/);
 assert.match(refresh,/registerConfirmationNotifications\(\)/);
 assert.match(main,/"preference":LocalText.preference,"locale":LocalText.systemLocale/);
 for(const relative of ['native/BrowserHost.swift'])assert.match(fs.readFileSync(path.join(root,relative),'utf8'),/LocalText.systemLocale/);
 assert.match(fs.readFileSync(path.join(root,'scripts/build-v09.mjs'),'utf8'),/'native\/LocalText.swift','native\/BrowserHost.swift'/);
});
