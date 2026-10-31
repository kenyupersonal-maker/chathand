import vm from 'node:vm';
import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
import {storeTestDistribution} from '../test-support/chrome-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Repair,ensureBrowserHost} from '../app/v1/repair.mjs';
import {aiBrief} from '../app/v1/ai-brief.mjs';
import {lastOutputLine} from '../app/v1/job-line.mjs';
import {recentErrorCodes} from '../app/v1/support.mjs';

function harness(t,{browser=false,desktop=false,distribution=storeTestDistribution()}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-support-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s={enabled:true,mode:'full',settings:{browser_enabled:browser,desktop_enabled:desktop,tunnel:{tunnel_id:'test-only'}},credentials:{healthy:true},connection:{process_running:true,ready:true,healthy:true,control_plane:{state:'up',proxy:'http://127.0.0.1:7890'}},automation:{browser:{extension:{connected:false}},computer:{permissions:{accessibility:true,screen_recording:true}}},setup_test:{status:'read_write'}};
 let now=0;const calls={restore:0,open:0,register:0};
 const host={manifestPath:path.join(dir,'com.kenyu.chathand.browser.json'),expectedBinary:path.join(dir,'ken-browser-host'),register(){calls.register++;fs.writeFileSync(host.manifestPath,JSON.stringify({name:'com.kenyu.chathand.browser',path:host.expectedBinary,type:'stdio',allowed_origins:['chrome-extension://'+(distribution.extension_id||'a'.repeat(32))+'/']}));}};
 const deps={distribution,snapshot:()=>s,now:()=>now,sleep:async ms=>{now+=ms;},systemProxy:()=> 'http://127.0.0.1:7890',probePort:async()=>false,browserHost:host,restoreTunnel:async()=>{calls.restore++;Object.assign(s.connection,{process_running:true,ready:true,healthy:true});},openChromeInBackground:async()=>{calls.open++;s.automation.browser.extension.connected=true;},cleanupUpgrade:async()=>({cleaned:0})};
 const repair=new Repair(deps);
 const finish=async body=>{const running=repair.start(body);assert.equal(running.status,'running');assert.equal(repair.start({}),running);for(let i=0;i<150&&running.status==='running';i++)await new Promise(r=>setImmediate(r));assert.equal(running.status,'done');return running;};
 return {dir,s,deps,calls,host,repair,finish};
}
test('repair reconnects, reports the proxy port and exposes only recent error codes',async t=>{
 const h=harness(t);assert.equal(h.repair.current(),null);h.s.connection.process_running=false;
 const r=await h.finish();assert.equal(r.summary.text_key,'repair.summary.fixedActionNeeded');assert.deepEqual(r.summary.text_params,{fixed:1,actionNeeded:1,failed:0});for(const item of r.items){assert.ok(Object.hasOwn(item,'title_key'),item.id);assert.ok(Object.hasOwn(item,'title_params'),item.id);assert.ok(Object.hasOwn(item,'message_key'),item.id);assert.ok(Object.hasOwn(item,'message_params'),item.id);}assert.equal(h.calls.restore,1);assert.equal(r.items.find(i=>i.id==='tunnel').status,'fixed');
 const proxy=r.items.find(i=>i.id==='proxy_alive');assert.equal(proxy.status,'action');assert.equal(proxy.message_key,'repair.common.proxyOff.message');assert.deepEqual(proxy.message_params,{address:'127.0.0.1:7890'});assert.match(proxy.message,/127\.0\.0\.1:7890/);
 assert.equal(r.summary.text,'已修复 1 项，1 项需手动处理');assert.equal(r.summary.fixed,1);assert.equal(r.summary.action_needed,1);assert.equal(r.summary.failed,0);
 assert.deepEqual(r.items.map(i=>i.id),['paused','credentials','tunnel','proxy_match','proxy_alive','cloud','chatgpt_tools','browser_host','browser_helper','desktop_permissions','login_item','upgrade_leftover']);
 fs.writeFileSync(path.join(h.dir,'audit.jsonl'),[{event:'tool_error',time:1,code:'FIRST',title:'private'},{event:'tool_error',time:2,code:'unsafe-value',payload:'private'},{event:'tool_error',time:3,code:'LAST'}].map(e=>JSON.stringify(e)).join('\n'));
 assert.deepEqual(recentErrorCodes(h.dir,2),[{time:2,code:'REDACTED'},{time:3,code:'LAST'}]);assert.deepEqual(recentErrorCodes(h.dir,0),[]);
 // Browser registration is repaired once and subsequently preserved.
 h.s.settings.browser_enabled=true;assert.equal(await ensureBrowserHost(h.deps),'fixed');assert.equal(await ensureBrowserHost(h.deps),'ok');assert.equal(h.calls.register,1);
 fs.writeFileSync(h.host.manifestPath,'{}');assert.equal(await ensureBrowserHost(h.deps),'fixed');
 h.deps.browserHost.register=()=>{throw Error('private details');};fs.writeFileSync(h.host.manifestPath,'{}');assert.equal(await ensureBrowserHost(h.deps),'failed');
});
test('disabled browser and desktop capabilities are skipped without opening Chrome',async t=>{
 const h=harness(t,{distribution:legacyChromeDistribution()}),r=await h.finish({login_item_requires_approval:true});
 for(const id of ['browser_host','browser_helper','desktop_permissions']){const item=r.items.find(i=>i.id===id);assert.equal(item.status,'skipped');assert.equal(item.message,'已关闭，不检查');}
 assert.equal(h.calls.open,0);assert.equal(h.calls.register,0);assert.equal(r.items.find(i=>i.id==='login_item').action.kind,'open_login_items');
 h.s.settings.browser_enabled=true;h.s.settings.desktop_enabled=true;h.repair.deps.probePort=async()=>true;
 const next=await h.finish();assert.equal(next.items.find(i=>i.id==='browser_host').status,'fixed');assert.equal(next.items.find(i=>i.id==='browser_helper').status,'fixed');assert.equal(h.calls.open,1);
 // A failed item does not prevent later checks; no exception text is exposed.
 h.repair.deps.systemProxy=()=>{throw Error('private details');};const last=await h.finish();assert.equal(last.items.find(i=>i.id==='proxy_match').message,'此项检查失败');assert.equal(last.items.at(-1).status,'ok');
 h.s.settings.access_enabled=false;h.s.enabled=false;h.s.connection.process_running=false;const paused=await h.finish();assert.equal(paused.items.find(i=>i.id==='paused').action.kind,'resume');assert.equal(paused.items.find(i=>i.id==='tunnel').status,'skipped');assert.equal(h.calls.restore,0);
});
test('AI brief includes executable instructions while keeping sensitive snapshot fields private',()=>{
 const secret='sk-'+'x'.repeat(24),channel=['tunnel','test1234567'].join('_'),workspace='/private/client-workspace',title='Private task title';
 const snapshot={about:{version:'1.0.0-beta.3',build:1011},version:'1.0.0-beta.3',mode:'full',settings:{tunnel:{tunnel_id:channel,api_key:secret},browser_enabled:false},connection:{ready:true,healthy:true,tunnel_id:channel,control_plane:{state:'up',proxy:'http://user:'+secret+'@127.0.0.1:7890'}},credentials:{api_key:secret},jobs:[{title}],project:{root:workspace},automation:{computer:{permissions:{accessibility:true,screen_recording:true}}}};
 const {text}=aiBrief({snapshot,errors:[{time:1,code:secret,payload:workspace}],repair:{items:[{id:'tunnel',status:'failed',message:title}]},appPath:'/Users/test/Applications/ChatHand.app',home:'/Users/test',osVersion:'26.0'});
 for(const value of [secret,channel,workspace,title,'/Users/test'])assert.equal(text.includes(value),false,'sensitive field escaped the whitelist');
 assert.match(text,/doctor/);assert.match(text,/~\/Applications\/ChatHand\.app\/Contents\/Resources\/runtime\/skills\/chathand-setup\/references\/troubleshooting\.md/);assert.match(text,/网络：代理 127\.0\.0\.1:7890/);assert.match(text,/检查：tunnel=failed/);assert.match(text,/此项检查失败/);
 const dev=aiBrief({snapshot,appPath:'/tmp/development-repo',osVersion:'26.0'}).text;assert.match(dev,/\/tmp\/development-repo\/skills\/chathand-setup\/scripts\/setup\.mjs/);
});
test('last output line removes terminal escapes, ignores blank lines and limits Unicode length',()=>{
 assert.equal(lastOutputLine([]),'');assert.equal(lastOutputLine([{stream:'stdout',text:'older\n\x1b[31m最后一行\x1b[0m\n\n\x00'},{stream:'status',text:'not command output'}]),'最后一行');
 const long=lastOutputLine([{stream:'stderr',text:'prefix\n\x1b[32m'+'😀'.repeat(140)+'\x1b[0m\n \n'}]);assert.equal(Array.from(long).length,120);assert.equal(long.endsWith('…'),true);assert.equal(long.includes('\x1b'),false);
 assert.equal(lastOutputLine([{stream:'stdout',text:'x'.repeat(5000)+'\n'},{stream:'stderr',text:'\x1b]0;window title\x07done\rupdated\n'}]),'updated');
 assert.equal(lastOutputLine([{stream:'stdout',text:'first\n\x1b['},{stream:'stdout',text:'31mcombined\x1b[0m\n'}]),'combined');
 assert.equal(lastOutputLine([{stream:'stdout',text:'a\tb\x01c\n'}]),'abc');
});

// A store repair offers a window action, while Chrome installation still needs the user.
test('CWS repair for a disconnected extension offers the store action without opening Chrome',async t=>{
 const h=harness(t,{browser:true,distribution:storeTestDistribution()});
 const result=await h.finish();
 const item=result.items.find(i=>i.id==='browser_helper');
 assert.equal(item.status,'action');
 assert.equal(h.calls.open,0);
 assert.equal(item.action.kind,'install_helper');
 const ui=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');
 const nativeCalls=[],dialog={open:false,dataset:{}};
 const context=vm.createContext({S:{...h.s,automation:{browser:{extension:{...h.s.automation.browser.extension,...h.deps.distribution}}}},CHATGPT_URL:'https://chatgpt.com/',Date,E:String,T:k=>k,TH:k=>k,
  btn:()=>'',tbtn:()=>'',modal:(_html,kind)=>{dialog.open=true;dialog.dataset.kind=kind;},$:()=>dialog,closeModal:async()=>{dialog.open=false;},capOn:()=>true,refresh:async()=>{},
  native:async(name,data)=>{nativeCalls.push({name,data});return {opened:true};},api:async()=>({connected:false,compatibility:{state:'unknown'}}),
  setTimeout:()=>1,clearTimeout(){},toast(){},extensionSuccessToast:async()=>{}});
 vm.runInContext(ui.split('\n').find(line=>line.startsWith('const REPAIR_ACTIONS='))+'\nthis.repairActions=REPAIR_ACTIONS;',context);
 vm.runInContext(ui.slice(ui.indexOf('let chromeInstallView='),ui.indexOf('function desktopSheet()')),context);
 const start=ui.indexOf(" case'extensionSetup':"),end=ui.indexOf(" case'extensionSetupWithDesktop':",start);
 vm.runInContext('async function openRepairAction(name,id){switch(name){'+ui.slice(start,end)+'}}',context);
 const [name,id]=context.repairActions[item.action.kind];
 assert.equal(name,'extensionSetup');
 await context.openRepairAction(name,id);
 // Ken 10/26：先出说明，点「打开 Chrome」才打开商店页面
 assert.equal(nativeCalls.length,0);
 assert.equal(dialog.dataset.kind,'chrome-store');
 await context.openRepairAction('chromeStoreOpen','');
 assert.equal(nativeCalls.length,1);
 assert.equal(nativeCalls[0].name,'openChromeStore');
 assert.equal(h.calls.open,0);
});
