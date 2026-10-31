import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TOOLS} from '../app/tools.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL('../contracts/'+name,import.meta.url),'utf8'));const previous=read('tools-v28.json'),api29=read('tools-v29.json');
test('API29 changes only audited annotations, recording sentence, and five necessary content-addressed card URIs',()=>{
 assert.equal(api29.length,83);const fields=[];
 function diff(a,b,p=[]){if(JSON.stringify(a)===JSON.stringify(b))return;if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],[...p,k]);}else fields.push(p.join('.'));}
 for(const t of api29){const old=previous.find(x=>x.name===t.name);assert.ok(old);fields.length=0;diff(old,t);
  const permitted=new Set();if(['log_note','setup_claim','setup_done'].includes(t.name)){permitted.add('annotations.destructiveHint');permitted.add('annotations.openWorldHint');assert.equal(t.annotations.destructiveHint,false);assert.equal(t.annotations.openWorldHint,false);}
  if(t.name==='browser_wait_for'){permitted.add('annotations.destructiveHint');assert.equal(t.annotations.destructiveHint,false);assert.equal(t.annotations.openWorldHint,true);}
  if(['matter_write','bridge_info'].includes(t.name)){permitted.add('description');assert.equal(t.description,old.description.replaceAll('记到待办事项里了','记下了，在『记一下』里'));}
  if(['show_task','task_checkpoint','finish_task','setup_write_probe','request_permission'].includes(t.name)){permitted.add('_meta.ui.resourceUri');permitted.add('_meta.openai/outputTemplate');assert.match(t._meta.ui.resourceUri,/^ui:\/\/chathand\/task-[a-f0-9]{10}\.html$/);}
  for(const field of fields)assert.ok(permitted.has(field),t.name+':'+field);
 }
 assert.deepEqual(api29.map(t=>t.name),previous.map(t=>t.name));const current=read('tools-v31.json');assert.deepEqual(TOOLS,current);assert.equal(TOOLS.length,current.length);
 for(const name of ['propose_command','command_input','cancel_command','task_stop','automation_stop','browser_close','tools_refresh_click'])assert.deepEqual(TOOLS.find(t=>t.name===name).annotations,previous.find(t=>t.name===name).annotations,name);
});
