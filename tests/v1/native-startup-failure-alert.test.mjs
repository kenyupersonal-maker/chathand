import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo=fileURLToPath(new URL('../../',import.meta.url));
test('real CLI failure statuses reach native reason text and usable NSAlert controls',{skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-native-failure-alert-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['home','cache'])fs.mkdirSync(path.join(root,name),{mode:0o700});
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),CFFIXED_USER_HOME:path.join(root,'home'),TMPDIR:root,CLANG_MODULE_CACHE_PATH:path.join(root,'cache')};
 const binary=path.join(root,'checks');
 const build=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/BuildVersion.swift','native/NativeDiagnostics.swift','native/StartupFailureAlert.swift','native/tests/StartupFailureAlertChecks.swift','-o',binary],{cwd:repo,env,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,build.stderr);
 const output=process.env.CHATHAND_STARTUP_SHOTS;if(output)fs.mkdirSync(output,{recursive:true});
 for(const [error,status,code,action]of [['NODE_VERSION',71,'STARTUP_NODE_VERSION','download'],['EACCES',75,'STARTUP_ACCESS_DENIED','dataFolder'],['ENOSPC',76,'STARTUP_STORAGE_FULL','dataFolder'],['EADDRINUSE',77,'STARTUP_PORT_IN_USE','retry'],['B_STORE_UNSAFE',84,'B_STORE_UNSAFE','dataFolder']]){
  const child=spawnSync(process.execPath,['tests/v1/desktop-cli-fixture.mjs','error',error],{cwd:repo,env:{...env,NODE_TEST_CONTEXT:'child-v8',CHATHAND_UI_KEY_STDIN:'1',CHATHAND_OWNER_PIPE:'stdin-v1'},input:JSON.stringify({v:2,ui_key:'a'.repeat(64),owner_key:'b'.repeat(64)})+'\n',encoding:'utf8',timeout:5000});
  assert.equal(child.status,status,child.stderr);assert.deepEqual(JSON.parse(child.stderr),{code});
  for(const [locale,scheme]of [['zh','light'],['zh','dark'],['en','light']]){
   const args=[path.join(repo,'locales'),locale,String(child.status),scheme,...(output?[path.join(output,`native-${code}-${locale}-${scheme}.png`)]:[])];
   const run=spawnSync(binary,args,{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'PASS: '+code+' '+action+',log,quit');
  }
 }
 for(const [code,expected] of [['STARTUP_ALREADY_RUNNING','dataFolder,clearRetry,log,quit'],['INSTANCE_LOCK_BUSY','dataFolder,clearRetry,log,quit'],['INSTANCE_QUITTING_TIMEOUT','dataFolder,clearRetry,log,quit'],['ORPHAN_IDENTITY_UNKNOWN','retry,clearRetry,log,quit']]){
  for(const [locale,scheme,label]of [['zh','light','清除旧记录并重试'],['zh','dark','清除旧记录并重试'],['en','light','Clear and Retry']]){
   const args=[path.join(repo,'locales'),locale,'72',scheme,...(output?[path.join(output,`native-${code}-${locale}-${scheme}.png`)]:[]),`code:${code}`];
   const run=spawnSync(binary,args,{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'PASS: '+code+' '+expected);
   const catalog=JSON.parse(fs.readFileSync(path.join(repo,'locales',`${locale}.json`),'utf8'));
   assert.equal(catalog['native.startupFailure.action.clearRetry'],label);
  }
 }
});
