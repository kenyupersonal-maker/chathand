import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setupOpenItems} from '../../app/v1/permissions.mjs';
import {ToolsRefresher} from '../../app/v1/tools-refresh.mjs';
import {Repair} from '../../app/v1/repair.mjs';
import {storeTestDistribution} from '../support/chrome-store-fixture.mjs';
const distribution=storeTestDistribution();
test('store setup requires a current connection; legacy setup retains its existing installation hint',()=>{
 const state={data:{mode:'auto',browser_enabled:true,terminal_enabled:true},project:()=>({path:'/synthetic'})};
 const item=browser=>setupOpenItems(state,{browser}).find(x=>x.id==='browser');
 const history={backend:'extension',distribution:'chrome_web_store',connected:false,installed:null,last_seen:100,installation_previously_observed:true};
 const offline=item(history);assert.equal(offline.status,'todo');assert.equal(offline.detail.installed,null);assert.equal(offline.detail.installation_previously_observed,true);
 assert.equal(item({...history,connected:true,installed:true}).status,'done');
 assert.equal(item({...history,distribution:'legacy_unpacked',installed:true}).status,'done');
});
test('store tools refresh wakes once without installation history; disabled or missing extension still stops honestly',async()=>{
 for(const connects of [true,false]){let woke=0;const status={selected_backend:'extension',extension:{distribution:'chrome_web_store',connected:false,installed:null,last_seen:null,compatibility:{state:'unknown'}}};
 const r=new ToolsRefresher({distribution,invoke:async()=>status,wakeChrome:async()=>{woke++;if(connects)Object.assign(status.extension,{connected:true,compatibility:{state:'compatible'}});}});
 const result=await r.waitHelper('manual');assert.equal(woke,1);assert.equal(result.ok,connects);if(!connects)assert.equal(result.code,'EXTENSION_DISCONNECTED');}
 let woke=0;const legacy=new ToolsRefresher({distribution:{distribution:'legacy_unpacked'},invoke:async()=>({selected_backend:'extension',extension:{connected:false}}),wakeChrome:async()=>woke++});assert.equal((await legacy.waitHelper('manual')).ok,false);assert.equal(woke,0);
});
function repair(t,{connects=false,enabled=true,optedIn=true,openError=null}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-live-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=0,opened=0;
 const s={enabled:true,settings:{browser_enabled:enabled,desktop_enabled:false},connection:{process_running:true,ready:true,healthy:true,control_plane:{state:'up'}},automation:{browser:{extension:{distribution:'chrome_web_store',connected:false,installed:null,last_seen:null,installation_previously_observed:true,compatibility:{state:'unknown'}}},computer:{permissions:{}}},setup_test:{status:'read_write'}};
 const manifest=path.join(root,'host.json'),binary=path.join(root,'host');fs.writeFileSync(manifest,JSON.stringify({name:'com.kenyu.chathand.browser',path:binary,type:'stdio',allowed_origins:[`chrome-extension://${distribution.extension_id}/`]}));
 const r=new Repair({distribution,registrationOnlyAfterOptIn:true,browserOptIn:()=>optedIn,snapshot:async()=>s,now:()=>now,sleep:async ms=>{now+=ms;},systemProxy:()=>null,probePort:async()=>false,restoreTunnel:async()=>({ok:false}),browserHost:{manifestPath:manifest,expectedBinary:binary,register(){}},openChromeInBackground:async()=>{opened++;if(openError)throw openError;if(connects)Object.assign(s.automation.browser.extension,{connected:true,compatibility:{state:'compatible'}});},cleanupUpgrade:async()=>({cleaned:0})});
 return {get opened(){return opened;},get elapsed(){return now;},async run(){const value=r.start();for(let i=0;i<200&&value.status==='running';i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(value.status,'done');return value.items.find(x=>x.id==='browser_helper');}};
}
test('store repair wakes without a live installation claim and reports real reconnect success/failure',async t=>{
 const good=repair(t,{connects:true});assert.equal((await good.run()).status,'fixed');assert.equal(good.opened,1);
 const bad=repair(t);const result=await bad.run();assert.equal(bad.opened,1);assert.equal(result.code,'EXTENSION_DISCONNECTED');assert.equal(result.action.kind,'manage_chrome_extensions');
 for(const options of [{enabled:false},{optedIn:false}]){const off=repair(t,options);assert.equal((await off.run()).status,'skipped');assert.equal(off.opened,0);}
});

test('repair stops immediately on revoked access and treats unknown launch errors as failures',async t=>{for(const code of ['CAPABILITY_OFF','LOCAL_DISABLED','INSTALL_ACCESS_CHANGED','PERMISSION_TRANSITION','UPGRADE_VERIFYING']){const f=repair(t,{openError:Object.assign(Error(code),{code})});assert.equal((await f.run()).status,'skipped');assert.equal(f.elapsed,0);}const f=repair(t,{openError:Error('UNKNOWN_OPEN_ERROR')});assert.equal((await f.run()).status,'failed');assert.equal(f.elapsed,0);});
