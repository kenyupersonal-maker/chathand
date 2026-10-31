import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// 1070：先等辅助功能的那一轮，原生先回「开始了」，要选 Chrome 用户时改从安装状态里带 choose_profile。
const source=fs.readFileSync(new URL('../../ui/app.js',import.meta.url),'utf8');
function fixture(statuses,started={started:true,phase:'waiting_accessibility'}){
 const outputs=[],calls=[],asked=[],timers=new Map();let next=0;
 const context=vm.createContext({T:k=>k,TH:k=>k,S:{},capOn:()=>true,scheduleRender:()=>{},E:String,btn:(text,kind,id)=>`[${text}|${kind}|${id||''}]`,modal:text=>outputs.push(text),native:async(action,args)=>{calls.push([action,args]);return started;},api:async(route,body)=>{asked.push(body);return statuses.length>1?statuses.shift():statuses[0];},refresh:async()=>{},setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(source.slice(source.indexOf('let chromeInstallView='),source.indexOf('function desktopSheet()')),context);
 const setup=source.slice(source.indexOf(" case'extensionSetup':"),source.indexOf(" case'extensionManual':"));
 vm.runInContext('async function perform(kind,id=""){switch(kind){'+setup+'}}',context);
 const tick=async()=>{const [id,fn]=[...timers][0]||[];if(!fn)return false;timers.delete(id);await fn();return true;};
 return {context,outputs,calls,asked,timers,tick,run:(kind,id)=>context.perform(kind,id)};
}
const profiles=[{id:'Default',name:'Work'},{id:'Profile 2',name:'Home',installed:true}];
test('1070 a profile choice that arrives through install status opens the chooser and stops polling',async()=>{
 const f=fixture([{phase:'loading',active:true,stage:'waiting_accessibility'},{phase:'choose_profile',active:false,stage:'checking_profile',choose_profile:true,profiles,selected_profile:'Profile 2',repair:false,attempt_id:'00000000-0000-4000-8000-000000000000'}]);
 await f.run('extensionSetup');assert.equal(f.timers.size,1);
 await f.tick();assert.equal(f.timers.size,1);
 await f.tick();assert.equal(f.timers.size,0);
 const last=f.outputs.at(-1);
 assert.match(last,/\[Work\|extensionSetup\|Default\]/);assert.match(last,/\[Home[^|]*\|extensionSetup\|Profile 2\]/);
 assert.equal(f.calls.filter(([a])=>a==='extensionCancel').length,0);
});
test('1070 a profile choice during replace keeps the replace action',async()=>{
 const f=fixture([{phase:'choose_profile',active:false,choose_profile:true,profiles,selected_profile:'',repair:true}]);
 await f.run('extensionSetup');await f.tick();assert.equal(f.timers.size,0);
 const last=f.outputs.at(-1);
 assert.match(last,/\|extensionRepair\|Default\]/);assert.doesNotMatch(last,/\|extensionSetup\|/);
});
test('1070 a status without profiles is not treated as a choice',async()=>{
 const f=fixture([{phase:'stopped',active:false,choose_profile:true,profiles:[],code:'CHROME_INSTALL_CANCELLED'}]);
 await f.run('extensionSetup');await f.tick();assert.equal(f.timers.size,0);
 assert.doesNotMatch(f.outputs.at(-1),/\|extensionSetup\|Default\]/);
});
const A='0a1b2c3d-0000-4000-8000-00000000000a',B='0a1b2c3d-0000-4000-8000-00000000000b';
test('1070 a known attempt id is sent with every status poll and a choice from another attempt is ignored',async()=>{
 const f=fixture([{phase:'choose_profile',active:false,choose_profile:true,profiles,selected_profile:'',repair:false,attempt_id:B}],{started:true,phase:'waiting_accessibility',attempt_id:A.toUpperCase()});
 await f.run('extensionSetup');await f.tick();
 assert.equal(JSON.stringify(f.asked),JSON.stringify([{attempt_id:A}]));
 assert.doesNotMatch(f.outputs.at(-1),/\|extensionSetup\|Default\]/);
});
test('1070 a choice from the same attempt opens the chooser',async()=>{
 const f=fixture([{phase:'choose_profile',active:false,choose_profile:true,profiles,selected_profile:'Default',repair:false,attempt_id:A}],{started:true,attempt_id:A});
 await f.run('extensionSetup');await f.tick();assert.equal(f.timers.size,0);
 assert.match(f.outputs.at(-1),/\[Work\|extensionSetup\|Default\]/);
});
test('1070 without an attempt id the poll sends no id',async()=>{
 const f=fixture([{phase:'loading',active:true}]);
 await f.run('extensionSetup');await f.tick();assert.equal(JSON.stringify(f.asked),"[{}]");
});
