import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../ui/h10/host.mjs',import.meta.url),'utf8');
const between=(start,end)=>{
 const a=source.indexOf(start),b=source.indexOf(end,a);
 assert.ok(a>=0&&b>a,`production section ${start}`);return source.slice(a,b);
};
const plain=value=>JSON.parse(JSON.stringify(value));
const siteProof=at=>({route:'site',site_id:'synthetic-completion-site',verified:true,verified_at:at});
const openaiProof=()=>({verified:true,read:true,write:true,status:'read_write'});
function snapshot(selected='site'){
 return {settings:{setup_complete:true},setup_route:selected,
  setup_test:selected==='site'?siteProof(1000):openaiProof(),
  site_b:{selected,routes:{site:{configured:true,state:'healthy',health_fresh:true,site_id:'synthetic-completion-site'},openai:{configured:true,state:'healthy',health_fresh:true}}},
  setup_activity:{active:false,last_at:900,finished_at:1000,route:'site'}};
}

// Execute the production route/proof rules and the screen transition portion
// of render. Rendering is also exercised in the isolated browser review.
function fixture(state=snapshot(),over={}){
 let now=2000;const calls=[],started=[];
 const box=vm.createContext({state,Date:class extends Date{static now(){return now;}},URL,Number,
  route:'site',screen:'f7',setupMode:'assisted',routeChosen:false,freshFrom:0,freshVerified:null,
  opened:true,pressing:false,renderPending:false,doneShownAt:0,busy:false,manualPicked:false,
  noticeText:'',actor:'ai',activityOpened:false,seenFinishedAt:1000,routeDialog:{open:false},
  clearProofExpiryTimer(){},document:{getElementById:()=>null},
  isHealthy:(b,r)=>b?.routes?.[r]?.configured===true&&b.routes[r].state==='healthy'&&b.routes[r].health_fresh===true,
  current:()=>box.state,bState:()=>box.state.site_b,openaiTunnel:()=>true,
  routeName:r=>r,uiText:k=>k,safeCode:e=>e.code,siteCreatable:()=>true,
  toastText(){},bridge:()=>({refresh:async()=>{}}),
  start:options=>{started.push(options);box.opened=true;},
  api:async(path,body)=>{
   calls.push([path,plain(body)]);
   if(path==='/api/setup/route')box.state.setup_route=body.route;
   if(path==='/api/site-b/select'){
    box.state.site_b.selected=body.route;
    box.state.setup_test=body.route==='site'?siteProof(1000):openaiProof();
   }
   return {};
  },...over});
 vm.runInContext(between('const openaiTested=','// 1052 C4（Claude）：F11'),box);
 vm.runInContext(between('function render(){',' syncWatch();')+'\n}',box);
 vm.runInContext(between('function maybeAutoOpen(){','// 1069 第 2 条'),box);
 vm.runInContext(between('async function switchRoute(desired){',"actions.addEventListener('click'"),box);
 return {box,calls,started,clock:at=>{now=at;},run:code=>vm.runInContext(code,box),
  render:()=>{box.render();return {screen:box.screen,route:box.route};}};
}

test('a verified current connection wins over a leftover activity from the other connection',()=>{
 for(const selected of ['openai','site']){
  const state=snapshot(selected),other=selected==='site'?'openai':'site';
  state.setup_activity={active:true,last_at:1500,route:other,finished_at:1000};
  const f=fixture(state,{route:other});
  assert.deepEqual(f.render(),{screen:'f15',route:selected});
  for(const at of [5000,601001,902000]){f.clock(at);assert.deepEqual(f.render(),{screen:'f15',route:selected});}
 }
});

test('an open completion page follows a successful connection switch in the same state update',()=>{
 const f=fixture(snapshot('site'));assert.equal(f.render().screen,'f15');
 for(const selected of ['openai','site','openai','site']){
  f.box.state=snapshot(selected);
  f.box.state.setup_activity={active:true,last_at:1500,route:'site',finished_at:1000};
  assert.deepEqual(f.render(),{screen:'f15',route:selected});
 }
});

test('switching to an already verified connection discards the prior attempt freshness gate',async()=>{
 const f=fixture(snapshot('site'));
 f.run('beginFresh(current())');
 assert.equal(f.render().screen,'f7','the explicit new attempt still needs new proof');
 await f.box.switchRoute('openai');
 assert.deepEqual(f.render(),{screen:'f15',route:'openai'});
 assert.equal(f.box.freshFrom,0);assert.equal(f.box.freshVerified,null);
 assert.deepEqual(f.calls.map(c=>c[0]),['/api/setup/route','/api/site-b/select']);
});

test('fresh setup success belongs to the route being tested, not a previous route completion',()=>{
 const f=fixture(snapshot('openai'),{route:'openai'});
 f.run('beginFresh(current())');
 f.box.state.setup_activity={active:false,last_at:2100,finished_at:2200,route:'site'};
 f.clock(2300);
 assert.equal(f.run('freshProof(current())'),false);
 assert.equal(f.render().screen,'f7');
 f.box.state.setup_activity={active:false,last_at:2100,finished_at:2200,route:'openai'};
 assert.equal(f.run('freshProof(current())'),true);
 assert.equal(f.render().screen,'f15');
});

test('a new attempt is visible immediately after an earlier successful setup',()=>{
 const f=fixture(snapshot('openai'),{route:'openai',opened:false,seenFinishedAt:1000});
 f.box.state.setup_test={verified:false};
 f.box.state.setup_activity={active:true,last_at:1900,finished_at:1000,route:'openai'};
 assert.equal(f.run('aiBusy(current())'),true);
 assert.equal(f.box.maybeAutoOpen(),true);
 assert.equal(f.started.length,1);
});

test('old completion events cannot reopen a different unverified connection',()=>{
 const state=snapshot('openai');state.setup_test={verified:false};
 const f=fixture(state,{opened:false,seenFinishedAt:0});
 assert.equal(f.box.maybeAutoOpen(),false);
 assert.deepEqual(f.started,[]);
 assert.equal(f.box.seenFinishedAt,1000,'stale completion is consumed once');
});

test('revoked proof, explicit retest and stale Site health still exit the completion page',()=>{
 for(const change of ['proof','retest','health','identity']){
  const f=fixture(snapshot('site'));assert.equal(f.render().screen,'f15');
  if(change==='health')f.box.state.site_b.routes.site.health_fresh=false;
  else if(change==='identity')f.box.state.site_b.routes.site.site_id='different-site';
  else f.box.state.setup_test={...f.box.state.setup_test,verified:false};
  if(change==='retest')f.box.state.setup_activity={active:true,last_at:2000,route:'site',finished_at:1000};
  assert.notEqual(f.render().screen,'f15',change);
 }
});

test('an expired temporary Site receipt cannot keep a completed page alive',()=>{
 const state=snapshot('site');state.setup_test={verified:false};
 state.site_b.host_attestation='verified_current_installation';state.site_b.routes.site.generation=1;
 state.h10={connection_check:{source:'trusted_host',verified:true,route:'site',site_id:'synthetic-completion-site',generation:1,installation_bound:true,binding_verified:true,current_session:true,issued_at:1000,expires_at:3000}};
 const f=fixture(state);assert.equal(f.render().screen,'f15');f.clock(3001);
 assert.notEqual(f.render().screen,'f15');
});
