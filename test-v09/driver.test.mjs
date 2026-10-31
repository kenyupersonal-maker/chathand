import test from 'node:test';import assert from 'node:assert/strict';import {BrowserDriver} from '../browser-extension/driver.js';import {frameSupport} from '../browser-extension/frame-tree.js';
function fixture(options={}){
 const calls=[];let name='Submit',type='text',url='https://example.test',incognito=false,disabled=false,hitResponse=null,hitSequence=[],inspectHook=null,sensitiveMarked=true;
 const point={x:60,y:30,width:100,height:40};
 const node=()=>({nodeId:'n',backendDOMNodeId:12,role:{value:'textbox'},name:{value:name},value:{value:'DO_NOT_RETURN_FORM_VALUE'},properties:disabled?[{name:'disabled',value:{value:true}}]:[]});
 const nextHit=()=>hitSequence.length?hitSequence.shift():hitResponse||point;
 const api={
  tabs:{get:async id=>({id,url,title:'Fixture',incognito,windowId:1}),query:async()=>[{id:1,url,title:'Fixture'},{id:2,url:'chrome://settings'},{id:3,url,incognito:true}],create:async o=>({id:4,...o}),update:async(id,args)=>{calls.push({type:'update',id,args});return{id};},remove:async id=>calls.push({type:'remove',id}),reload:async()=>{}},
  windows:{update:async()=>{}},
  runtime:{getPlatformInfo:async()=>({os:'mac'})},
  debugger:{
   attach:async target=>calls.push({type:'attach',target}),
   detach:async target=>calls.push({type:'detach',target}),
   sendCommand:async(target,method,params)=>{
    calls.push({method,params});
    if(method==='Accessibility.getFullAXTree'||method==='Accessibility.getPartialAXTree')return{nodes:[node()]};
    if(method==='DOM.describeNode')return{node:{attributes:['type',type]}};
    if(method==='DOM.getBoxModel')return{model:{content:[10,10,110,10,110,50,10,50]}};
    if(method==='Page.captureScreenshot')return{data:'image-fixture'};
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame-1'}}};
    if(method==='Page.createIsolatedWorld')return{executionContextId:7};
    if(method==='Runtime.evaluate'&&params.expression==='document.visibilityState')return{result:{value:'visible'}};
    if(method==='DOM.resolveNode')return{object:{objectId:'object-1'}};
    if(method==='Runtime.callFunctionOn'){if(params.functionDeclaration.includes('data-chathand-sensitive'))return{result:{value:sensitiveMarked}};const value=nextHit();inspectHook?.(value);return{result:{value}};}
    if(method==='Runtime.releaseObject')return{};
    return{};
   }
  }
 };
 const driver=new BrowserDriver(api,options);
 return{driver,api,calls,point,setName:v=>name=v,setType:v=>type=v,setURL:v=>url=v,setIncognito:v=>incognito=v,setDisabled:v=>disabled=v,setHitResponse:v=>hitResponse=v,setHitSequence:v=>hitSequence=[...v],onInspect:v=>inspectHook=v,setSensitiveMarked:v=>sensitiveMarked=v};
}
test('tab listing excludes internal and incognito pages',async()=>{const {driver}=fixture();assert.equal((await driver.execute('tabs')).tabs.length,1);});
test('snapshot returns labels and fresh refs, not form values',async()=>{const {driver}=fixture();const s=await driver.execute('snapshot',{page_id:'1'});assert.equal(s.elements[0].name,'Submit');assert.ok(!JSON.stringify(s).includes('DO_NOT_RETURN_FORM_VALUE'));});
test('repeated reads use one attached debugger session',async()=>{const {driver,calls}=fixture();await driver.execute('snapshot',{page_id:'1'});await driver.execute('snapshot',{page_id:'1'});assert.equal(calls.filter(x=>x.type==='attach').length,1);});
test('click targets observed element geometry and invalidates old snapshot',async()=>{const {driver,calls}=fixture(),s=await driver.execute('snapshot',{page_id:'1'});await driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'});const down=calls.find(x=>x.method==='Input.dispatchMouseEvent'&&x.params.type==='mousePressed');assert.equal(down.params.x,60);assert.equal(down.params.y,30);await assert.rejects(()=>driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'}),/SNAPSHOT_STALE/);});
test('持续遮挡到命中检测超时不会派发 Input',async()=>{const f=fixture({actionabilityTimeoutMs:15});f.setHitResponse({reason:'ELEMENT_OBSCURED'});const s=await f.driver.execute('snapshot',{page_id:'1'});await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'}),{code:'ELEMENT_OBSCURED'});assert.equal(f.calls.filter(x=>x.method==='Input.dispatchMouseEvent').length,0);});
test('遮挡解除后只派发一次点击',async()=>{const f=fixture({actionabilityTimeoutMs:200});f.setHitSequence([{reason:'ELEMENT_OBSCURED'},f.point,f.point]);const s=await f.driver.execute('snapshot',{page_id:'1'});await f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'});const input=f.calls.filter(x=>x.method==='Input.dispatchMouseEvent');assert.equal(input.length,2);assert.equal(input.filter(x=>x.params.type==='mousePressed').length,1);assert.deepEqual(input[0].params,{type:'mousePressed',x:60,y:30,button:'left',clickCount:1});});
test('命中等待期间 label 改变会拒绝点击',async()=>{const f=fixture({actionabilityTimeoutMs:120});let inspections=0;f.onInspect(()=>{if(++inspections===1)f.setName('Changed during wait');});const s=await f.driver.execute('snapshot',{page_id:'1'});await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'}),{code:'ELEMENT_CHANGED'});assert.equal(f.calls.filter(x=>x.method==='Input.dispatchMouseEvent').length,0);});
test('命中等待期间 disabled 改变会拒绝点击',async()=>{const f=fixture({actionabilityTimeoutMs:120});let inspections=0;f.onInspect(()=>{if(++inspections===1)f.setDisabled(true);});const s=await f.driver.execute('snapshot',{page_id:'1'});await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'}),{code:'ELEMENT_DISABLED'});assert.equal(f.calls.filter(x=>x.method==='Input.dispatchMouseEvent').length,0);});
test('bounded 调用后同步 cancel 不会在微任务中派发 Input',async()=>{const f=fixture(),generation=f.driver.generation,pending=f.driver.send(1,'Input.dispatchMouseEvent',{type:'mousePressed'},generation);f.driver.cancel();await assert.rejects(pending,{code:'ACTION_CANCELLED'});assert.equal(f.calls.filter(x=>x.method==='Input.dispatchMouseEvent').length,0);});
test('navigation invalidates a previous reference',async()=>{const f=fixture(),s=await f.driver.execute('snapshot',{page_id:'1'});f.setURL('https://other.test');await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'}),/SNAPSHOT_STALE/);});
test('label change causes refusal instead of a stale destructive click',async()=>{const f=fixture(),s=await f.driver.execute('snapshot',{page_id:'1'});f.setName('Delete account');await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'}),/ELEMENT_CHANGED/);assert.ok(!f.calls.some(x=>x.method==='Input.dispatchMouseEvent'));});
test('authorized web password fill requires a verified sensitive marker before native input',async()=>{for(const marked of [true,false]){const f=fixture();f.setName('Unlabelled');f.setType('password');f.setSensitiveMarked(marked);const s=await f.driver.execute('snapshot',{page_id:'1'}),args={page_id:'1',snapshot_id:s.snapshot_id,ref:'e1',text:'test-not-secret'};if(marked){assert.equal((await f.driver.execute('fill',args)).performed,'fill');const mark=f.calls.findIndex(x=>x.method==='Runtime.callFunctionOn'&&x.params.functionDeclaration.includes('data-chathand-sensitive')),input=f.calls.findIndex(x=>x.method==='Input.insertText');assert.ok(mark>=0&&input>mark);assert.equal(f.calls.filter(x=>x.method==='Input.insertText').length,1);}else{await assert.rejects(()=>f.driver.execute('fill',args),{code:'SCREENSHOT_REDACTION_UNAVAILABLE'});assert.equal(f.calls.filter(x=>x.method?.startsWith('Input.')).length,0);}}});
test('fill uses native input commands, no arbitrary caller script',async()=>{const f=fixture(),s=await f.driver.execute('snapshot',{page_id:'1'});await f.driver.execute('fill',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1',text:'HELLO'});assert.ok(f.calls.some(x=>x.method==='Input.insertText'&&x.params.text==='HELLO'));assert.ok(!f.calls.some(x=>x.method==='Runtime.evaluate'));});
test('永不返回的 CDP 命令在有界时间内失败并撤销当前动作',async()=>{const f=fixture({commandTimeoutMs:10});f.api.debugger.sendCommand=async(target,method,params)=>{f.calls.push({method,params});return new Promise(()=>{});};await assert.rejects(f.driver.send(1,'NeverReturns'),{code:'CDP_COMMAND_TIMEOUT'});});
test('CDP 迟到响应不会继续派发旧点击',async()=>{const f=fixture({commandTimeoutMs:10});let release;const original=f.api.debugger.sendCommand;f.api.debugger.sendCommand=(target,method,params)=>{if(method==='DOM.scrollIntoViewIfNeeded'){f.calls.push({method,params});return new Promise(resolve=>{release=resolve;});}return original(target,method,params);};const s=await f.driver.execute('snapshot',{page_id:'1'});const action=f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'});for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');await assert.rejects(action,{code:'CDP_COMMAND_TIMEOUT'});release({});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(x=>x.method?.startsWith('Input.')).length,0);});
test('动作撤销后迟到响应不会继续派发后续输入',async()=>{const f=fixture({commandTimeoutMs:1000});let release;const original=f.api.debugger.sendCommand;f.api.debugger.sendCommand=(target,method,params)=>{if(method==='DOM.scrollIntoViewIfNeeded'){f.calls.push({method,params});return new Promise(resolve=>{release=resolve;});}return original(target,method,params);};const s=await f.driver.execute('snapshot',{page_id:'1'});const action=f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1'});for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');await f.driver.detachAll();release({});await assert.rejects(action,{code:'ACTION_CANCELLED'});assert.equal(f.calls.filter(x=>x.method?.startsWith('Input.')).length,0);});
test('tabs.get 迟到响应在撤销后不会继续 attach',async()=>{const f=fixture({commandTimeoutMs:1000});let release;f.api.tabs.get=async()=>new Promise(resolve=>{release=resolve;});const action=f.driver.execute('click',{page_id:'1',snapshot_id:'unused',ref:'e1'});for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');f.driver.cancel();release({id:1,url:'https://example.test',title:'Fixture',incognito:false,windowId:1});await assert.rejects(action,{code:'ACTION_CANCELLED'});assert.equal(f.calls.filter(x=>x.type==='attach').length,0);});
test('getPlatformInfo 迟到响应在撤销后不会继续派发输入',async()=>{const f=fixture({commandTimeoutMs:1000});let release;f.api.runtime.getPlatformInfo=async()=>new Promise(resolve=>{release=resolve;});const s=await f.driver.execute('snapshot',{page_id:'1'});const action=f.driver.execute('fill',{page_id:'1',snapshot_id:s.snapshot_id,ref:'e1',text:'HELLO'});for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');f.driver.cancel();release({os:'mac'});await assert.rejects(action,{code:'ACTION_CANCELLED'});assert.equal(f.calls.filter(x=>x.method?.startsWith('Input.')).length,0);});
test('attach 超时的迟到 detach 会阻塞下一轮 attach，避免拆掉新连接',async()=>{const f=fixture({commandTimeoutMs:20});let releaseAttach,releaseDetach,attachCalls=0,detachCalls=0;f.api.debugger.attach=async target=>{attachCalls++;if(attachCalls===1)return new Promise(resolve=>{releaseAttach=resolve;});f.calls.push({type:'attach',target});};f.api.debugger.detach=async target=>{detachCalls++;return new Promise(resolve=>{releaseDetach=resolve;});};await assert.rejects(()=>f.driver.attach(1),{code:'CDP_ATTACH_TIMEOUT'});await assert.rejects(()=>f.driver.attach(1),{code:'CDP_ATTACH_BUSY'});releaseAttach();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof releaseDetach,'function');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.driver.pendingDetaches.size,1);await assert.rejects(()=>f.driver.attach(1),{code:'CDP_DETACH_BUSY'});assert.equal(attachCalls,1);releaseDetach();for(let i=0;i<20&&f.driver.pendingDetaches.size;i++)await new Promise(resolve=>setImmediate(resolve));await f.driver.attach(1);assert.equal(attachCalls,2);assert.equal(detachCalls,1);});
test('internal URL and embedded credentials cannot be opened',async()=>{const {driver}=fixture();for(const url of ['file:///etc/passwd','javascript:alert(1)','https://u:p@example.test'])await assert.rejects(()=>driver.execute('new',{url}),/URL_BLOCKED/);});
test('detach releases controller without closing personal tabs',async()=>{const {driver,calls}=fixture();await driver.execute('snapshot',{page_id:'1'});await driver.detachAll();assert.equal(calls.filter(x=>x.type==='detach').length,1);assert.equal(calls.filter(x=>x.type==='remove').length,0);});

function frameFixture({crossOrigin=false,childAX=true,childAXError=null,extraFrames=0,ownerLayout='safe',ownerResult=()=>({x:120,y:80}),actionabilityTimeoutMs=250}={}){
 const calls=[],root={id:'root-frame',url:'https://example.test/',loaderId:'root-document'},child={id:'child-frame',parentId:'root-frame',url:crossOrigin?'https://other.test/iframe.html':'https://example.test/iframe.html',loaderId:'child-document'},extra=Array.from({length:extraFrames},(_,index)=>({id:`extra-frame-${index}`,parentId:'root-frame',url:'https://example.test/extra.html',loaderId:`extra-document-${index}`}));let ownerIndex=0;
 const childNode=()=>({backendDOMNodeId:22,role:{value:'button'},name:{value:'iframe 内按钮：点击一次'},properties:[]});
 const rootNode=()=>({backendDOMNodeId:11,role:{value:'button'},name:{value:'父页面按钮'},properties:[]});
 const api={
  tabs:{get:async id=>({id,url:root.url,title:'Fixture',incognito:false,windowId:1}),query:async()=>[],create:async()=>({id:2,url:root.url}),update:async()=>({}),remove:async()=>{},reload:async()=>{}},
  windows:{update:async()=>{}},runtime:{getPlatformInfo:async()=>({os:'mac'})},
  debugger:{
   attach:async target=>calls.push({type:'attach',target}),detach:async target=>calls.push({type:'detach',target}),
   sendCommand:async(target,method,params={})=>{
    calls.push({method,params});
    if(method==='Page.getFrameTree')return{frameTree:{frame:root,childFrames:[{frame:child},...extra.map(frame=>({frame}))]}};
    if(method==='Accessibility.getFullAXTree'){
     if(params.frameId==='child-frame'&&childAXError)throw Object.assign(new Error(childAXError),{code:childAXError});
     if(params.frameId==='child-frame'&&!childAX)throw Object.assign(new Error('OOPIF'),{code:'TARGET_UNAVAILABLE'});
     return{nodes:params.frameId==='child-frame'?[childNode()]:[rootNode()]};
    }
    if(method==='Accessibility.getPartialAXTree')return{nodes:[params.backendNodeId===22?childNode():rootNode()]};
    if(method==='DOM.describeNode')return{node:{attributes:params.backendNodeId===22?['type','button']:[]}};
    if(method==='DOM.scrollIntoViewIfNeeded')return{};
    if(method==='Page.createIsolatedWorld')return{executionContextId:params.frameId==='child-frame'?11:10};
    if(method==='Runtime.evaluate'&&params.expression==='document.visibilityState')return{result:{value:'visible'}};
    if(method==='DOM.resolveNode')return{object:{objectId:params.backendNodeId===99?'owner-object':'target-object'}};
    if(method==='DOM.getFrameOwner')return{backendNodeId:99};
    if(method==='Runtime.callFunctionOn'){
     if(params.objectId==='owner-object'){
      if(ownerLayout!=='safe')return{result:{value:{reason:'ELEMENT_FRAME_UNSUPPORTED'}}};
      return{result:{value:ownerResult(ownerIndex++)}};
     }
     return{result:{value:{x:20,y:15,width:40,height:20}}};
    }
    if(method==='Runtime.releaseObject')return{};
    return{};
   }
  }
 };
 return{driver:new BrowserDriver(api,{actionabilityTimeoutMs}),api,calls,root,child,setChildLoader:v=>{child.loaderId=v;},ownerCalls:()=>ownerIndex};
}

test('同源 iframe AX snapshot binds exact button ref to frame and document',async()=>{const f=frameFixture(),s=await f.driver.execute('snapshot',{page_id:'1'}),inner=s.elements.find(e=>e.role==='button'&&e.name==='iframe 内按钮：点击一次');assert.ok(inner);assert.equal(inner.frame_id,'child-frame');assert.equal(inner.document_id,'child-document');assert.equal(s.unsupported_frames.length,0);const raw=f.calls.find(c=>c.method==='DOM.resolveNode'&&c.params.backendNodeId===22);assert.equal(raw,undefined);await f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:inner.ref});const resolve=f.calls.find(c=>c.method==='DOM.resolveNode'&&c.params.backendNodeId===22);assert.equal(resolve.params.executionContextId,11);const down=f.calls.find(c=>c.method==='Input.dispatchMouseEvent'&&c.params.type==='mousePressed');assert.deepEqual({x:down.params.x,y:down.params.y},{x:120,y:80});});

test('iframe document navigation rejects the old ref before input',async()=>{const f=frameFixture(),s=await f.driver.execute('snapshot',{page_id:'1'}),inner=s.elements.find(e=>e.frame_id==='child-frame');f.setChildLoader('child-document-2');await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:inner.ref}),{code:'SNAPSHOT_STALE'});assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);});

test('moving iframe owner waits for main viewport geometry to settle',async()=>{let values=[{x:100,y:100},{x:140,y:100},{x:140,y:100}];const f=frameFixture({ownerResult:()=>values.shift()||{x:140,y:100}}),s=await f.driver.execute('snapshot',{page_id:'1'}),inner=s.elements.find(e=>e.frame_id==='child-frame');await f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:inner.ref});const down=f.calls.find(c=>c.method==='Input.dispatchMouseEvent'&&c.params.type==='mousePressed');assert.equal(down.params.x,140);assert.equal(down.params.y,100);assert.ok(f.ownerCalls()>=3);});

test('parent overlay blocks iframe click without dispatching input',async()=>{const f=frameFixture({ownerResult:()=>({reason:'ELEMENT_OBSCURED'})}),s=await f.driver.execute('snapshot',{page_id:'1'}),inner=s.elements.find(e=>e.frame_id==='child-frame');await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:inner.ref}),{code:'ELEMENT_OBSCURED'});assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);});

test('cross-origin iframe is listed as unsupported and never falls back to parent',async()=>{const f=frameFixture({crossOrigin:true}),s=await f.driver.execute('snapshot',{page_id:'1'});assert.equal(s.elements.some(e=>e.name==='iframe 内按钮：点击一次'),false);assert.deepEqual(s.unsupported_frames.map(e=>e.reason),['CROSS_ORIGIN_FRAME_UNSUPPORTED']);});

test('same-origin iframe that is not in this target is explicitly unsupported',async()=>{const f=frameFixture({childAX:false}),s=await f.driver.execute('snapshot',{page_id:'1'});assert.equal(s.elements.some(e=>e.name==='iframe 内按钮：点击一次'),false);assert.equal(s.unsupported_frames[0].reason,'OOPIF_FRAME_UNSUPPORTED');});

test('iframe transform or zoom is refused before any input dispatch',async()=>{for(const ownerLayout of ['transform','zoom']){const f=frameFixture({ownerLayout}),s=await f.driver.execute('snapshot',{page_id:'1'}),inner=s.elements.find(e=>e.frame_id==='child-frame');await assert.rejects(()=>f.driver.execute('click',{page_id:'1',snapshot_id:s.snapshot_id,ref:inner.ref}),{code:'ELEMENT_FRAME_UNSUPPORTED'});assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);const ownerCall=f.calls.find(c=>c.method==='Runtime.callFunctionOn'&&c.params.objectId==='owner-object');assert.match(ownerCall.params.functionDeclaration,/style\.transform/);assert.match(ownerCall.params.functionDeclaration,/style\.zoom/);}});

test('snapshot child AX timeout is propagated instead of being labeled OOPIF',async()=>{const f=frameFixture({childAXError:'CDP_COMMAND_TIMEOUT'});await assert.rejects(()=>f.driver.execute('snapshot',{page_id:'1'}),{code:'CDP_COMMAND_TIMEOUT'});});

test('snapshot child AX cancellation is propagated instead of being labeled OOPIF',async()=>{const f=frameFixture({childAXError:'ACTION_CANCELLED'});await assert.rejects(()=>f.driver.execute('snapshot',{page_id:'1'}),{code:'ACTION_CANCELLED'});});

test('snapshot caps frame enumeration and reports truncation',async()=>{const f=frameFixture({extraFrames:40}),s=await f.driver.execute('snapshot',{page_id:'1'});assert.equal(s.frames_truncated,true);assert.equal(s.ax_nodes_truncated,false);});

test('nested about blank and srcdoc frames inherit the root origin',()=>{const root={id:'root',url:'https://example.test/'},blank={id:'blank',parentId:'root',url:'about:blank'},srcdoc={id:'srcdoc',parentId:'blank',url:'about:srcdoc'};assert.deepEqual(frameSupport({root,frames:[root,blank,srcdoc]},srcdoc),{supported:true,reason:null});});
