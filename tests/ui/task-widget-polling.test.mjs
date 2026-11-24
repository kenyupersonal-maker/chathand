import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../ui/task-widget.html',import.meta.url),'utf8');
const between=(begin,end)=>{
 const a=source.indexOf(begin),b=source.indexOf(end,a+begin.length);
 assert.ok(a>=0&&b>a,`Cannot find widget section: ${begin}`);
 return source.slice(a,b);
};
const errors=between('// Only a complete, explicitly structured error code','function relayPrompt(');
const relay=between('async function relayPoll(){','// 1052（Claude）：停住了');
const polling=between('async function poll(){',"window.addEventListener('pagehide'");
const wiring=between("document.addEventListener('visibilitychange'","window.addEventListener('message'");

function harness({relayToken='token'}={}){
 const timeouts=new Map(),events={},calls=[],metadata=[];
 let now=100000,seq=0,host=async()=>({structuredContent:{task:{task_id:'task',status:'active'},relay:{state:'idle'}}});
 const context={
  Error,JSON,Math,Set,Object,Promise,Date:{now:()=>now},console,
  current:{task:{task_id:'task',status:'active',relay:{state:'idle'}}},
  cardBorn:now,relayToken,relayInterruptToken:null,originCheckpoint:null,
  observationNonce:null,collapsed:false,pollFailures:0,pollInFlight:false,pollOnWake:false,
  timer:null,timerDue:0,relayTimer:null,polls:0,cardErrN:0,cardErrCodes:new Set(),
  document:{visibilityState:'visible',addEventListener:(name,fn)=>events[name]=fn},
  window:{openai:{callTool:(name,args)=>{calls.push({name,args});return host(name,args);}},addEventListener:(name,fn)=>events[name]=fn},
  setTimeout:(fn,ms)=>{const id=++seq;timeouts.set(id,{fn,ms});return id;},
  clearTimeout:id=>timeouts.delete(id),
  queueMicrotask:fn=>Promise.resolve().then(fn),
  acceptMetadata:r=>metadata.push(r),
  noteCardError:()=>{},
  render:payload=>{context.current.task={...context.current.task,...(payload.task||{})};},
  renderCompact:()=>{context.collapsed=true;vm.runInContext('stopTimer()',ctx);},
  relayInterrupt:async()=>{},
  call:async()=>({task:{task_id:'task',status:'active'}}),
  T:key=>key,alertLine:()=>{}
 };
 const ctx=vm.createContext(context);
 vm.runInContext(errors+'\n'+relay+'\n'+polling+'\n'+wiring,ctx);
 return {
  ctx,calls,timeouts,events,
  setHost:fn=>host=fn,
  get failures(){return ctx.pollFailures;},
  get collapsed(){return ctx.collapsed;},
  get delay(){return [...timeouts.values()].map(t=>t.ms);},
  poll:()=>vm.runInContext('poll()',ctx),
  wake:()=>vm.runInContext('resumePolling()',ctx),
  flush:()=>new Promise(resolve=>setImmediate(resolve)),
  advanceClock:ms=>{now+=ms;}
 };
}

test('private host errors: only four exact envelope/code forms retire superseded cards',async t=>{
 const payloads=[
  {isError:true,structuredContent:{code:'RELAY_CARD_SUPERSEDED'}},
  {isError:true,content:[{type:'text',text:JSON.stringify({code:'RELAY_CARD_INVALID'})}]},
  Object.assign(new Error('Host wrapper'),{code:'RELAY_CARD_SUPERSEDED'}),
  new Error('RELAY_CARD_INVALID')
 ];
 for(const [n,payload] of payloads.entries()){
  await t.test('exact form '+n,async()=>{
   const h=harness();
   h.setHost(async()=>{if(payload instanceof Error)throw payload;return payload;});
   await h.poll();
   assert.equal(h.collapsed,true);
   assert.deepEqual(h.delay,[]);
   assert.equal(h.calls.length,1);
   await h.poll();
   assert.equal(h.calls.length,1,'old retired card never re-queries');
  });
 }
});

test('plain text references to retired-code words never retire a current card',async()=>{
 const h=harness();
 h.setHost(async()=>({isError:true,content:[{text:'The text mentions RELAY_CARD_SUPERSEDED in a paragraph.'}]}));
 await h.poll();
 assert.equal(h.collapsed,false);
 assert.equal(h.failures,1);
 assert.deepEqual(h.delay,[30000]);
 h.setHost(async()=>({isError:true,content:[{text:JSON.stringify({message:'RELAY_CARD_INVALID'})}]}));
 await h.poll();
 assert.equal(h.collapsed,false);
 assert.equal(h.failures,2);
});

test('ordinary private errors back off to 60s, stop after five, retain card, then recover on online',async()=>{
 const h=harness();
 h.setHost(async()=>{throw new Error('temporary network issue');});
 for(let i=1;i<=5;i++){
  await h.poll();
  assert.equal(h.failures,i);
  assert.equal(h.collapsed,false);
  assert.deepEqual(h.delay,i===5?[]:[Math.min(60000,15000*2**i)]);
 }
 assert.equal(h.calls.length,5);
 await h.poll();
 assert.equal(h.calls.length,5,'ordinary exhausted card stays visible without background calls');
 h.setHost(async()=>({structuredContent:{task:{task_id:'task',status:'active'},relay:{state:'idle'}}}));
 h.events.online();
 await h.flush();
 assert.equal(h.calls.length,6);
 assert.equal(h.failures,0);
 assert.deepEqual(h.delay,[15000]);
 assert.equal(h.collapsed,false);
});

test('ordinary cards without relay credentials use identical failure cap and visibility recovery',async()=>{
 const h=harness({relayToken:null});
 let count=0;
 h.ctx.call=async()=>{count++;throw new Error('unavailable');};
 for(let i=1;i<=5;i++)await h.poll();
 assert.equal(count,5);assert.equal(h.failures,5);assert.equal(h.collapsed,false);
 assert.deepEqual(h.delay,[]);
 h.ctx.call=async()=>{count++;return {task:{task_id:'task',status:'active'}};};
 h.ctx.document.visibilityState='hidden';h.events.visibilitychange();
 h.ctx.document.visibilityState='visible';h.events.visibilitychange();
 await h.flush();
 assert.equal(count,6);assert.equal(h.failures,0);assert.deepEqual(h.delay,[30000]);
});

test('two cards are independent: old card is retired and new card continues updating',async()=>{
 const old=harness(),newer=harness();
 old.setHost(async()=>({isError:true,structuredContent:{code:'RELAY_CARD_SUPERSEDED'}}));
 newer.setHost(async()=>({structuredContent:{task:{task_id:'task',status:'active',checkpoint_seq:2},relay:{state:'idle'}}}));
 await Promise.all([old.poll(),newer.poll()]);
 assert.equal(old.collapsed,true);assert.equal(newer.collapsed,false);
 assert.equal(newer.ctx.current.task.checkpoint_seq,2);
 assert.deepEqual(old.delay,[]);assert.deepEqual(newer.delay,[15000]);
});

test('only one polling request and one timer are active, including an online wake during the request',async()=>{
 const h=harness();let resolveHost;
 h.setHost(()=>new Promise(resolve=>resolveHost=resolve));
 const first=h.poll(),duplicate=h.poll();
 assert.equal(h.calls.length,1);
 assert.equal(h.ctx.pollInFlight,true);
 h.events.online();
 assert.equal(h.calls.length,1,'online must not duplicate pending request');
 resolveHost({structuredContent:{task:{task_id:'task',status:'active'},relay:{state:'idle'}}});
 await Promise.all([first,duplicate]);
 await h.flush();
 assert.equal(h.calls.length,2,'wake queues exactly one follow-up after the pending request');
 assert.equal(h.ctx.pollInFlight,true);
 resolveHost({structuredContent:{task:{task_id:'task',status:'active'},relay:{state:'idle'}}});
 await h.flush();
 assert.ok(h.delay.length<=1,'one timer after last request settles');
});
