import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Parent comparison selects source only. Every transport, Chrome-version query,
// Site capability and child/timer boundary below stays in memory.
const sourceRoot=process.env.CHATHAND_LIFECYCLE_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url));
const personalModule=process.env.CHATHAND_LIFECYCLE_PERSONAL_MODULE||path.join(sourceRoot,'app/v08/personal-chrome.mjs');
const {PersonalChrome}=await import(pathToFileURL(personalModule));
const {runSiteExecution}=await import(pathToFileURL(path.join(sourceRoot,'app/v1/site-execution-context.mjs')));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const outcome=p=>p.then(value=>({value}),error=>({error}));
const pages=(ids=[1])=>({structuredContent:{pages:ids.map(id=>({id,url:'https://fixture.invalid/'+id,title:'Fixture'}))}});
const snapshot=()=>({structuredContent:{snapshot:{uid:'ref',role:'button',name:'Fixture',focused:true}}});
function transport({call,stop}={}){
 return {running:true,calls:[],stops:0,isRunning(){return this.running;},async call(name,args){this.calls.push({name,args});if(call)return call(name,args);return name==='take_snapshot'?snapshot():pages();},async stop(){this.stops++;this.running=false;if(stop)await stop();}};
}
function fixture({pool=[],current=transport(),store}={}){
 const state={data:{mode:'full',browser_enabled:true,high_risk:{}}},policy={epoch:1,check(){}};let created=0;
 const browser=new PersonalChrome(state,store||{stateDir:'/unused-lifecycle-memory-fixture'},policy,{chromeInfo:()=>({installed:true,supported:true}),transportFactory:()=>{created++;assert.ok(pool.length,'unexpected transport creation');return pool.shift();}});
 browser.t=current;browser.phase='connected';return {browser,state,policy,current,get created(){return created;}};
}
const rejected=(result,code='RESULT_REVOKED')=>assert.equal(result.error?.code,code);

test('an old close cannot clear replacement pending or permit a third transport',async()=>{
 const gate=deferred(),init=deferred(),old=transport({stop:()=>gate.promise}),next=transport({call:()=>init.promise}),f=fixture({current:old,pool:[next]});
 const closing=f.browser.closeAll();f.browser.startConnect();const pending=f.browser.pending;await flush();
 assert.ok(pending);assert.equal(next.calls.length,0,'replacement waits for old stop');
 f.browser.startConnect();assert.equal(f.created,1);assert.equal(f.browser.pending,pending);
 gate.resolve();await closing;await flush();assert.equal(f.browser.pending,pending);assert.equal(next.calls.length,1);
 f.browser.startConnect();assert.equal(f.created,1);init.resolve(pages());await pending;assert.equal(f.browser.phase,'connected');assert.equal(next.stops,0);
});

test('a late old start success owns neither new phase nor pending',async()=>{
 const gate=deferred(),init=deferred(),nextInit=deferred(),old=transport({call:()=>init.promise,stop:()=>gate.promise}),next=transport({call:()=>nextInit.promise}),f=fixture({pool:[old,next]});
 f.browser.phase='disconnected';f.browser.t=null;f.browser.startConnect();const first=f.browser.pending;await flush();
 const closing=f.browser.closeAll();f.browser.startConnect();const second=f.browser.pending;
 init.resolve(pages());await first;assert.equal(f.browser.pending,second);assert.equal(f.browser.phase,'connecting');assert.equal(next.calls.length,0);
 gate.resolve();await closing;await flush();nextInit.resolve(pages());await second;assert.equal(f.browser.phase,'connected');assert.equal(next.stops,0);
});

test('a failed old start cannot stop a replacement or clear it from finally',async()=>{
 const gate=deferred(),init=deferred(),old=transport({call:()=>init.promise,stop:()=>gate.promise}),next=transport(),f=fixture({pool:[old,next]});
 f.browser.phase='disconnected';f.browser.t=null;f.browser.startConnect();const first=f.browser.pending;await flush();init.reject(Object.assign(Error('fixture'),{code:'CHROME_PROTOCOL_ERROR'}));await flush();assert.equal(old.stops,1);
 const closing=f.browser.closeAll();f.browser.startConnect();const second=f.browser.pending;gate.resolve();await Promise.all([first,closing]);await second;
 assert.equal(f.browser.t,next);assert.equal(f.browser.phase,'connected');assert.equal(next.stops,0);assert.equal(f.browser.pending,null);
});

test('synchronous startup failure leaves a retryable state rather than a stuck pending',async()=>{
 const bad=transport();bad.call=()=>{throw Object.assign(Error('fixture'),{code:'CHROME_PROTOCOL_ERROR'});};const next=transport(),f=fixture({pool:[bad,next]});f.browser.phase='disconnected';f.browser.t=null;
 f.browser.startConnect();await f.browser.pending;assert.equal(f.browser.phase,'needs_permission');assert.equal(f.browser.pending,null);
 await f.browser.connect();assert.equal(f.browser.phase,'connected');
});

for(const reason of [null,'browser_disabled'])test('resolved old open cannot send new_page to replacement after '+(reason||'close'),async()=>{
 const reply=deferred(),old=transport({call:()=>reply.promise}),next=transport(),f=fixture({current:old,pool:[next]});
 const pending=outcome(f.browser.open({url:'https://fixture.invalid/new',task_id:'task'},'caller'));await flush();assert.equal(old.calls[0].name,'list_pages');
 reply.resolve(pages([]));if(reason){f.state.data.browser_enabled=false;f.policy.epoch++;}const closing=f.browser.closeAll({reason});
 if(reason){assert.throws(()=>f.browser.startConnect(),{code:'CAPABILITY_OFF'});f.state.data.browser_enabled=true;f.policy.epoch++;}
 await f.browser.connect();await closing;rejected(await pending,reason?'TASK_REVOKED':'RESULT_REVOKED');await f.browser.tail;
 assert.deepEqual(next.calls.map(x=>x.name),['list_pages']);assert.equal(next.stops,0);
});

test('queued actions capture the old session at enqueue and keep the same tail',async()=>{
 const hold=deferred(),entered=deferred(),old=transport(),next=transport(),f=fixture({current:old,pool:[next]});let siteStarts=0;
 const first=outcome(f.browser.exclusive('caller','task',async()=>{entered.resolve();await hold.promise;return {ok:true};}));await entered.promise;
 const second=outcome(runSiteExecution({assert(){},async beforeStart(){siteStarts++;}},()=>f.browser.tabs({action:'list',task_id:'task'},'caller')));
 await f.browser.closeAll();await f.browser.connect();hold.resolve();rejected(await first);rejected(await second);assert.equal(siteStarts,0,'stale queued action rejected before Site hook');
 const list=await f.browser.tabs({action:'list',task_id:'task'},'caller');assert.equal(list.tabs.length,1);assert.deepEqual(next.calls.map(x=>x.name),['list_pages','list_pages']);
});

test('Site start await cannot resume an action onto a replacement session',async()=>{
 const hold=deferred(),entered=deferred(),old=transport(),next=transport(),f=fixture({current:old,pool:[next]});let starts=0;
 const pending=outcome(runSiteExecution({assert(){},async beforeStart(){starts++;entered.resolve();await hold.promise;}},()=>f.browser.tabs({action:'new',url:'https://fixture.invalid',task_id:'task'},'caller')));
 await entered.promise;await f.browser.closeAll();await f.browser.connect();hold.resolve();rejected(await pending);assert.equal(starts,1);assert.equal(old.calls.length,0);assert.deepEqual(next.calls.map(x=>x.name),['list_pages']);
});

test('a bound stopped transport cannot be auto-started by an old queued action',async()=>{
 const hold=deferred(),f=fixture();f.browser.tail=hold.promise;const pending=outcome(f.browser.tabs({action:'list'},'caller'));f.current.running=false;hold.resolve();rejected(await pending);assert.equal(f.current.calls.length,0);
});

for(const reconnected of [false,true])test('late '+(reconnected?'reconnected':'list')+' response cannot overwrite replacement cache or generation',async()=>{
 const reply=deferred(),old=transport({call:()=>reply.promise}),next=transport(),f=fixture({current:old,pool:[next]});const pending=outcome(f.browser.tabs({action:'list'},'caller'));await flush();
 await f.browser.closeAll();await f.browser.connect();const generation=f.browser.generation;f.browser.tabsById.set('sentinel',{page_id:'sentinel'});f.browser.snapshots.set('sentinel',{snapshot_id:'current'});
 reply.resolve({...pages(),structuredContent:{...pages().structuredContent,reconnected}});rejected(await pending);
 assert.equal(f.browser.generation,generation);assert.equal(f.browser.tabsById.has('sentinel'),true);assert.equal(f.browser.snapshots.has('sentinel'),true);
});

test('snapshot consumer rechecks after validated RPC before mutating cache',async()=>{
 const reply=deferred(),old=transport({call:()=>reply.promise}),f=fixture({current:old});f.browser.page=async()=>({id:1,url:'https://fixture.invalid/1'});
 const pending=outcome(f.browser.snapshot({page_id:'page'},'caller'));await flush();reply.resolve(snapshot());
 // RPC helper resumes first; the close runs before its consumer resumes.
 queueMicrotask(()=>{void f.browser.closeAll();f.browser.snapshots.set('sentinel',{snapshot_id:'current'});});rejected(await pending);assert.deepEqual([...f.browser.snapshots.keys()],['sentinel']);
});

test('epoch change rejects successful replies but transport errors retain their original code',async()=>{
 const reply=deferred(),f=fixture({current:transport({call:()=>reply.promise})});const pending=outcome(f.browser.tabs({action:'list'},'caller'));await flush();f.policy.epoch++;reply.resolve(pages());rejected(await pending);assert.equal(f.browser.tabsById.size,0);
 const reply2=deferred(),g=fixture({current:transport({call:()=>reply2.promise})});const pending2=outcome(g.browser.tabs({action:'list'},'caller'));await flush();g.policy.epoch++;reply2.reject(Object.assign(Error('fixture'),{code:'CHROME_CONNECTION_CLOSED'}));rejected(await pending2,'CHROME_CONNECTION_CLOSED');
});

test('ordinary same-session calls stay serial and preserve owner, snapshots and actions',async()=>{
 const gate=deferred(),entered=deferred();let lists=0,active=0,max=0;
 const t=transport({async call(name){active++;max=Math.max(max,active);try{if(name==='list_pages'&&++lists===1){entered.resolve();await gate.promise;}return name==='take_snapshot'?snapshot():pages();}finally{active--;}}}),f=fixture({current:t});
 const a=f.browser.tabs({action:'list',task_id:'task'},'caller');await entered.promise;const b=f.browser.tabs({action:'list',task_id:'task'},'caller');await flush();assert.equal(t.calls.length,1);
 await assert.rejects(f.browser.tabs({action:'list'},'other'),{code:'PERSONAL_CHROME_IN_USE'});gate.resolve();const [list]=await Promise.all([a,b]);assert.equal(max,1);
 const page_id=list.tabs[0].page_id,view=await f.browser.snapshot({page_id,task_id:'task'},'caller');assert.equal(view.elements[0].ref,'ref');
 const result=await f.browser.action({page_id,snapshot_id:view.snapshot_id,ref:'ref',action:'click',task_id:'task'},'caller');assert.equal(result.performed,'click');assert.equal(t.calls.filter(x=>x.name==='click').length,1);assert.equal(f.browser.snapshots.has(page_id),false);
});

function uploadFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const files=['a.txt','b.txt'].map(name=>{const f=path.join(dir,name);fs.writeFileSync(f,name);return f;});let resolves=0;
 const f=fixture({store:{stateDir:dir,resolve(v){resolves++;return v;}}});f.browser.target=async()=>({p:{id:1,url:'https://fixture.invalid'},n:{ref:'ref'}});
 return {...f,dir,files,get resolves(){return resolves;},args:{page_id:'page',task_id:'task',paths:files}};
}

test('upload revoked after target await performs no local resolution, copy or send',async t=>{
 const f=uploadFixture(t),hold=deferred();f.browser.target=()=>hold.promise;const pending=outcome(f.browser.upload(f.args,'caller'));await flush();hold.resolve({p:{id:1},n:{ref:'ref'}});await f.browser.closeAll();rejected(await pending);assert.equal(f.resolves,0);assert.equal(f.current.calls.length,0);assert.equal(fs.existsSync(f.browser.workspace),false);
});

test('upload revoked during first copy neither copies next file nor sends and cleans its private batch',async t=>{
 const f=uploadFixture(t),copy=fs.copyFileSync;let copies=0;
 t.mock.method(fs,'copyFileSync',(...args)=>{copy(...args);copies++;void f.browser.closeAll();});
 rejected(await outcome(f.browser.upload(f.args,'caller')));assert.equal(copies,1);assert.equal(f.resolves,1);assert.equal(f.current.calls.length,0);assert.deepEqual(fs.readdirSync(f.browser.workspace),[]);
});

test('upload copy boundary revocation cannot send to a newly selected transport',async t=>{
 const f=uploadFixture(t),next=transport(),copy=fs.copyFileSync;let closing;
 t.mock.method(fs,'copyFileSync',(...args)=>{copy(...args);closing=f.browser.closeAll();f.browser.transportFactory=()=>next;f.browser.startConnect();});
 rejected(await outcome(f.browser.upload(f.args,'caller')));await closing;await f.browser.pending;assert.deepEqual(next.calls.map(x=>x.name),['list_pages']);assert.deepEqual(fs.readdirSync(f.browser.workspace),[]);
});

test('ordinary upload copies only into a private batch and sends once in the same session',async t=>{
 const f=uploadFixture(t);let copied;
 f.current.call=async function(name,args){this.calls.push({name,args});assert.equal(name,'upload_file');copied=args.filePaths.map(p=>({path:p,text:fs.readFileSync(p,'utf8')}));return {};};
 const result=await f.browser.upload(f.args,'caller');assert.equal(result.uploaded,2);assert.equal(f.current.calls.length,1);assert.deepEqual(copied.map(x=>x.text),['a.txt','b.txt']);assert.ok(copied.every(x=>x.path.startsWith(f.browser.workspace+path.sep)));assert.deepEqual(fs.readdirSync(f.browser.workspace),[]);
});

// Extract production stop() with inert child/timer boundaries. No process exists.
function stopFixture(){
 const source=fs.readFileSync(path.join(sourceRoot,'app/v08/chrome-transport.mjs'),'utf8'),start=source.indexOf(' async stop(){'),stop=source.slice(start,source.lastIndexOf('\n}'));
 const child=new EventEmitter(),timers=[];child.exitCode=null;child.signalCode=null;child.kills=[];child.stdin={end(){}};child.kill=s=>child.kills.push(s);
 const context={setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},err:(code,message)=>Object.assign(Error(message),{code})};vm.createContext(context);vm.runInContext('class T {'+stop+'}\nglobalThis.T=T;',context);
 const t=new context.T();Object.assign(t,{child,generation:0,pending:new Map(),buffer:'',ready:null,closing:null});return {t,child,timers,fire(ms){const timer=timers.find(x=>x.ms===ms);assert.ok(timer,'missing synthetic timer '+ms);timer.fn();}};
}

test('transport that closed in first grace wait does not wait another 1200ms',async()=>{
 const f=stopFixture(),stopping=f.t.stop();f.child.exitCode=0;f.child.emit('close');await flush();assert.deepEqual(f.timers.map(x=>x.ms),[500]);assert.deepEqual(f.child.kills,[]);await stopping;
});

test('transport still alive retains TERM grace then KILL fallback with fake timers only',async()=>{
 const f=stopFixture(),stopping=f.t.stop();f.fire(500);await flush();assert.deepEqual(f.child.kills,['SIGTERM']);assert.deepEqual(f.timers.map(x=>x.ms),[500,1200]);f.fire(1200);await stopping;assert.deepEqual(f.child.kills,['SIGTERM','SIGKILL']);
});

for(const resume of [false,true])test('user-stop: open waiting for list cannot send new_page after stop'+(resume?' then resume':''),async()=>{
 const reply=deferred(),f=fixture({current:transport({call:name=>name==='list_pages'?reply.promise:pages()})});
 const pending=outcome(f.browser.open({task_id:'task',url:'https://fixture.invalid/new'},'caller'));await flush();f.browser.userStop('task');if(resume)f.browser.userResume('task');reply.resolve(pages([]));
 const result=await pending;assert.equal(f.current.calls.some(x=>x.name==='new_page'),false);rejected(result,'BROWSER_USER_ACTIVE');assert.equal(result.error.details.user_stopped,true);assert.equal(result.error.details.replay_safe,false);assert.equal(f.browser.tabsById.size,0);
 if(resume){const fresh=await f.browser.exclusive('caller','task',async()=>({fresh:true}));assert.equal(fresh.fresh,true);}
});

for(const resume of [false,true])test('user-stop: page stop at final action target return blocks click'+(resume?' after resume':''),async()=>{
 const target=deferred(),f=fixture();f.browser.page=async()=>({id:1,url:'https://fixture.invalid/1'});f.browser.target=()=>target.promise;
 const pending=outcome(f.browser.action({task_id:'task',page_id:'page',action:'click'},'caller'));await flush();target.resolve({n:{ref:'ref'}});f.browser.userStop('task',{page_id:'page'});if(resume)f.browser.userResume('task',{page_id:'page'});
 const result=await pending;assert.equal(f.current.calls.length,0);rejected(result,'BROWSER_USER_ACTIVE');assert.equal(result.error.details.page_id,'page');
});

for(const resume of [false,true])test('user-stop: page stop at upload target return blocks resolution and copying'+(resume?' after resume':''),async t=>{
 const f=uploadFixture(t),target=deferred();f.browser.target=()=>target.promise;const pending=outcome(f.browser.upload(f.args,'caller'));await flush();target.resolve({p:{id:1},n:{ref:'ref'}});f.browser.userStop('task',{page_id:'page'});if(resume)f.browser.userResume('task',{page_id:'page'});
 const result=await pending;assert.equal(f.resolves,0);assert.equal(f.current.calls.length,0);assert.equal(fs.existsSync(f.browser.workspace),false);rejected(result,'BROWSER_USER_ACTIVE');
});

test('user-stop: stop and resume during upload copy invalidates old batch and cannot send',async t=>{
 const f=uploadFixture(t),copy=fs.copyFileSync;let copies=0;t.mock.method(fs,'copyFileSync',(...args)=>{copy(...args);copies++;f.browser.userStop('task',{page_id:'page'});f.browser.userResume('task',{page_id:'page'});});
 const result=await outcome(f.browser.upload(f.args,'caller'));assert.equal(copies,1);assert.equal(f.resolves,1);assert.equal(f.current.calls.length,0);assert.deepEqual(fs.readdirSync(f.browser.workspace),[]);rejected(result,'BROWSER_USER_ACTIVE');
});

test('user-stop: queued old task stays revoked after resume while another task on same page proceeds',async()=>{
 const hold=deferred(),f=fixture();f.browser.tail=hold.promise;let hooks=0;
 const old=outcome(runSiteExecution({assert(){},async beforeStart(){hooks++;}},()=>f.browser.snapshot({task_id:'task',page_id:f.browser.generation+':1'},'caller')));
 f.browser.userStop({id:'task'});f.browser.userResume('task');const other=f.browser.tabs({action:'list',task_id:'other'},'caller');hold.resolve();const result=await old;rejected(result,'BROWSER_USER_ACTIVE');assert.equal(hooks,0);assert.equal((await other).tabs.length,1);assert.deepEqual(f.current.calls.map(x=>x.name),['list_pages']);
});

test('user-stop: page-specific stop and resume leaves other page of the same task usable',async()=>{
 const hold=deferred(),entered=deferred();let snapshots=0;const f=fixture({current:transport({async call(name){if(name==='take_snapshot'){if(++snapshots===1){entered.resolve();await hold.promise;}return snapshot();}return pages([1,2]);}})});
 const a=f.browser.generation+':1',b=f.browser.generation+':2',first=outcome(f.browser.snapshot({task_id:'task',page_id:a},'caller'));await entered.promise;
 const second=f.browser.snapshot({task_id:'task',page_id:b},'caller');f.browser.userStop('task',{page_id:a});f.browser.userResume('task',{page_id:a});hold.resolve();rejected(await first,'BROWSER_USER_ACTIVE');assert.equal((await second).page_id,b);assert.equal(f.browser.snapshots.has(a),false);assert.equal(f.browser.snapshots.has(b),true);
 const fresh=await f.browser.snapshot({task_id:'task',page_id:a},'caller');assert.equal(fresh.page_id,a);
});

test('user-stop: task stop invalidates every page of that task without changing connection generation',async()=>{
 const hold=deferred(),f=fixture();f.browser.tail=hold.promise;const generation=f.browser.generation;
 const a=outcome(f.browser.snapshot({task_id:'task',page_id:generation+':1'},'caller')),b=outcome(f.browser.snapshot({task_id:'task',page_id:generation+':2'},'caller'));
 f.browser.userStop('task');f.browser.userResume('task');hold.resolve();rejected(await a,'BROWSER_USER_ACTIVE');rejected(await b,'BROWSER_USER_ACTIVE');assert.equal(f.browser.generation,generation);assert.equal(f.current.calls.length,0);
 assert.equal((await f.browser.tabs({task_id:'other',action:'list'},'caller')).tabs.length,1);
});

test('user-stop: existing Site hook await cannot revive a task after stop and resume',async()=>{
 const hold=deferred(),entered=deferred(),f=fixture();let hooks=0;
 const pending=outcome(runSiteExecution({assert(){},async beforeStart(){hooks++;entered.resolve();await hold.promise;}},()=>f.browser.tabs({task_id:'task',action:'new',url:'https://fixture.invalid'},'caller')));
 await entered.promise;f.browser.userStop('task');f.browser.userResume('task');hold.resolve();const result=await pending;assert.equal(f.current.calls.length,0);assert.equal(hooks,1);rejected(result,'BROWSER_USER_ACTIVE');
});

for(const reconnected of [false,true])test('user-stop: stopped then resumed task cannot process '+(reconnected?'reconnected':'list')+' response or replace cache',async()=>{
 const reply=deferred(),f=fixture({current:transport({call:()=>reply.promise})}),generation=f.browser.generation;
 const pending=outcome(f.browser.tabs({task_id:'task',action:'list'},'caller'));await flush();f.browser.tabsById.set('sentinel',{page_id:'sentinel'});f.browser.snapshots.set('sentinel',{snapshot_id:'current'});f.browser.userStop('task');f.browser.userResume('task');reply.resolve({structuredContent:{pages:[],reconnected}});
 rejected(await pending,'BROWSER_USER_ACTIVE');assert.equal(f.browser.generation,generation);assert.equal(f.browser.tabsById.has('sentinel'),true);assert.equal(f.browser.snapshots.has('sentinel'),true);
});

test('user-stop: stop between validated snapshot reply and cache update still revokes resumed old action',async()=>{
 const reply=deferred(),f=fixture({current:transport({call:()=>reply.promise})});f.browser.page=async()=>({id:1,url:'https://fixture.invalid/1'});
 const pending=outcome(f.browser.snapshot({task_id:'task',page_id:'page'},'caller'));await flush();reply.resolve(snapshot());queueMicrotask(()=>{f.browser.userStop('task',{page_id:'page'});f.browser.userResume('task',{page_id:'page'});});rejected(await pending,'BROWSER_USER_ACTIVE');assert.equal(f.browser.snapshots.has('page'),false);
});

test('user-stop: stopping an unrelated task or page cannot cancel a current pending page action',async()=>{
 const reply=deferred(),f=fixture({current:transport({call:()=>reply.promise})});f.browser.page=async()=>({id:1,url:'https://fixture.invalid/1'});
 const pending=f.browser.snapshot({task_id:'task',page_id:'page'},'caller');await flush();f.browser.userStop('other',{page_id:'page'});f.browser.userStop('task',{page_id:'unrelated'});reply.resolve(snapshot());assert.equal((await pending).page_id,'page');
});

test('user-stop: both exclusive signatures remain usable and stopped work cannot queue for later resume',async()=>{
 const f=fixture();assert.equal((await f.browser.exclusive('caller',async()=>({legacy:true}))).legacy,true);assert.equal((await f.browser.exclusive('caller','task',async()=>({task:true}))).task,true);
 const hold=deferred();f.browser.tail=hold.promise;f.browser.userStop('task');const stopped=outcome(f.browser.tabs({task_id:'task',action:'list'},'caller'));f.browser.userResume('task');hold.resolve();rejected(await stopped,'BROWSER_USER_ACTIVE');assert.equal(f.current.calls.length,0);
});
