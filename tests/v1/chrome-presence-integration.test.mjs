import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {ExtensionBrowser} from '../../app/v09/extension-browser.mjs';
import {browserModelStatus} from '../../app/v1/chrome-store-status.mjs';
import {storeTestDistribution,storeTestHelper} from '../support/chrome-store-fixture.mjs';
import {fixture,waitFor} from './1070-chrome-server-fixture.mjs';
const distribution=storeTestDistribution();
function browser(t){const state={data:{browser_enabled:true,mode:'auto',chrome_store_observation:{extension_id:distribution.extension_id,last_seen:Date.now()}},project:()=>({path:'/synthetic'})};const policy={epoch:1,check(){},require(){},tasks:new Map()};const ext=new ExtensionBrowser(state,{},policy,{distribution});t.after(()=>ext.closeAll());return ext;}
test('model names removed, disabled, stalled and closed-Chrome readiness; unknown keeps fallback',()=>{
 const base={distribution:'chrome_web_store',connected:false,installation_previously_observed:true};
 for(const [state,stalled,available,word,button] of [['missing',false,false,'移除','重新安装'],['disabled',false,false,'关闭','去 Chrome 打开'],['enabled',true,false,'连不上','重新连接'],['enabled',false,true,'已安装',null]]){
 const out=browserModelStatus({extension:{...base,presence:{state,chrome_running:false,stalled}}}).extension;assert.equal(out.available,available);assert.match(out.detail,new RegExp(word));if(button)assert.match(out.recovery,new RegExp(button));else assert.equal(out.recovery,null);
 }
 assert.match(browserModelStatus({extension:{...base,presence:{state:'unknown'}}}).extension.recovery,/检查 Chrome/);
 const current=browserModelStatus({extension:{...base,connected:true,presence:{state:'disabled'}}}).extension;assert.equal(current.available,true);assert.equal(current.recovery,null);
});
test('a fresh missing/disabled result stops AI browser action before waking Chrome',t=>{
 for(const [state,code,button] of [['missing','EXTENSION_REMOVED','重新安装'],['disabled','EXTENSION_DISABLED','去 Chrome 打开']]){
 const ext=browser(t);let refreshed=0,wakes=0;ext.refreshPresence=options=>{assert.equal(options.force,true);refreshed++;return {state};};ext.wakeChrome=()=>{wakes++;};
 assert.throws(()=>ext.request('new',{url:'https://example.com'},'caller','task'),e=>e.code===code&&e.recovery.includes(button));assert.equal(refreshed,1);assert.equal(wakes,0);
 }
});
test('fresh enabled supersedes an old removed observation and retains automatic wake',async t=>{
 const ext=browser(t);ext.presence={state:'missing'};ext.refreshPresence=()=>({state:'enabled'});ext.wakeChrome=()=>{};let wakes=0;ext.wakeAndRetry=async()=>{wakes++;return {ok:true};};assert.deepEqual(await ext.request('new',{},'caller','task'),{ok:true});assert.equal(wakes,1);
});
test('real server projects presence to status, skips reads before opt-in and on connection, and reconnect repairs host and resets stalled',async t=>{
 const reads=[],reader={refresh(o){reads.push(o);return o.optedIn&&!o.connected?{state:'enabled',chrome_running:o.chromeRunning,stalled:false,checked_at:1}:undefined;},resetStalled(){this.resets=(this.resets||0)+1;}};
 const f=fixture(t,{chromeDistribution:distribution,browser:true,optedIn:false,chromePresence:reader,chromeRunning:()=>true}),app=await f.building,ext=app.tools.automation.browser.extension;
 await new Promise(r=>setImmediate(r));assert.equal(ext.status().presence,undefined);assert.ok(reads.every(x=>x.optedIn===false));
 app.state.data.browser_control_opt_in=true;ext.refreshPresence({force:true});assert.equal((await f.post('/api/browser/extension/store/status')).body.presence.state,'enabled');
 ext.next(crypto.randomUUID(),storeTestHelper());assert.equal(ext.status().presence,undefined);assert.equal(reads.at(-1).connected,true);
 f.calls.cloud='up';await waitFor(()=>f.calls.starts===1);await app.snapshot();const before=f.calls.registers;const out=await f.post('/api/browser/extension/reconnect');assert.equal(out.status,200);assert.ok(f.calls.registers>before);assert.equal(reader.resets,1);
});
