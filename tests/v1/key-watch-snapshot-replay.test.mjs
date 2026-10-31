import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=file=>fs.readFileSync(new URL("../../"+file,import.meta.url),'utf8');
const wizard=read('ui/wizard.js'),app=read('ui/app.js');
const catalogs=Object.fromEntries(['zh','en'].map(locale=>[locale,JSON.parse(read('locales/'+locale+'.json'))]));
const tunnelA='tunnel_snapshot_A',tunnelB='tunnel_snapshot_B';
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture({load=true,existing=false}={}){
 let now=100000,serial=0,requestSerial=existing?1:0,stream='fallback',deferStatus=false;
 const jobs=new Map(),events=new Map(),calls=[],pending=[],nodes=[];
 const initialKey={active:existing,received:false,last4:null};
 const state={settings:{setup_step:1,setup_complete:load,setup_tunnel_id:tunnelA,...(load?{tunnel:{tunnel_id:tunnelA}}:{})},setup:{key_watch:initialKey,open_items:[]},credentials:{tunnel:false},permissions:{tier:'full'},connection:{},setup_test:{verified:false},automation:{browser:{extension:{}},computer:{permissions:{}}}};
 const server={active:existing,received:false,last4:null,request:existing?{id:'req1',tunnel_id:tunnelA,expires_at:now+600000}:null};
 const schedule=(fn,ms,repeat)=>{const id=++serial;jobs.set(id,{fn,ms,repeat,at:now+ms});return id;};
 const element=()=>({hidden:true,innerHTML:'',dataset:{},setAttribute(){},addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]});
 const root=element();
 const context={S:state,document:{documentElement:element(),body:{append:node=>nodes.push(node)},createElement:element,querySelector:selector=>selector==='#app'?root:null},
  Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},
  setTimeout:(fn,ms)=>schedule(fn,ms,false),clearTimeout:id=>jobs.delete(id),setInterval:(fn,ms)=>schedule(fn,ms,true),clearInterval:id=>jobs.delete(id),
  addEventListener:(type,fn,options)=>{const entries=events.get(type)||[];entries.push({fn,once:options?.once});events.set(type,entries);},
  ChatHandStream:{status:()=>stream},scheduleRender(){context.renders++;},renders:0,
  E:value=>String(value??''),connected:()=>false,connectionText:()=>'',userMessage:error=>error.message,
  native:()=>{throw Error('real native forbidden');},refresh:async()=>{context.refreshes++;},refreshes:0,
  fetch:async url=>{assert.equal(url,'/assets/tutorial/tutorial.json');return {json:async()=>JSON.parse(read('ui/assets/tutorial/tutorial.json'))};},
  api:async(route,data)=>{
   calls.push({route,data,at:now});
   if(route==='/api/setup/await-key'){
    server.active=true;server.received=false;server.last4=null;server.request={id:'req'+(++requestSerial),tunnel_id:data.tunnel_id,expires_at:now+600000};
    return {active:true,received:false,last4:null};
   }
   if(route==='/api/setup/await-key/status'){
    if(server.request&&now>=server.request.expires_at){server.active=false;server.request=null;}
    const value=structuredClone(server);
    if(deferStatus)return new Promise(resolve=>pending.push({resolve,value}));
    return value;
   }
   if(route==='/api/setup/await-key/cancel'){
    if(!data.id||data.id===server.request?.id){server.active=false;server.request=null;}
    return {active:server.active,received:server.received,last4:server.last4};
   }
   throw Error('unexpected API '+route);
  },__CHATHAND_TEXT_CATALOGS__:catalogs};
 context.window=context;vm.createContext(context);vm.runInContext(read('ui/local-text.js'),context);
 const loadWizard=()=>vm.runInContext(wizard,context);
 if(load)loadWizard();
 // Register the actual application DOM-ready replay, rather than reproducing its logic.
 vm.runInContext(app.match(/^addEventListener\('DOMContentLoaded'.*$/m)[0],context);
 const fire=async type=>{const entries=events.get(type)||[];events.set(type,entries.filter(entry=>!entry.once));for(const entry of entries)await entry.fn();await flush();};
 const tick=async ms=>{const end=now+ms;for(;;){const next=[...jobs].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;const [id,job]=next;now=job.at;if(job.repeat)job.at+=job.ms;else jobs.delete(id);await job.fn();await flush();}now=end;await flush();};
 const replay=keyState=>context.wizardRefresh(keyState??context.S);
 return {context,calls,server,pending,nodes,initialKey,loadWizard,fire,tick,replay,start:()=>context.ChatHandKeyWatch.start(tunnelA),watch:()=>context.ChatHandKeyWatch.state(),
  statuses:()=>calls.filter(call=>call.route==='/api/setup/await-key/status'),defer:value=>{deferStatus=value;},stream:value=>{stream=value;},
  adopt:(key,bound=tunnelA)=>{context.S={...context.S,settings:{...context.S.settings,setup_tunnel_id:bound},setup:{...context.S.setup,key_watch:key}};replay();}};
}

test('start/status success survives actual DOM-ready replay and keeps two 3s fallback polls',async()=>{
 const f=fixture();await f.start();assert.equal(f.watch().active,true);assert.equal(f.watch().request.id,'req1');
 await f.fire('DOMContentLoaded');assert.equal(f.watch().active,true);assert.equal(f.context.renders,1);
 await f.tick(6000);assert.deepEqual(f.statuses().map(call=>call.at),[100000,103000,106000]);
});
test('same key projection in a shallow-cloned S keeps the active watch without consuming stale false again',async()=>{
 const f=fixture();await f.start();
 f.context.S={...f.context.S,permissions:{tier:'light'}};f.replay();
 assert.equal(f.watch().active,true);await f.tick(3000);assert.equal(f.statuses().length,2);
});
test('a consumed active snapshot cannot reactivate a later inactive status on replay',async()=>{
 const f=fixture();await f.start();const key={active:true,received:false,last4:null};f.adopt(key);
 f.server.active=false;f.server.request=null;await f.tick(3000);assert.equal(f.watch().active,false);
 f.replay();assert.equal(f.watch().active,false);await f.tick(3000);assert.equal(f.statuses().length,2);
});
test('a genuinely new false projection, even with baseline values, still stops fallback polling',async()=>{
 const f=fixture();await f.start();f.adopt({...f.initialKey});assert.equal(f.watch().active,false);
 await f.tick(6000);assert.equal(f.statuses().length,1);
});
test('a new received projection still clears the local request and keeps only last four characters',async()=>{
 const f=fixture();await f.start();f.adopt({active:false,received:true,last4:'prefix-a7Qz'});
 assert.equal(f.watch().received,true);assert.equal(f.watch().request,null);assert.equal(f.watch().last4,'a7Qz');
 await f.tick(6000);assert.equal(f.statuses().length,1);
});
test('real request expiry through the existing status path still stops polling',async()=>{
 const f=fixture();await f.start();f.server.request.expires_at=104000;await f.tick(9000);
 assert.equal(f.watch().active,false);assert.equal(f.watch().request,null);assert.equal(f.statuses().length,3);
});
test('local cancellation still clears the owner and rejects subsequent snapshot reactivation',async()=>{
 const f=fixture();await f.start();await f.context.ChatHandKeyWatch.cancel();f.adopt({active:true,received:false,last4:null});
 assert.equal(f.watch().active,false);assert.equal(f.watch().request,null);await f.tick(6000);
 assert.equal(f.statuses().length,1);assert.equal(f.calls.filter(call=>call.route.endsWith('/cancel')).length,1);
 assert.equal(f.calls.find(call=>call.route.endsWith('/cancel')).data.id,'req1');
});
test('cancelled in-flight status cannot restore the old attempt',async()=>{
 const f=fixture();await f.start();f.defer(true);await f.tick(3000);assert.equal(f.pending.length,1);
 await f.context.ChatHandKeyWatch.cancel();f.pending[0].resolve(f.pending[0].value);await flush();
 assert.equal(f.watch().active,false);assert.equal(f.watch().request,null);await f.tick(6000);assert.equal(f.statuses().length,2);
});
test('switching tunnel generations rejects late old status and seeds the current baseline again',async()=>{
 const f=fixture();f.defer(true);const old=f.start();await flush();assert.equal(f.pending.length,1);
 f.context.S={...f.context.S,settings:{...f.context.S.settings,setup_tunnel_id:tunnelB}};
 const current=f.context.ChatHandKeyWatch.start(tunnelB);await flush();assert.equal(f.pending.length,2);
 f.pending[1].resolve(f.pending[1].value);await current;f.pending[0].resolve(f.pending[0].value);await old;
 assert.equal(f.watch().request.tunnel_id,tunnelB);assert.equal(f.watch().request.id,'req2');
 f.replay();assert.equal(f.watch().active,true);f.defer(false);await f.tick(3000);assert.equal(f.statuses().length,3);
});
test('a foreign-bound projection is not consumed before its binding matches',async()=>{
 const f=fixture();await f.start();const key={active:false,received:false,last4:null};f.adopt(key,tunnelB);assert.equal(f.watch().active,true);
 f.adopt(key,tunnelA);assert.equal(f.watch().active,false);
});
test('state arriving before wizard load still initializes on actual DOM ready and keeps polling',async()=>{
 const f=fixture({load:false});assert.equal(f.calls.length,0);f.loadWizard();await f.fire('DOMContentLoaded');
 assert.equal(f.nodes[0].hidden,false);assert.equal(f.nodes[0].dataset.step,'1');assert.equal(f.watch().active,true);
 assert.equal(f.calls.filter(call=>call.route==='/api/setup/await-key').length,1);await f.fire('load');f.replay();
 await f.tick(6000);assert.equal(f.statuses().length,3);
});
test('late initialization resumes an existing request instead of creating another',async()=>{
 const f=fixture({load:false,existing:true});f.loadWizard();await f.fire('DOMContentLoaded');
 assert.equal(f.watch().active,true);assert.equal(f.watch().request.id,'req1');assert.equal(f.calls.filter(call=>call.route==='/api/setup/await-key').length,0);
 await f.tick(3000);assert.equal(f.statuses().length,2);
});
test('live stream still suppresses periodic status calls and fallback resumes after stream loss',async()=>{
 const f=fixture();f.stream('live');await f.start();await f.fire('DOMContentLoaded');await f.tick(6000);assert.equal(f.statuses().length,1);
 f.stream('fallback');await f.tick(3000);assert.equal(f.statuses().length,2);assert.equal(f.watch().active,true);
});
