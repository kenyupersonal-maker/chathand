import test from 'node:test';import assert from 'node:assert/strict';import {PassThrough} from 'node:stream';
import {readUpgradeLifecycleKey,upgradeOwnerHeaders} from '../scripts/upgrade.mjs';
import {updateWorkPending} from '../app/v1/client-features.mjs';
test('private upgrade authority travels only over bounded stdin and only authorizes lifecycle quit',async()=>{
 const key='a'.repeat(64);for(const [input,expected] of [[key+'\n',key],['invalid\n',null],['a'.repeat(257),null],['',null]]){const stream=new PassThrough();const read=readUpgradeLifecycleKey({input:stream,timeout:100});stream.end(input);assert.equal(await read===expected,true);}
 assert.equal(await readUpgradeLifecycleKey({input:{isTTY:true}}),null);
 for(const route of ['/api/state','/api/upgrade/commit','/api/access'])assert.equal('X-ChatHand-Upgrade' in upgradeOwnerHeaders('fixture',route,key),false);
 assert.equal(upgradeOwnerHeaders('fixture','/api/lifecycle/quit',key)['X-ChatHand-Upgrade']===key,true);
 assert.equal('X-ChatHand-Upgrade' in upgradeOwnerHeaders('fixture','/api/lifecycle/quit','invalid'),false);
});
test('updates wait for every active/pending task and live or cleaning command, regardless of task age',()=>{
 for(const [tasks,jobs,expected] of [[[],[],false],[[{status:'active',created_at:1}],[],true],[[{status:'pending_approval'}],[],true],[[{status:'completed'}],[],false],[[],[{process_alive:true}],true],[[],[{cleanup_pending:true}],true],[[],[{process_alive:false,cleanup_pending:false}],false]])assert.equal(updateWorkPending({tasks,jobs}),expected);
});
