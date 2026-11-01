import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
import {assertDesktopDataCompatibility} from '../../app/v1/data-compatibility.mjs';import {DesktopState} from '../../app/state.mjs';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-data-compat-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function snapshot(root){const rows=[];const walk=p=>{for(const name of fs.readdirSync(p).sort()){const f=path.join(p,name),s=fs.lstatSync(f);rows.push({name:path.relative(root,f),mode:s.mode,size:s.size,mtime:s.mtimeMs,sha:s.isFile()?sha(fs.readFileSync(f)):null,link:s.isSymbolicLink()?fs.readlinkSync(f):null});if(s.isDirectory())walk(f);}};walk(root);return rows;}
function write(dir,value){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'desktop.json'),JSON.stringify(value),{mode:0o600});}
function run(home,override){const env={...process.env,HOME:home};delete env.CHATHAND_STATE_DIR;delete env.KEN_BRIDGE_STATE_DIR;if(override)Object.assign(env,override);return spawnSync(process.execPath,['scripts/migrate-state.mjs'],{encoding:'utf8',env,timeout:5000});}
test('format preflight is read-only and accepts absent, v1 and versionless legacy without changing additive fields',t=>{
 const root=fixture(t);assert.equal(assertDesktopDataCompatibility(path.join(root,'absent')).compatible,true);assert.equal(fs.readdirSync(root).length,0);
 for(const value of [{version:1,schema:1,unknown:{keep:true}},{unknown:{keep:true}},{version:1}]){const dir=path.join(root,crypto.randomUUID());write(dir,value);const before=snapshot(dir);assert.equal(assertDesktopDataCompatibility(dir).compatible,true);assert.deepEqual(snapshot(dir),before);}
});
test('future or malformed declared formats are rejected with fixed codes and no data or lock writes',t=>{
 const root=fixture(t);for(const value of [{version:999},{schema:2},{version:1,schema:999},{version:0},{version:'999'},{version:1.5},{schema:null},[],null]){const dir=path.join(root,crypto.randomUUID());write(dir,value);const before=snapshot(dir);assert.throws(()=>assertDesktopDataCompatibility(dir),e=>e.code===(value?.version===999||value?.schema>1?'DATA_FORMAT_NEWER':'DATA_FORMAT_UNSUPPORTED'));assert.deepEqual(snapshot(dir),before);}
 const dir=path.join(root,'broken');write(dir,{});fs.writeFileSync(path.join(dir,'desktop.json'),'{');const before=snapshot(dir);assert.throws(()=>assertDesktopDataCompatibility(dir),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(dir),before);
});
test('unsafe linked data/header fails without following or modifying foreign files',t=>{
 const root=fixture(t),foreign=path.join(root,'foreign'),data=path.join(root,'data');write(foreign,{version:999});fs.symlinkSync(foreign,data);const before=snapshot(root);assert.throws(()=>assertDesktopDataCompatibility(data),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(root),before);
 fs.unlinkSync(data);fs.mkdirSync(data);fs.symlinkSync(path.join(foreign,'desktop.json'),path.join(data,'desktop.json'));const again=snapshot(root);assert.throws(()=>assertDesktopDataCompatibility(data),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(root),again);
});
test('CLI returns fixed 73/74 format codes for default data and both explicit state overrides without writes',t=>{
 for(const relative of ['data']){
  const home=fixture(t),dir=path.join(home,'Library/Application Support/ChatHand',relative);write(dir,{version:999});const before=snapshot(home),result=run(home);assert.equal(result.status,73,result.stderr);assert.equal(result.stderr,'DATA_FORMAT_NEWER\n');assert.equal(result.stdout,'');assert.deepEqual(snapshot(home),before);
 }
 for(const key of ['CHATHAND_STATE_DIR','KEN_BRIDGE_STATE_DIR']){const home=fixture(t),dir=path.join(home,'explicit');write(dir,{version:999});const before=snapshot(home),result=run(home,{[key]:dir});assert.equal(result.status,73,result.stderr);assert.equal(result.stderr,'DATA_FORMAT_NEWER\n');assert.equal(result.stdout,'');assert.deepEqual(snapshot(home),before);}
 const home=fixture(t),support=path.join(home,'Library/Application Support/ChatHand');
 const dir=path.join(support,'unsupported');write(dir,{version:'future'});const before=snapshot(dir),result=run(home,{CHATHAND_STATE_DIR:dir});assert.equal(result.status,74);assert.equal(result.stderr,'DATA_FORMAT_UNSUPPORTED\n');assert.equal(result.stdout,'');assert.deepEqual(snapshot(dir),before);
});
test('absent default and explicit paths return quickly without creating data',t=>{
 const home=fixture(t),absent=path.join(home,'absent');const result=run(home,{CHATHAND_STATE_DIR:absent});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).compatible,true);assert.equal(fs.existsSync(absent),false);const normal=run(home);assert.equal(normal.status,0,normal.stderr);assert.equal(JSON.parse(normal.stdout).compatible,true);assert.equal(fs.readdirSync(home).length,0);
});
test('format preflight adds no 32MiB limit to an existing valid v1 desktop',t=>{
 const root=fixture(t),dir=path.join(root,'large');write(dir,{version:1,additive_fixture:'x'.repeat(33*1024*1024)});const before=snapshot(dir);assert.ok(before[0].size>32*1024*1024);assert.equal(assertDesktopDataCompatibility(dir).compatible,true);assert.deepEqual(snapshot(dir),before);
});
test('known v1 desktop state remains usable after compatibility checks',t=>{
 const home=fixture(t),state=path.join(home,'state'),work=path.join(home,'work');fs.mkdirSync(work);const first=new DesktopState(state,{defaultRoot:work});first.data.extra={kept:true};first.save();const before=snapshot(state);assertDesktopDataCompatibility(state);assert.deepEqual(snapshot(state),before);const next=new DesktopState(state,{defaultRoot:work});next.data.notifications=false;next.save();assert.equal(new DesktopState(state,{defaultRoot:work}).data.extra.kept,true);
});
