import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installSkill} from '../app/v09/local-setup.mjs';
import {callOwner,locateRuntime} from '../skills/chathand-setup/scripts/setup.mjs';

test('Codex setup skill installs to discoverable skills root and archives replacements outside it',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kb-skill-install-')),codexHome=path.join(home,'.codex');
 try{
  const first=installSkill({home,codexHome});
  assert.equal(first.path,path.join(codexHome,'skills/chathand-setup'));
  assert.match(fs.readFileSync(path.join(first.path,'SKILL.md'),'utf8'),/name: chathand-setup/);
  assert.equal(first.backup_path,null);
  fs.writeFileSync(path.join(first.path,'local-note.txt'),'prior install');
  const second=installSkill({home,codexHome});
  assert.ok(second.backup_path.startsWith(path.join(codexHome,'skill-backups')+path.sep));
  assert.equal(fs.readFileSync(path.join(second.backup_path,'local-note.txt'),'utf8'),'prior install');
  assert.equal(fs.existsSync(path.join(second.path,'local-note.txt')),false);
  assert.equal(fs.readdirSync(path.join(codexHome,'skills')).filter(x=>x.includes('chathand-setup')).length,1);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('setup skill installer refuses replacing a linked target',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kb-skill-link-')),codexHome=path.join(home,'.codex'),skills=path.join(codexHome,'skills');
 try{
  fs.mkdirSync(skills,{recursive:true});fs.symlinkSync(home,path.join(skills,'chathand-setup'));
  assert.throws(()=>installSkill({home,codexHome}),e=>e.code==='SKILL_PATH_LINK');
  assert.equal(fs.lstatSync(path.join(skills,'chathand-setup')).isSymbolicLink(),true);
  fs.unlinkSync(path.join(skills,'chathand-setup'));fs.symlinkSync(path.join(home,'missing'),path.join(skills,'chathand-setup'));
  assert.throws(()=>installSkill({home,codexHome}),e=>e.code==='SKILL_PATH_LINK');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('sandbox process-probe denial does not mislabel a running app as stopped',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kb-skill-runtime-'));
 try{
  const dir=path.join(home,'Library/Application Support/ChatHand/data');fs.mkdirSync(dir,{recursive:true});
  const runtime={ui_origin:'http://127.0.0.1:12345',admin_token:'a'.repeat(64),pid:12345};
  fs.writeFileSync(path.join(dir,'runtime.json'),JSON.stringify(runtime));
  const denied=()=>{throw Object.assign(Error('sandbox denied'),{code:'EPERM'});};
  assert.deepEqual(locateRuntime({home,stateDir:dir,platform:'darwin',probe:denied}),runtime);
  const gone=()=>{throw Object.assign(Error('missing'),{code:'ESRCH'});};
  assert.throws(()=>locateRuntime({home,stateDir:dir,platform:'darwin',probe:gone}),e=>e.code==='APP_NOT_RUNNING');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('blocked owner transport reports an unknown state without printing a token',async()=>{
 const runtime={ui_origin:'http://127.0.0.1:12345',admin_token:'a'.repeat(64)};
 await assert.rejects(callOwner(runtime,'/api/state',undefined,async()=>{throw Error('sandbox denied');}),e=>e.code==='OWNER_UNREACHABLE'&&!e.message.includes(runtime.admin_token));
});
