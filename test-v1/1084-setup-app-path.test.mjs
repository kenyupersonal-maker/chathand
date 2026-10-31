import test from 'node:test';
import assert from 'node:assert/strict';
import {run,verifySetupOwner} from '../skills/chathand-setup/scripts/setup.mjs';
import {setupHandoff} from '../app/v1/setup-handoff.mjs';

const installed='/Applications/ChatHand.app';
const disk='/Volumes/ChatHand 1084 本地测试/ChatHand.app';
const node=app=>app+'/Contents/Resources/runtime/bin/ChatHandNode';
const realpath=p=>p;

test('setup handoff binds its path to the actual running App',()=>{
 for(const app of [installed,disk]){
  const handoff=setupHandoff({appPath:app,route:'openai'});
  assert.ok(handoff.prompt.includes(app));
  assert.equal(handoff.prompt.includes(app===installed?disk:installed),false);
 }
});

test('bundled helper only accepts the backend from the same App',async()=>{
 const runtime={};
 const good=async(_r,route)=>{assert.equal(route,'/api/state');return {node:node(installed)};};
 assert.equal((await verifySetupOwner(runtime,{executable:node(installed),realpath,call:good})).node,node(installed));
 for(const response of [{node:node(disk)},{}, {node:null}]){
  await assert.rejects(verifySetupOwner(runtime,{executable:node(installed),realpath,call:async()=>response}),{code:'APP_PATH_MISMATCH'});
 }
 const unresolved=p=>{if(p===node(installed))throw Error('not found');return p;};
 await assert.rejects(verifySetupOwner(runtime,{executable:node(installed),realpath:unresolved,call:good}),{code:'APP_PATH_MISMATCH'});
});

test('a mismatched bundled helper stops before reading the key or changing setup',async()=>{
 for(const args of [['doctor'],['connect','--tunnel-id','tunnel_test0001','--key-from-clipboard'],['site-start'],['switch','--route','openai']]){
  const calls=[];
  await assert.rejects(run(args,{
   locate:()=>({}),executable:node(installed),realpath,
   read:()=>{throw Error('must not read clipboard');},
   call:async(_r,route)=>{calls.push(route);assert.equal(route,'/api/state');return {node:node(disk)};}
  }),{code:'APP_PATH_MISMATCH'});
  assert.deepEqual(calls,['/api/state']);
 }
});

test('outside the bundled runtime existing development helpers keep their behavior',async()=>{
 assert.equal(await verifySetupOwner({}, {executable:'/usr/local/bin/node',call:async()=>{throw Error('unexpected call');}}),null);
});
