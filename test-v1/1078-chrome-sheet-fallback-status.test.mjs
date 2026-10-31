import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
class ChromeInstallProbe extends ProductionChromeInstallProbe {constructor(options){super({...options,distribution:legacyChromeDistribution()});}}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {ChromeInstallProbe as ProductionChromeInstallProbe} from '../app/v1/chrome-install-probe.mjs';
import {chromeInstallFields,chromeInstallFailureFields,DiagnosticEvents,readChromeInstallEvents} from '../app/diagnostic-events.mjs';

const SHEET='CHROME_INSTALL_SHEET_UNKNOWN';
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const base={stage:'preparing',outcome:'stopped',code:SHEET,ms:7,target_is_default:null};
const original={detail_code:'SHEETS_AX_ERROR',ax_error:-25205};
const reasons=['ENTRY_VALUE_PRESENT','DEADLINE','PERMISSION_CHANGED','TIMEOUT_SETUP_FAILED',
 'WINDOW_ROLE_READ_FAILED','WINDOW_ROLE_INVALID','CHILDREN_READ_FAILED','CHILDREN_INVALID',
 'CHILDREN_EMPTY','CHILDREN_LIMIT','CHILD_IDENTITY_INVALID','CHILD_ROLE_READ_FAILED',
 'CHILD_ROLE_INVALID','CHILD_ROLE_DISALLOWED','CHILD_PARENT_READ_FAILED','CHILD_PARENT_INVALID','SNAPSHOT_CHANGED'];

test('1078 fallback rejection preserves the original stopped contract with bounded categories only',()=>{
 for(const fallback_code of reasons){
  const detail={...original,fallback_code};
  assert.deepEqual(chromeInstallFailureFields({...base,...detail}),detail);
  assert.deepEqual(chromeInstallFields({...base,...detail,role:'PRIVATE_ROLE',parent:'PRIVATE_PARENT',path:'PRIVATE_PATH'}),{...base,...detail});
 }
});

test('1078 malformed optional fallback never suppresses the original failure or carries arbitrary values',()=>{
 for(const fallback_code of [undefined,null,true,false,42,{},[],['DEADLINE'],'CHILD_ROLE_DISALLOWED\n','MODAL_FALSE','/PRIVATE_PATH','<script>PRIVATE</script>']){
  assert.deepEqual(chromeInstallFields({...base,...original,fallback_code}),{...base,...original});
 }
 for(const patch of [{ax_error:-25204},{ax_error:-25212},{ax_error:0},{detail_code:'SHEETS_PRESENT',ax_error:0},
   {code:'CHROME_INSTALL_TARGET_UNKNOWN',detail_code:'WINDOWS_AX_ERROR'},
   {stage:'extensions'},{outcome:'running'},{outcome:'completed'},{code:'CHROME_INSTALL_PERMISSION_CHANGED'}]){
  const status=chromeInstallFields({...base,...original,fallback_code:'DEADLINE',...patch});
  assert.equal(status.fallback_code,undefined);
  assert.equal(status.code,patch.code||SHEET);
  assert.equal(status.outcome,patch.outcome||'stopped');
 }
});

function probeFixture(){
 const events=[],policy={epoch:1,permissionRevision:1,check(){}},state={data:{browser_enabled:true,desktop_enabled:true}};
 const probe=new ChromeInstallProbe({state,policy,extension:{},now:()=>0,diagnostic:event=>events.push(event)});
 const report=(attempt_id,native_event,code,extra={})=>probe.progress(undefined,'preparing',{attempt_id,native_event,code,elapsed_ms:7,target_is_default:null,...extra});
 return {probe,policy,events,report};
}

test('1078 fallback stays bound to its stopped attempt through duplicate reports and caller mutation',()=>{
 const f=probeFixture();f.report(A,'started');
 f.report(A,'stopped',SHEET,{...original,fallback_code:'CHILD_ROLE_DISALLOWED'});
 const status=f.probe.publicStatus(undefined,A);
 assert.equal(status.active,false);assert.equal(status.phase,'stopped');assert.equal(status.code,SHEET);
 assert.equal(status.fallback_code,'CHILD_ROLE_DISALLOWED');
 status.fallback_code='PRIVATE_MUTATION';
 assert.equal(f.probe.publicStatus().fallback_code,'CHILD_ROLE_DISALLOWED');
 assert.equal(f.report(A,'stopped',SHEET,{...original,fallback_code:'DEADLINE'}).discarded,true);
 assert.equal(f.probe.publicStatus().fallback_code,'CHILD_ROLE_DISALLOWED');
 f.report(B,'started');
 assert.equal(f.probe.publicStatus().fallback_code,undefined);
 assert.equal(f.report(A,'stopped',SHEET,{...original,fallback_code:'DEADLINE'}).discarded,true);
 assert.equal(f.probe.publicStatus().active,true);
 f.policy.permissionRevision++;
 assert.equal(f.probe.publicStatus().code,'INSTALL_ACCESS_CHANGED');
 assert.equal(f.probe.publicStatus().fallback_code,undefined);
 assert.equal(JSON.stringify(f.events).includes(A),false);
 assert.equal(JSON.stringify(f.events).includes('PRIVATE_'),false);
});

test('1078 invalid native fallback remains a stopped primary failure',()=>{
 const f=probeFixture();f.report(A,'started');
 f.report(A,'stopped',SHEET,{...original,fallback_code:'PRIVATE_AX_ROLE'});
 const status=f.probe.publicStatus();
 assert.equal(status.phase,'stopped');assert.equal(status.active,false);assert.equal(status.code,SHEET);
 assert.equal(status.detail_code,original.detail_code);assert.equal(status.ax_error,original.ax_error);
 assert.equal(status.fallback_code,undefined);
 assert.equal(JSON.stringify(f.events).includes('PRIVATE_AX_ROLE'),false);
});

test('1078 isolated diagnostic storage round-trips only approved fallback reasons',t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1078-fallback-')));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const writer=new DiagnosticEvents(temp,{salt:Buffer.alloc(32)});
 for(const fallback_code of reasons)
  assert.equal(writer.record('chrome.install',{...base,...original,fallback_code,role:'PRIVATE_ROLE',parent:'PRIVATE_PARENT',profile_name:'PRIVATE_PROFILE'}),true);
 assert.equal(writer.record('chrome.install',{...base,...original,fallback_code:'PRIVATE_AX_VALUE'}),true);
 const result=readChromeInstallEvents(temp);
 assert.equal(result.events.length,reasons.length+1);
 assert.deepEqual(result.events.slice(0,-1).map(event=>event.fallback_code),reasons);
 assert.equal(result.events.at(-1).fallback_code,undefined);
 assert.equal(result.events.at(-1).code,SHEET);
 assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

const source=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');
function uiFixture(reply,status){
 const views=[],timers=new Map(),calls=[];let serial=0;
 const context=vm.createContext({S:{},T:(key,p)=>key+(p?JSON.stringify(p):''),TH:key=>key,
  E:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  btn:(_label,action)=>'ACTION:'+action,modal:html=>views.push(html),capOn:()=>true,
  native:async action=>{calls.push(action);return reply;},api:async()=>status,refresh:async()=>{},
  extensionSuccessToast:async()=>{throw Error('failed installation must not show success');},
  setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
 const start=source.indexOf('let chromeInstallView='),end=source.indexOf('function desktopSheet()',start);
 assert.ok(start>0&&end>start);vm.runInContext(source.slice(start,end),context);
 return {context,views,calls,async tick(){const [id,fn]=[...timers][0]||[];assert.ok(fn);timers.delete(id);await fn();}};
}

test('1078 immediate and acknowledged failures show the same bounded fallback code without success or retry',async()=>{
 const detail={...original,fallback_code:'CHILD_ROLE_DISALLOWED'};
 const immediate=uiFixture({error:{code:SHEET},...detail});
 await immediate.context.startExtensionSetup('','repair');
 const acknowledged=uiFixture({started:true,attempt_id:A},{phase:'stopped',active:false,stage:'preparing',code:SHEET,attempt_id:A,...detail});
 await acknowledged.context.startExtensionSetup('','repair');await acknowledged.tick();
 for(const f of [immediate,acknowledged]){
  assert.match(f.views.at(-1),/CHROME_INSTALL_SHEET_UNKNOWN \/ SHEETS_AX_ERROR \/ AX -25205 \/ CHILD_ROLE_DISALLOWED/);
  assert.equal(f.calls.includes('extensionCancel'),false);
  assert.equal(f.calls.filter(call=>call==='extensionRepair').length,1);
 }
});

test('1078 UI omits fallback outside the exact unsupported-sheet context',()=>{
 const f=uiFixture({});
 for(const patch of [{fallback_code:'<script>PRIVATE_VALUE</script>'},{ax_error:-25204},
   {code:'CHROME_INSTALL_TARGET_UNKNOWN'},{detail_code:'SHEETS_PRESENT'},
   {stage:'extensions'},{active:true},{phase:'running',active:true}]){
  f.context.showChromeInstall({phase:'stopped',active:false,stage:'preparing',code:SHEET,...original,fallback_code:'CHILD_ROLE_DISALLOWED',...patch});
  assert.doesNotMatch(f.views.at(-1),/PRIVATE_VALUE|CHILD_ROLE_DISALLOWED/);
 }
});
