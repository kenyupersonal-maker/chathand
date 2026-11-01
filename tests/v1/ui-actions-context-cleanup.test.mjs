import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../ui/1012/checks/actions.js',import.meta.url),'utf8');
function fixture(failedContext,{cleanupFails=false}={}){
 const original=Error('synthetic page action failure'),cleanup=Error('synthetic context cleanup failure');
 const contexts=[],errors=[],results=[],opened=[];
 const open=async query=>{
  opened.push(query);const number=opened.length;
  const ctx={closes:0,errs:[],close:async()=>{ctx.closes++;if(cleanupFails&&number===failedContext)throw cleanup;}};
  ctx.page={click:async()=>{if(number===failedContext)throw original;},evaluate:async()=>true,waitForTimeout:async()=>{},
   locator:()=>({getAttribute:async()=> 'polite'}),keyboard:{press:async()=>{}}};
  contexts.push(ctx);return ctx;
 };
 const context={process:{exitCode:0},console:{error:error=>errors.push(error)},require:name=>{
  if(name==='../shoot')return {open};
  if(name==='./common')return {result:(...args)=>results.push(args),settle:async()=>{}};
  throw Error('unexpected module '+name);
 }};
 vm.createContext(context);
 const completion=new vm.Script(source,{filename:'actual-actions.js'}).runInContext(context);
 return {completion,contexts,errors,results,opened,context,original,cleanup};
}
for(const failedContext of [1,2])test('actual actions script closes current context '+failedContext+' after page failure and keeps original error',async()=>{
 const f=fixture(failedContext);await f.completion;
 assert.equal(f.opened.length,failedContext);assert.deepEqual(f.contexts.map(ctx=>ctx.closes),Array(failedContext).fill(1));
 assert.ok(f.errors.includes(f.original));assert.equal(f.context.process.exitCode,1);assert.deepEqual(f.results,[],'an exception must not manufacture a completed result');
});
test('cleanup failure is reported without replacing the original page failure or writing results',async()=>{
 const f=fixture(2,{cleanupFails:true});await f.completion;
 assert.deepEqual(f.contexts.map(ctx=>ctx.closes),[1,1]);assert.ok(f.errors.includes(f.original));assert.ok(f.errors.includes(f.cleanup));
 assert.equal(f.context.process.exitCode,1);assert.deepEqual(f.results,[]);
});
