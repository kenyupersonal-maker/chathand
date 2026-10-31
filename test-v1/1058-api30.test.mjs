import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import path from 'node:path';
import {TOOLS} from '../app/tools.mjs';import {manifest} from '../app/product.mjs';import {CapabilityRegistry} from '../app/v1/capabilities.mjs';
import {SITE_WIDGET_ALIASES} from '../app/v1/widget-resource-aliases.mjs';import {TASK_URI} from '../app/v06/features.mjs';import {IMAGE_BATCH_URI} from '../app/v1/image-batch.mjs';
import {desktop} from './1052-a-fixture.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL('../contracts/'+name,import.meta.url),'utf8'));
test('historical API30 remains hash-frozen while current API31 contract is checked separately',()=>{
 const previous=read('tools-v29.json'),api30=read('tools-v30.json'),current=read('tools-v31.json'),frozen=read('api30-freeze.json');assert.equal(api30.length,84);assert.equal(manifest(api30).schema_sha256,frozen.schema_sha256);assert.equal(frozen.connector_api,30);assert.equal(TOOLS.length,current.length);assert.deepEqual(TOOLS,current);assert.equal(manifest(TOOLS).connector_api,31);
 for(const old of previous){const actual=structuredClone(api30.find(t=>t.name===old.name)),expected=structuredClone(old);assert.ok(actual,old.name);for(const t of [actual,expected])if(t._meta?.ui?.resourceUri){delete t._meta.ui.resourceUri;delete t._meta['openai/outputTemplate'];}assert.deepEqual(actual,expected,old.name);}
 assert.equal(TASK_URI,'ui://chathand/task.html');assert.equal(IMAGE_BATCH_URI,'ui://chathand/image-batch.html');
 const generic=TOOLS.find(t=>t.name==='run_capability');assert.equal(generic.annotations.readOnlyHint,false);assert.equal(generic.annotations.destructiveHint,true);assert.equal(generic.annotations.openWorldHint,true);
});
test('1058 fixed resources and all historically published aliases resolve without remote script domains',async t=>{
 const {app}=await desktop(t);for(const uri of [TASK_URI,IMAGE_BATCH_URI,...SITE_WIDGET_ALIASES]){const r=app.tools.features.resource(uri);assert.ok(r.contents[0].text.includes('<html'));assert.deepEqual(r.contents[0]._meta.ui.csp,{connectDomains:[],resourceDomains:[]});}
});
test('1058 API31 contract_status exposes authenticated same-workspace continuation; API31 freeze stays current',async t=>{
 const f=await desktop(t),start=f.ok(await f.rpc('begin_task',{request_id:'1058-cap-first',title:'合同核对'}));assert.deepEqual(start.extra_capabilities.map(c=>c.name),['execute_task_step','contract_status']);
 const reused=f.ok(await f.rpc('begin_task',{request_id:'1058-cap-reuse',title:'继续核对'}));assert.equal(reused.extra_capabilities,undefined);assert.equal(reused.task_id,start.task_id);
 const value=f.ok(await f.rpc('run_capability',{capability:'contract_status',parameters:{}}));assert.equal(value.connector_api,31);assert.equal(value.tool_count,TOOLS.length);assert.equal(value.api31_frozen,true);assert.equal(value.shell_protocol,1);assert.equal(value.offline_shell,true);assert.deepEqual(value.capability_categories,['contract_diagnostics']);
 assert.deepEqual(f.ok(await f.rpc('bridge_info')).extra_capabilities.map(c=>c.name),['execute_task_step','contract_status']);
 const discovery=f.ok(await f.rpc('run_capability',{capability:'unregistered',parameters:{}}));assert.equal(discovery.discovery,true);assert.equal(discovery.executed,false);assert.deepEqual(discovery.extra_capabilities.map(c=>c.name),['execute_task_step','contract_status']);
 for(const args of [{capability:'contract_status',parameters:{arbitrary:'field'}},{capability:'contract_status',parameters:[]}])assert.equal((await f.rpc('run_capability',args)).isError,true);
 let ran=0;f.app.tools.extraCapabilities.register({name:'isolated_browser_write',description:'test only',inputSchema:{type:'object',properties:{task_id:{type:'string'}},required:['task_id'],additionalProperties:false},permissions:['browser'],run:()=>{ran++;return {done:true};}});
 const continued=await f.rpc('run_capability',{capability:'isolated_browser_write',parameters:{task_id:start.task_id}},{session:'authenticated-second-session'});assert.equal(continued.isError,false);assert.deepEqual(continued.structuredContent,{done:true});assert.equal(ran,1,'the authenticated continuation executes exactly once');
 await f.app.handle('/api/settings',{browser_enabled:false});const denied=await f.rpc('run_capability',{capability:'isolated_browser_write',parameters:{task_id:start.task_id}});assert.equal(denied.isError,true);assert.equal(ran,1,'disabled browser permission prevents another execution');
});
test('1058 authenticated continuation rejects another project, root, or permission epoch',async t=>{
 for(const mismatch of ['project','root','epoch']){
  const f=await desktop(t),start=f.ok(await f.rpc('begin_task',{request_id:'1058-scope-'+mismatch,title:'隔离范围'}));let ran=0;
  f.app.tools.extraCapabilities.register({name:'isolated_browser_write',description:'test only',inputSchema:{type:'object',properties:{task_id:{type:'string'}},required:['task_id'],additionalProperties:false},permissions:['browser'],run:()=>{ran++;return {done:true};}});
  if(mismatch==='project')f.app.state.data.active='isolated-other-project';
  if(mismatch==='root')f.app.store.root=path.join(f.root,'isolated-other-root');
  if(mismatch==='epoch')f.app.policy.epoch++;
  const denied=await f.rpc('run_capability',{capability:'isolated_browser_write',parameters:{task_id:start.task_id}},{session:'authenticated-second-session'});assert.equal(denied.isError,true,mismatch);assert.equal(denied.structuredContent.code,'ROOT_CHANGED',mismatch);assert.equal(ran,0,mismatch+' must not invoke the handler');
 }
});
test('1058 registry rejects existing names, unbounded writes and malformed nested input before handler execution',async()=>{
 const r=new CapabilityRegistry({existingNames:['read_file']});const definition={name:'local_extra',description:'test',inputSchema:{type:'object',properties:{count:{type:'integer',minimum:1,maximum:3}},required:['count'],additionalProperties:false},readOnly:true,run:a=>a};
 assert.throws(()=>r.register({...definition,name:'read_file'}));assert.throws(()=>r.register({...definition,readOnly:false}));r.register(definition);
 for(const input of [{count:0},{count:4},{count:1,extra:true},{count:'1'},null])await assert.rejects(()=>r.call('local_extra',input,{}),{code:'CAPABILITY_ARGUMENT_INVALID'});
 assert.deepEqual(await r.call('local_extra',{count:2},{}),{count:2});
});
