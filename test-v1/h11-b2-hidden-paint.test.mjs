import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserDriver} from '../browser-extension/driver.js';
import {findChrome, launchChrome, FakeChrome, startServer} from '../test-support/real-chrome.mjs';

function fixture(paint,timeout=200,{world=()=>({executionContextId:71}),visibility=()=>({result:{value:'hidden'}})}={}){
 const commands=[];let documentId='own-document';
 const api={tabs:{get:async id=>({id,url:'http://127.0.0.1:9999/own',incognito:false})},debugger:{
  detach:async()=>{},sendCommand:async(target,method,params)=>{
   commands.push({target,method,params});
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'own-root',loaderId:documentId,url:'http://127.0.0.1:9999/own'}}};
   // The page's main realm lies. Only our separately created context sees native visibility.
   if(method==='Runtime.evaluate')return params.contextId===71?visibility():{result:{value:'visible'}};
   if(method==='Page.captureScreenshot')return paint();
   if(method==='Page.createIsolatedWorld')return params.worldName==='ChatHand.Visibility'?world():{executionContextId:41};
   if(method==='DOM.resolveNode')return {object:{objectId:'own-element'}};
   if(method==='Runtime.callFunctionOn')return {result:{value:{x:50,y:50,width:40,height:40}}};
   if(method==='Accessibility.getPartialAXTree')return {nodes:[{backendDOMNodeId:10,role:{value:'button'},name:{value:'Own entry'}}]};
   return {};
  }
 }};
 const driver=new BrowserDriver(api,{commandTimeoutMs:timeout});
 const click=()=>driver.click(7,{backend:10,frameId:'own-root',documentId:'own-document',frameUrl:'http://127.0.0.1:9999/own',role:'button',name:'Own entry'});
 return {driver,commands,click,changeDocument:()=>{documentId='replacement-document';}};
}

test('hidden paint timeout dispatches zero Input and stays on the bound target',async()=>{
 const f=fixture(()=>new Promise(()=>{}),30);
 await assert.rejects(f.click(),error=>error.code==='CDP_COMMAND_TIMEOUT');
 assert.equal(f.commands.filter(c=>c.method.startsWith('Input.')).length,0);
 assert.ok(f.commands.every(c=>c.target.tabId===7));
 assert.equal(f.commands.filter(c=>c.method==='Page.captureScreenshot').length,1);
});

test('cancel during hidden paint prevents late Input when capture completes',async()=>{
 let release,entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const f=fixture(()=>new Promise(resolve=>{release=resolve;entered();}));
 const pending=f.click();await ready;f.driver.cancel(7);release({data:'own-local-frame'});
 await assert.rejects(pending,error=>error.code==='ACTION_CANCELLED');
 assert.equal(f.commands.filter(c=>c.method.startsWith('Input.')).length,0);
 assert.ok(f.commands.every(c=>c.target.tabId===7));
});

test('missing hidden paint data stops before dispatch instead of replaying',async()=>{
 const f=fixture(async()=>({}));
 await assert.rejects(f.click(),error=>error.code==='ELEMENT_GEOMETRY');
 assert.equal(f.commands.filter(c=>c.method.startsWith('Input.')).length,0);
 assert.equal(f.commands.filter(c=>c.method==='Page.captureScreenshot').length,1);
});

test('navigation during hidden paint rejects the old document with zero Input',async()=>{
 const f=fixture(async()=>{f.changeDocument();return {data:'local-new-frame'};});
 await assert.rejects(f.click(),error=>error.code==='ELEMENT_CHANGED');
 assert.equal(f.commands.filter(c=>c.method.startsWith('Input.')).length,0);
 assert.ok(f.commands.every(c=>c.target.tabId===7));
});

test('ordinary post-paint timeout keeps one dispatched click and forbids replay',async()=>{
 let paints=0;
 const f=fixture(()=>++paints===1?{data:'own-prepaint'}:new Promise(()=>{}),100);
 const generation=f.driver.generation,result=await f.click();
 assert.equal(f.commands.filter(c=>c.method==='Input.dispatchMouseEvent').length,2);
 assert.equal(paints,2);assert.equal(f.driver.generation,generation);
 assert.deepEqual(result.paint,{observed:false,error:'CDP_COMMAND_TIMEOUT'});
 assert.equal(result.delivery_unconfirmed,true);assert.equal(result.do_not_replay,true);assert.equal(result.replay_safe,false);
});

test('cancel after Input keeps the result unknown and never posts another click',async()=>{
 let paints=0,entered,release;
 const ready=new Promise(resolve=>{entered=resolve;});
 const f=fixture(()=>++paints===1?{data:'own-prepaint'}:new Promise(resolve=>{release=resolve;entered();}));
 const pending=f.click();await ready;f.driver.cancel(7);release({data:'late-observation'});
 await assert.rejects(pending,error=>error.code==='ACTION_CANCELLED'&&error.details.delivery_unconfirmed===true&&error.details.do_not_replay===true&&error.details.replay_safe===false);
 assert.equal(f.commands.filter(c=>c.method==='Input.dispatchMouseEvent').length,2);
});

test('post-paint snapshot stale remains a stop with exactly one dispatched click',async()=>{
 let paints=0;
 const f=fixture(()=>{if(++paints===1)return {data:'own-prepaint'};throw Object.assign(Error('stale'),{code:'SNAPSHOT_STALE'});});
 await assert.rejects(f.click(),error=>error.code==='SNAPSHOT_STALE'&&error.details.do_not_replay===true);
 assert.equal(f.commands.filter(c=>c.method==='Input.dispatchMouseEvent').length,2);
});

test('empty post-paint data reports observation unknown without replaying Input',async()=>{
 let paints=0;
 const f=fixture(()=>++paints===1?{data:'own-prepaint'}:{});
 const result=await f.click();
 assert.deepEqual(result.paint,{observed:false,error:'ELEMENT_GEOMETRY'});
 assert.equal(result.delivery_unconfirmed,true);assert.equal(result.do_not_replay,true);assert.equal(result.replay_safe,false);
 assert.equal(f.commands.filter(c=>c.method==='Input.dispatchMouseEvent').length,2);
});

test('page visibility spoof cannot bypass the root isolated-world paint guard',async()=>{
 const f=fixture(()=>({data:'own-local-frame'}));
 const result=await f.click();
 const world=f.commands.find(c=>c.method==='Page.createIsolatedWorld'&&c.params.worldName==='ChatHand.Visibility');
 assert.deepEqual(world.params,{frameId:'own-root',worldName:'ChatHand.Visibility',grantUniveralAccess:false});
 const reads=f.commands.filter(c=>c.method==='Runtime.evaluate');
 assert.equal(reads.length,1);assert.equal(reads[0].params.contextId,71);
 assert.equal(reads[0].target.tabId,7);assert.equal(reads[0].target.sessionId,undefined);
 assert.equal(f.commands.filter(c=>c.method==='Page.captureScreenshot').length,2);
 assert.deepEqual(result.paint,{observed:true});
});

for(const [name,options] of [
 ['missing context',{world:()=>({})}],
 ['context exception',{visibility:()=>({exceptionDetails:{text:'context lost'}})}],
 ['invalid visibility',{visibility:()=>({result:{value:'spoofed'}})}]
])test('isolated visibility '+name+' fails closed without main-world fallback or Input',async()=>{
 const f=fixture(()=>({data:'own-local-frame'}),200,options);
 await assert.rejects(f.click(),error=>error.code==='ELEMENT_FRAME_UNSUPPORTED');
 assert.equal(f.commands.filter(c=>c.method.startsWith('Input.')).length,0);
 assert.equal(f.commands.filter(c=>c.method==='Page.captureScreenshot').length,0);
 assert.ok(f.commands.filter(c=>c.method==='Runtime.evaluate').every(c=>c.params.contextId===71));
});

test('cancel while creating visibility world prevents late evaluation, paint and Input',async()=>{
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;});
 const f=fixture(()=>({data:'own-local-frame'}),200,{world:()=>new Promise(resolve=>{release=resolve;entered();})});
 const pending=f.click();await ready;f.driver.cancel(7);release({executionContextId:71});
 await assert.rejects(pending,error=>error.code==='ACTION_CANCELLED');
 assert.equal(f.commands.filter(c=>c.method==='Runtime.evaluate'||c.method==='Page.captureScreenshot'||c.method.startsWith('Input.')).length,0);
});

const CHROME=findChrome();
test('real temporary Chrome: page-overridden visibility stays hidden in ChatHand world and one trusted click completes rAF',
 {skip:CHROME?false:'找不到 Chrome，隔离环境真浏览器证据未验证',timeout:45000},async t=>{
 const chrome=await launchChrome(CHROME);t.after(()=>chrome.close());
 const server=await startServer({
  '/user':'<!doctype html><title>Own user guard</title><input id="user">',
  '/ai':`<!doctype html><title>Own hidden SPA</title><button type="button" id="go">Own entry</button><p id="out">ready</p><script>
   window.clicks=0;window.trusted=false;
   go.onclick=e=>{clicks++;trusted=e.isTrusted;requestAnimationFrame(()=>out.textContent='complete');};
  </script>`,
  '/favicon.ico':''
 });t.after(()=>server.close());
 const api=new FakeChrome(chrome.cdp),driver=api.wire(new BrowserDriver(api));
 t.after(async()=>{await driver.detachAll();await api.dispose();});
 const user=await api.tabs.create({url:server.base+'/user',active:true});
 const ai=await api.tabs.create({url:server.base+'/ai',active:false});
 const until=async(check)=>{const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('own page did not load');};
 await until(async()=>await api.evaluate(user.id,'!!document.getElementById("user")'));
 await until(async()=>await api.evaluate(ai.id,'!!document.getElementById("go")'));
 await api.tabs.update(user.id,{active:true});
 assert.equal(await api.evaluate(ai.id,'document.visibilityState'),'hidden');
 await api.evaluate(user.id,'document.getElementById("user").focus()');
 // Alter both page wrappers. Native state in the isolated realm must remain unaffected.
 await api.evaluate(ai.id,`Object.defineProperty(Document.prototype,'visibilityState',{configurable:true,get:()=> 'visible'});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});`);
 assert.equal(await api.evaluate(ai.id,'document.visibilityState'),'visible');
 const commands=[],sendCommand=api.debugger.sendCommand;
 api.debugger.sendCommand=async(target,method,params)=>{
  const result=await sendCommand(target,method,params);
  commands.push({target,method,params,...(method==='Runtime.evaluate'?{value:result.result?.value}:{})});return result;
 };
 const snapshot=await driver.execute('snapshot',{page_id:String(ai.id)});
 const button=snapshot.elements.find(e=>e.role==='button'&&e.name==='Own entry');assert.ok(button);
 const result=await driver.execute('click',{page_id:String(ai.id),snapshot_id:snapshot.snapshot_id,ref:button.ref});
 assert.equal(result.performed,'click');assert.deepEqual(result.click.paint,{observed:true});
 assert.deepEqual(await api.evaluate(ai.id,'({clicks,trusted,out:document.getElementById("out").textContent})'),{clicks:1,trusted:true,out:'complete'});
 const read=commands.find(c=>c.method==='Runtime.evaluate'&&c.params.expression==='document.visibilityState');
 assert.ok(Number.isSafeInteger(read?.params.contextId));assert.equal(read.value,'hidden');
 assert.equal(commands.filter(c=>c.method==='Page.captureScreenshot').length,2);
 assert.equal(commands.filter(c=>c.method==='Input.dispatchMouseEvent').length,2);
 assert.ok(commands.every(c=>c.target.tabId===ai.id));assert.equal(api.activeTab,user.id);
 assert.equal(await api.evaluate(user.id,'document.visibilityState'),'visible');
 assert.equal(await api.evaluate(user.id,'document.activeElement.id'),'user');
 assert.equal(JSON.stringify(result).includes('image_base64'),false);
 t.diagnostic(JSON.stringify({chrome:chrome.version,page_visibility:'visible',isolated_visibility:read.value,trusted_clicks:1,user_tab_unchanged:true,pixels_returned:false}));
});
