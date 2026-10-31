import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DiagnosticEvents,readConnectionTimeline,readNativeTimeline,chromeInstallFields} from '../../app/diagnostic-events.mjs';

function temp(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1070-backend-diagnostics-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('Site startup and restart sources survive writer and reader without accepting arbitrary startup sources',t=>{
 const state=temp(t),events=new DiagnosticEvents(state,{salt:Buffer.alloc(32)});
 events.record('conn.startup',{stage:'transport',outcome:'begin',source:'site',ms:3,private_value:'PRIVATE'});
 events.record('conn.restart',{reason:'connection_lost',source:'site',ms:4});
 events.record('conn.startup',{stage:'healthy',outcome:'ok',source:'PRIVATE_SOURCE',ms:5});
 const rows=readConnectionTimeline(state).events;
 assert.equal(rows[0].source,'site');assert.equal(rows[1].source,'site');assert.equal(rows[2].source,undefined);
 assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
});

test('uninstall revoke exports exactly its three result codes and keeps other phase/code combinations unchanged',t=>{
 const state=temp(t),dir=path.join(state,'diagnostics');fs.mkdirSync(dir,{mode:0o700});
 const at='2026-10-23T00:00:00.000Z',base={at,phase:'uninstall_revoke',private_path:'PRIVATE',response:{token:'PRIVATE'}};
 const rows=['CONFIRMED','UNCONFIRMED','SKIPPED','STARTED','PRIVATE_CODE'].map(code=>({...base,code}));
 rows.push({...base,phase:'uninstall_app',code:'CONFIRMED'},{...base,phase:'PRIVATE_PHASE',code:'SKIPPED'});
 fs.writeFileSync(path.join(dir,'native-events.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
 const result=readNativeTimeline(state,{auditRoot:null});
 assert.deepEqual(result.events.map(row=>row.code),['CONFIRMED','UNCONFIRMED','SKIPPED']);
 assert.ok(result.events.every(row=>Object.keys(row).sort().join(',')==='at,code,phase'));
 assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});


test('Chrome wait diagnostic allowance is phase-specific and exports only categorical fields',()=>{
 const base={stage:'waiting_accessibility',code:'CHROME_INSTALL_ACCESSIBILITY_TIMEOUT',ms:180000,outcome:'stopped',target_is_default:null,attempt_id:'PRIVATE',profiles:['PRIVATE']};
 assert.equal(chromeInstallFields(base).ms,180000);
 assert.equal(chromeInstallFields({...base,ms:300000}).ms,300000);
 assert.equal(chromeInstallFields({...base,ms:300001}),null);
 for(const stage of ['preparing','removing_copy','installed_verified']){
  assert.ok(chromeInstallFields({...base,stage,ms:90000}));
  assert.equal(chromeInstallFields({...base,stage,ms:90001}),null);
 }
 assert.deepEqual(Object.keys(chromeInstallFields(base)).sort(),['code','ms','outcome','stage','target_is_default']);
});
