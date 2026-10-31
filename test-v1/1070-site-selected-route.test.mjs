import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitized,run} from '../skills/chathand-setup/scripts/setup.mjs';
test('sanitized selected_route follows actual selection while preserving setup intent and execution route',()=>{
 for(const selected of ['site','openai'])for(const setup_route of ['none','site','openai',undefined]){
  const result=sanitized({site_b:{selected},setup_route});
  assert.equal(result.selected_route,selected);assert.equal(result.execution_route,selected);
  assert.equal(result.setup_route,setup_route??null);
 }
});
test('absent or invalid actual selection retains legacy intent fallback and default',()=>{
 for(const selected of [undefined,null,'invalid','none'])for(const setup_route of ['none','site','openai',undefined,'invalid']){
  const result=sanitized({site_b:{selected},setup_route});
  assert.equal(result.selected_route,['none','site','openai'].includes(setup_route)?setup_route:'openai');
  assert.equal(result.execution_route,'openai');
 }
});
test('doctor exposes actual selection without issuing a selection command',async()=>{
 const calls=[];const result=await run(['doctor'],{locate:()=>({}),call:async(_,route)=>{calls.push(route);return {setup_route:'site',site_b:{selected:'openai'}};}});
 assert.equal(result.selected_route,'openai');assert.deepEqual(calls,['/api/state']);
});
