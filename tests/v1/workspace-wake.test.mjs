import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {startupFixture} from '../support/startup-five-fixture.mjs';

async function readFile(f){
 const runtime=JSON.parse(fs.readFileSync(path.join(f.stateDir,'runtime.json'),'utf8'));
 const response=await fetch(runtime.mcp_url,{method:'POST',headers:{'Content-Type':'application/json','X-Ken-Bridge-Token':runtime.mcp_token,Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_file',arguments:{path:'wake.txt'},_meta:{'openai/session':'synthetic-workspace-wake'}}})});
 const result=(await response.json()).result;assert.equal(result.isError,false);assert.equal(result.structuredContent.content,'WAKE_TEST');
}

test('an isolated service suspended beyond the old timeout resumes without creating a recovery lock',{skip:process.platform!=='darwin'},async t=>{
 const f=await startupFixture(t);fs.writeFileSync(path.join(f.work,'wake.txt'),'WAKE_TEST');await f.request('/api/access',{enabled:true});await readFile(f);
 const before=(await f.request('/api/state')).body;assert.equal(before.project.workspace.available,true);
 // This suspends only the fixture-owned service, not the Mac. A physical lid
 // cycle is a separate manual acceptance step recorded by workspace-lid-check.
 f.child.kill('SIGSTOP');try{await new Promise(resolve=>setTimeout(resolve,4500));}finally{f.child.kill('SIGCONT');}
 await readFile(f);const after=(await f.request('/api/state')).body;assert.equal(after.project.workspace.available,true);assert.equal(after.project.workspace.confirm_reason,null);assert.equal(after.project.workspace_recovery_required,undefined);
 const saved=JSON.parse(fs.readFileSync(path.join(f.stateDir,'desktop.json'),'utf8'));assert.equal(saved.projects.find(p=>p.id===saved.active).workspace_recovery_required,undefined);
});
