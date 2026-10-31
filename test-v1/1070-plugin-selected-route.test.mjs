import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../plugins/chathand/skills/chathand-setup/scripts/setup.mjs';

async function doctor(state){
 let calls=0;
 const result=await run(['doctor'],{locate:()=>({}),call:async(_,route)=>{calls++;assert.equal(route,'/api/state');return state;},clipboard:()=>assert.fail('doctor does not read clipboard')});
 assert.equal(calls,1);return result;
}
test('1070 packaged doctor reports actual route before stale setup intent without changing either',async()=>{
 for(const selected of ['site','openai'])for(const setup_route of ['none','site','openai']){
  const state={site_b:{selected},setup_route},before=structuredClone(state),result=await doctor(state);
  assert.equal(result.selected_route,selected);assert.equal(result.execution_route,selected);assert.equal(result.setup_route,setup_route);assert.deepEqual(state,before);
 }
});
test('1070 packaged doctor retains legacy route fallback when actual selection is unavailable',async()=>{
 for(const selected of [undefined,'invalid'])for(const setup_route of ['none','site','openai',undefined]){
  const result=await doctor({site_b:{selected},setup_route});assert.equal(result.selected_route,setup_route||'openai');
 }
});
