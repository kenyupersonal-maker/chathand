import {nativeFixture} from '../../tests/support/native-fixtures.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn,spawnSync} from 'node:child_process';
import {createUpgradeRunner} from '../../scripts/upgrade.mjs';
const run=(program,args,env)=>new Promise((resolve,reject)=>{const child=spawn(program,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
test('ordinary helper discovers a real exact executable absent from NSWorkspace, then proves its PID absent',{skip:process.platform!=='darwin',timeout:90000},async t=>{
 const root='/private/tmp/chathand-1060-rehearsal-pid-'+crypto.randomBytes(8).toString('hex');fs.mkdirSync(root,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const helper=path.join(root,'helper'),app=path.join(root,'Fixture.app'),binary=path.join(app,'Contents/MacOS/Fixture');fs.mkdirSync(path.dirname(binary),{recursive:true});
 fs.copyFileSync(nativeFixture('sleep_fixture'),binary);
 fs.writeFileSync(path.join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleIdentifier</key><string>invalid.chathand.pidfixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleName</key><string>Fixture</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
 const seal=spawnSync('/usr/bin/codesign',['--force','--sign','-',app],{encoding:'utf8'});assert.equal(seal.status,0,seal.stderr);
 const signed=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{encoding:'utf8'});assert.equal(signed.status,0,signed.stderr);
 fs.copyFileSync(nativeFixture('upgrade_control'),helper);
 const child=spawn(binary,['60'],{stdio:'ignore'});t.after(()=>{try{child.kill('SIGTERM');}catch{}});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 await new Promise(resolve=>setTimeout(resolve,200));assert.equal(child.exitCode,null,'owned compiled fixture remains alive before probing');
 const info=await run(helper,['info',app]);assert.equal(info.code,0,info.err+info.out);const row=JSON.parse(info.out);assert.equal(row.kernel_scan,true);assert.deepEqual(row.pids,[child.pid]);assert.equal(row.identities[0].executable,binary);
 const stopped=await run(helper,['stop-exact',app,String(child.pid)]);assert.equal(stopped.code,0,stopped.err+stopped.out);assert.equal(JSON.parse(stopped.out).pid_absent,true);assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
 const absent=JSON.parse((await run(helper,['info',app])).out);assert.deepEqual(absent.pids,[]);
 fs.writeFileSync(path.join(root,'.rehearsal-root.json'),JSON.stringify({format:1,purpose:'1060 isolated rehearsal'}),{mode:0o600});for(const d of ['home','state','logs'])fs.mkdirSync(path.join(root,d),{mode:0o700});
 const environment={HOME:path.join(root,'home'),CFFIXED_USER_HOME:path.join(root,'home'),CHATHAND_REHEARSAL_ROOT:root,CHATHAND_REHEARSAL_HOME:path.join(root,'home'),CHATHAND_STATE_DIR:path.join(root,'state'),CHATHAND_REHEARSAL_LOG_DIR:'/private/tmp',PATH:'/usr/bin:/bin'};
 const outside=await run(helper,['start',app],environment);assert.notEqual(outside.code,0);assert.match(outside.out,/REHEARSAL_PATH_OUTSIDE_ROOT/);
 fs.renameSync(path.join(root,'logs'),path.join(root,'own-logs'));fs.symlinkSync('/private/tmp',path.join(root,'logs'));delete environment.CHATHAND_REHEARSAL_LOG_DIR;
 const alias=await run(helper,['start',app],environment);assert.notEqual(alias.code,0);assert.match(alias.out,/REHEARSAL_PATH_ALIAS/);
 assert.deepEqual(JSON.parse((await run(helper,['info',app])).out).pids,[],'invalid output roots never launch an app');
});
test('installer stop rejects unknown process enumeration and a surviving exact old PID',async t=>{
 const root='/private/tmp/chathand-1060-rehearsal-stop-'+crypto.randomBytes(8).toString('hex');fs.mkdirSync(root,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const app=path.join(root,'target.app');fs.mkdirSync(app);
 for(const scan of [{pids:[]},{kernel_scan:true,identities:[],pids:[123]},{kernel_scan:true,identities:[],pids:[]}]){
  let info=0;const commands=[];const runner=createUpgradeRunner({packageRoot:root,destination:app,stateDir:path.join(root,'state'),backupRoot:path.join(root,'backup'),executeCommand:(program,args)=>{commands.push(args);return {status:0,stdout:JSON.stringify(args[0]==='info'&&++info===1?scan:{kernel_scan:true,identities:[{pid:process.pid}],pids:[process.pid]})};}});
  await assert.rejects(runner.hooks.stop(app),/APP_PID_IDENTITY_UNKNOWN|OLD_APP_PID_STILL_RUNNING/);
  assert.ok(!commands.some(args=>args[0]==='start'));
 }
});
test('installer uses the candidate helper to stop an older destination',async t=>{
 const root='/private/tmp/chathand-1060-rehearsal-candidate-'+crypto.randomBytes(8).toString('hex');fs.mkdirSync(root,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app=path.join(root,'old.app'),candidateHelper=path.join(root,'ChatHand.app/Contents/Resources/runtime/bin/ChatHandUpgradeControl');fs.mkdirSync(app);fs.mkdirSync(path.dirname(candidateHelper),{recursive:true});fs.writeFileSync(candidateHelper,'fixture; never executed');
 const commands=[];let scans=0;
 const runner=createUpgradeRunner({packageRoot:root,destination:app,stateDir:path.join(root,'state'),backupRoot:path.join(root,'backup'),executeCommand:(program,args)=>{commands.push({program,args});return {status:0,stdout:JSON.stringify(args[0]==='info'?(++scans===1?{kernel_scan:true,identities:[{pid:2147483647}],pids:[2147483647]}:{kernel_scan:true,identities:[],pids:[]}):{stopped:true,pid_absent:true})};}});
 await runner.hooks.stop(app);
 assert.deepEqual(commands.map(c=>c.program),[candidateHelper,candidateHelper,candidateHelper]);
 assert.deepEqual(commands.map(c=>c.args),[['info',app],['stop-exact',app,'2147483647'],['info',app]]);
});
