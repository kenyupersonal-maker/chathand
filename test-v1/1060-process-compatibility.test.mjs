import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {PROCESS_LAYOUT,appProcessExecutable,stageProcessCompatibility,validateProcessIdentityBaseline,captureProcessIdentityBaseline} from '../scripts/process-identity.mjs';
import {signApplication,SIGNING_IDENTITY} from '../scripts/signing.mjs';
import {watchNativeOwnerPipe} from '../app/v1/process-owner-lifetime.mjs';
import {readNativeBootstrap} from '../app/v1/native-bootstrap-keys.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
function temp(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1060-process-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function baseline(){return {format:1,source:{build:1059,dmg_sha256:'a'.repeat(64),updater_sha256:'b'.repeat(64)},components:Object.fromEntries(PROCESS_LAYOUT.map(r=>[r.key,{identifier:r.key==='app'?'com.kenyu.chathand':'fixture.'+r.key,requirement:`identifier "${r.key==='app'?'com.kenyu.chathand':'fixture.'+r.key}" and certificate leaf = H"${SIGNING_IDENTITY}"`,entitlements:null}]))};}

test('new updater chooses new executable and falls back to exact 1059 paths',t=>{
 const app=path.join(temp(t),'ChatHand.app');
 for(const row of PROCESS_LAYOUT){assert.equal(appProcessExecutable(app,row.key),path.join(app,row.legacy));fs.mkdirSync(path.dirname(path.join(app,row.current)),{recursive:true});fs.writeFileSync(path.join(app,row.current),'fixture');assert.equal(appProcessExecutable(app,row.key),path.join(app,row.current));}
 assert.throws(()=>appProcessExecutable(app,'../foreign'),/UNKNOWN/);
});

test('rename signing requires baseline and preserves public identifier/DR/entitlements before seal',t=>{
 const app=path.join(temp(t),'ChatHand.app'),row=PROCESS_LAYOUT[0],executable=path.join(app,row.current);
 fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,Buffer.from('cffaedfe00000000','hex'));
 let calls=[];assert.throws(()=>signApplication(app,()=>{throw Error('must not execute');}),/BASELINE_SOURCE_REQUIRED/);
 const b=baseline();b.components.app.entitlements='<?xml version="1.0"?><plist version="1.0"><dict/></plist>';
 const run=(program,args)=>{calls.push({program,args});assert.ok(!program.endsWith('/security'));if(program.endsWith('/PlistBuddy'))return 'com.kenyu.chathand';if(args[0]==='-dr')return 'designated => '+b.components.app.requirement;if(args[0]==='-d')return args.includes('--entitlements')?b.components.app.entitlements:'Identifier=com.kenyu.chathand\n';if(args.includes('--entitlements'))assert.equal(fs.readFileSync(args[args.indexOf('--entitlements')+1],'utf8'),b.components.app.entitlements);return '';};
 signApplication(app,run,{processIdentityBaseline:b});
 const signs=calls.filter(c=>c.args.includes('--force'));assert.equal(signs.length,2);
 for(const {args} of signs){assert.equal(args[args.indexOf('--identifier')+1],'com.kenyu.chathand');assert.equal(args[args.indexOf('--requirements')+1],'=designated => '+b.components.app.requirement);}
 assert.ok(calls.some(c=>c.args.includes('-R')&&c.args.at(-1)===executable));
 b.components.app.requirement+=' and cdhash H"1234"';assert.throws(()=>validateProcessIdentityBaseline(b),/BASELINE_INVALID_app/);
});

test('private stdin lifetime retains bootstrap auth and closes once on EOF, including early EOF',async()=>{
 const input=new PassThrough(),watch=watchNativeOwnerPipe(input,'stdin-v1');
 const bootstrap=readNativeBootstrap(input);input.write(JSON.stringify({v:2,ui_key:'a'.repeat(64),owner_key:'b'.repeat(64)})+'\n');
 assert.equal((await bootstrap).uiKey,'a'.repeat(64));let closed=0;watch.bind(()=>closed++);assert.equal(closed,0);
 input.end();await new Promise(r=>setImmediate(r));assert.equal(closed,1);input.emit('error',Error('fake'));assert.equal(closed,1);watch.close();
 const early=new PassThrough(),w=watchNativeOwnerPipe(early,'stdin-v1');early.resume();early.end();await new Promise(r=>setImmediate(r));assert.equal(w.lost,true);w.bind(()=>closed++);assert.equal(closed,2);w.close();
 assert.equal(watchNativeOwnerPipe(new PassThrough(),undefined),null);
});

test('private pipe watcher disposal releases listeners without quitting a service',()=>{
 const input=new PassThrough(),watch=watchNativeOwnerPipe(input,'stdin-v1');let calls=0;watch.bind(()=>calls++);watch.close();watch.close();input.emit('end');assert.equal(calls,0);assert.equal(input.listenerCount('data'),0);assert.equal(input.listenerCount('close'),0);
});

test('compiled legacy exec alias keeps PID, argv, stdin, environment and final exit code', {skip:process.platform!=='darwin'},async t=>{
 const dir=temp(t),receiver=path.join(dir,'receiver.c'),next=path.join(dir,'ChatHandFixture'),shim=path.join(dir,'KenBridge');
 fs.writeFileSync(receiver,'#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(int argc,char **argv){char line[64];if(!fgets(line,sizeof(line),stdin))return 90;printf("%d\\n%d\\n%s\\n%s\\n%s",getpid(),argc,argv[1],getenv("CHATHAND_FAKE_VALUE"),line);return 37;}\n');
 for(const args of [['clang','-Wall','-Wextra',receiver,'-o',next],['clang','-Wall','-Wextra','-Werror','-DCHATHAND_PROCESS_TARGET="ChatHandFixture"',path.join(root,'native/ProcessCompatibility.c'),'-o',shim]]){
  const r=spawnSync('/usr/bin/xcrun',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }
 const child=spawn(shim,['fake argument with spaces'],{env:{CHATHAND_FAKE_VALUE:'temporary-test-value'},stdio:['pipe','pipe','pipe']});let out='';child.stdout.on('data',d=>out+=d);child.stdin.end('fake stdin\n');
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,37);assert.equal(out,`${child.pid}\n2\nfake argument with spaces\ntemporary-test-value\nfake stdin\n`);
 fs.renameSync(next,next+'.saved');assert.equal(spawnSync(shim,[],{encoding:'utf8'}).status,126);
 fs.symlinkSync(next+'.saved',next);assert.equal(spawnSync(shim,[],{encoding:'utf8'}).status,126);
});

test('bundle staging refuses linked inputs before changing any path',t=>{
 const app=path.join(temp(t),'ChatHand.app');for(const row of PROCESS_LAYOUT){const f=path.join(app,row.legacy);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,'fixture');}
 const row=PROCESS_LAYOUT.at(-1),file=path.join(app,row.legacy);fs.unlinkSync(file);fs.symlinkSync('foreign',file);
 assert.throws(()=>stageProcessCompatibility(app,{root,run:()=>assert.fail('no compiler')}),/UNSAFE/);assert.ok(fs.existsSync(path.join(app,PROCESS_LAYOUT[0].legacy)));assert.ok(!fs.existsSync(path.join(app,PROCESS_LAYOUT[0].current)));
});

test('1059 baseline capture reads only explicit temporary public package metadata',t=>{
 const app=path.join(temp(t),'ChatHand.app'),b=baseline();
 for(const row of PROCESS_LAYOUT){const file=path.join(app,row.legacy);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fake public executable');}
 const updater=path.join(app,'Contents/Resources/runtime/scripts/upgrade.mjs');fs.mkdirSync(path.dirname(updater),{recursive:true});fs.writeFileSync(updater,'fake frozen updater source');
 let commands=0;
 const run=(program,args)=>{
  commands++;if(program.endsWith('/PlistBuddy'))return '1059';assert.equal(program,'/usr/bin/codesign');assert.ok(['-d','-dr'].includes(args[0]));
  const row=PROCESS_LAYOUT.find(r=>path.join(app,r.legacy)===args.at(-1));assert.ok(row);const c=b.components[row.key];
  return args[0]==='-dr'?'designated => '+c.requirement:args.includes('--entitlements')?'':`Identifier=${c.identifier}\n`;
 };
 const captured=captureProcessIdentityBaseline({app,dmgSHA256:'a'.repeat(64)},run);
 assert.equal(captured.source.build,1059);assert.match(captured.source.updater_sha256,/^[a-f0-9]{64}$/);assert.equal(commands,1+PROCESS_LAYOUT.length*3);
 assert.deepEqual(Object.keys(captured.components),PROCESS_LAYOUT.map(r=>r.key));
 assert.throws(()=>captureProcessIdentityBaseline({app,dmgSHA256:'invalid'},()=>assert.fail('no command')),/TEMPORARY_1059_PACKAGE_REQUIRED/);
});
