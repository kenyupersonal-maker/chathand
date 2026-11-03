// 1095 (Claude, Ken 11/3): the installation identity never stops ChatHand from
// opening. Only the Mac's hardware UUID decides "another Mac"; host name and
// data-folder inode changes are ordinary and keep the same identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {InstallationPilot} from '../../app/v1/installation-pilot.mjs';

const MAC_A='11111111-2222-4333-8444-555555555555';
const MAC_B='66666666-7777-4888-9999-aaaaaaaaaaaa';
const on=mac=>({readDevice:()=>mac});
const FILE='installation-1049.json';
function folder(t,name='state'){
 const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-identity-')));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const dir=path.join(base,name);fs.mkdirSync(dir,{mode:0o700});return dir;
}
const saved=dir=>JSON.parse(fs.readFileSync(path.join(dir,FILE),'utf8'));
const aside=dir=>fs.readdirSync(dir).filter(name=>/^installation-1049\.unreadable-.*\.json$/.test(name));

test('same Mac with a changed host name or folder scope keeps its identity and pilot choice',t=>{
 const dir=folder(t),first=new InstallationPilot(dir,on(MAC_A));first.applyDefaultOnce();
 fs.writeFileSync(path.join(dir,FILE),JSON.stringify({...saved(dir),installation_scope:'scope-from-an-older-host-name'})+'\n',{mode:0o600});
 const again=new InstallationPilot(dir,on(MAC_A));
 assert.equal(again.change,null);assert.equal(again.data.installation_uuid,first.data.installation_uuid);assert.equal(again.eligible(),true);
 assert.equal(saved(dir).installation_scope,again.scope,'the scope is refreshed for older versions');
});

test('a rebuilt or restored data folder on the same Mac keeps its identity',t=>{
 const dir=folder(t),first=new InstallationPilot(dir,on(MAC_A));
 const rebuilt=folder(t,'restored');fs.copyFileSync(path.join(dir,FILE),path.join(rebuilt,FILE));
 const again=new InstallationPilot(rebuilt,on(MAC_A));
 assert.equal(again.change,null);assert.equal(again.data.installation_uuid,first.data.installation_uuid);
});

test('data copied to another Mac starts a new identity and leaves the copied pairing unused',t=>{
 const dir=folder(t),first=new InstallationPilot(dir,on(MAC_A));first.applyDefaultOnce();
 const other=folder(t,'other-mac');fs.copyFileSync(path.join(dir,FILE),path.join(other,FILE));
 const copy=new InstallationPilot(other,on(MAC_B));
 assert.equal(copy.change,'other_mac');assert.notEqual(copy.data.installation_uuid,first.data.installation_uuid);
 assert.equal(copy.data.previous_installation_uuid,first.data.installation_uuid);assert.equal(copy.eligible(),false);
 assert.equal(saved(other).installation_uuid,copy.data.installation_uuid);
 copy.applyDefaultOnce();assert.equal(copy.eligible(),true,'the new identity gets its own default');
 assert.equal(new InstallationPilot(other,on(MAC_B)).data.installation_uuid,copy.data.installation_uuid,'and keeps it on later starts');
 assert.equal(new InstallationPilot(dir,on(MAC_A)).data.installation_uuid,first.data.installation_uuid,'the original Mac is untouched');
});

test('when this Mac cannot be read, the saved identity is kept',t=>{
 const dir=folder(t),first=new InstallationPilot(dir,on(MAC_A)),before=fs.readFileSync(path.join(dir,FILE));
 const again=new InstallationPilot(dir,on(null));
 assert.equal(again.change,null);assert.equal(again.data.installation_uuid,first.data.installation_uuid);
 assert.deepEqual(fs.readFileSync(path.join(dir,FILE)),before);
 const throwing=new InstallationPilot(dir,{readDevice:()=>{throw Error('ioreg unavailable');}});
 assert.equal(throwing.data.installation_uuid,first.data.installation_uuid);
});

test('identities saved by 1094 and earlier are treated as this Mac and get its record once',t=>{
 const dir=folder(t),uuid='3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
 fs.writeFileSync(path.join(dir,FILE),JSON.stringify({format:1,installation_uuid:uuid,installation_scope:'scope-from-an-older-host-name',pilot_installation_uuid:uuid,pilot_default_applied:true})+'\n',{mode:0o600});
 const first=new InstallationPilot(dir,on(MAC_A));
 assert.equal(first.change,null);assert.equal(first.data.installation_uuid,uuid);assert.equal(first.eligible(),true);assert.match(saved(dir).device,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(saved(dir)).includes(MAC_A),false,'the hardware UUID itself is never stored');
 const before=fs.readFileSync(path.join(dir,FILE));new InstallationPilot(dir,on(MAC_A));
 assert.deepEqual(fs.readFileSync(path.join(dir,FILE)),before,'nothing is rewritten when nothing changed');
});

for(const [kind,write] of [
 ['broken JSON',file=>fs.writeFileSync(file,'{"format":1,broken',{mode:0o600})],
 ['unknown shape',file=>fs.writeFileSync(file,JSON.stringify({format:1,installation_uuid:'not-a-uuid'}),{mode:0o600})],
 ['oversized file',file=>fs.writeFileSync(file,JSON.stringify({format:1,pad:'x'.repeat(5000)}),{mode:0o600})],
 ['a folder in its place',file=>fs.mkdirSync(file)],
])test('a damaged identity ('+kind+') is kept aside and a fresh one opens',t=>{
 const dir=folder(t),file=path.join(dir,FILE);write(file);
 const isDir=fs.statSync(file).isDirectory(),before=isDir?null:fs.readFileSync(file);
 const pilot=new InstallationPilot(dir,on(MAC_A));
 assert.equal(pilot.change,'damaged');assert.equal(aside(dir).length,1);
 if(before)assert.deepEqual(fs.readFileSync(path.join(dir,aside(dir)[0])),before,'kept byte-for-byte');
 assert.equal(saved(dir).installation_uuid,pilot.data.installation_uuid);
 assert.equal(new InstallationPilot(dir,on(MAC_A)).data.installation_uuid,pilot.data.installation_uuid);
});

test('loose file permissions are tightened instead of stopping startup',t=>{
 const dir=folder(t),first=new InstallationPilot(dir,on(MAC_A));fs.chmodSync(path.join(dir,FILE),0o644);
 const again=new InstallationPilot(dir,on(MAC_A));
 assert.equal(again.data.installation_uuid,first.data.installation_uuid);assert.equal(fs.statSync(path.join(dir,FILE)).mode&0o777,0o600);
});
