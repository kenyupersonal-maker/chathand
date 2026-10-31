import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DiagnosticEvents,readChromeInstallEvents,readOnboardingEvents} from '../app/diagnostic-events.mjs';
import {desktop} from './1052-a-fixture.mjs';
const temp=t=>{const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-1061-export-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const at='2026-10-18T00:00:00.000Z';
const metadata={stage:'validating_helper',code:'CHROME_INSTALL_TARGET_HANDSHAKE_TIMEOUT',ms:36000,target_is_default:null,outcome:'stopped'};
const privateFields={profile_id:'PRIVATE_PROFILE',profile_name:'PRIVATE_NAME',path:'/PRIVATE_PATH',lease_id:'PRIVATE_LEASE',url:'https://PRIVATE_URL',helper:{extension:'PRIVATE_EXTENSION'},unknown:'PRIVATE_UNKNOWN'};
const append=(dir,row)=>fs.appendFileSync(path.join(dir,'diagnostics/events.jsonl'),JSON.stringify(row)+'\n');
test('1061 chrome install reader revalidates and projects only at/kind plus five metadata fields',t=>{
 const dir=temp(t),writer=new DiagnosticEvents(dir,{now:()=>Date.parse(at)});
 assert.equal(writer.record('chrome.install',{...metadata,...privateFields}),true);
 // A hand-written or older log may contain extra fields even though the real
 // writer strips them. The reader must independently reconstruct the schema.
 append(dir,{at,kind:'chrome.install',...metadata,...privateFields});
 for(const patch of [{at:'PRIVATE_TIMESTAMP'},{code:'PRIVATE_CODE'},{stage:'/PRIVATE_STAGE'},{ms:90001},{outcome:'PRIVATE_OUTCOME'},{target_is_default:'true'},{kind:'other'}])append(dir,{at,kind:'chrome.install',...metadata,...patch,...privateFields});
 const rows=readChromeInstallEvents(dir).events;
 assert.deepEqual(rows,[{at,kind:'chrome.install',...metadata},{at,kind:'chrome.install',...metadata}]);
 assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
 assert.deepEqual(readOnboardingEvents(dir).events,[]);
});
test('1061 chrome install reader stays bounded across rotations and empty limits',t=>{
 const dir=temp(t),writer=new DiagnosticEvents(dir,{maxBytes:700,retain:5,now:()=>Date.parse(at)});
 for(let i=0;i<40;i++)assert.equal(writer.record('chrome.install',{...metadata,ms:i}),true);
 const rows=readChromeInstallEvents(dir,{limit:3});assert.equal(rows.events.length,3);assert.equal(rows.truncated,true);assert.deepEqual(rows.events.map(x=>x.ms),[37,38,39]);
 assert.deepEqual(readChromeInstallEvents(dir,{limit:0}).events,[]);
 const bounded=readChromeInstallEvents(dir,{maxBytes:100,retain:1});assert.equal(bounded.truncated,true);assert.equal(bounded.events.length,0);
});
test('1061 chrome install reader refuses file/dir symlinks, hardlinks and permissive logs',t=>{
 const dir=temp(t),writer=new DiagnosticEvents(dir,{now:()=>Date.parse(at)});assert.equal(writer.record('chrome.install',metadata),true);
 const file=path.join(dir,'diagnostics/events.jsonl'),outside=path.join(dir,'outside');fs.renameSync(file,outside);fs.symlinkSync(outside,file);
 assert.equal(readChromeInstallEvents(dir).events.length,0);assert.ok(readChromeInstallEvents(dir).unreadable>=1);
 fs.unlinkSync(file);fs.linkSync(outside,file);assert.equal(readChromeInstallEvents(dir).events.length,0);assert.ok(readChromeInstallEvents(dir).unreadable>=1);
 fs.unlinkSync(file);fs.copyFileSync(outside,file);if(process.platform!=='win32'){fs.chmodSync(file,0o644);assert.equal(readChromeInstallEvents(dir).events.length,0);fs.chmodSync(file,0o600);}
 const moved=path.join(dir,'moved');fs.renameSync(path.join(dir,'diagnostics'),moved);fs.symlinkSync(moved,path.join(dir,'diagnostics'));
 assert.equal(readChromeInstallEvents(dir).events.length,0);assert.equal(readChromeInstallEvents(dir).unreadable,1);
});
test('1061 actual isolated diagnostics export route returns recorded Chrome stages/codes/default state without private fields',async t=>{
 const f=await desktop(t),app=f.app,stateDir=path.join(f.root,'state'),writer=new DiagnosticEvents(stateDir,{now:()=>Date.parse(at)});
 const codes=['CHROME_INSTALL_NOT_INSTALLED','CHROME_INSTALL_OTHER_PROFILE','CHROME_INSTALL_NATIVE_HOST_NOT_CONNECTED','CHROME_INSTALL_TARGET_HANDSHAKE_TIMEOUT'];
 for(let i=0;i<codes.length;i++)assert.equal(writer.record('chrome.install',{...metadata,code:codes[i],ms:i*100,target_is_default:[true,false,null,true][i],...privateFields}),true);
 append(stateDir,{at,kind:'chrome.install',...metadata,...privateFields});
 append(stateDir,{at,kind:'chrome.install',...metadata,stage:'PRIVATE_PATH',...privateFields});
 const response=await fetch('http://127.0.0.1:'+app.apiPort+'/api/diagnostics/export',{method:'POST',headers:{Authorization:'Bearer '+app.adminToken,'Content-Type':'application/json'},body:'{}'});
 assert.equal(response.status,200);const exported=await response.json();assert.deepEqual(exported.chrome_install,readChromeInstallEvents(stateDir));
 assert.equal(exported.chrome_install.events.length,5);assert.deepEqual(exported.chrome_install.events.slice(0,4).map(x=>x.code),codes);assert.deepEqual(exported.chrome_install.events.slice(0,4).map(x=>x.target_is_default),[true,false,null,true]);
 assert.ok(exported.chrome_install.events.every(row=>Object.keys(row).sort().join(',')==='at,code,kind,ms,outcome,stage,target_is_default'));
 assert.equal(JSON.stringify(exported.chrome_install).includes('PRIVATE'),false);assert.ok(exported.trace);assert.ok(exported.onboarding);
});
