import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {refreshTaskWidget,validateOfflineHTML,parseArguments,AFFECTED_TESTS} from '../scripts/refresh-task-widget.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const page=text=>'<!doctype html><html><head><style>body{color:#123}</style></head><body>'+text+'<script>function render(v){document.getElementById("title").textContent=v;}</script></body></html>';
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-widget-refresh-')),root=path.join(base,'repo'),evidence=path.join(base,'new-evidence'),source=path.join(base,'claude.html');
 fs.mkdirSync(root);
 const write=(rel,body)=>{const dest=path.join(root,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,body);};
 const old=page('<h1 id="title">Previous</h1>'),incoming=page('<h1 id="title">New</h1><p>Example: https://example.invalid/docs</p>')+'\r\n';
 write('ui/task-widget.html',old);fs.chmodSync(path.join(root,'ui/task-widget.html'),0o644);fs.writeFileSync(source,incoming);
 write('package.json',JSON.stringify({version:'0.9.0-test',kenBridge:{connector_api:31,build_number:1060}}));
 const defs=[{name:'show_task',_meta:{ui:{resourceUri:'ui://chathand/task.html',csp:{connectDomains:[],resourceDomains:[]}},'openai/outputTemplate':'ui://chathand/task.html'}}];
 write('contracts/tools-v31.json',JSON.stringify(defs,null,2)+'\n');write('contracts/api31-freeze.json',JSON.stringify({connector_api:31,schema_sha256:sha(JSON.stringify(defs)),shell_protocol:1},null,2)+'\n');
 write('locales/en.json','{"untouched":"Original English"}\n');
 for(const file of AFFECTED_TESTS)write(file,'// Placeholder; fake runner must never execute this file.');
 const calls=[],f={base,root,evidence,source,old,incoming,write,calls};
 f.runner=(program,args)=>{calls.push({program,args});if(program==='git')return {status:0,stdout:args[0]==='status'?'':'b'.repeat(40),stderr:''};return f.step?.(program,args)||{status:0,stdout:'fixture proof only',stderr:''};};
 f.run=options=>refreshTaskWidget({root,source,evidence,runner:f.runner,...options});
 f.read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return f;
}

test('success keeps stable descriptor bytes, preserves both HTML inputs, and records exact content identity',t=>{
 const f=fixture(t),contract=f.read('contracts/tools-v31.json'),lock=f.read('contracts/api31-freeze.json'),english=f.read('locales/en.json');
 const receipt=f.run();
 assert.equal(receipt.status,'PASS_SOURCE_ONLY');assert.equal(f.read('ui/task-widget.html'),f.incoming);
 assert.equal(receipt.old_widget_sha256,sha(f.old));assert.equal(receipt.new_widget_sha256,sha(f.incoming));
 assert.equal(fs.readFileSync(path.join(f.evidence,'previous-task-widget.html'),'utf8'),f.old);
 assert.equal(fs.readFileSync(path.join(f.evidence,'incoming-task-widget.html'),'utf8'),f.incoming);assert.equal(fs.readFileSync(f.source,'utf8'),f.incoming);
 assert.equal(f.read('contracts/tools-v31.json'),contract);assert.equal(f.read('contracts/api31-freeze.json'),lock);assert.equal(f.read('locales/en.json'),english);
 assert.equal(fs.statSync(path.join(f.root,'ui/task-widget.html')).mode&0o777,0o644);
 const steps=f.calls.filter(x=>x.program!=='git').map(x=>x.args);
 assert.deepEqual(steps,[['scripts/generate-tool-contract.mjs','--check'],['scripts/generate-tool-contract.mjs','--freeze'],['scripts/check-contract.mjs'],['scripts/check-locales.mjs'],['scripts/ui-locale-resources.mjs','--check'],['--test','--test-concurrency=1',...AFFECTED_TESTS]]);
 assert.equal(receipt.final_candidate_acceptance,'NOT_RUN_SOURCE_ONLY');assert.match(receipt.required_final_candidate_acceptance.join(' '),/signed.*candidate.*1059/s);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence,'receipt.json'))).new_widget_sha256,sha(f.incoming));
});

test('failed affected whole-file tests restore original HTML and keep failure output plus old/new evidence',t=>{
 const f=fixture(t);f.step=(_program,args)=>args[0]==='--test'?{status:1,stdout:'original failed assertion',stderr:'failure detail'}:undefined;
 assert.throws(()=>f.run(),error=>{assert.equal(error.receipt.status,'FAILED_RESTORED');return /CHECK_FAILED: affected-tests/.test(error.message);});
 assert.equal(f.read('ui/task-widget.html'),f.old);assert.equal(fs.readFileSync(f.source,'utf8'),f.incoming);
 const log=JSON.parse(fs.readFileSync(path.join(f.evidence,'06-affected-tests.json')));assert.equal(log.status,1);assert.equal(log.stdout,'original failed assertion');
 assert.equal(fs.readFileSync(path.join(f.evidence,'incoming-task-widget.html'),'utf8'),f.incoming);assert.equal(fs.readFileSync(path.join(f.evidence,'previous-task-widget.html'),'utf8'),f.old);
});

test('stale inline locale check restores HTML without generating translations or running card tests',t=>{
 const f=fixture(t),english=f.read('locales/en.json');
 f.step=(_program,args)=>args[0]==='scripts/ui-locale-resources.mjs'?{status:1,stdout:'',stderr:'I18N_GENERATED_STALE ui/task-widget.html'}:undefined;
 assert.throws(()=>f.run(),/CHECK_FAILED: check-ui-locales/);assert.equal(f.read('ui/task-widget.html'),f.old);assert.equal(f.read('locales/en.json'),english);
 assert.equal(f.calls.some(x=>x.args[0]==='--test'),false);assert.equal(f.calls.some(x=>x.args.includes('--english')),false);
});

test('a successful runner cannot silently change the frozen descriptor or CSP; both contracts are restored',t=>{
 const f=fixture(t),before=f.read('contracts/tools-v31.json'),lock=f.read('contracts/api31-freeze.json');
 f.step=(_program,args)=>{if(args.includes('--freeze')){const defs=JSON.parse(before);defs[0]._meta.ui.csp.resourceDomains=['https://new.invalid'];f.write('contracts/tools-v31.json',JSON.stringify(defs));f.write('contracts/api31-freeze.json','altered');}return undefined;};
 assert.throws(()=>f.run(),/FROZEN_DESCRIPTOR_CHANGED/);assert.equal(f.read('ui/task-widget.html'),f.old);assert.equal(f.read('contracts/tools-v31.json'),before);assert.equal(f.read('contracts/api31-freeze.json'),lock);
 assert.equal(f.calls.some(x=>x.args[0]==='--test'),false);
});

test('failed freeze retains its original diagnostics and restores the product HTML',t=>{
 const f=fixture(t);f.step=(_program,args)=>args.includes('--freeze')?{status:1,stdout:'',stderr:'FROZEN_CONTRACT_DIFFERS: fixture'}:undefined;
 assert.throws(()=>f.run(),/CHECK_FAILED: freeze-api31/);assert.equal(f.read('ui/task-widget.html'),f.old);
 assert.match(fs.readFileSync(path.join(f.evidence,'02-freeze-api31.json'),'utf8'),/FROZEN_CONTRACT_DIFFERS/);
});

test('missing or invalid API31 freeze, changed stable URI, and dirty worktree reject before any product write',t=>{
 for(const kind of ['missing','hash','uri','dirty']){
  const f=fixture(t);
  if(kind==='missing')fs.unlinkSync(path.join(f.root,'contracts/api31-freeze.json'));
  if(kind==='hash')f.write('contracts/api31-freeze.json',JSON.stringify({connector_api:31,schema_sha256:'wrong'}));
  if(kind==='uri'){const defs=JSON.parse(f.read('contracts/tools-v31.json'));defs[0]._meta.ui.resourceUri='ui://chathand/task-123.html';f.write('contracts/tools-v31.json',JSON.stringify(defs));f.write('contracts/api31-freeze.json',JSON.stringify({connector_api:31,schema_sha256:sha(JSON.stringify(defs))}));}
  if(kind==='dirty')f.runner=()=>({status:0,stdout:' M ui/task-widget.html',stderr:''});
  assert.throws(()=>f.run());assert.equal(f.read('ui/task-widget.html'),f.old);assert.equal(fs.existsSync(f.evidence),false);
 }
});

test('preflight mismatch writes a failure receipt but never attempts replacement',t=>{
 const f=fixture(t);f.step=()=>({status:1,stdout:'',stderr:'descriptor registry drift'});
 assert.throws(()=>f.run(),error=>error.receipt.rollback_performed===false&&error.receipt.status==='FAILED_RESTORED');
 assert.equal(f.read('ui/task-widget.html'),f.old);assert.equal(f.calls.filter(x=>x.program!=='git').length,1);
});

test('existing evidence is never overwritten and source/evidence inside the repository are rejected',t=>{
 const f=fixture(t);fs.mkdirSync(f.evidence);fs.writeFileSync(path.join(f.evidence,'receipt.json'),'previous receipt');
 assert.throws(()=>f.run(),/EVIDENCE_ALREADY_EXISTS/);assert.equal(fs.readFileSync(path.join(f.evidence,'receipt.json'),'utf8'),'previous receipt');
 assert.throws(()=>f.run({source:path.join(f.root,'ui/task-widget.html'),evidence:path.join(f.base,'fresh')}),/OUTSIDE_REPOSITORY/);
 assert.throws(()=>f.run({evidence:path.join(f.root,'new')}),/OUTSIDE_REPOSITORY/);assert.equal(f.read('ui/task-widget.html'),f.old);
});

test('source validation failure preserves the candidate and original HTML without running product checks',t=>{
 const f=fixture(t);fs.writeFileSync(f.source,page('<img src="https://cdn.invalid/added.png">'));
 assert.throws(()=>f.run(),/WIDGET_EXTERNAL_RESOURCE_ATTRIBUTE/);assert.equal(f.read('ui/task-widget.html'),f.old);assert.equal(f.calls.filter(x=>x.program!=='git').length,0);
 assert.match(fs.readFileSync(path.join(f.evidence,'incoming-task-widget.html'),'utf8'),/cdn.invalid/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence,'receipt.json'))).status,'FAILED_RESTORED');
});

test('checker cannot replace tested HTML behind the content receipt',t=>{
 const f=fixture(t);f.step=(_program,args)=>{if(args[0]==='--test')f.write('ui/task-widget.html',page('unreviewed bytes'));};
 assert.throws(()=>f.run(),/WIDGET_CHANGED_DURING_CHECKS/);assert.equal(f.read('ui/task-widget.html'),f.old);
});

test('ordinary DOM rendering, dynamic ARIA, registration and string examples stay allowed',()=>{
 const html=page(`<ul id="list"></ul><script>
 const example="fetch('https://docs.example.invalid')";
 list.innerHTML=rows.map(row=>'<li>'+row+'</li>').join('');
 list.outerHTML='<ul><li>normal list</li></ul>';
 list.insertAdjacentHTML('beforeend','<li>another row</li>');
 list.setAttribute('aria-'+stateName,stateValue);
 window[rendererName](rows);
 register('normal-renderer',render);
 const marker='\\u2192';
 </script><style>li::after{content:"\\2192"}</style>`);
 assert.equal(validateOfflineHTML(html).body_example_urls_allowed,true);
});

test('the current real task HTML passes read-only inspection without executing or replacing it',()=>{
 const file=new URL('../ui/task-widget.html',import.meta.url),before=fs.readFileSync(file);
 assert.equal(validateOfflineHTML(before.toString('utf8')).body_example_urls_allowed,true);
 assert.deepEqual(fs.readFileSync(file),before);
});

test('offline inspection distinguishes plain example URLs from loaded resources and network code',()=>{
 assert.equal(validateOfflineHTML(page('<p>https://docs.example.invalid is just a text example</p><a href="#details">Details</a>')).body_example_urls_allowed,true);
 for(const content of [
  '<script src="https://cdn.invalid/a.js"></script>',
  '<img src=//cdn.invalid/a.png>',
  '<svg><image href="https&#58;//cdn.invalid/a.svg"></image></svg>',
  '<link rel="stylesheet" href="https://cdn.invalid/a.css">',
  '<style>p{background:url(https://cdn.invalid/a.png)}</style>',
  '<style>@import "https://cdn.invalid/a.css";</style>',
  '<iframe srcdoc="hello"></iframe>',
  '<meta http-equiv="refresh" content="0;url=https://other.invalid">',
  '<script>fetch("https://other.invalid")</script>',
  '<script>new WebSocket("wss://other.invalid")</script>',
  '<script>import helper from "https://cdn.invalid/module.js"</script>',
  '<script>window.open("https://other.invalid")</script>',
  '<script>window["fetch"]("https://other.invalid")</script>',
  '<script>document.createElement("img").src="https://other.invalid/a.png"</script>',
 ])assert.throws(()=>validateOfflineHTML(page(content)),undefined,content);
});

test('CLI limits proof selection to approved whole files and rejects malformed arguments',t=>{
 assert.deepEqual(parseArguments(['--source','/tmp/card.html','--evidence','/tmp/proof','--test',AFFECTED_TESTS[0]]),{source:'/tmp/card.html',evidence:'/tmp/proof',tests:[AFFECTED_TESTS[0]]});
 for(const args of [['--source'],['--source','/a','--source','/b'],['--skip-tests'],['--root','/other']])assert.throws(()=>parseArguments(args));
 const f=fixture(t);assert.throws(()=>f.run({tests:['test-v1/unrelated.test.mjs']}),/UNKNOWN_OR_EMPTY_AFFECTED_TEST_LIST/);assert.equal(f.calls.length,0);
 const receipt=f.run({tests:[AFFECTED_TESTS[0]]});assert.deepEqual(receipt.tests,[AFFECTED_TESTS[0]]);
});
