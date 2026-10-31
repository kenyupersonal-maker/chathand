import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const source=read('ui/app.js');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){
 const nativeCalls=[],posts=[],toasts=[],attributes=new Map(),context={console,Map,Set,URL,Date,Promise,
  document:{documentElement:{dataset:{},setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k)}},
  S:{settings:{appearance:'system'}},IN_APP:true,scheduleRender(){},toast:m=>toasts.push(m),
  native:(action,body)=>{const reply=deferred();nativeCalls.push({action,body,...reply});return reply.promise;},
  api:async(route,body)=>{posts.push({route,body});return {};},
  __CHATHAND_TEXT_CATALOGS__:{zh:JSON.parse(read('locales/zh.json')),en:JSON.parse(read('locales/en.json'))}};
 context.window=context;vm.createContext(context);vm.runInContext(read('ui/local-text.js'),context);
 vm.runInContext(source.match(/^const T=.*$/m)[0],context);
 // Execute production appearance action, with its shared transaction helpers when present.
 const start=source.indexOf(" case'appearance':"),end=source.indexOf("\n case'tier':",start);assert.ok(start>=0&&end>start);
 const helperStart=source.indexOf('// Appearance transaction state.'),helperEnd=source.indexOf('// End appearance transaction.',helperStart);
 if(helperStart>=0){assert.ok(helperEnd>helperStart);vm.runInContext(source.slice(helperStart,helperEnd),context);}
 vm.runInContext("async function appearanceAction(id){switch('appearance'){"+source.slice(start,end)+'}}',context);
 return {context,nativeCalls,posts,toasts,attributes,run:id=>context.appearanceAction(id),theme:()=>attributes.get('data-theme')||'system'};
}

test('one successful native appearance selection persists once and keeps real text bootstrap',async()=>{
 const f=fixture(),pending=f.run('dark');assert.equal(f.theme(),'dark');f.nativeCalls[0].resolve({mode:'dark'});await pending;
 assert.equal(f.context.S.settings.appearance,'dark');assert.equal(f.posts.length,0,'native already persisted settings');assert.equal(f.nativeCalls.length,1);assert.notEqual(f.context.ChatHandText.t('ui.window.action.appearance.text'),'ui.window.action.appearance.text');
});
for(const oldFailed of [false,true])test('old appearance '+(oldFailed?'failure':'success')+' cannot change latest selection or persist/rollback',async()=>{
 const f=fixture(),old=f.run('dark'),latest=f.run('light');assert.equal(f.nativeCalls.length,2);f.nativeCalls[1].resolve({mode:'light'});await latest;
 f.nativeCalls[0].resolve(oldFailed?{error_code:'LOCAL_NETWORK'}:{mode:'dark'});await old;await flush();
 assert.equal(f.context.S.settings.appearance,'light');assert.equal(f.theme(),'light');assert.equal(f.nativeCalls.length,2);assert.equal(f.posts.length,0);assert.equal(f.toasts.length,0);
});
test('service cancellation cannot roll back a newly synchronized appearance',async()=>{
 const f=fixture(),pending=f.run('dark');f.context.S={settings:{appearance:'light'}};f.attributes.set('data-theme','light');
 f.nativeCalls[0].resolve({cancelled:true});await pending;assert.equal(f.theme(),'light');assert.equal(f.context.S.settings.appearance,'light');assert.equal(f.posts.length,0);assert.equal(f.nativeCalls.length,1);assert.equal(f.toasts.length,0);
});
test('latest failed selection preserves the existing failure message without another persistence request',async()=>{
 const f=fixture(),pending=f.run('dark');f.nativeCalls[0].resolve({error_code:'LOCAL_NETWORK'});await pending;
 assert.equal(f.theme(),'system');assert.equal(f.context.S.settings.appearance,'system');assert.equal(f.toasts.length,1);assert.equal(f.toasts[0],f.context.ChatHandText.t('ui.window.action.appearance.text'));assert.equal(f.nativeCalls.length,1);assert.equal(f.posts.length,0);
});
for(const mode of ['light','dark','system'])test('latest '+mode+' selection succeeds normally',async()=>{
 const f=fixture(),pending=f.run(mode);f.nativeCalls[0].resolve({mode});await pending;assert.equal(f.theme(),mode);assert.equal(f.context.S.settings.appearance,mode);assert.equal(f.posts.length,0);assert.equal(f.toasts.length,0);
});

test('ordinary state synchronization preserves active selection and expired intent permits fresh state',async()=>{
 const f=fixture(),pending=f.run('dark');
 f.context.S={settings:{appearance:'light'}};f.context.synchronizeAppearance();assert.equal(f.theme(),'dark');
 f.nativeCalls[0].resolve({mode:'dark'});await pending;assert.equal(f.theme(),'dark');
 f.context.S={settings:{appearance:'light'}};f.context.synchronizeAppearance();assert.equal(f.theme(),'light');
});
test('same UI deadline is passed to native and late result cannot project after expiry',async()=>{
 const f=fixture();let now=100000;f.context.Date={now:()=>now};const pending=f.run('dark');
 assert.equal(f.nativeCalls[0].body.expires_at,130000);now=130000;f.nativeCalls[0].resolve({mode:'dark'});await pending;
 assert.equal(f.theme(),'system');assert.equal(f.context.S.settings.appearance,'system');assert.equal(f.nativeCalls.length,1);assert.equal(f.posts.length,0);assert.equal(f.toasts.length,1);
});
test('actual native IPC keeps 30s timeout and ignores its late reply without replay',async()=>{
 const posted=[],timers=[],context={Map,Set,crypto:{randomUUID:()=>String(posted.length+1)},IN_APP:true,windowKeyLost(){throw Error('unexpected auth');},
  setTimeout:(run,ms)=>{timers.push({run,ms});return timers.length;},clearTimeout(){},window:{webkit:{messageHandlers:{native:{postMessage:m=>posted.push(m)}}}}};
 vm.createContext(context);const start=source.indexOf('const nativePending='),end=source.indexOf('\nif(window.chrome?.webview)',start);
 vm.runInContext(source.slice(start,end),context);const pending=context.native('setAppearance',{mode:'dark',expires_at:130000});
 assert.equal(timers[0].ms,30000);assert.equal(posted[0].data.expires_at,130000);timers[0].run();assert.equal((await pending).error,'NATIVE_TIMEOUT');
 context.window.nativeReply({id:posted[0].id,result:{mode:'dark'}});assert.equal(posted.length,1);
});

test('latest failure restores the currently synchronized confirmed state without a rollback write',async()=>{
 const f=fixture(),pending=f.run('dark');f.context.S={settings:{appearance:'light'}};f.context.synchronizeAppearance();assert.equal(f.theme(),'dark');
 f.nativeCalls[0].resolve({error_code:'LOCAL_NETWORK'});await pending;
 assert.equal(f.theme(),'light');assert.equal(f.context.S.settings.appearance,'light');assert.equal(f.toasts.length,1);assert.equal(f.nativeCalls.length,1);assert.equal(f.posts.length,0);
});
