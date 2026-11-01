import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeComputer} from '../../app/v07/computer.mjs';

function fixture(){
 const state={data:{mode:'full',desktop_enabled:true,high_risk:{chatgpt_self:false}}};
 const policy={epoch:1,require:()=>({status:'active'})};
 const computer=new NativeComputer(state,policy);computer.heartbeat({accessibility:true});
 return {state,policy,computer};
}
test('desktop trusted flag comes from saved permission, not caller args; native real-bundle refusal becomes the existing risk receipt',async()=>{
 const {state,computer}=fixture();
 const result=computer.request('observe',{bundle_id:'com.openai.chat',chatgpt_self_allowed:true},'task-a','caller');
 const request=computer.next().request;assert.equal(request.args.chatgpt_self_allowed,false);
 computer.complete(request.id,{error:{code:'HIGH_RISK_DISABLED',details:{id:'chatgpt_self'}}});
 await assert.rejects(result,e=>e.code==='HIGH_RISK_DISABLED'&&e.details.blocked.item.id==='chatgpt_self');
 state.data.high_risk.chatgpt_self=true;
 const allowed=computer.request('observe',{bundle_id:'com.openai.chat'},'task-a','caller');
 const next=computer.next().request;assert.equal(next.args.chatgpt_self_allowed,true);computer.complete(next.id,{test:'allowed'});assert.equal((await allowed).test,'allowed');
});
test('stop and resume belong to one task; an already queued action is never replayed',async()=>{
 const {computer}=fixture();const p=computer.request('action',{action:'click'},'task-a','caller');
 const stopped=computer.userStop('task-a',{scope:'desktop'});assert.equal(stopped.stopped,true);
 await assert.rejects(p,e=>e.code==='COMPUTER_USER_ACTIVITY'&&e.details.do_not_replay===true);
 assert.equal(computer.next().request,null);
 assert.throws(()=>computer.request('action',{},'task-a','caller'),e=>e.details.user_stopped===true);
 const other=computer.request('observe',{},'task-b','caller');const r=computer.next().request;computer.complete(r.id,{observed:true});assert.equal((await other).observed,true);
 assert.equal(computer.userResume('task-a',{scope:'desktop'}).next_action,'computer_observe');
 assert.equal(computer.next().request,null);
});
test('revoking self permission invalidates already queued desktop input before delivery',async()=>{const {state,policy,computer}=fixture();state.data.high_risk.chatgpt_self=true;const result=computer.request('action',{bundle_id:'com.openai.chat',action:'click'},'task-a','caller');state.data.high_risk.chatgpt_self=false;policy.permissionRevision=1;assert.equal(computer.next().request,null);await assert.rejects(result,e=>e.code==='COMPUTER_REQUEST_EXPIRED');});
