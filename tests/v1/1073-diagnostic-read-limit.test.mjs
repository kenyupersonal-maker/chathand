import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readConnectionTimeline,readResourceTimeline,readChromeInstallEvents,readOnboardingEvents} from '../../app/diagnostic-events.mjs';

const readers=[
 ['connection',readConnectionTimeline,{kind:'conn.state',from:'connecting',to:'ready',source:'tunnel'}],
 ['resource',readResourceTimeline,{kind:'mcp.resource',method:'resources/list',family:'unknown',code:'OK',http_status:200,resource_bytes:0,resource_sha256:null,session_present:false,scope:'local_handler_only',host_ui_not_observed:true}],
 ['Chrome installation',readChromeInstallEvents,{kind:'chrome.install',stage:'opening_chrome',code:'CHROME_INSTALL_PROGRESS',ms:1,target_is_default:true,outcome:'running'}],
 ['onboarding',readOnboardingEvents,{kind:'onboarding.step',step:'first_tool_call',phase:'end',result:'ok',error_code:'NONE',actor:'ai',wait_ms:1,source:'server',span:'o_'+'1'.repeat(24)}]
];

for(const [name,read,fields] of readers)test(`${name} diagnostic read honors an empty result limit without rewriting evidence`,()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-diagnostic-limit-'));
 try{
  const dir=path.join(state,'diagnostics');fs.mkdirSync(dir,{mode:0o700});
  const file=path.join(dir,'events.jsonl');
  const rows=['2026-10-24T00:00:00.000Z','2026-10-24T00:00:01.000Z'].map(at=>({...fields,at}));
  const original=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';fs.writeFileSync(file,original,{mode:0o600});
  assert.equal(read(state).events.length,2);
  assert.deepEqual(read(state,{limit:1}).events.map(row=>row.at),[rows[1].at]);
  for(const limit of [0,-1]){
   const result=read(state,{limit});assert.deepEqual(result.events,[]);assert.equal(result.truncated,true);assert.equal(result.unreadable,0);
  }
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.deepEqual(fs.readdirSync(dir),['events.jsonl']);
 }finally{fs.rmSync(state,{recursive:true,force:true});}
});
