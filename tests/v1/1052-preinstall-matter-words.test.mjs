import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {desktop} from './1052-a-fixture.mjs';
test('preinstall11 finish preparation maps known termination and hides unknown raw reason',async t=>{
 const f=await desktop(t),m=f.app.tools.matterStore;
 // 断言跟着 Ken 10/28 12:43 改：「连接断开太久，停下了」换成跟窗口一样的「因连接中断已停止」
 for(const [reason,expected] of [['connection_lost','因连接中断已停止，先放着'],['unknown_fake_reason','任务已结束，先放着']]){
  const task={id:crypto.randomUUID()},r=await m.write({request_id:crypto.randomUUID(),entries:[{operation_id:crypto.randomUUID(),action:'create',title:reason,raw:{speaker:'fixture',text:'fake matter'},state:'waiting_ai',task_id:task.id,create_anyway:true}]},{project_id:f.app.state.data.active});assert.equal(r.items[0].saved,true);
  const intent=m.prepareFinish(task,'chatgpt',[],{reason});assert.equal(intent.entries[0].entry.waiting_for,expected);assert.equal(intent.entries[0].entry.waiting_for.includes(reason),false);
 }
});
