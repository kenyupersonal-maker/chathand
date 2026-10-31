import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {clangPrivacyFlags} from './build-privacy.mjs';

// Internal protocol names, bundle IDs and installed App location stay unchanged.
export const PROCESS_LAYOUT = Object.freeze([
 {key:'app',legacy:'Contents/MacOS/KenBridge',current:'Contents/MacOS/ChatHand'},
 {key:'node',legacy:'Contents/Resources/runtime/bin/node',current:'Contents/Resources/runtime/bin/ChatHandNode'},
 {key:'upgrade',legacy:'Contents/Resources/runtime/bin/ken-upgrade-control',current:'Contents/Resources/runtime/bin/ChatHandUpgradeControl'},
 {key:'document',legacy:'Contents/Resources/runtime/bin/ken-document-reader',current:'Contents/Resources/runtime/bin/ChatHandDocumentReader'},
 {key:'browser',legacy:'Contents/Resources/runtime/bin/ken-browser-host',current:'Contents/Resources/runtime/bin/ChatHandBrowserHost'},
 {key:'artifact',legacy:'Contents/Resources/runtime/bin/ken-artifact-io',current:'Contents/Resources/runtime/bin/ChatHandArtifactIO'},
 {key:'tunnel',legacy:'Contents/Resources/runtime/bin/tunnel-client',current:'Contents/Resources/runtime/bin/ChatHandTunnel'},
 {key:'cloudflared',legacy:'Contents/Resources/runtime/bin/cloudflared',current:'Contents/Resources/runtime/bin/ChatHandCloudflared'},
]);

export function validateProcessIdentityBaseline(value) {
 if(value?.format!==1||value.source?.build!==1059||!['dmg_sha256','updater_sha256'].every(k=>/^[a-f0-9]{64}$/.test(value.source[k]||'')))throw Error('PROCESS_IDENTITY_BASELINE_SOURCE_REQUIRED');
 for(const {key} of PROCESS_LAYOUT){
  const c=value.components?.[key];
  if(!c||typeof c.identifier!=='string'||!/^[A-Za-z0-9._-]+$/.test(c.identifier)||typeof c.requirement!=='string'||
   !requirementIdentifies(c.requirement,c.identifier)||/cdhash/i.test(c.requirement)||
   !(c.entitlements===null||typeof c.entitlements==='string'&&c.entitlements.includes('<plist')))throw Error('PROCESS_IDENTITY_BASELINE_INVALID_'+key);
 }
 if(value.components.app.identifier!=='com.kenyu.chathand')throw Error('PROCESS_IDENTITY_APP_CHANGED');
 return value;
}

// codesign legitimately prints simple identifiers without quotes (node,
// cloudflared). Match the complete identifier token, never a prefix or a later
// unrelated clause. codesign -R still verifies the original unchanged DR.
function requirementIdentifies(requirement,identifier) {
 const match=requirement.replace(/^designated\s*=>\s*/,'').match(/^identifier\s+(?:"([A-Za-z0-9._-]+)"|([A-Za-z0-9._-]+))(?=\s|$)/);
 return (match?.[1]??match?.[2])===identifier;
}

export function processSigningIdentity(app,file,baseline) {
 const relative=path.relative(app,file).split(path.sep).join('/');
 const row=PROCESS_LAYOUT.find(r=>r.current===relative||r.legacy===relative);
 return row?baseline.components[row.key]:null;
}

export function readPublicProcessSignature(file,run) {
 const details=run('/usr/bin/codesign',['-d','--verbose=4',file]);
 const requirementOutput=run('/usr/bin/codesign',['-dr','-',file]);
 const entitlementOutput=run('/usr/bin/codesign',['-d','--entitlements',':-',file]);
 const identifier=details.match(/^Identifier=(.+)$/m)?.[1]?.trim();
 const requirement=requirementOutput.match(/(?:^|\n)designated\s*=>\s*(.+)/)?.[1]?.trim();
 const entitlements=entitlementOutput.match(/<\?xml[\s\S]*?<\/plist>|<plist[\s\S]*?<\/plist>/)?.[0]?.trim()??null;
 if(!identifier||!requirement)throw Error('PROCESS_PUBLIC_SIGNATURE_UNREADABLE');
 return {identifier,requirement,entitlements};
}

// Preparation for Root's later frozen-1059 rehearsal. Reads only public package
// files/signature metadata from an explicitly supplied temporary extraction.
// It neither mounts, installs, signs nor launches the package.
export function captureProcessIdentityBaseline({app,dmgSHA256},run) {
 const real=fs.realpathSync(app),temporary=[os.tmpdir(),'/private/tmp'].map(p=>fs.realpathSync(p));
 if(!temporary.some(p=>real.startsWith(p+path.sep))||!real.endsWith('.app')||!/^[a-f0-9]{64}$/.test(dmgSHA256||''))throw Error('TEMPORARY_1059_PACKAGE_REQUIRED');
 const build=Number(run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',path.join(real,'Contents/Info.plist')]).trim());
 if(build!==1059)throw Error('FROZEN_1059_REQUIRED');
 const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const components=Object.fromEntries(PROCESS_LAYOUT.map(row=>{
  const file=path.join(real,row.legacy),st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())throw Error('PROCESS_BASELINE_FILE_REQUIRED');
  return [row.key,{...readPublicProcessSignature(file,run),sha256:sha(file)}];
 }));
 return validateProcessIdentityBaseline({format:1,source:{build,dmg_sha256:dmgSHA256,updater_sha256:sha(path.join(real,'Contents/Resources/runtime/scripts/upgrade.mjs'))},components});
}

export function hasRenamedProcesses(app){return PROCESS_LAYOUT.some(r=>fs.existsSync(path.join(app,r.current)));}

// Called only during bundle assembly, before any signing or outer resource seal.
export function stageProcessCompatibility(app,{root,run}) {
 for(const row of PROCESS_LAYOUT){
  const old=path.join(app,row.legacy),next=path.join(app,row.current),st=fs.lstatSync(old);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||fs.existsSync(next))throw Error('PROCESS_LAYOUT_UNSAFE_'+row.key);
 }
 for(const row of PROCESS_LAYOUT){
  const old=path.join(app,row.legacy),next=path.join(app,row.current);
  fs.renameSync(old,next);
  run('/usr/bin/xcrun',['clang',...clangPrivacyFlags(root),'-O2','-Wall','-Wextra','-Werror',`-DCHATHAND_PROCESS_TARGET="${path.basename(next)}"`,path.join(root,'native/ProcessCompatibility.c'),'-o',old]);
  fs.chmodSync(next,0o755);fs.chmodSync(old,0o755);
 }
 return PROCESS_LAYOUT;
}

// The new updater can inspect either generation; 1059 still uses our exec aliases.
export function appProcessExecutable(app,component,exists=fs.existsSync){
 const row=PROCESS_LAYOUT.find(r=>r.key===component);
 if(!row)throw Error('PROCESS_COMPONENT_UNKNOWN');
 const current=path.join(app,row.current);
 return exists(current)?current:path.join(app,row.legacy);
}
