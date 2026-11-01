import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {checkZip,exportPublicSource} from '../../scripts/export-public-source.mjs';

function crc32(bytes){
 let c=0xffffffff;for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
 return (c^0xffffffff)>>>0;
}
function zipStored(name='hello.txt',content='hello\n'){
 const n=Buffer.from(name),b=Buffer.from(content),crc=crc32(b);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
 local.writeUInt32LE(crc,14);local.writeUInt32LE(b.length,18);local.writeUInt32LE(b.length,22);local.writeUInt16LE(n.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);
 central.writeUInt32LE(crc,16);central.writeUInt32LE(b.length,20);central.writeUInt32LE(b.length,24);central.writeUInt16LE(n.length,28);
 central.writeUInt32LE((0o100644<<16)>>>0,38);
 const start=local.length+n.length+b.length,size=central.length+n.length,end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(size,12);end.writeUInt32LE(start,16);
 return Buffer.concat([local,n,b,central,n,end]);
}
function put(root,name,data='fixture\n'){
 const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,data);
}
function git(root,...args){return execFileSync('git',args,{cwd:root,stdio:'pipe'});}
function commit(root){
 git(root,'add','-A');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
  '-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture');
}
function fixture(t){
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-oss-export-test-')),root=path.join(parent,'repo');
 fs.mkdirSync(root);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));git(root,'init','-q');
 for(const p of ['package.json','package-lock.json','README.md','README.en.md','README.zh-CN.md','LICENSE','THIRD_PARTY_NOTICES.md',
  'app/server.mjs','ui/index.html','native/Package.swift','scripts/build-v09.mjs',
  'locales/zh.json','locales/en.json','engine/src/core.mjs','codex/INSTALL.md','docs/INSTALL.md','docs/INSTALL.en.md',
  'connectors/site-template-pin.json','site-template/local-template-pin.json'])put(root,p);
 for(const p of ['site-template/chathand-site-template.zip','site-template/chathand-site-template-1060-local.zip'])put(root,p,zipStored());
 put(root,'app/committed.mjs','export const value = 1;\n');
 put(root,'docs/cards/private.md','internal fixture\n');put(root,'tools/skin-studio/private.txt','internal fixture\n');
 commit(root);return {parent,root};
}
test('exports only committed allowed files and produces identical manifests',t=>{
 const {parent,root}=fixture(t);
 put(root,'app/committed.mjs','export const value = 2;\n');put(root,'app/untracked.mjs','untracked\n');
 const first=exportPublicSource({root,destination:path.join(parent,'first')});
 const second=exportPublicSource({root,destination:path.join(parent,'second')});
 assert.equal(first.status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');assert.equal(first.secret_scan,'COMPLETE');
 assert.equal(first.source_commit,second.source_commit);assert.equal(first.manifest_sha256,second.manifest_sha256);
 assert.deepEqual(first.files,second.files);
 assert.equal(fs.readFileSync(path.join(first.destination,'app/committed.mjs'),'utf8'),'export const value = 1;\n');
 for(const p of ['app/untracked.mjs','docs/cards/private.md','tools/skin-studio/private.txt','.git'])assert.equal(fs.existsSync(path.join(first.destination,p)),false,p);
 assert.ok(fs.existsSync(path.join(first.destination,'locales/zh.json')));assert.ok(fs.existsSync(path.join(first.destination,'site-template/chathand-site-template.zip')));
});
test('blocks a known private runtime input before creating any destination',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'candidate');
 put(root,'app/v1/matter-source-1051.json','{}\n');commit(root);
 const result=exportPublicSource({root,destination:dest});
 assert.equal(result.status,'BLOCKED');assert.equal(result.secret_scan,'NOT_RUN');
 assert.ok(result.findings.some(x=>x.type==='PERSONAL_IMPORT_REVIEW'&&x.path==='app/v1/matter-source-1051.json'));
 assert.equal(fs.existsSync(dest),false);
});
test('private legacy matter archive never enters public or trial exports',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'candidate');
 put(root,'private/legacy-matters-1051/matter-import.mjs','private fixture\n');
 put(root,'private/legacy-matters-1051/matter-source-1051.json','private fixture\n');
 put(root,'private/legacy-matters-1051/import-check.mjs.archive','private fixture\n');
 put(root,'private/unrelated-record.txt','private fixture\n');
 put(root,'scripts/export-trial-source.mjs',fs.readFileSync(new URL('../../scripts/export-trial-source.mjs',import.meta.url)));commit(root);
 const result=exportPublicSource({root,destination:dest});
 assert.equal(result.status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');
 assert.equal(fs.existsSync(path.join(dest,'private')),false);
 assert.equal(result.files.some(x=>x.path.startsWith('private/')),false);
 const trial=path.join(parent,'trial');
 execFileSync(process.execPath,[path.join(root,'scripts/export-trial-source.mjs'),trial],{cwd:root,stdio:'pipe'});
 assert.equal(fs.existsSync(path.join(trial,'private')),false);
});
test('reports potentially personal paths without returning their values',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'candidate');
 const privatePath=['','Users','privateperson','Documents','private.txt'].join('/');
 put(root,'app/location.mjs',`export const value = '${privatePath}';\n`);commit(root);
 const result=exportPublicSource({root,destination:dest});
 assert.equal(result.status,'BLOCKED');assert.ok(result.findings.some(x=>x.type==='HOME_PATH_REVIEW'&&x.path==='app/location.mjs'));
 assert.equal(JSON.stringify(result).includes(privatePath),false);assert.equal(fs.existsSync(dest),false);
});
test('detects encoded home paths and paths within a tracked archive',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'candidate');
 const prefix=['%2F','Users','%2F','privateperson','%2F'].join('');
 put(root,'app/encoded.mjs',`export const value = '${prefix}Documents';\n`);
 const privatePath=['','Users','privateperson','Documents','file'].join('/');
 put(root,'site-template/chathand-site-template.zip',zipStored('example.txt',privatePath));commit(root);
 const result=exportPublicSource({root,destination:dest});
 assert.equal(result.status,'BLOCKED');
 assert.ok(result.findings.some(x=>x.type==='HOME_PATH_REVIEW'&&x.path==='app/encoded.mjs'));
 assert.ok(result.findings.some(x=>x.type==='HOME_PATH_REVIEW'&&x.path==='site-template/chathand-site-template.zip!example.txt'));
 assert.equal(JSON.stringify(result).includes(privatePath),false);assert.equal(fs.existsSync(dest),false);
});
test('reports custom Site and application identifiers without returning their values',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'candidate');
 const site=['https://','private-example','.chatgpt','.site'].join('');
 const app=['asdk_','app_','ab'.repeat(16)].join('');
 put(root,'app/identity.mjs',`const site = '${site}';\nconst app = '${app}';\n`);commit(root);
 const result=exportPublicSource({root,destination:dest});
 assert.equal(result.status,'BLOCKED');assert.ok(result.findings.some(x=>x.type==='SITE_ORIGIN_REVIEW'));
 assert.ok(result.findings.some(x=>x.type==='APP_ID_REVIEW'));
 assert.equal(JSON.stringify(result).includes(site),false);assert.equal(JSON.stringify(result).includes(app),false);
 assert.equal(fs.existsSync(dest),false);
});
test('reviewed exceptions apply only to the exact file, line and finding type',t=>{
 const {parent,root}=fixture(t),file='app/example.mjs',dest=path.join(parent,'candidate');
 const value=['','Users','fixtureperson','Documents','test'].join('/');
 const contents=`export const value = '${value}';\n`;put(root,file,contents);
 const policy={version:1,reviewed:[{path:file,content_sha256:crypto.createHash('sha256').update(contents).digest('hex'),
  matches:[{type:'HOME_PATH_REVIEW',line:1}],reason:'Synthetic fixture reviewed.'}]};
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 const reviewed=exportPublicSource({root,destination:dest});
 assert.equal(reviewed.status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');assert.equal(reviewed.reviewed_findings.length,1);
 put(root,file,contents+'// content changed\n');commit(root);
 const stale=exportPublicSource({root,destination:path.join(parent,'stale')});
 assert.equal(stale.status,'BLOCKED');assert.ok(stale.findings.some(x=>x.type==='HOME_PATH_REVIEW'));
});
test('a review exception cannot suppress a known personal-input blocker',t=>{
 const {parent,root}=fixture(t),file='app/v1/matter-source-1051.json',contents='{}\n';put(root,file,contents);
 const policy={version:1,reviewed:[{path:file,content_sha256:crypto.createHash('sha256').update(contents).digest('hex'),
  matches:[{type:'PERSONAL_IMPORT_REVIEW',line:1}],reason:'Attempted bypass.'}]};
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 assert.throws(()=>exportPublicSource({root,destination:path.join(parent,'candidate')}),{code:'REVIEW_POLICY_INVALID'});
});
test('tutorial image review applies only to the exact reviewed bytes',t=>{
 const {parent,root}=fixture(t),file='ui/assets/tutorial/s5b-new-plugin.png',contents=Buffer.from('synthetic image fixture');
 put(root,file,contents);commit(root);
 const initial=exportPublicSource({root,checkOnly:true});
 assert.equal(initial.status,'BLOCKED');assert.ok(initial.findings.some(x=>x.type==='TUTORIAL_IMAGE_REVIEW'));
 const policy={version:1,reviewed:[{path:file,content_sha256:crypto.createHash('sha256').update(contents).digest('hex'),
  matches:[{type:'TUTORIAL_IMAGE_REVIEW',line:0}],reason:'Synthetic fixture reviewed.'}]};
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 const reviewed=exportPublicSource({root,destination:path.join(parent,'reviewed')});
 assert.equal(reviewed.status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');
 assert.ok(reviewed.reviewed_findings.some(x=>x.type==='TUTORIAL_IMAGE_REVIEW'));
 put(root,file,Buffer.from('changed image fixture'));commit(root);
 const changed=exportPublicSource({root,destination:path.join(parent,'changed')});
 assert.equal(changed.status,'BLOCKED');assert.ok(changed.findings.some(x=>x.type==='TUTORIAL_IMAGE_REVIEW'));
});
test('tunnel tutorial image requires a content-bound review',t=>{
 const {parent,root}=fixture(t),file='ui/assets/tutorial/s3a-tunnels.png',contents=Buffer.from('synthetic tunnel illustration');
 put(root,file,contents);commit(root);
 const blocked=exportPublicSource({root,checkOnly:true});
 assert.equal(blocked.status,'BLOCKED');assert.ok(blocked.findings.some(x=>x.type==='TUTORIAL_IMAGE_REVIEW'&&x.path===file));
 const policy={version:1,reviewed:[{path:file,content_sha256:crypto.createHash('sha256').update(contents).digest('hex'),
  matches:[{type:'TUTORIAL_IMAGE_REVIEW',line:0}],reason:'Synthetic illustration reviewed.'}]};
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 assert.equal(exportPublicSource({root,destination:path.join(parent,'reviewed')}).status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');
 put(root,file,Buffer.from('changed image'));commit(root);
 assert.equal(exportPublicSource({root,destination:path.join(parent,'changed')}).status,'BLOCKED');
});
test('secret scanner blocks synthetic credential without returning its value',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'candidate');
 const synthetic=['gh','p_',crypto.randomBytes(24).toString('hex').slice(0,36)].join('');put(root,'app/fixture.mjs',`const value = '${synthetic}';\n`);commit(root);
 const result=exportPublicSource({root,destination:dest});
 assert.equal(result.status,'BLOCKED');assert.equal(result.secret_scan,'COMPLETE');
 assert.ok(result.findings.some(x=>x.type==='SECRET_REVIEW'));assert.equal(JSON.stringify(result).includes(synthetic),false);assert.equal(fs.existsSync(dest),false);
});
test('a reviewed secret finding is bound to the exact content, line and rule',t=>{
 const {parent,root}=fixture(t),file='app/fixture.mjs';
 const synthetic=['gh','p_',crypto.randomBytes(24).toString('hex').slice(0,36)].join('');
 const contents=`const value = '${synthetic}';\n`;put(root,file,contents);commit(root);
 const initial=exportPublicSource({root,checkOnly:true}),finding=initial.findings.find(x=>x.type==='SECRET_REVIEW');
 assert.ok(finding);assert.equal(finding.path,file);
 const policy={version:1,reviewed:[{path:file,content_sha256:crypto.createHash('sha256').update(contents).digest('hex'),
  matches:[{type:finding.type,line:finding.line,rule:finding.rule}],reason:'Synthetic test credential reviewed.'}]};
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 const reviewed=exportPublicSource({root,destination:path.join(parent,'reviewed')});
 assert.equal(reviewed.status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');assert.equal(reviewed.reviewed_findings.length,1);
 put(root,file,contents+'// changed\n');commit(root);
 const stale=exportPublicSource({root,destination:path.join(parent,'stale')});
 assert.equal(stale.status,'BLOCKED');assert.ok(stale.findings.some(x=>x.type==='SECRET_REVIEW'));
 assert.equal(JSON.stringify(stale).includes(synthetic),false);
});
test('never overwrites an existing destination or exports inside the repo',t=>{
 const {parent,root}=fixture(t),dest=path.join(parent,'existing');fs.mkdirSync(dest);put(dest,'keep.txt','keep\n');
 assert.throws(()=>exportPublicSource({root,destination:dest}),{code:'DESTINATION_NOT_NEW_EXTERNAL'});
 assert.equal(fs.readFileSync(path.join(dest,'keep.txt'),'utf8'),'keep\n');
 assert.throws(()=>exportPublicSource({root,destination:path.join(root,'inside')}),{code:'DESTINATION_NOT_NEW_EXTERNAL'});
});
test('legacy private trial excludes untracked files and retained internal result data',t=>{
 const {parent,root}=fixture(t),script=path.join(root,'scripts/export-trial-source.mjs');
 put(root,'scripts/export-trial-source.mjs',fs.readFileSync(new URL('../../scripts/export-trial-source.mjs',import.meta.url)));
 put(root,'tests/support/node-known-results/private.json','{}\n');commit(root);
 put(root,'app/untracked.mjs','untracked\n');
 const dest=path.join(parent,'trial');
 const output=execFileSync(process.execPath,[script,dest],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 assert.equal(JSON.parse(output).status,'EXPORTED_WITHOUT_HISTORY');
 assert.equal(fs.existsSync(path.join(dest,'app/untracked.mjs')),false);
 assert.equal(fs.existsSync(path.join(dest,'tests/support/node-known-results/private.json')),false);
 assert.equal(fs.statSync(dest).mode&0o077,0);
});
test('refuses tracked symlinks and archives with traversal or symlinks',t=>{
 const {parent,root}=fixture(t);fs.symlinkSync('/outside',path.join(root,'app/link'));commit(root);
 assert.throws(()=>exportPublicSource({root,destination:path.join(parent,'candidate')}),{code:'UNSAFE_TREE_ENTRY'});
 assert.throws(()=>checkZip(zipStored('../escape.txt')),{code:'UNSAFE_ZIP'});
 const zip=zipStored('link');const central=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));zip.writeUInt32LE((0o120777<<16)>>>0,central+38);
 assert.throws(()=>checkZip(zip),{code:'UNSAFE_ZIP'});
 const mismatched=zipStored('safe.txt');mismatched[30]=0x78;
 assert.throws(()=>checkZip(mismatched),{code:'UNSAFE_ZIP'});
});

test('Ken logo decision permits only the exact logo bytes and cannot allow another trademark asset',t=>{
 const {parent,root}=fixture(t),file='ui/assets/dmg/src/chatgpt-logo.svg',contents=Buffer.from('synthetic logo fixture');
 put(root,file,contents);commit(root);
 const blocked=exportPublicSource({root,checkOnly:true});
 assert.equal(blocked.status,'BLOCKED');assert.ok(blocked.findings.some(x=>x.type==='TRADEMARK_ASSET_REVIEW'&&x.path===file));
 const policy={version:1,reviewed:[{path:file,content_sha256:crypto.createHash('sha256').update(contents).digest('hex'),
  matches:[{type:'TRADEMARK_ASSET_REVIEW',line:0}],reason:'Synthetic content-bound Ken decision.'}]};
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 const allowed=exportPublicSource({root,destination:path.join(parent,'allowed')});
 assert.equal(allowed.status,'CANDIDATE_CREATED_REVIEW_STILL_REQUIRED');
 assert.ok(allowed.reviewed_findings.some(x=>x.type==='TRADEMARK_ASSET_REVIEW'&&x.path===file));
 put(root,file,Buffer.from('changed logo fixture'));commit(root);
 const changed=exportPublicSource({root,destination:path.join(parent,'changed')});
 assert.equal(changed.status,'BLOCKED');assert.ok(changed.findings.some(x=>x.type==='TRADEMARK_ASSET_REVIEW'));
 policy.reviewed[0].path='ui/assets/dmg/src/another-logo.svg';
 put(root,'scripts/oss-public-reviewed.json',JSON.stringify(policy));commit(root);
 assert.throws(()=>exportPublicSource({root,checkOnly:true}),{code:'REVIEW_POLICY_INVALID'});
});
