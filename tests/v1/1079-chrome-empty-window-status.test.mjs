import {legacyChromeDistribution} from '../../app/v1/chrome-distribution.mjs';
class ChromeInstallProbe extends ProductionChromeInstallProbe {constructor(options){super({...options,distribution:legacyChromeDistribution()});}}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {ChromeInstallProbe as ProductionChromeInstallProbe} from '../../app/v1/chrome-install-probe.mjs';
import {chromeInstallFields,chromeInstallFailureFields,DiagnosticEvents,readChromeInstallEvents} from '../../app/diagnostic-events.mjs';

const SHEET='CHROME_INSTALL_SHEET_UNKNOWN';
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const base={stage:'preparing',outcome:'stopped',code:SHEET,ms:7,target_is_default:null};
const failure={detail_code:'SHEETS_AX_ERROR',ax_error:-25205,fallback_code:'CHILDREN_EMPTY'};
const context={window_relation:'OTHER',empty_window_minimized:false,empty_window_main:false,empty_window_focused:false,app_active:false,app_hidden:false,window_subrole:'STANDARD'};
const keys=Object.keys(context),boolKeys=keys.filter(key=>typeof context[key]==='boolean');

test('1079 empty-window metadata keeps only bounded classifications in the exact failure envelope',()=>{
 for(const window_relation of ['SAME','OTHER','UNKNOWN','PROCESS_CHANGED','ANCHOR_MISSING']){
  for(const window_subrole of ['STANDARD','DIALOG','UNKNOWN']){
   for(const value of [true,false]){
    const fields={...context,window_relation,window_subrole,...Object.fromEntries(boolKeys.map(key=>[key,value]))};
    assert.deepEqual(chromeInstallFailureFields({...base,...failure,...fields}),{...failure,...fields});
    assert.deepEqual(chromeInstallFields({...base,...failure,...fields,window_id:'PRIVATE_ID',pid:734,profile_path:'PRIVATE_PATH',raw_role:'PRIVATE_ROLE'}),{...base,...failure,...fields});
   }
  }
 }
});

test('1079 malformed optional fields are dropped individually without hiding the primary failure',()=>{
 for(const key of keys){
  const bad=boolKeys.includes(key)?[null,0,1,'false',{},[]]:[null,true,7,{},[],'PRIVATE_VALUE','<script>private</script>'];
  for(const value of bad){
   const expected={...context};delete expected[key];
   assert.deepEqual(chromeInstallFields({...base,...failure,...context,[key]:value}),{...base,...failure,...expected});
  }
 }
 for(const patch of [{stage:'extensions'},{outcome:'running'},{code:'CHROME_INSTALL_TARGET_UNKNOWN'},
   {fallback_code:'CHILD_ROLE_DISALLOWED'},{detail_code:'SHEETS_PRESENT',ax_error:0},{ax_error:-25204}]){
  const result=chromeInstallFields({...base,...failure,...context,...patch});
  for(const key of keys)assert.equal(result[key],undefined);
  assert.equal(result.code,patch.code||SHEET);assert.equal(result.outcome,patch.outcome||'stopped');
 }
});

function probeFixture(){
 const events=[],policy={epoch:1,permissionRevision:1,check(){}},state={data:{browser_enabled:true,desktop_enabled:true}};
 const probe=new ChromeInstallProbe({state,policy,extension:{},now:()=>0,diagnostic:event=>events.push(event)});
 const report=(attempt_id,native_event,code,extra={})=>probe.progress(undefined,'preparing',{attempt_id,native_event,code,elapsed_ms:7,target_is_default:null,...extra});
 return {probe,policy,events,report};
}
test('1079 window context is bound to the current stopped attempt and cleared before any next run',()=>{
 const f=probeFixture();f.report(A,'started');f.report(A,'stopped',SHEET,{...failure,...context});
 const status=f.probe.publicStatus(undefined,A);
 assert.equal(status.phase,'stopped');assert.equal(status.active,false);
 for(const key of keys)assert.equal(status[key],context[key]);
 status.window_relation='PRIVATE_MUTATION';assert.equal(f.probe.publicStatus().window_relation,'OTHER');
 assert.equal(f.report(A,'stopped',SHEET,{...failure,window_relation:'SAME'}).discarded,true);
 assert.equal(f.probe.publicStatus().window_relation,'OTHER');
 f.report(B,'started');for(const key of keys)assert.equal(f.probe.publicStatus()[key],undefined);
 assert.equal(f.report(A,'stopped',SHEET,{...failure,...context}).discarded,true);
 assert.equal(f.probe.publicStatus().active,true);f.policy.permissionRevision++;
 assert.equal(f.probe.publicStatus().code,'INSTALL_ACCESS_CHANGED');
 for(const key of keys)assert.equal(f.probe.publicStatus()[key],undefined);
 assert.equal(JSON.stringify(f.events).includes(A),false);assert.equal(JSON.stringify(f.events).includes('PRIVATE_'),false);
});

test('1079 isolated diagnostic storage never writes raw identity or arbitrary AX values',t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1079-window-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const writer=new DiagnosticEvents(temp,{salt:Buffer.alloc(32)});
 assert.equal(writer.record('chrome.install',{...base,...failure,...context,window_id:'PRIVATE_ID',window_title:'PRIVATE_TITLE',pid:734,profile_path:'PRIVATE_PATH',raw_subrole:'PRIVATE_ROLE'}),true);
 const result=readChromeInstallEvents(temp);assert.equal(result.events.length,1);
 for(const key of keys)assert.equal(result.events[0][key],context[key]);
 assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);assert.equal(result.events[0].pid,undefined);
});

const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
function uiFixture(reply,status){
 const views=[],timers=new Map(),calls=[];let serial=0;
 const context=vm.createContext({S:{},T:(key,p)=>key+(p?JSON.stringify(p):''),TH:key=>key,
  E:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  btn:(_label,action)=>'ACTION:'+action,modal:html=>views.push(html),capOn:()=>true,
  native:async action=>{calls.push(action);return reply;},api:async()=>status,refresh:async()=>{},
  extensionSuccessToast:async()=>{throw Error('failed diagnostic must not show installation success');},
  setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
 const start=source.indexOf('let chromeInstallView='),end=source.indexOf('function desktopSheet()',start);
 assert.ok(start>0&&end>start);vm.runInContext(source.slice(start,end),context);
 return {context,views,calls,async tick(){const [id,fn]=[...timers][0]||[];assert.ok(fn);timers.delete(id);await fn();}};
}
test('1079 immediate and acknowledged empty-window errors expose the same finite facts',async()=>{
 const detail={...failure,...context};
 const immediate=uiFixture({error:{code:SHEET},...detail});await immediate.context.startExtensionSetup('','repair');
 const acknowledged=uiFixture({started:true,attempt_id:A},{phase:'stopped',active:false,stage:'preparing',code:SHEET,attempt_id:A,...detail});
 await acknowledged.context.startExtensionSetup('','repair');await acknowledged.tick();
 for(const f of [immediate,acknowledged]){
  for(const code of ['CHILDREN_EMPTY','WINDOW_OTHER','MINIMIZED_FALSE','MAIN_FALSE','FOCUSED_FALSE','APP_ACTIVE_FALSE','APP_HIDDEN_FALSE','SUBROLE_STANDARD'])assert.ok(f.views.at(-1).includes(code),code);
  assert.equal(f.calls.includes('extensionCancel'),false);
 }
});
test('1079 UI ignores arbitrary context and omits context outside CHILDREN_EMPTY',()=>{
 const f=uiFixture({});
 f.context.showChromeInstall({phase:'stopped',active:false,...base,...failure,window_relation:'<script>PRIVATE_ID</script>',app_hidden:'false',window_subrole:'PRIVATE_ROLE'});
 assert.doesNotMatch(f.views.at(-1),/PRIVATE_|APP_HIDDEN_|WINDOW_|SUBROLE_/);
 for(const patch of [{stage:'extensions'},{code:'CHROME_INSTALL_TARGET_UNKNOWN'},{fallback_code:'CHILD_ROLE_DISALLOWED'},{ax_error:-25204}]){
  f.context.showChromeInstall({phase:'stopped',active:false,...base,...failure,...context,...patch});
  assert.doesNotMatch(f.views.at(-1),/WINDOW_OTHER|APP_ACTIVE_|MINIMIZED_|SUBROLE_STANDARD/);
 }
});
