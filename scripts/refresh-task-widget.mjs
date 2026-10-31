// Replaces only the offline task HTML. The frozen descriptor is an invariant.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../',import.meta.url));
const widget='ui/task-widget.html';
const contracts=['contracts/tools-v31.json','contracts/api31-freeze.json'];
export const AFFECTED_TESTS=Object.freeze([
 'test-v1/1029-checkpoint-card.test.mjs',
 'test-v1/1041-h8-widget.test.mjs',
 'test-v1/1060-ui-widget-locales.test.mjs',
 'test-v1/1060-ui-locale-packaging.test.mjs',
 'test-v1/1060-card-backend.test.mjs',
 'test-v1/1060-card-metadata-budget.test.mjs',
]);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error(message);};
const inside=(parent,child)=>child===parent||child.startsWith(parent+path.sep);
function regular(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('REGULAR_UNLINKED_FILE_REQUIRED: '+file);return s;}
function decodeEntities(value){
 return value.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi,(_,n)=>String.fromCodePoint(parseInt(n[0].toLowerCase()==='x'?n.slice(1):n,n[0].toLowerCase()==='x'?16:10))).replace(/&(?:colon|tab|newline|amp|quot|apos);/gi,m=>({'&colon;':':','&tab;':'\t','&newline;':'\n','&amp;':'&','&quot;':'"','&apos;':"'"}[m.toLowerCase()]));
}
function inlineReference(value){return !value||value.startsWith('#')||/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value);}
function cssReferences(css){
 const source=css.replace(/\/\*[\s\S]*?\*\//g,'');
 if(/@import/i.test(source))fail('WIDGET_EXTERNAL_CSS_REFERENCE');
 for(const match of source.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi))if(!inlineReference(match[2].trim()))fail('WIDGET_EXTERNAL_CSS_REFERENCE');
}
function scriptReferences(script){
 // Inspect clear literal loading targets only. Normal DOM rendering and code
 // whose target is dynamic stay under the already frozen host CSP.
 const tokens=(script.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)||[]).filter(t=>!t.startsWith('//')&&!t.startsWith('/*'));
 const literal=t=>/^['"`]/.test(t||'')?t.slice(1,-1):null;
 const external=t=>/^(?:https?:|wss?:|\/\/)/i.test(literal(t)||'');
 const network=new Set(['fetch','WebSocket','WebTransport','EventSource','Worker','SharedWorker','importScripts','sendBeacon','import']);
 const resource=new Set(['src','href','srcset','srcdoc','action','formAction','location']);
 for(let i=0;i<tokens.length;i++){
  const name=tokens[i];
  if(network.has(name)&&tokens[i+1]==='('&&external(tokens[i+2]))fail('WIDGET_EXTERNAL_SCRIPT_TARGET');
  if(name==='['&&literal(tokens[i+1])==='fetch'&&tokens[i+2]===']'&&tokens[i+3]==='('&&external(tokens[i+4]))fail('WIDGET_EXTERNAL_SCRIPT_TARGET');
  if(['from','import'].includes(name)&&external(tokens[i+1]))fail('WIDGET_EXTERNAL_SCRIPT_TARGET');
  if(resource.has(name)&&tokens[i-1]==='.'&&tokens[i+1]==='='&&external(tokens[i+2]))fail('WIDGET_EXTERNAL_SCRIPT_TARGET');
  if(name==='setAttribute'&&tokens[i+1]==='('&&resource.has(literal(tokens[i+2]))&&tokens[i+3]===','&&external(tokens[i+4]))fail('WIDGET_EXTERNAL_SCRIPT_TARGET');
  if(name==='open'&&tokens[i-1]==='.'&&tokens[i+1]==='('&&(external(tokens[i+2])||(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(literal(tokens[i+2])||'')&&tokens[i+3]===','&&external(tokens[i+4]))))fail('WIDGET_EXTERNAL_SCRIPT_TARGET');
 }
}

export function validateOfflineHTML(html){
 if(!/^\s*<!doctype html>/i.test(html)||!/<html\b/i.test(html)||!/<\/html\s*>/i.test(html))fail('COMPLETE_HTML_REQUIRED');
 const withoutComments=html.replace(/<!--[\s\S]*?-->/g,'');
 const markup=withoutComments.replace(/<(script|style)\b([^>]*?)>([\s\S]*?)<\/\1\s*>/gi,(whole,tag,attrs,body)=>{
  if(tag.toLowerCase()==='script')scriptReferences(body);else cssReferences(body);
  return '<'+tag+attrs+'></'+tag+'>';
 });
 for(const match of markup.matchAll(/<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)){
  const tag=match[1].toLowerCase(),attributes=match[2];
  if(['base','iframe','frame','object','embed','applet'].includes(tag))fail('WIDGET_EXTERNAL_DOCUMENT_CAPABILITY');
  for(const attr of attributes.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)){
   const name=attr[1].toLowerCase(),value=decodeEntities(attr[2]??attr[3]??attr[4]??'').trim();
   if(name==='http-equiv'&&/refresh|content-security-policy/i.test(value))fail('WIDGET_REDIRECT_OR_CSP_OVERRIDE');
   if(name==='srcdoc'||name==='srcset'||name==='ping')fail('WIDGET_EXTERNAL_RESOURCE_ATTRIBUTE');
   if(['src','href','xlink:href','action','formaction','poster','background','data','codebase','manifest'].includes(name)&&!inlineReference(value))fail('WIDGET_EXTERNAL_RESOURCE_ATTRIBUTE: '+name);
   if(name==='style')cssReferences(value);
   if(name.startsWith('on'))scriptReferences(value);
  }
 }
 return {policy:'offline inline HTML; fragment links and inline raster images only',body_example_urls_allowed:true};
}
function runDefault(program,args,{root}){const r=spawnSync(program,args,{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});return {status:r.status??1,stdout:r.stdout||'',stderr:r.stderr||r.error?.message||''};}
function atomicReplace(file,bytes,mode){const tmp=file+'.refresh-'+crypto.randomUUID();try{fs.writeFileSync(tmp,bytes,{flag:'wx',mode});fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
export function refreshTaskWidget({source,evidence,root=repository,tests=AFFECTED_TESTS,runner=runDefault}={}){
 root=fs.realpathSync(root);
 if(!path.isAbsolute(source||'')||!path.isAbsolute(evidence||''))fail('ABSOLUTE_SOURCE_AND_NEW_EVIDENCE_REQUIRED');
 source=fs.realpathSync(source);
 const evidenceParent=fs.realpathSync(path.dirname(evidence));evidence=path.join(evidenceParent,path.basename(evidence));
 if(inside(root,source)||inside(root,evidence)||inside(evidence,source))fail('SOURCE_AND_EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY');
 if(fs.existsSync(evidence))fail('EVIDENCE_ALREADY_EXISTS');
 const sourceStat=regular(source);if(sourceStat.size>3*1024*1024)fail('WIDGET_SOURCE_TOO_LARGE');
 const incoming=fs.readFileSync(source),html=new TextDecoder('utf-8',{fatal:true}).decode(incoming);
 if(!Array.isArray(tests)||!tests.length||new Set(tests).size!==tests.length||tests.some(t=>!AFFECTED_TESTS.includes(t)))fail('UNKNOWN_OR_EMPTY_AFFECTED_TEST_LIST');
 for(const file of tests)regular(path.join(root,file));
 const git=(args)=>{const r=runner('git',args,{root});if(r.status!==0)fail('GIT_PREFLIGHT_FAILED');return r.stdout.trim();};
 if(git(['status','--porcelain','--untracked-files=normal']))fail('CLEAN_WORKTREE_REQUIRED');
 const commit=git(['rev-parse','HEAD']);
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
 if(pkg.kenBridge?.connector_api!==31)fail('API31_PACKAGE_REQUIRED');
 for(const rel of contracts)if(!fs.existsSync(path.join(root,rel)))fail('API31_ALREADY_FROZEN_REQUIRED');
 const snapshots=new Map([widget,...contracts].map(rel=>{const file=path.join(root,rel),stat=regular(file);return [rel,{bytes:fs.readFileSync(file),mode:stat.mode&0o777}];}));
 const definitions=JSON.parse(snapshots.get(contracts[0]).bytes),freeze=JSON.parse(snapshots.get(contracts[1]).bytes);
 if(freeze.connector_api!==31||freeze.schema_sha256!==sha(JSON.stringify(definitions)))fail('API31_ALREADY_FROZEN_REQUIRED');
 for(const descriptor of definitions){for(const uri of [descriptor._meta?.ui?.resourceUri,descriptor._meta?.['openai/outputTemplate']])if(typeof uri==='string'&&/^ui:\/\/chathand\/task/.test(uri)&&uri!=='ui://chathand/task.html')fail('STABLE_TASK_WIDGET_URI_REQUIRED');}
 fs.mkdirSync(evidence,{mode:0o700});
 const save=(name,value)=>fs.writeFileSync(path.join(evidence,name),value,{flag:'wx',mode:0o600});
 save('previous-task-widget.html',snapshots.get(widget).bytes);save('incoming-task-widget.html',incoming);
 for(const rel of contracts)save(path.basename(rel),snapshots.get(rel).bytes);
 const receipt={format:1,status:'running',source_commit:commit,source_version:pkg.version,source_build:pkg.kenBridge.build_number,source,old_widget_sha256:sha(snapshots.get(widget).bytes),new_widget_sha256:sha(incoming),connector_api:31,descriptor_schema_sha256:freeze.schema_sha256,descriptor_files:Object.fromEntries(contracts.map(rel=>[rel,sha(snapshots.get(rel).bytes)])),tests:[...tests],steps:[],created_at:new Date().toISOString(),required_final_candidate_acceptance:['Run signed-page rehearsal against the final signed candidate bytes.','Run the unchanged original 1059 successful-upgrade rehearsal against the same final candidate.'],final_candidate_acceptance:'NOT_RUN_SOURCE_ONLY'};
 const pinned=()=>{for(const rel of contracts)if(!fs.readFileSync(path.join(root,rel)).equals(snapshots.get(rel).bytes))fail('FROZEN_DESCRIPTOR_CHANGED: '+rel);};
 let replaced=false;
 try{
  receipt.offline_validation=validateOfflineHTML(html);
  const run=(label,args)=>{const result=runner(process.execPath,args,{root});save(String(receipt.steps.length+1).padStart(2,'0')+'-'+label+'.json',JSON.stringify({program:process.execPath,args,...result},null,2)+'\n');receipt.steps.push({label,exit_code:result.status});pinned();if(result.status!==0)fail('CHECK_FAILED: '+label);};
  run('existing-freeze',['scripts/generate-tool-contract.mjs','--check']);
  if(git(['status','--porcelain','--untracked-files=normal']))fail('WORKTREE_CHANGED_DURING_PREFLIGHT');
  if(!fs.readFileSync(path.join(root,widget)).equals(snapshots.get(widget).bytes))fail('WIDGET_CHANGED_DURING_PREFLIGHT');
  atomicReplace(path.join(root,widget),incoming,snapshots.get(widget).mode);replaced=true;
  run('freeze-api31',['scripts/generate-tool-contract.mjs','--freeze']);
  run('check-contract',['scripts/check-contract.mjs']);
  run('check-locales',['scripts/check-locales.mjs']);
  run('check-ui-locales',['scripts/ui-locale-resources.mjs','--check']);
  run('affected-tests',['--test','--test-concurrency=1',...tests]);
  pinned();
  if(sha(fs.readFileSync(path.join(root,widget)))!==receipt.new_widget_sha256)fail('WIDGET_CHANGED_DURING_CHECKS');
  receipt.status='PASS_SOURCE_ONLY';receipt.rollback_performed=false;
 }catch(error){
  const restoreErrors=[];
  for(const rel of [widget,...contracts])try{const s=snapshots.get(rel),file=path.join(root,rel);if(!fs.existsSync(file)||!fs.readFileSync(file).equals(s.bytes))atomicReplace(file,s.bytes,s.mode);}catch(e){restoreErrors.push(rel+': '+e.message);}
  receipt.status=restoreErrors.length?'FAILED_ROLLBACK_INCOMPLETE':'FAILED_RESTORED';receipt.error=error.message;receipt.rollback_performed=replaced;receipt.restore_errors=restoreErrors;
  save('receipt.json',JSON.stringify(receipt,null,2)+'\n');throw Object.assign(Error(error.message),{evidence,receipt});
 }
 save('receipt.json',JSON.stringify(receipt,null,2)+'\n');
 return {...receipt,evidence};
}
export function parseArguments(args){
 const options={},tests=[];
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(!['--source','--evidence','--test'].includes(arg)||!args[i+1]||args[i+1].startsWith('--'))fail('USE_--source_ABS_HTML_--evidence_ABS_NEW_DIRECTORY_[--test_APPROVED_FILE]');
  const value=args[++i];if(arg==='--test')tests.push(value);else{const key=arg.slice(2);if(options[key])fail('DUPLICATE_OPTION: '+arg);options[key]=value;}
 }
 return {...options,...(tests.length?{tests}:{})};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(refreshTaskWidget(parseArguments(process.argv.slice(2))),null,2));}
 catch(error){console.error(JSON.stringify({status:'FAILED',error:error.message,evidence:error.evidence,...(error.receipt?{rollback:error.receipt.status,required_final_candidate_acceptance:error.receipt.required_final_candidate_acceptance}:{})}));process.exitCode=1;}
}
