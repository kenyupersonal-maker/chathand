import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDesktop} from '../app/server.mjs';
import {TOOLS} from '../app/tools.mjs';
import {toolResult,TASK_URI} from '../app/v06/features.mjs';
import {RelayClient} from '../app/relay.mjs';
import {CONNECTOR_API} from '../app/product.mjs';
const contains=(x,s)=>JSON.stringify(x).includes(s);
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1031-probe-')),work=path.join(root,'work');fs.mkdirSync(work);
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'c'.repeat(64),clientDeps:{currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Isolated Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({currentBuild:1030,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 app.policy.enabled=true;app.store.paused=false;app.store.writesEnabled=true;
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 let id=0;const call=async(name,args={},session='probe-conv',modern=false)=>{const meta={...(session?{'openai/session':session}:{}),...(modern?{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}:{})};const r=await app.tools.rpc({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args,_meta:meta}},'chatgpt',{setupPrincipal:'probe-account'});return r.result;};
 const begin=await call('begin_task',{request_id:'probe-fixture-task',title:'probe'});assert.equal(begin.isError,false);
 return {app,root,call,task_id:begin.structuredContent.task_id};
}
test('toolResult strips plain-object card data before text/structure/images; ordinary results stay identical',()=>{
 const secret=crypto.randomBytes(32).toString('hex'),a={mode:'new',_card_meta:{'chathand/test_marker':secret}},r=toolResult(a);
 assert.equal(JSON.stringify(r).split(secret).length-1,1);assert.equal(contains(r.content,secret),false);assert.equal(contains(r.structuredContent,secret),false);assert.equal(Object.hasOwn(r.structuredContent,'_card_meta'),false);
 for(const x of [null,[],new Date(),'bad'])assert.throws(()=>toolResult({_card_meta:x}),e=>e.code==='CARD_META_INVALID');
 const plain={answer:4},expected={content:[{type:'text',text:JSON.stringify(plain)}],structuredContent:plain,isError:false};assert.deepEqual(toolResult(plain),expected);
 const image=toolResult({image_base64:'aW1hZ2U=',mimeType:'image/png',caption:'x',_card_meta:{secret}});assert.equal(contains(image.content,secret),false);assert.equal(image._meta.secret,secret);
});

test('desktop metadata is an explicit programming error and cannot enter error details or observers',async t=>{
 const f=await fixture(t),s=crypto.randomBytes(32).toString('hex'),invoke=f.app.tools.invoke.bind(f.app.tools);
 f.app.tools.invoke=async(name,...args)=>name==='computer_screenshot'?{observation:{image_base64:'aW1hZ2U='},_card_meta:{secret:s}}:invoke(name,...args);
 const r=await f.call('computer_screenshot',{task_id:f.task_id});assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'CARD_META_DESKTOP_UNSUPPORTED');assert.equal(contains(r,s),false);
});


test('retired tools and old resource cannot change permission or create a confirmation',async t=>{
 const f=await fixture(t),before=structuredClone(f.app.state.data);
 for(const name of ['card_probe','card_probe_report']){
  const r=await f.call(name,{task_id:f.task_id});
  assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'TOOL_UNKNOWN');
 }
 assert.deepEqual(f.app.state.data,before);
 const resources=f.app.tools.features.resources().resources;
 assert.equal(resources.length,2);assert.equal(resources[0].uri,TASK_URI);
 assert.throws(()=>f.app.tools.features.resource('ui://chathand/probe-0123456789.html'),e=>e.code==='RESOURCE_MISSING'&&/探针已退出/.test(e.message));
 assert.ok(f.app.tools.features.resource(TASK_URI).contents[0].text.includes('task_status'));
 const current=JSON.parse(fs.readFileSync(new URL('../contracts/tools-v31.json',import.meta.url),'utf8'));assert.equal(CONNECTOR_API,31);assert.deepEqual(TOOLS,current,'current tool contract follows API31');
 assert.equal(TOOLS.find(tool=>tool.name==='relay_card_control')?._meta?.['openai/visibility'],'private');
 assert.deepEqual(TOOLS.find(tool=>tool.name==='task_stop')?.inputSchema.required,['task_id']);
 assert.ok(!TOOLS.some(x=>['card_probe','card_probe_report'].includes(x.name)));
 assert.deepEqual(TOOLS.map(tool=>tool.name),current.map(tool=>tool.name),'current names and order match API31 contract');
});

test('RPC card metadata remains private in legacy and modern transport and observers',async t=>{
 const f=await fixture(t),secret=crypto.randomBytes(32).toString('hex'),seen=[];
 const invoke=f.app.tools.invoke.bind(f.app.tools);
 f.app.tools.invoke=async(name,...args)=>name==='show_task'?{ok:true,_card_meta:{'chathand/test_marker':secret}}:invoke(name,...args);
 const trace=f.app.tools.trace.handled.bind(f.app.tools.trace),stats=f.app.tools.valueStats.enqueue.bind(f.app.tools.valueStats),after=f.app.tools.resume.after.bind(f.app.tools.resume);
 f.app.tools.trace.handled=(...args)=>{seen.push(args);return trace(...args);};
 f.app.tools.valueStats.enqueue=(...args)=>{seen.push(args);return stats(...args);};
 f.app.tools.resume.after=(...args)=>{seen.push(args);return after(...args);};
 for(const modern of [false,true]){
  const r=await f.call('show_task',{task_id:f.task_id},'probe-conv',modern);
  assert.equal(r.isError,false);assert.equal(r._meta['chathand/test_marker'],secret);
  assert.equal(contains(r.content,secret),false);assert.equal(contains(r.structuredContent,secret),false);
  if(modern)assert.ok(r._meta['io.modelcontextprotocol/serverInfo']);
 }
 assert.equal(contains(seen,secret),false);
 f.app.tools.valueStats.drain();f.app.tools.valueStats.flush();
 const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.isFile()?[path.join(dir,e.name)]:[]);
 for(const file of files(path.join(f.root,'state')))assert.equal(fs.readFileSync(file).includes(Buffer.from(secret)),false);
});


test('late retired requests discard private inputs before every observer and preserve carried notices',async t=>{
 const f=await fixture(t),secret=crypto.randomBytes(32).toString('hex'),seen=[],calls={};
 const wrap=(object,key)=>{const old=object[key].bind(object);object[key]=(...args)=>{calls[key]=(calls[key]||0)+1;seen.push(args);return old(...args);};};
 for(const key of ['receiveRPC','handled'])wrap(f.app.tools.trace,key);
 for(const key of ['before','after','takeCarried'])wrap(f.app.tools.resume,key);
 wrap(f.app.tools.confirmations,'takeNote');wrap(f.app.tools.commandNotes,'collect');wrap(f.app.tools.valueStats,'enqueue');
 const permissions=structuredClone(f.app.state.data);
 for(const modern of [false,true])for(const name of ['card_probe','card_probe_report']){
  const r=await f.call(name,{task_id:f.task_id,probe_id:secret,last4:secret.slice(-4),_card_meta:{secret}},'probe-conv',modern);
  assert.equal(r.isError,true);assert.equal(r.structuredContent.code,'TOOL_UNKNOWN');assert.equal(contains(r,secret),false);
 }
 const notification=await f.app.tools.rpc({jsonrpc:'2.0',method:'tools/call',params:{name:'card_probe_report',arguments:{last4:secret},_meta:{'io.modelcontextprotocol/protocolVersion':{secret}}}});
 assert.equal(notification,null);
 assert.equal(contains(seen,secret),false);assert.ok(!JSON.stringify(seen).includes('last4'));
 assert.equal(calls.receiveRPC,5);assert.equal(calls.handled,5);
 for(const key of ['before','after','takeCarried','takeNote','collect','enqueue'])assert.equal(calls[key]||0,0,key+' consumed a retired request');
 assert.deepEqual(f.app.state.data,permissions);
});


test('retired resource returns an id-bound protocol error and fake relay delivers it once',async t=>{
 const f=await fixture(t);
 for(const modern of [false,true]){
  const r=await f.app.tools.rpc({jsonrpc:'2.0',id:909,method:'resources/read',params:{uri:'ui://chathand/probe-0123456789.html',_meta:modern?{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}:{}}});
  assert.equal(r.id,909);assert.equal(r.error.code,-32002);assert.equal(r.error.data.code,'RESOURCE_MISSING');assert.match(r.error.message,/探针已退出/);assert.ok(!JSON.stringify(r).includes('0123456789'));
 }
 let calls=0;const delivered=[];
 const relay=new RelayClient({name:'Isolated fixture',rpc:(...args)=>{calls++;return f.app.tools.rpc(...args);}});
 relay.config={base:'https://fixture.invalid'};
 relay.currentToken=async()=> 'synthetic-fixture';
 relay.post=async(url,data)=>{assert.equal(url,'https://fixture.invalid/device/result');delivered.push(data);return {ok:true};};
 await relay.execute({id:'retired-resource-once',caller:'relay:isolated',request:{jsonrpc:'2.0',id:910,method:'resources/read',params:{uri:'ui://chathand/probe-0123456789.html'}}},new AbortController().signal);
 assert.equal(calls,1);assert.equal(delivered.length,1);assert.equal(delivered[0].response.id,910);assert.equal(delivered[0].response.error.data.code,'RESOURCE_MISSING');
});
