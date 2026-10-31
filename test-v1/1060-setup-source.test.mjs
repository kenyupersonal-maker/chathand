import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {syncSetupSkill} from '../scripts/setup-skill-sync.mjs';
import {setupHandoff} from '../app/v1/setup-handoff.mjs';
import {run} from '../skills/chathand-setup/scripts/setup.mjs';

test('new setup defaults to OpenAI, explicit route survives, invalid route is rejected',()=>{
 const appPath='/tmp/Fake ChatHand.app';
 assert.equal(setupHandoff({appPath}).route,'openai');
 for(const route of ['openai','site'])assert.equal(setupHandoff({appPath,route}).route,route);
 for(const route of ['',null,'other'])assert.throws(()=>setupHandoff({appPath,route}),{code:'SETUP_ROUTE_INVALID'});
});

test('connect preserves a healthy selected Site before reading secrets or mutating',async()=>{
 let reads=0;
 const result=await run(['connect'],{locate:()=>({}),call:async(_,route)=>{
  assert.equal(route,'/api/state');reads++;
  return {site_b:{selected:'site',routes:{site:{configured:true,state:'healthy',health_fresh:true}}}};
 },stdin:()=>assert.fail('stdin'),read:()=>assert.fail('clipboard'),clear:()=>assert.fail('clipboard clear')});
 assert.equal(result.preserved_existing_connection,true);assert.equal(reads,1);
});

test('site explicitly consumes its private pairing line even when a healthy Site is already selected',async()=>{
 const origin='https://private-a.chatgpt.site',siteId='privateSiteA',line=JSON.stringify({format:'chathand-site-v2',site_origin:origin,site_id:siteId,service_credential:'synthetic-service-bearer-'.padEnd(48,'x')});let reads=0,posts=0;
 const state=(revision,phase='configured',noticeAt=1000)=>({site_b:{selected:'site',routes:{site:{configured:true,state:'healthy',health_fresh:true,origin,site_id:siteId,revision}},pairing:{phase,target_site:siteId,pending_until:null},paired_notice:{notice_id:'fixture',origin,paired_at:noticeAt}}});
 const result=await run(['site'],{locate:()=>({}),now:()=>1000,stdin:async()=>{reads++;return line;},call:async(_,route,body)=>{if(route==='/api/state')return state(posts?5:4);assert.equal(route,'/api/setup/site');assert.equal(body.site_id,siteId);posts++;return {phase:'pairing',origin};}});
 assert.equal(reads,1);assert.equal(posts,1);assert.equal(result.preserved_existing_connection,undefined);assert.equal(result.phase,'paired');
});

test('mirror check detects drift and sync repairs copies without deleting extras',t=>{
 const repoRoot=fs.mkdtempSync(path.join(os.tmpdir(),'setup-mirror-'));
 t.after(()=>fs.rmSync(repoRoot,{recursive:true,force:true}));
 const source=path.join(repoRoot,'skills/chathand-setup'),dest=path.join(repoRoot,'plugins/chathand/skills/chathand-setup');
 fs.mkdirSync(source,{recursive:true});fs.mkdirSync(dest,{recursive:true});
 fs.writeFileSync(path.join(source,'SKILL.md'),'canonical');fs.writeFileSync(path.join(dest,'SKILL.md'),'drift');
 assert.throws(()=>syncSetupSkill({repoRoot,check:true}),/SETUP_MIRROR_DRIFT/);
 assert.equal(fs.readFileSync(path.join(dest,'SKILL.md'),'utf8'),'drift');
 assert.equal(syncSetupSkill({repoRoot}).updated,1);
 assert.equal(syncSetupSkill({repoRoot,check:true}).updated,0);
 fs.writeFileSync(path.join(dest,'extra'),'preserve');
 assert.throws(()=>syncSetupSkill({repoRoot}),/SETUP_MIRROR_EXTRA_FILES/);
 assert.equal(fs.readFileSync(path.join(dest,'extra'),'utf8'),'preserve');
});

test('packaged skill is identical to the sole maintained source',()=>{
 assert.equal(syncSetupSkill({check:true}).updated,0);
});
