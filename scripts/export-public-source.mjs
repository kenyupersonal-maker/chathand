/** Build a private, reviewable public-source candidate from a committed tree. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const rootDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const top=new Set(['.gitignore','.gitleaks.toml','README.md','README.en.md','README.zh-CN.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json']);
const dirs=new Set(['app','browser-extension','cloud','connectors','contracts','codex','native','plugins','scripts','skills','ui','vendor','licenses','locales','.github']);
const required=[
 'package.json','package-lock.json','README.md','README.en.md','README.zh-CN.md','LICENSE','THIRD_PARTY_NOTICES.md',
 'app/server.mjs','ui/index.html','native/Package.swift','scripts/build-v09.mjs',
 'locales/zh.json','locales/en.json','engine/src/core.mjs','codex/INSTALL.md','docs/INSTALL.md','docs/INSTALL.en.md',
 'connectors/site-template-pin.json','site-template/local-template-pin.json',
 'site-template/chathand-site-template.zip','site-template/chathand-site-template-1060-local.zip'
];
// These files have current, evidenced privacy or trademark review items. A
// change to this list requires review of the relevant asset, not just its hash.
const reviewRequired=new Map([
 ['app/v1/matter-import.mjs','PERSONAL_IMPORT_REVIEW'],
 ['app/v1/matter-source-1051.json','PERSONAL_IMPORT_REVIEW'],
 ['ui/assets/tutorial/s3a-tunnels.png','TUTORIAL_IMAGE_REVIEW'],
 ['ui/assets/tutorial/s5b-new-plugin.png','TUTORIAL_IMAGE_REVIEW'],
 ['ui/assets/dmg/src/chatgpt-logo.svg','TRADEMARK_ASSET_REVIEW']
]);
// Private Worker test sources and their test consumers require an external fixture.
// Keep them in the development repository; export the pinned template ZIPs unchanged.
const privateWorkerTests=new Set([
 "scripts/run-node-tests.py",
 "scripts/test-runtime-manifest-budget.mjs",
 "test-release/node-runner.test.mjs",
 "test-support/node-runner-checks.py",
 "test-v1/1019-image-batch.test.mjs",
 "test-v1/1052-a2-private-cards.test.mjs",
 "test-v1/1052-a2-regular.test.mjs",
 "test-v1/1052-a4-auto.test.mjs",
 "test-v1/1052-a4-full-paging.test.mjs",
 "test-v1/1052-b-production-transport-affected.test.mjs",
 "test-v1/1052-final-auto-review.test.mjs",
 "test-v1/1052-final-directory-parity.test.mjs",
 "test-v1/1052-final-eb-review.test.mjs",
 "test-v1/1052-final-private-review.test.mjs",
 "test-v1/1052-patch1-production.test.mjs",
 "test-v1/1052-patch2-timeout.test.mjs",
 "test-v1/1052-preinstall-connection-private-names.test.mjs",
 "test-v1/1052-preinstall-full-id-budget.test.mjs",
 "test-v1/1052-preinstall-image-observer.test.mjs",
 "test-v1/1052-preinstall-site-recovery.test.mjs",
 "test-v1/1052-site-template-package.test.mjs",
 "test-v1/1052-v412-fixture.mjs",
 "test-v1/1052-v412-host-lifecycle.test.mjs",
 "test-v1/1052-v412-playwright-cancel.test.mjs",
 "test-v1/1052-v412-production-parameters.test.mjs",
 "test-v1/1052-v412-scoped-ws.test.mjs",
 "test-v1/1052-v412-stage1.test.mjs",
 "test-v1/1052-v412-stage2-cards.test.mjs",
 "test-v1/1052-v412-stage23-fixture.mjs",
 "test-v1/1052-v412-stage23-host.test.mjs",
 "test-v1/1052-v412-stage23-interruption.test.mjs",
 "test-v1/1053-widget-resource-aliases.test.mjs",
 "test-v1/1053-ws-backoff.test.mjs",
 "test-v1/1057-widget-aliases.test.mjs",
 "test-v1/1060-file-presentation.test.mjs",
 "test-v1/1060-local-site-template.test.mjs",
 "test-v1/1060-site-deployment-protocol.test.mjs",
 "test-v1/1060-site-route-refusal.test.mjs",
 "test-v1/1060-skill-site-resume.test.mjs",
 "test-v1/1060-stop-continuity.test.mjs",
 "test-v1/1061-site-template.test.mjs",
 "test-v1/1066-connection-stages.test.mjs",
 "test-v1/1066-runtime-manifest-budget.test.mjs",
 "test-v1/1068-bootstrap-identity-page.test.mjs",
 "test-v1/1068-site-setup-proof.test.mjs",
 "test-v1/1069-binding-client.test.mjs",
 "test-v1/1069-binding-fixture.mjs",
 "test-v1/1069-binding-template.test.mjs",
 "test-v1/1069-binding-upgrade.test.mjs",
 "test-v1/1069-binding-worker.test.mjs",
 "test-v1/1069-network-notice.test.mjs",
 "test-v1/1069-site-standby.test.mjs",
 "test-v1/1070-owner-rebind.test.mjs",
 "test-v1/1070-site-conflict.test.mjs",
 "test-v1/1070-site-health.test.mjs",
 "test-v1/1070-site-template.test.mjs",
 "test-v1/1070-uninstall-fixture.mjs",
 "test-v1/1070-uninstall-revoke.test.mjs",
 "test-v1/1082-chatgpt-app-routes.test.mjs",
 "test-v1/relay-v412/scoped-fixture.mjs",
 "test-v1/setup-completion-stability.test.mjs"
]);
const isIncluded=f=>!privateWorkerTests.has(f)&&(top.has(f)||dirs.has(f.split('/')[0])||
 /^test(?:-|\/)/.test(f)&&!f.startsWith('test-support/node-known-results/')||
 /^docs\/(INSTALL(?:\.en)?\.md|release-notes-[^/]+\.md|images\/)/.test(f)||
 /^engine\/(src\/|test\/|scripts\/|examples\/|public\/|docs\/[^/]+\.json$|package\.json$|LICENSE$)/.test(f)||
 /^site-template\/(?:[^/]+\.(?:zip|json)|source\/(?:bootstrap-identity-page|owner-rebind-page)\.mjs)$/.test(f));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function crc32(bytes){
 let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
 return (c^0xffffffff)>>>0;
}
function fail(code){throw Object.assign(new Error(code),{code});}
function run(command,args,{cwd,input,maxBuffer=200*1024*1024}={}){
 const r=spawnSync(command,args,{cwd,input,maxBuffer,encoding:null});
 if(r.error||r.status!==0)fail(command==='git'?'GIT_COMMAND_FAILED':'TOOL_COMMAND_FAILED');
 return r.stdout;
}
function validName(name){
 return !!name&&!name.startsWith('/')&&!name.includes('\\')&&!/[\0\r\n]/.test(name)&&
  name.split('/').every(part=>part&&part!=='.'&&part!=='..');
}
function tree(root,revision){
 const commit=run('git',['rev-parse','--verify',`${revision}^{commit}`],{cwd:root}).toString().trim();
 if(!/^[a-f0-9]{40,64}$/.test(commit))fail('INVALID_COMMIT');
 const bytes=run('git',['ls-tree','-r','-z','--full-tree',commit],{cwd:root});
 try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('UNSAFE_TREE_PATH');}
 const entries=[];
 for(const record of bytes.toString('utf8').split('\0').filter(Boolean)){
  const tab=record.indexOf('\t');if(tab<0)fail('INVALID_GIT_TREE');
  const [mode,type,oid]=record.slice(0,tab).split(' '),name=record.slice(tab+1);
  if(!validName(name))fail('UNSAFE_TREE_PATH');
  if(!isIncluded(name))continue;
  if(type!=='blob'||!['100644','100755'].includes(mode)||!/^[a-f0-9]{40,64}$/.test(oid))fail('UNSAFE_TREE_ENTRY');
  entries.push({path:name,mode,oid});
 }
 entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
 return {commit,entries};
}
function loadBlobs(root,entries){
 const raw=run('git',['cat-file','--batch'],{cwd:root,input:Buffer.from(entries.map(e=>e.oid+'\n').join(''))});
 let pos=0;
 for(const e of entries){
  const end=raw.indexOf(10,pos);if(end<0)fail('INVALID_GIT_BLOB');
  const match=raw.subarray(pos,end).toString().match(/^([a-f0-9]{40,64}) blob ([0-9]+)$/);
  if(!match||match[1]!==e.oid)fail('INVALID_GIT_BLOB');
  const size=Number(match[2]);if(!Number.isSafeInteger(size)||size>50*1024*1024)fail('SOURCE_FILE_TOO_LARGE');
  pos=end+1;if(pos+size>=raw.length||raw[pos+size]!==10)fail('INVALID_GIT_BLOB');
  e.bytes=raw.subarray(pos,pos+size);e.sha256=sha(e.bytes);pos+=size+1;
 }
 if(pos!==raw.length)fail('INVALID_GIT_BLOB');
}
function textFindings(entry){
 const b=entry.bytes;if(b.includes(0))return [];
 const decoder=new TextDecoder('utf-8',{fatal:true});let text;
 try{text=decoder.decode(b);}catch{return [{path:entry.path,type:'TEXT_ENCODING_REVIEW'}];}
 const out=[],lines=text.split('\n');
 const licenseFile=entry.path==='LICENSE'||entry.path==='THIRD_PARTY_NOTICES.md'||entry.path.startsWith('licenses/')||/(?:^|[\/!])(?:LICENSE|NOTICE)(?:\.|$)/i.test(entry.path);
 for(let i=0;i<lines.length;i++){
  const line=lines[i].replaceAll('\\/','/').replace(/\\u002f|%2f/gi,'/').replace(/\\u0040|%40/gi,'@').replace(/\\u005c|%5c/gi,'\\');
  if(/(?<![A-Za-z0-9_./-])\/(?:Users|home)\/[^/\s"'`<>]+(?:\/|(?=["'`\s]|$))/.test(line)||
     /file:\/\/\/(?:Users|home)\/[^/\s"'`<>]+/.test(line)||
     /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`<>]+\\{1,2}/i.test(line))
   out.push({path:entry.path,line:i+1,type:'HOME_PATH_REVIEW'});
  if(/https?:\/\/[a-z0-9-]+\.chatgpt\.site\b/i.test(line))out.push({path:entry.path,line:i+1,type:'SITE_ORIGIN_REVIEW'});
  if(/\basdk_app_[a-z0-9]{16,}\b/i.test(line))out.push({path:entry.path,line:i+1,type:'APP_ID_REVIEW'});
  if(!licenseFile){
   for(const match of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)){
    const domain=match[1].toLowerCase();
    if(/^(?:background|MenuBarIcon|icon_[0-9]+x[0-9]+)@2x\.png$/.test(match[0]))continue;
    if(domain!=='example.com'&&!domain.endsWith('.example')&&!domain.endsWith('.invalid')&&!domain.endsWith('.test')){
     out.push({path:entry.path,line:i+1,type:'EMAIL_REVIEW'});break;
    }
   }
  }
 }
 return out;
}
// Check central-directory names and modes before any archive scanner opens it.
export function checkZip(bytes){
 let eocd=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){
  if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){eocd=i;break;}
 }
 if(eocd<0)fail('UNSAFE_ZIP');
 const disk=bytes.readUInt16LE(eocd+4),other=bytes.readUInt16LE(eocd+6),localCount=bytes.readUInt16LE(eocd+8),count=bytes.readUInt16LE(eocd+10);
 const cdSize=bytes.readUInt32LE(eocd+12),cdStart=bytes.readUInt32LE(eocd+16);
 if(disk||other||localCount!==count||count===0xffff||cdStart+cdSize!==eocd)fail('UNSAFE_ZIP');
 let pos=cdStart,total=0;const names=new Set(),contents=[];
 for(let n=0;n<count;n++){
  if(pos+46>eocd||bytes.readUInt32LE(pos)!==0x02014b50)fail('UNSAFE_ZIP');
  const nlen=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32);
  const flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10),checksum=bytes.readUInt32LE(pos+16),compressed=bytes.readUInt32LE(pos+20),plain=bytes.readUInt32LE(pos+24),local=bytes.readUInt32LE(pos+42);
  const end=pos+46+nlen+extra+comment;if(!nlen||end>eocd)fail('UNSAFE_ZIP');
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(pos+46,pos+46+nlen));}catch{fail('UNSAFE_ZIP');}
  const check=name.endsWith('/')?name.slice(0,-1):name;
  const mode=(bytes.readUInt32LE(pos+38)>>>16)&0xffff;
  const nameKey=name.normalize('NFC').toLowerCase();
  if(!validName(check)||/^[A-Za-z]:/.test(check)||names.has(nameKey)||(mode&0xf000)===0xa000||(flags&1)||![0,8].includes(method))fail('UNSAFE_ZIP');
  if(local+30>cdStart||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)fail('UNSAFE_ZIP');
  const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),start=local+30+localName+localExtra;
  if(localName!==nlen||start+compressed>cdStart||!bytes.subarray(local+30,local+30+localName).equals(bytes.subarray(pos+46,pos+46+nlen)))fail('UNSAFE_ZIP');
  names.add(nameKey);total+=plain;if(plain>20*1024*1024||total>200*1024*1024)fail('UNSAFE_ZIP');
  let content;try{content=method===0?bytes.subarray(start,start+compressed):inflateRawSync(bytes.subarray(start,start+compressed),{maxOutputLength:Math.max(plain,1)});}catch{fail('UNSAFE_ZIP');}
  if(content.length!==plain||crc32(content)!==checksum)fail('UNSAFE_ZIP');
  if(!name.endsWith('/'))contents.push({path:name,bytes:content});pos=end;
 }
 if(pos!==eocd)fail('UNSAFE_ZIP');
 return contents;
}
function inspect(root,revision){
 const {commit,entries}=tree(root,revision),findings=[];
 const selected=new Set(entries.map(e=>e.path));
 for(const p of required)if(!selected.has(p))findings.push({path:p,type:'REQUIRED_FILE_MISSING'});
 for(const [p,type] of reviewRequired)if(selected.has(p))findings.push({path:p,type});
 loadBlobs(root,entries);
 for(const e of entries){
  if(e.path.endsWith('.zip')){
   try{
    for(const member of checkZip(e.bytes)){
     const archivePath=e.path+'!'+member.path;
     if(/\.(?:zip|tar|tgz|gz|7z)$/i.test(member.path))findings.push({path:archivePath,type:'NESTED_ARCHIVE_REVIEW'});
     else findings.push(...textFindings({path:archivePath,bytes:member.bytes}));
    }
   }catch{findings.push({path:e.path,type:'UNSAFE_ZIP'});}
  }
  else findings.push(...textFindings(e));
 }
 const manifest=entries.map(({path,mode,sha256})=>({path,mode,sha256}));
 return {commit,entries,manifest,manifest_sha256:sha(Buffer.from(JSON.stringify(manifest))),findings};
}
function reviewedPolicy(entries,findings){
 const policyEntry=entries.find(e=>e.path==='scripts/oss-public-reviewed.json');
 if(!policyEntry)return {findings,reviewed:[]};
 let policy;try{policy=JSON.parse(policyEntry.bytes.toString('utf8'));}catch{fail('REVIEW_POLICY_INVALID');}
 if(policy?.version!==1||!Array.isArray(policy.reviewed))fail('REVIEW_POLICY_INVALID');
 const allowed=new Map(),blobs=new Map(entries.map(e=>[e.path,e.sha256]));
 for(const row of policy.reviewed){
  if(!row||typeof row.path!=='string'||!validName(row.path.split('!')[0])||
     !/^[a-f0-9]{64}$/.test(row.content_sha256)||!Array.isArray(row.matches)||typeof row.reason!=='string'||!row.reason.trim())fail('REVIEW_POLICY_INVALID');
  for(const item of row.matches){
   const textFinding=item&&['HOME_PATH_REVIEW','EMAIL_REVIEW','SITE_ORIGIN_REVIEW','APP_ID_REVIEW','SECRET_REVIEW'].includes(item.type)&&Number.isSafeInteger(item.line)&&item.line>=1;
   // Whole-file reviews are limited to the identified tutorial images and the
   // single logo Ken accepted. Exact content hashes remain mandatory.
   const tutorialImage=item&&item.type==='TUTORIAL_IMAGE_REVIEW'&&['ui/assets/tutorial/s3a-tunnels.png','ui/assets/tutorial/s5b-new-plugin.png'].includes(row.path)&&item.line===0&&!item.rule;
   const kenLogo=item&&item.type==='TRADEMARK_ASSET_REVIEW'&&row.path==='ui/assets/dmg/src/chatgpt-logo.svg'&&item.line===0&&!item.rule;
   if((!textFinding&&!tutorialImage&&!kenLogo)||
      (item.type==='SECRET_REVIEW'&&(typeof item.rule!=='string'||!item.rule)))fail('REVIEW_POLICY_INVALID');
   const key=JSON.stringify([row.path,item.type,item.line,item.rule||'']);if(allowed.has(key))fail('REVIEW_POLICY_INVALID');
   allowed.set(key,row.content_sha256);
  }
 }
 const remaining=[],reviewed=[];
 for(const item of findings){
  const key=JSON.stringify([item.path,item.type,item.line||0,item.rule||'']),base=item.path.split('!')[0];
  if(allowed.has(key)&&allowed.get(key)===blobs.get(base))reviewed.push(item);else remaining.push(item);
 }
 return {findings:remaining,reviewed};
}
function safeDestination(root,destination){
 if(!destination)fail('DESTINATION_REQUIRED');
 const resolved=path.resolve(destination),parent=fs.realpathSync(path.dirname(resolved)),source=fs.realpathSync(root);
 const dest=path.join(parent,path.basename(resolved));
 if(dest===source||dest.startsWith(source+path.sep)||fs.existsSync(dest))fail('DESTINATION_NOT_NEW_EXTERNAL');
 return dest;
}
function stageFiles(dir,entries){
 for(const e of entries){
  const target=path.join(dir,e.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  fs.writeFileSync(target,e.bytes,{flag:'wx',mode:e.mode==='100755'?0o755:0o644});
 }
}
function leaks(dir){
 const r=spawnSync('gitleaks',['dir','.','--redact=100','--no-banner','--max-archive-depth','1','--report-format','json','--report-path','-'],{cwd:dir,encoding:'utf8',maxBuffer:20*1024*1024});
 if(r.error||![0,1].includes(r.status))fail('SECRET_SCANNER_UNAVAILABLE');
 let data=[];try{data=r.stdout.trim()?JSON.parse(r.stdout):[];}catch{fail('SECRET_SCANNER_FAILED');}
 if(!Array.isArray(data)||(r.status===1&&!data.length))fail('SECRET_SCANNER_FAILED');
 return data.map(x=>({path:String(x.File||'').replace(/^\.\//,''),line:Number(x.StartLine)||0,type:'SECRET_REVIEW',rule:String(x.RuleID||'unknown')}));
}
export function exportPublicSource({root=rootDefault,revision='HEAD',destination,checkOnly=false}={}){
 const dest=checkOnly?null:safeDestination(root,destination);
 const result=inspect(root,revision);
 const initial=reviewedPolicy(result.entries,result.findings);result.findings=initial.findings;
 const flagged=new Set(result.findings.map(x=>x.path.split('!')[0]));
 const files=result.manifest.map(item=>flagged.has(item.path)?{path:item.path,mode:item.mode,sha256:null}:item);
 const report={status:'BLOCKED',source_commit:result.commit,manifest_sha256:result.findings.length?null:result.manifest_sha256,files,findings:result.findings,reviewed_findings:initial.reviewed,secret_scan:'NOT_RUN',image_review:'REQUIRED'};
 if(result.findings.length)return report;
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-public-export-'));fs.chmodSync(temp,0o700);
 try{
  stageFiles(temp,result.entries);const secretResult=reviewedPolicy(result.entries,leaks(temp));
  report.findings=secretResult.findings;report.reviewed_findings.push(...secretResult.reviewed);report.secret_scan='COMPLETE';
  if(report.findings.length){
   const flaggedFiles=new Set(report.findings.map(x=>x.path.split('!')[0]));
   report.files=report.files.map(item=>flaggedFiles.has(item.path)?{...item,sha256:null}:item);
   report.manifest_sha256=null;return report;
  }
  if(checkOnly){report.status='SCAN_PASSED_REVIEW_STILL_REQUIRED';return report;}
  fs.mkdirSync(dest,{mode:0o700});
  try{stageFiles(dest,result.entries);}catch(error){fs.rmSync(dest,{recursive:true,force:true});throw error;}
  report.status='CANDIDATE_CREATED_REVIEW_STILL_REQUIRED';report.destination=dest;return report;
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
function main(){
 const args=process.argv.slice(2);let checkOnly=false,destination,revision='HEAD';
 for(let i=0;i<args.length;i++){
  if(args[i]==='--check')checkOnly=true;
  else if(args[i]==='--revision'&&args[i+1])revision=args[++i];
  else if(!args[i].startsWith('-')&&!destination)destination=args[i];
  else fail('INVALID_ARGUMENTS');
 }
 if(checkOnly&&destination)fail('INVALID_ARGUMENTS');
 const report=exportPublicSource({revision,destination,checkOnly});
 console.log(JSON.stringify(report));if(report.status==='BLOCKED')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{main();}catch(error){console.error(JSON.stringify({status:'ERROR',code:error.code||'EXPORT_FAILED'}));process.exitCode=1;}
}
