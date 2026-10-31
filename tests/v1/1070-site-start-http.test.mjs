import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './1070-chrome-server-fixture.mjs';

test('1070 passive state never creates a Site intent; explicit start creates one before watch and activity',async t=>{
 const f=fixture(t,{preference:'none'});await f.building;const a=f.app,local=a.tools.bSiteLocalStore,count=()=>local.db.prepare('SELECT count(*) AS n FROM b_pair_intents').get().n;
 assert.equal(count(),0);assert.equal((await a.snapshot()).site_b.pairing.verified_template_source,null);await a.snapshot();assert.equal(count(),0);assert.equal((await a.snapshot()).setup_activity.active,false);
 const response=await f.post('/api/setup/site/start',{});assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.watching,true);assert.equal(response.body.route,'site');assert.equal(typeof response.body.prompt,'string');assert.equal(count(),1);
 const view=await a.snapshot();assert.equal(view.site_b.pairing.verified_template_source.template_sha256,response.body.template_sha256);assert.equal(view.setup_activity.active,true);assert.equal(view.setup_activity.last_command,'site-start');assert.equal(view.setup_activity.route,'site');
 await a.snapshot();await a.snapshot();assert.equal(count(),1);
});
