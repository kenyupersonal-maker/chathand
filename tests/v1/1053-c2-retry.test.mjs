import test from 'node:test';import assert from 'node:assert/strict';import {ConnectionController} from '../../app/connection.mjs';
function fixture(){let now=1000,seq=0;const restarts=[],lost=[],back=[];const t={child:{id:++seq},key:'synthetic',stop(){restarts.push(now);this.child=null;},doctor:async()=>({ok:false}),start(){this.child={id:++seq};}};const c=new ConnectionController({tunnel:t,state:{data:{},save(){}},clock:()=>now,onCloudLost:x=>lost.push(x),onCloudBack:x=>back.push(x)});c.desired=true;c.phase='ready';return {c,t,restarts,lost,back,at:x=>now=x};}
test('C2 exact 45/60/120/300 second ladder survives reset, failed doctor, blocked and missing child; up alone resets',async()=>{
 const f=fixture(),{c,t}=f;c.watchCloud({state:'checking',down_since:1000});for(const [at,count] of [[45999,0],[46000,1],[105999,1],[106000,2],[225999,2],[226000,3],[525999,3],[526000,4],[826000,5]]){
  f.at(at);c.tick();if(c.busy)await c.busy;assert.equal(f.restarts.length,count,'at '+at);
  if([46000,106000,226000,526000,826000].includes(at)){f.at(at+1500);c.tick();if(c.busy)await c.busy;assert.equal(c.blocked,false);assert.equal(c.phase,'running');assert.ok(c.cloudEpisode);c.watchCloud({state:'down',down_since:1000});}
 }
 assert.equal(f.lost.length,1);assert.deepEqual(f.restarts,[46000,106000,226000,526000,826000]);
 t.child={id:55};c.phase='ready';c.watchCloud({state:'up'});assert.equal(c.cloudEpisode,null);assert.equal(c.cloudLost,false);assert.equal(f.back.length,1);f.at(900000);c.watchCloud({state:'down',down_since:900000});assert.equal(c.cloudEpisode.attempts,0);f.at(945000);assert.equal(c.nextDeadline(),945000);c.tick();if(c.busy)await c.busy;assert.equal(f.restarts.length,6);assert.equal(c.cloudEpisode.attempts,1);assert.equal(c.cloudEpisode.next,1005000);
});
test('C2 auth/stop fence retries; late doctor cannot start after stop; proxy restart retains episode',async()=>{
 const f=fixture(),{c,t}=f;c.watchCloud({state:'down',down_since:1000});f.at(2000);assert.equal(c.restart('proxy_changed'),true);assert.equal(c.cloudEpisode.attempts,1);assert.equal(c.cloudEpisode.since,1000);c.failed(true);f.at(999999);c.tick();assert.equal(f.restarts.length,1);assert.equal(f.lost.length,0);
 let resolve;t.doctor=()=>new Promise(r=>resolve=r);c.errorCode=null;c.blocked=false;c.startAttempt();c.stop({persist:false});resolve({ok:true});await c.busy;assert.equal(t.child,null);f.at(2000000);c.tick();assert.equal(c.cloudEpisode,null);assert.equal(c.desired,false);
});
test('C2 process replacement and fresh checking cannot postpone existing outage deadline',()=>{const f=fixture();f.c.watchCloud({state:'checking',down_since:1000});f.at(30000);f.t.child={id:9};f.c.phase='ready';f.c.watchCloud({state:'checking',down_since:30000});f.at(46000);f.c.tick();assert.equal(f.restarts.length,1);assert.equal(f.c.cloudEpisode.since,1000);});
