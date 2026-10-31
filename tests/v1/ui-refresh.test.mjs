import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('an action during an in-flight refresh awaits one queued fresh snapshot with SSE enabled',async()=>{
 const source=fs.readFileSync('ui/app.js','utf8');const code=source.slice(source.indexOf('function refresh(){'),source.indexOf('/* ---------- 动作 ---------- */'));
 const replies=[],snapshots=[];let renders=0;const context={h10StreamArrivalSerial:0,refreshing:false,refreshQueued:false,refreshPromise:null,S:null,P:{},announced:true,nativeStatusAt:Date.now(),Date,api:()=>new Promise(r=>replies.push(r)),adoptState:state=>{context.S=state;snapshots.push(state.value);renders++;},native:async()=>({})};vm.createContext(context);vm.runInContext(code,context);
 const poll=context.refresh(),action=context.refresh(),another=context.refresh();assert.equal(poll,action);assert.equal(action,another);assert.equal(replies.length,1);
 replies.shift()({value:'old',settings:{}});await new Promise(setImmediate);assert.equal(replies.length,1);assert.equal(context.refreshing,true);
 replies.shift()({value:'new',settings:{}});await action;assert.equal(context.S.value,'new');assert.equal(context.refreshing,false);assert.equal(renders,2);assert.deepEqual(snapshots,['old','new']);assert.equal(replies.length,0);
});
