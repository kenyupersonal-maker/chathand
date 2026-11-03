import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {desktopStartupFailure} from '../../app/v1/desktop-cli.mjs';
import {readNativeTimeline} from '../../app/diagnostic-events.mjs';

test('native startup timeline keeps exact categories and drops arbitrary codes and private fields',t=>{
 const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-startup-timeline-')));
 t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
 const directory=path.join(state,'diagnostics');fs.mkdirSync(directory,{mode:0o700});
 const codes=['PRIVATE_SYNTHETIC_CODE','NODE_VERSION','ALREADY_RUNNING','DATA_FORMAT_NEWER','DATA_FORMAT_UNSUPPORTED','EACCES','ENOSPC','EADDRINUSE','NATIVE_OWNER_EXITED','PILOT_IDENTITY_UNSAFE','PILOT_IDENTITY_CORRUPT','PILOT_IDENTITY_INVALID','RELAY_STATE_VERSION','B_STORE_CONFIG','B_STORE_UNSAFE','MATTER_UNSAFE_PATH','MATTER_UNSAFE_FILE','MATTER_SEQUENCE','MATTER_ID','MATTER_JOURNAL_CONFLICT','STATE_UNSAFE'].map(code=>desktopStartupFailure({code}).code);
 const base={at:'2026-11-03T00:00:00.000Z',phase:'startup',build:1094,native_pid:42,backend_pid:43,message:'PRIVATE_SYNTHETIC_MESSAGE',path:'/PRIVATE_SYNTHETIC_PATH',credential:'PRIVATE_SYNTHETIC_CREDENTIAL'};
 const rows=codes.map(code=>({...base,code}));
 rows.push({...base,code:'STARTUP_PRIVATE_SYNTHETIC_CODE'},{...base,code:'STARTUP_FAILURE_UNKNOWN_PRIVATE'},{...base,code:'FAKE_CREDENTIAL_PRIVATE_SYNTHETIC_TOKEN'},{...base,phase:'PRIVATE_SYNTHETIC_PHASE',code:'STARTUP_FAILURE_UNKNOWN'});
 const file=path.join(directory,'native-events.jsonl'),original=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
 fs.writeFileSync(file,original,{mode:0o600});
 const timeline=readNativeTimeline(state,{auditRoot:null});
 assert.deepEqual(timeline.events.map(row=>row.code),codes);
 assert.equal(timeline.unreadable,0);assert.doesNotMatch(JSON.stringify(timeline),/PRIVATE_SYNTHETIC|UNKNOWN_PRIVATE/);
 assert.ok(timeline.events.every(row=>Object.keys(row).sort().join(',')==='at,backend_pid,build,code,native_pid,phase'));
 assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('native startup status protocol persists only fixed categories and metadata',
 {skip:process.platform!=='darwin',timeout:120000},t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-startup-diagnostics-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const name of ['home','state','cache'])fs.mkdirSync(path.join(root,name),{mode:0o700});
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:path.join(root,'home'),CFFIXED_USER_HOME:path.join(root,'home'),TMPDIR:root,CLANG_MODULE_CACHE_PATH:path.join(root,'cache')};
 const binary=path.join(root,'checks');
 const compiled=spawnSync('/usr/bin/xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',path.join(root,'cache'),'native/BuildVersion.swift','native/NativeDiagnostics.swift','tests/v1/native-startup-diagnostics-checks.swift','-o',binary],{env,encoding:'utf8',timeout:90000});
 assert.equal(compiled.status,0,compiled.stderr);
 const run=spawnSync(binary,[path.join(root,'state')],{env,encoding:'utf8',timeout:5000});
 assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS: fixed startup categories/);
 const rows=fs.readFileSync(path.join(root,'state','diagnostics','native-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const inputs=['PRIVATE_SYNTHETIC_CODE','PRIVATE_SYNTHETIC_CODE','NODE_VERSION','ALREADY_RUNNING','DATA_FORMAT_NEWER','DATA_FORMAT_UNSUPPORTED','EACCES','ENOSPC','EADDRINUSE','NATIVE_OWNER_EXITED','PILOT_IDENTITY_UNSAFE','PILOT_IDENTITY_CORRUPT','PILOT_IDENTITY_INVALID','RELAY_STATE_VERSION','B_STORE_CONFIG','B_STORE_UNSAFE','MATTER_UNSAFE_PATH','MATTER_UNSAFE_FILE','MATTER_SEQUENCE','MATTER_ID','MATTER_JOURNAL_CONFLICT','STATE_UNSAFE','PRIVATE_SYNTHETIC_CODE','PRIVATE_SYNTHETIC_CODE'];
 assert.deepEqual(rows.map(row=>row.code),inputs.map(code=>desktopStartupFailure({code}).code),'Node and Swift must agree on every reserved status');
 assert.deepEqual([...new Set(readNativeTimeline(path.join(root,'state'),{auditRoot:null}).events.map(row=>row.code))].sort(),[...new Set(rows.map(row=>row.code))].sort(),'real native receipts must reach the support timeline');
 assert.equal(fs.statSync(path.join(root,'state','diagnostics','native-events.jsonl')).mode & 0o777,0o600);
});
