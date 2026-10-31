import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {hasRenamedProcesses,validateProcessIdentityBaseline,processSigningIdentity,readPublicProcessSignature} from './process-identity.mjs';
export const BUNDLE_ID = 'com.kenyu.chathand';
export const SIGNING_IDENTITY = '13D3EF5EB9C743427123452CD966CBC8FD9ECF2D';
const magics = new Set(['cffaedfe','feedfacf','cefaedfe','feedface','cafebabe','bebafeca','cafebabf','bfbafeca']);
export function machOFiles(dir) {
 const found=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory()) found.push(...machOFiles(file));
  else if(entry.isFile()) {const fd=fs.openSync(file,'r'),header=Buffer.alloc(4);try{fs.readSync(fd,header,0,4,0);}finally{fs.closeSync(fd);}if(magics.has(header.toString('hex')))found.push(file);}
 }
 return found;
}
function command(program,args){const r=spawnSync(program,args,{encoding:'utf8',timeout:120000});if(r.status!==0)throw Error(`${path.basename(program)} failed: ${r.stderr||r.error?.message||r.stdout}`);return (r.stdout||'')+(r.stderr||'');}
export function verifyRequirement(text){
 if(!text.includes(`identifier "${BUNDLE_ID}"`)||!text.toLowerCase().includes(`certificate leaf = h"${SIGNING_IDENTITY.toLowerCase()}"`)||text.includes('cdhash'))throw Error('UNSTABLE_SIGNING_REQUIREMENT');
}
export function signApplication(app,run=command,{beforeSeal=null,processIdentityBaseline=null}={}){
 // Read-only public 1059 metadata must be supplied before a renamed release can
 // be signed. Do not enumerate a keychain or invent filename-derived identities.
 const renamed=hasRenamedProcesses(app);
 const baseline=renamed?validateProcessIdentityBaseline(processIdentityBaseline):null;
 const plist=run('/usr/libexec/PlistBuddy',['-c','Print CFBundleIdentifier',path.join(app,'Contents/Info.plist')]).trim();
 if(plist!==BUNDLE_ID)throw Error('WRONG_BUNDLE_ID');
 const files=machOFiles(app);
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-process-sign-'));
 function sign(file,identity){
  const args=['--force','--sign',SIGNING_IDENTITY,'--timestamp=none'];
  if(identity){
   args.push('--identifier',identity.identifier,'--requirements','=designated => '+identity.requirement.replace(/^designated\s*=>\s*/,''));
   if(identity.entitlements!==null){const entitlements=path.join(scratch,'entitlements.plist');fs.writeFileSync(entitlements,identity.entitlements,{mode:0o600});args.push('--entitlements',entitlements);}
  }
  run('/usr/bin/codesign',[...args,file]);
 }
 try{
 for(const file of files)sign(file,baseline?processSigningIdentity(app,file,baseline):null);
 // Signing changes Mach-O bytes. Freeze binary provenance after inner signatures
 // and before the outer App resource seal; never rewrite sealed resources later.
 beforeSeal?.();
 sign(app,baseline?.components.app);
 run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 if(baseline)for(const file of files){
  const identity=processSigningIdentity(app,file,baseline);if(!identity)continue;
  run('/usr/bin/codesign',['--verify','--strict','-R','='+identity.requirement.replace(/^designated\s*=>\s*/,''),file]);
  const actual=readPublicProcessSignature(file,run);
  if(actual.identifier!==identity.identifier||actual.requirement!==identity.requirement.replace(/^designated\s*=>\s*/,'')||actual.entitlements!==(identity.entitlements?.trim()??null))throw Error('PROCESS_IDENTITY_CHANGED');
 }
 const requirement=run('/usr/bin/codesign',['-dr','-',app]);verifyRequirement(requirement);
 return {identity_sha1:SIGNING_IDENTITY,bundle_id:BUNDLE_ID,executables_signed:files.length,requirement,verification:'deep_strict_pass',process_identity:baseline?'1059_requirements_verified':'legacy_layout'};
 }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
