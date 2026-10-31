import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyBundleTree,swiftPrivacyFlags,clangPrivacyFlags,swiftPackagePrivacyFlags} from '../scripts/build-privacy.mjs';
import {PROCESS_LAYOUT,stageProcessCompatibility} from '../scripts/process-identity.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-build-privacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function write(file,value='fixture'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}

test('shipping copy excludes every rehearsal entry and retains runtime scripts and symlinks',t=>{
 const source=path.join(temporary(t),'source'),output=path.join(path.dirname(source),'output');
 for(const file of ['scripts/rehearse-1060-isolated.mjs','scripts/rehearse-1060-isolated.test.mjs','scripts/rehearse-future/probe.mjs','scripts/upgrade.mjs','scripts/build-privacy.mjs','scripts/.DS_Store','app/entry.mjs'])write(path.join(source,file));
 fs.symlinkSync('upgrade.mjs',path.join(source,'scripts/upgrade-alias.mjs'));
 copyBundleTree(source,output,source);
 assert.deepEqual(fs.readdirSync(path.join(output,'scripts')).sort(),['build-privacy.mjs','upgrade-alias.mjs','upgrade.mjs']);
 assert.equal(fs.readlinkSync(path.join(output,'scripts/upgrade-alias.mjs')),'upgrade.mjs');
 assert.equal(fs.readFileSync(path.join(output,'app/entry.mjs'),'utf8'),'fixture');
});

test('SwiftPM passes path remapping to Swift and C dependencies for both logical and real checkout paths',t=>{
 const dir=temporary(t),source=path.join(dir,'source'),alias=path.join(dir,'linked-source');fs.mkdirSync(source);fs.symlinkSync(source,alias);
 const swift=swiftPrivacyFlags(alias),clang=clangPrivacyFlags(alias),spm=swiftPackagePrivacyFlags(alias);
 assert.ok(swift.includes('-gnone'));assert.equal(swift[swift.indexOf('-file-compilation-dir')+1],'/chathand/source');
 for(const sourceRoot of new Set([path.resolve(alias),fs.realpathSync(alias)])){
  const mapped=sourceRoot+'=/chathand/source';
  for(const flag of ['-debug-prefix-map','-file-prefix-map'])assert.ok(swift.some((v,i)=>v===flag&&swift[i+1]===mapped));
  for(const flag of ['-fdebug-prefix-map','-ffile-prefix-map'])assert.ok(clang.includes(flag+'='+mapped));
 }
 assert.deepEqual(spm,[...swift.flatMap(flag=>['-Xswiftc',flag]),...clang.flatMap(flag=>['-Xcc',flag])]);
});

test('every C compatibility entry compiles with mapped source paths and preserves executable names',t=>{
 const app=path.join(temporary(t),'ChatHand.app'),calls=[];
 for(const row of PROCESS_LAYOUT)write(path.join(app,row.legacy),'original executable');
 const layout=stageProcessCompatibility(app,{root,run:(program,args)=>{
  calls.push({program,args});write(args[args.indexOf('-o')+1],'compatibility executable');
 }});
 assert.deepEqual(layout,PROCESS_LAYOUT);assert.equal(calls.length,PROCESS_LAYOUT.length);
 for(const [index,call] of calls.entries()){
  assert.equal(call.program,'/usr/bin/xcrun');assert.deepEqual(call.args.slice(0,1+clangPrivacyFlags(root).length),['clang',...clangPrivacyFlags(root)]);
  assert.equal(call.args.at(-1),path.join(app,PROCESS_LAYOUT[index].legacy));
  assert.equal(fs.readFileSync(path.join(app,PROCESS_LAYOUT[index].current),'utf8'),'original executable');
 }
});

test('current release App routes every shipping native compile through privacy flags',()=>{
 const app=fs.readFileSync(new URL('../scripts/build-v09.mjs',import.meta.url),'utf8');
 assert.match(app,/function copy\(a,b\)\{copyBundleTree\(a,b,root\);\}/);
 assert.equal((app.match(/run\('\/usr\/bin\/xcrun',\['swiftc',/g)||[]).length,4);
 assert.equal((app.match(/run\('\/usr\/bin\/xcrun',\['swiftc',\.\.\.swiftPrivacyFlags\(root\),/g)||[]).length,4);
 assert.match(app,/'--product','ChatHandShell',\.\.\.swiftPackagePrivacyFlags\(root\)/);
});
