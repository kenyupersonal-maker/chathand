// 1081 N203（Claude，Ken 10/27 同意退役）：旧的私有发布桥（Ken 自己 Site 上的 /release/bridge，F1/F5 开它）退役。
// 界面这边：H10 不再读发布配置、不再生成或打开那个地址，也没有打开私有发布页的按钮；离线 F1/F5 页里没有那段脚本；
// 旧桥那种 release 写法跟别的没核验过的来源一样被拒。
// 留着的：原生文件选择的本地 DMG、挂载 DMG 旁的 App、签名/安装没确认的提示。GitHub 更新在 app/，不在这里测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as offline from '../../ui/h10/offline.mjs';

const read=p=>fs.readFileSync(new URL("../../"+p,import.meta.url),'utf8');
// 注释里会写到退役的是哪条路，只查代码行。
const code=p=>read(p).split('\n').filter(line=>!/^\s*\/\//.test(line)).join('\n');
const retired=/\/release\/bridge|releaseBridge|ownerBridge|owner-release|open-release-bridge|releaseConfig|openPrivateReleasePage|loadReleaseBootstrap|openOwnerPrivateRelease|releaseState/;
const removedKeys=['ui.h10.host.privateSiteOpened','ui.h10.host.privateSiteMissing','ui.h10.host.privateReleaseOpened','ui.h10.host.privateReleaseMissing',
 'ui.h10.host.privateReleaseInstructions','ui.h10.host.privateReleaseUnconfigured','ui.h10.host.privateReleaseAction','ui.h10.host.privateReleaseConfigured',
 'ui.offline.privateSiteMissing','ui.offline.privateSiteAttempted','ui.offline.privateSiteConfigured'];

test('H10 and the window bridge no longer read release config or open the private release page',()=>{
 for(const file of ['ui/h10/host.mjs','ui/h10/views.mjs','ui/h10/offline.mjs','ui/app.js'])assert.doesNotMatch(code(file),retired,file);
 assert.equal(Object.hasOwn(offline,'releaseBridgeViews'),false);
});

test('F1/F5 keep the native DMG picker, and their links stay off without a release bridge',()=>{
 const host=code('ui/h10/host.mjs');
 assert.match(host,/picker\.dataset\.extra='select-dmg'/);
 assert.match(host,/native\?\.\('chooseReleaseDMG',\{\}\)/);
 assert.match(host,/sourceURLConfigured:false,downloadConfigured:false,verificationConfigured:false,/);
});

test('offline F1/F5 pages keep the mounted-disk App path and carry no private release script or copy',()=>{
 for(const screen of ['f1','f5'])for(const localAppCandidate of [false,true]){
  const html=offline.renderOfflinePage({screen,localAppCandidate}),label=screen+(localAppCandidate?' + local App':'');
  assert.doesNotMatch(html,retired,label);
  assert.doesNotMatch(html,/私有 Site|私有发布|private (release|Site)/i,label);
  assert.match(html,/function mountedApp\(\)\{/,label);
 }
});

test('an old bridge-shaped release descriptor is refused like any other unverified source',()=>{
 const old={site_origin:'https://site-b.example',bridge_path:'/release/bridge',build_number:1081,version:'1.0.0-beta.31',source_signed_config:true};
 for(const screen of ['f1','f5'])assert.throws(()=>offline.renderOfflinePage({screen,release:old}),/H10_RELEASE_NOT_VERIFIED/);
});

test('private release copy is gone from both languages; the install notices that remain point at the local DMG',()=>{
 const zh=JSON.parse(read('locales/zh.json')),en=JSON.parse(read('locales/en.json'));
 for(const key of removedKeys)for(const [name,L] of [['zh',zh],['en',en]])assert.equal(L[key],undefined,name+' '+key);
 for(const key of ['ui.h10.host.downloadUnconfigured','ui.offline.installSourceMissing','ui.offline.downloadMissing'])
  for(const [name,L] of [['zh',zh],['en',en]])assert.doesNotMatch(L[key],/私有|private/i,name+' '+key);
 assert.match(zh['ui.h10.host.downloadUnconfigured'],/DMG/);assert.match(en['ui.h10.host.downloadUnconfigured'],/DMG/);
 assert.match(zh['ui.offline.installSourceMissing'],/没有可验证/);
});
