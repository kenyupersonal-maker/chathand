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
test('ordinary version/schema values are ignored, explicit newer formats stay read-only, and malformed content remains strict for strict callers',t=>{
 const root=fixture(t);
 for(const value of [{version:999},{schema:2},{version:1,schema:999},{version:0},{version:'999'},{version:1.5},{schema:null},{format:'other-v99'}]){const dir=path.join(root,crypto.randomUUID());write(dir,value);const before=snapshot(dir);assert.equal(assertDesktopDataCompatibility(dir).compatible,true);assert.deepEqual(snapshot(dir),before);}
 for(const value of [{format:'chathand-desktop-v2'},{format:'chathand-desktop-v9999999999999999999999',min_app_version:'9.9.9'}]){const dir=path.join(root,crypto.randomUUID());write(dir,value);const before=snapshot(dir);assert.equal(assertDesktopDataCompatibility(dir).kind,'newer');assert.deepEqual(snapshot(dir),before);}
 for(const value of [[],null]){const dir=path.join(root,crypto.randomUUID());write(dir,value);const before=snapshot(dir);assert.throws(()=>assertDesktopDataCompatibility(dir),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(dir),before);}
 const dir=path.join(root,'broken');write(dir,{});fs.writeFileSync(path.join(dir,'desktop.json'),'{');const before=snapshot(dir);assert.throws(()=>assertDesktopDataCompatibility(dir),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(dir),before);
});
test('unsafe linked data/header fails without following or modifying foreign files',t=>{
 const root=fixture(t),foreign=path.join(root,'foreign'),data=path.join(root,'data');write(foreign,{version:999});fs.symlinkSync(foreign,data);const before=snapshot(root);assert.throws(()=>assertDesktopDataCompatibility(data),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(root),before);
 fs.unlinkSync(data);fs.mkdirSync(data);fs.symlinkSync(path.join(foreign,'desktop.json'),path.join(data,'desktop.json'));const again=snapshot(root);assert.throws(()=>assertDesktopDataCompatibility(data),{code:'DATA_FORMAT_UNSUPPORTED'});assert.deepEqual(snapshot(root),again);
});
test('CLI permits ordinary headers, newer formats and corrupt settings without writing; unsafe paths still fail',t=>{
 for(const key of [null,'CHATHAND_STATE_DIR','KEN_BRIDGE_STATE_DIR'])for(const value of [{version:999},{format:'chathand-desktop-v2',version:2},null]){
  const home=fixture(t),dir=key?path.join(home,'explicit'):path.join(home,'Library/Application Support/ChatHand/data');write(dir,value);const before=snapshot(home),result=run(home,key?{[key]:dir}:undefined);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{compatible:true});assert.deepEqual(snapshot(home),before);
  if(value===null){const original=fs.statSync(path.join(dir,'desktop.json')),work=path.join(home,'not-created');const state=new DesktopState(dir,{defaultRoot:work,deferWorkspace:true,recoverCorrupt:true}),backups=fs.readdirSync(dir).filter(name=>name.startsWith('desktop.unreadable-'));assert.equal(backups.length,1);const backup=path.join(dir,backups[0]);assert.equal(fs.readFileSync(backup,'utf8'),'null');assert.equal(fs.statSync(backup).ino,original.ino);assert.equal(fs.statSync(backup).mode,original.mode);assert.equal(state.data.settings_recovery_notice,true);for(const flag of ['access_enabled','auto_connect','auto_update','terminal_enabled','browser_enabled','desktop_enabled'])assert.equal(state.data[flag],false);assert.equal(fs.existsSync(work),false);}
 }
 const home=fixture(t),foreign=path.join(home,'foreign'),linked=path.join(home,'linked');write(foreign,{version:1});fs.mkdirSync(linked);fs.symlinkSync(path.join(foreign,'desktop.json'),path.join(linked,'desktop.json'));const before=snapshot(home),result=run(home,{CHATHAND_STATE_DIR:linked});assert.equal(result.status,74);assert.equal(result.stderr,'DATA_FORMAT_UNSUPPORTED\n');assert.equal(result.stdout,'');assert.deepEqual(snapshot(home),before);
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
