import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {desktop} from './1052-a-fixture.mjs';
const source=fs.readFileSync(new URL('../ui/app.js',import.meta.url),'utf8');
test('1058 actual motion loop stops in idle/occlusion and background render rate stays at most 30fps',()=>{
 const classes=new Set(),raf=new Map(),timers=new Map();let serial=0,frames=0,hues=0;
 const box={document:{hidden:false},window:{__chathandWindowVisible:true},root:{classList:{contains:s=>classes.has(s),toggle:(s,on)=>on?classes.add(s):classes.delete(s)}},quiet:-Infinity,QUIET:900,spotOn:false,spotMoving:false,lraf:0,lastAura:-1e9,lastLoop:-Infinity,tickT:0,BD:{attached:()=>true,frame:()=>frames++},bctx:{reduce:()=>false},reduce:{matches:false},hueStep(){hues++;},hueCss(){},stepSpot:()=>false,requestAnimationFrame:f=>{const id=++serial;raf.set(id,f);return id;},setTimeout:f=>{const id=++serial;timers.set(id,f);return id;},clearTimeout:id=>timers.delete(id)};vm.createContext(box);
 vm.runInContext(source.slice(source.indexOf(' const motionVisible='),source.indexOf('\n function move(e)',source.indexOf(' const motionVisible='))),box);
 const step=now=>{const pending=[...raf.values()];raf.clear();for(const f of pending)f(now);};
 vm.runInContext('kickLoop()',box);step(0);assert.equal(raf.size,0);assert.equal(frames,0);assert.equal(timers.size,0);
 classes.add('st-run');vm.runInContext('kickLoop()',box);for(let t=0;t<1000;t+=1000/60)step(t);assert.ok(frames<=30,frames);assert.ok(frames>=20,frames);assert.ok(hues<=31,hues);
 box.window.__chathandWindowVisible=false;const previous=frames;step(1100);assert.equal(frames,previous);assert.equal(raf.size,0);
 box.window.__chathandWindowVisible=true;classes.delete('st-run');vm.runInContext('kickLoop()',box);step(1200);assert.equal(raf.size,0);
 box.quiet=1200;vm.runInContext('kickLoop()',box);step(1250);assert.ok(raf.size>0);step(2200);assert.equal(raf.size,0,'mouse inactivity stops animation');
});
test('1058 native cached JSON invalidates on settings, task terminal state and pending computer requests',async t=>{
 const f=await desktop(t),a=f.app,origin='http://127.0.0.1:'+a.apiPort,headers={Authorization:'Bearer '+a.adminToken,'X-ChatHand-UI':a.uiKey};
 const read=async()=>{const r=await fetch(origin+'/api/native/state',{headers});assert.equal(r.status,200);return r.json();};
 const idle=await read();assert.deepEqual(await read(),idle);a.state.data.appearance='dark';assert.equal((await read()).settings.appearance,'dark');
 const id=await f.begin();assert.ok((await read()).tasks.some(t=>t.task_id===id));f.ok(await f.rpc('finish_task',{task_id:id,summary:'结束隔离缓存测试',success:true}));assert.equal((await read()).tasks.some(t=>t.task_id===id),false);
 a.tools.automation.computer.pending.set('synthetic',{id:'synthetic'});assert.equal((await read()).computer.pending,1);a.tools.automation.computer.pending.delete('synthetic');assert.equal((await read()).computer.pending,0);
});
