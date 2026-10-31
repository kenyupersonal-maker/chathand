// ONE1052 source-only contract tests. No browser, GUI, host, Site or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {renderH10,STEP_TITLES} from '../ui/h10/views.mjs';
import {assets} from '../ui/h10/assets.mjs';
import {installationHandoff} from '../ui/h10/prompts.mjs';
import {renderOfflinePage,renderDmgArtwork} from '../ui/h10/offline.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'..');
const read=p=>fs.readFileSync(path.join(repo,p),'utf8');

test('production H10 uses approved static assets only and all five F7 steps',()=>{
 assert.equal(STEP_TITLES.length,5);
 const folder=fs.readdirSync(path.join(repo,'ui/h10'));
 for(const name of ['fixtures.mjs','review.mjs','review.css','index.html','evidence-source'])
  assert.equal(folder.includes(name),false,name+' must not ship with approved views');
 for(const asset of Object.values(assets)){
  assert.ok(asset?.src?.startsWith('./assets/'));
  assert.equal(fs.statSync(path.join(repo,'ui/h10',asset.src)).isFile(),true);
 }
 const vm={provenance:'host',screen:'f7',connectionRoute:'site',steps:[]};
 const html=renderH10(vm,{assets,review:false});
 assert.equal((html.match(/class="h10-progress-row"/g)||[]).length,5);
 assert.doesNotMatch(html,/已经在 ChatGPT 桌面版里填好了/);
 assert.doesNotMatch(html,/已完成连接/);
});
test('F15 requires current installation host proof; manual one-click switching only when provided',()=>{
 const vm={provenance:'host',screen:'f15',connectionRoute:'site',scope:'computer'};
 assert.throws(()=>renderH10(vm,{assets,review:false}),/F15 requires/);
 const honest=renderH10({...vm,completionView:'current-installation-verified'},{assets,review:false});
 assert.doesNotMatch(honest,/data-action="manual-switch"/);
 const available=renderH10({...vm,completionView:'current-installation-verified',manualSwitchTo:'openai',manualSwitchLabel:'切换到 OpenAI 通道'},{assets,review:false});
 assert.match(available,/data-action="manual-switch" data-value="openai"/);
});
test('F1/F5 no fabricated download or successful prefill',()=>{
 const handoff=installationHandoff();
 assert.equal(handoff.configured,false);assert.equal(handoff.deepLink,null);
 for(const screen of ['f1','f5']){
  const html=renderOfflinePage({screen});
  assert.match(html,/data-action="install-assisted" disabled/);
  assert.match(html,/data:image\/[^"]+;base64,/);
  assert.doesNotMatch(html,/<script[^>]+src=/);
 }
 assert.throws(()=>renderOfflinePage({screen:'f1',release:{downloadURL:'https://example.com/test'}}),/H10_RELEASE_NOT_VERIFIED/);
});
test('F4 uses approved698x718 artwork and real Finder objects remain separate',()=>{
 const html=renderDmgArtwork();
 assert.match(html,/width:698px;height:718px/);
 assert.ok(html.includes('将 ChatHand 拖入「应用程序」'));
 assert.doesNotMatch(html,/@VERSION@|https?:\/\//);
 assert.ok(html.includes(JSON.parse(read('package.json')).version));
 assert.doesNotMatch(html,/src="\.\/assets\//);
 const map=JSON.parse(read('ui/assets/dmg/src/finder-layout.json'));
 assert.deepEqual(map.content_size,[698,718]);
 assert.equal(map.icon_size,64);
 assert.deepEqual(map.icon_centers,{'让 ChatGPT 来装':[565,276],ChatHand:[350,578],'应用程序':[486,578],'第一次打开':[610,578]});
});
test('H10 production bindings remain guarded and current healthy A old path is preserved',()=>{
 const host=read('ui/h10/host.mjs'),wizard=read('ui/wizard.js'),server=read('app/server.mjs'),native=read('native/main.swift');
 const entrySource=wizard.split('window.h10Entry=state=>')[1]?.split('window.wizardRefresh=state=>')[0];
 assert.ok(entrySource,'production startup selector is present');
 const window={};vm.runInNewContext('window.h10Entry=state=>'+entrySource,{window});
 // 1083（Claude，Ken 10/28 21:38）：没选过连接方式默认 OpenAI 通道（原来是 Site）。
 assert.deepEqual({...window.h10Entry({settings:{},site_b:{selected:'openai'}})}, {route:'openai',screen:'f6'});
 assert.deepEqual({...window.h10Entry({settings:{},site_b:{selected:'openai',routes:{site:{configured:true}}}})},
  {route:'site',screen:'f12'});
 assert.equal(window.h10Entry({settings:{tunnel:{tunnel_id:'existing'}},site_b:{selected:'openai'}}),null);
 assert.equal(window.h10Entry({settings:{setup_complete:true},site_b:{selected:'site'}}),null);
 assert.match(wizard,/startWizard\(\)/);
 assert.match(server,/api\/site-b\/select/);
 assert.match(server,/export function needsInterface/);
 assert.match(read('app/v1/client-features.mjs'),/export function requireClientInterface/);
 assert.match(host,/completionProof\(s\)/);
 assert.match(host,/isHealthy\(state,to\)/);
 assert.match(native,/case "pasteSiteGrant"/);
 assert.match(native,/NSPasteboard\.general\.clearContents\(\)/);
 assert.doesNotMatch(host,/enrollment_grant\s*:/);
});
