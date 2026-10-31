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

const SHEET='CHROME_INSTALL_SHEET_UNKNOWN',TARGET='CHROME_INSTALL_TARGET_UNKNOWN';
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const base=(code=SHEET)=>({stage:'preparing',outcome:'stopped',code,ms:7,target_is_default:null});
const cases=[
 [TARGET,'WINDOWS_AX_ERROR',-25204],[TARGET,'WINDOWS_VALUE_MISSING',0],
 [TARGET,'WINDOWS_VALUE_INVALID',0],[TARGET,'WINDOWS_TOO_MANY',0],
 [TARGET,'WINDOW_ID_DUPLICATE'],[SHEET,'WINDOW_ROLE_AX_ERROR',-25204],
 [SHEET,'WINDOW_ROLE_VALUE_INVALID',0],[SHEET,'WINDOW_ROLE_MISMATCH',0],
 [SHEET,'WINDOW_ID_READER_MISSING'],[SHEET,'WINDOW_ID_UNAVAILABLE'],
 [SHEET,'SHEETS_DEADLINE'],[SHEET,'SHEETS_TIMEOUT_AX_ERROR',-25204],
 [SHEET,'SHEETS_AX_ERROR',-25205],[SHEET,'SHEETS_NOVALUE_WITH_VALUE',-25212],
 [SHEET,'SHEETS_VALUE_MISSING',0],[SHEET,'SHEETS_VALUE_NOT_ARRAY',0],
 [SHEET,'SHEETS_ARRAY_CAST_FAILED',0],[SHEET,'SHEETS_ELEMENT_INVALID',0],
 [SHEET,'SHEETS_PRESENT',0]
];

test('1077 preflight details preserve categorical reasons and the original failure code only',()=>{
 for(const [code,detail_code,ax_error] of cases){
  const detail={detail_code,...(ax_error===undefined?{}:{ax_error})};
  assert.deepEqual(chromeInstallFields({...base(code),...detail,path:'PRIVATE_PATH',title:'PRIVATE_TITLE',value:'PRIVATE_AX_VALUE'}),{...base(code),...detail});
  assert.deepEqual(chromeInstallFailureFields({...base(code),...detail}),detail);
  assert.deepEqual(chromeInstallFailureFields({...base(code===TARGET?SHEET:TARGET),...detail}),{});
  for(const patch of [{stage:'extensions'},{outcome:'running'},{code:'CHROME_INSTALL_USER_INTERRUPTED'}])
   assert.deepEqual(chromeInstallFailureFields({...base(code),...detail,...patch}),{});
 }
});

test('1077 malformed optional details cannot hide a stopped outcome or inject diagnostic content',()=>{
 const invalid=[
  {detail_code:'PRIVATE_PATH',ax_error:-25205},
  {detail_code:'<script>private</script>',ax_error:-25205},
  {ax_error:-25205},{detail_code:'SHEETS_AX_ERROR'},
  ...[null,true,false,1.5,'-25205',{},NaN,Infinity,-2147483649,2147483648,0,-25212].map(ax_error=>({detail_code:'SHEETS_AX_ERROR',ax_error})),
  {detail_code:'SHEETS_PRESENT',ax_error:-25205},
  {detail_code:'SHEETS_NOVALUE_WITH_VALUE',ax_error:-25205},
  {detail_code:'WINDOW_ID_UNAVAILABLE',ax_error:0}
 ];
 for(const fields of invalid)assert.deepEqual(chromeInstallFields({...base(),...fields}),base());
 assert.deepEqual(chromeInstallFailureFields(null),{});
 for(const ax_error of [-2147483648,2147483647])
  assert.equal(chromeInstallFailureFields({...base(),detail_code:'SHEETS_AX_ERROR',ax_error}).ax_error,ax_error);
});

function probeFixture(){
 let now=0;const events=[],policy={epoch:1,permissionRevision:1,check(){}},state={data:{browser_enabled:true,desktop_enabled:true}};
 const probe=new ChromeInstallProbe({state,policy,extension:{},now:()=>now,diagnostic:event=>events.push(event)});
 const report=(attempt_id,native_event,code,extra={})=>probe.progress(undefined,'preparing',{attempt_id,native_event,code,elapsed_ms:7,target_is_default:null,...extra});
 return {probe,policy,state,events,report,time:value=>now=value};
}
test('1077 attempt-bound stopped detail survives duplicate reports and never leaks into the next run',()=>{
 const f=probeFixture();f.report(A,'started');
 f.report(A,'stopped',SHEET,{detail_code:'SHEETS_AX_ERROR',ax_error:-25205});
 const status=f.probe.publicStatus(undefined,A);
 assert.equal(status.phase,'stopped');assert.equal(status.active,false);assert.equal(status.code,SHEET);
 assert.equal(status.detail_code,'SHEETS_AX_ERROR');assert.equal(status.ax_error,-25205);
 status.detail_code='changed by caller';assert.equal(f.probe.publicStatus().detail_code,'SHEETS_AX_ERROR');
 assert.equal(f.report(A,'stopped',SHEET).discarded,true);
 f.probe.progress(undefined,'preparing',{native_event:'stopped',code:SHEET,elapsed_ms:7,target_is_default:null});
 assert.equal(f.probe.publicStatus().detail_code,'SHEETS_AX_ERROR');
 f.report(B,'started');assert.equal(f.probe.publicStatus().detail_code,undefined);assert.equal(f.probe.publicStatus().ax_error,undefined);
 assert.equal(f.report(A,'stopped',SHEET,{detail_code:'SHEETS_PRESENT',ax_error:0}).discarded,true);
 assert.equal(f.probe.publicStatus().active,true);
 f.policy.permissionRevision++;assert.equal(f.probe.publicStatus().code,'INSTALL_ACCESS_CHANGED');
 assert.equal(f.probe.publicStatus().detail_code,undefined);
 assert.equal(JSON.stringify(f.events).includes(A),false);
});

test('1077 invalid detail still stops the matching attempt using its original main code',()=>{
 const f=probeFixture();f.report(A,'started');f.report(A,'stopped',SHEET,{detail_code:'SHEETS_AX_ERROR',ax_error:'PRIVATE_AX_VALUE'});
 const status=f.probe.publicStatus();assert.equal(status.active,false);assert.equal(status.code,SHEET);
 assert.equal(status.detail_code,undefined);assert.equal(status.ax_error,undefined);
 assert.equal(JSON.stringify(f.events).includes('PRIVATE_AX_VALUE'),false);
});

test('1077 diagnostic writer and reader retain only bounded failure categories in an isolated state',t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1077-preflight-')));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const writer=new DiagnosticEvents(temp,{salt:Buffer.alloc(32)});
 assert.equal(writer.record('chrome.install',{...base(),detail_code:'SHEETS_AX_ERROR',ax_error:-25205,path:'PRIVATE_PATH',title:'PRIVATE_TITLE',profile_name:'PRIVATE_PROFILE'}),true);
 const result=readChromeInstallEvents(temp);assert.equal(result.events.length,1);
 assert.equal(result.events[0].detail_code,'SHEETS_AX_ERROR');assert.equal(result.events[0].ax_error,-25205);
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

test('1077 both an immediate failure and an acknowledged attempt show the same safe diagnostic code',async()=>{
 const detail={detail_code:'SHEETS_AX_ERROR',ax_error:-25205};
 const immediate=uiFixture({error:{code:SHEET},...detail});
 await immediate.context.startExtensionSetup('','repair');
 assert.match(immediate.views.at(-1),/SHEETS_AX_ERROR/);assert.match(immediate.views.at(-1),/AX -25205/);
 const acknowledged=uiFixture({started:true,attempt_id:A},{phase:'stopped',active:false,stage:'preparing',code:SHEET,attempt_id:A,...detail});
 await acknowledged.context.startExtensionSetup('','repair');await acknowledged.tick();
 assert.match(acknowledged.views.at(-1),/SHEETS_AX_ERROR/);assert.match(acknowledged.views.at(-1),/AX -25205/);
 assert.equal(acknowledged.calls.includes('extensionCancel'),false);
});

test('1077 UI ignores arbitrary detail values and details outside a preflight failure',()=>{
 const f=uiFixture({});
 for(const patch of [{detail_code:'<script>PRIVATE_VALUE</script>',ax_error:-25205},{detail_code:'SHEETS_AX_ERROR',stage:'extensions'},{detail_code:'SHEETS_AX_ERROR',code:'CHROME_INSTALL_CANCELLED'}]){
  f.context.showChromeInstall({phase:'stopped',active:false,stage:'preparing',code:SHEET,...patch});
  assert.doesNotMatch(f.views.at(-1),/PRIVATE_VALUE|SHEETS_AX_ERROR/);
 }
 f.context.showChromeInstall({phase:'stopped',active:false,stage:'preparing',code:SHEET,detail_code:'WINDOW_ID_UNAVAILABLE',ax_error:'<script>PRIVATE_VALUE</script>'});
 assert.match(f.views.at(-1),/WINDOW_ID_UNAVAILABLE/);assert.doesNotMatch(f.views.at(-1),/PRIVATE_VALUE/);
});
