import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {toolContractFiles,writeToolContract} from '../../scripts/generate-tool-contract.mjs';
import {TOOLS} from '../../app/tools.mjs';
test('unfrozen API31 registry changes only approved v30 descriptor paths',()=>{
 const previous=JSON.parse(fs.readFileSync(new URL('../../contracts/tools-v30.json',import.meta.url),'utf8'));
 assert.deepEqual(TOOLS.map(t=>t.name),previous.filter(t=>t.name!=='request_permission').map(t=>t.name));
 const allowed=new Map(),allow=(names,paths)=>{for(const name of names){const set=allowed.get(name)||new Set();for(const p of paths)set.add(p);allowed.set(name,set);}};
 allow(['get_file_info','desktop_action','browser_status','browser_tabs','browser_action','computer_batch','browser_batch','begin_task','task_status','task_stop','command_result','input_status','command_input','move_path','trash_path','restore_trash','operation_status','request_update','run_capability'],['description']);
 allow(['browser_open','browser_tabs','browser_snapshot','browser_action','browser_screenshot','browser_upload','browser_download','browser_batch','browser_read','browser_find','browser_wait_for'],['inputSchema.properties.allow_personal']);
 allow(['browser_action','computer_action'],['inputSchema.properties.confirm']);
 allow(['browser_batch','computer_batch'],['inputSchema.properties.steps.items.properties.confirm']);
 allow(['run_capability'],['inputSchema.required']);
 allow(['desktop_action','task_stop'],['_meta']);allow(['task_status'],['_meta.ui']);
 allow(['card_answer'],['annotations.destructiveHint','annotations.openWorldHint']);
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const changed=(a,b,at='')=>{
  if(JSON.stringify(a)===JSON.stringify(b))return [];
  if(object(a)&&object(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>changed(a[k],b[k],at?at+'.'+k:k));
  return [at];
 };
 for(const actual of TOOLS){const before=previous.find(t=>t.name===actual.name);for(const p of changed(before,actual))assert.equal(allowed.get(actual.name)?.has(p),true,actual.name+': unapproved change at '+p);}
});
test('freeze generator refuses an unselected API and never replaces a reviewed contract',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-api31-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.throws(()=>toolContractFiles(TOOLS,30),/API31_PACKAGE_NOT_READY/);
 const files=toolContractFiles(TOOLS,31);writeToolContract(root,files);writeToolContract(root,files,{check:true});
 const prior=fs.readFileSync(path.join(root,'contracts/tools-v31.json'),'utf8');
 assert.throws(()=>writeToolContract(root,toolContractFiles(TOOLS.slice(1),31)),/FROZEN_CONTRACT_DIFFERS/);assert.equal(fs.readFileSync(path.join(root,'contracts/tools-v31.json'),'utf8'),prior);
 // Preflight all locks before producing a missing companion file.
 fs.unlinkSync(path.join(root,'contracts/tools-v31.json'));assert.throws(()=>writeToolContract(root,toolContractFiles(TOOLS.slice(1),31)),/FROZEN_CONTRACT_DIFFERS/);assert.equal(fs.existsSync(path.join(root,'contracts/tools-v31.json')),false);
});
