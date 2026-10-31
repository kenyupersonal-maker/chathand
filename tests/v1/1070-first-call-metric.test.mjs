import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../../app/connection.mjs';

test('1070 first authenticated call remains measurable after cloud health was already up; stale calls cannot add proof',()=>{
 let now=1000;const rows=[],tunnel={child:{},doctorChild:null};
 const c=new ConnectionController({tunnel,state:{data:{},save(){}},clock:()=>now,events:{record:(kind,value)=>rows.push({kind,...value})}});
 c.desired=true;c.recordCloud({state:'up',status:'ok'});now=2000;
 assert.equal(c.authenticatedCallSucceeded(now),true);
 assert.equal(rows.filter(r=>r.kind==='conn.cloud'&&r.reason==='call_ok').length,1);
 c.authenticatedCallSucceeded(++now);assert.equal(rows.filter(r=>r.reason==='call_ok').length,1);
 const old={generation:c.generation,child:tunnel.child};c.generation++;tunnel.child={};
 assert.equal(c.authenticatedCallSucceeded(++now,old),false);
 c.authenticatedCallSucceeded(++now);assert.equal(rows.filter(r=>r.reason==='call_ok').length,2);
});

