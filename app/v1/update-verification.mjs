import fs from 'node:fs';
import path from 'node:path';
import {verifyRequirement} from '../../scripts/signing.mjs';
import {payloadManifest} from './payload-manifest.mjs';
import {verifyPayload} from '../v09/payload-integrity.mjs';
import {candidateUpgradeContract,verifyUpgradeContract} from '../../scripts/upgrade.mjs';

// Shared by staged updates and verification of a manually replaced application.
// The product pin is public certificate metadata, never a Keychain lookup.
export async function verifyUpdateSignature({app,signerApp,command,exec,productSigner=false}) {
 try{await command('/usr/bin/codesign',['--verify','--deep','--strict',app],{timeout:30000});}catch{throw Object.assign(Error('UPDATE_SIGNATURE_INVALID'),{code:'UPDATE_SIGNATURE_INVALID'});}
 let signing;try{signing=await exec('/usr/bin/codesign',['-d','-r-',signerApp],{encoding:'utf8',timeout:10000,maxBuffer:65536});}catch{throw Object.assign(Error('UPDATE_SIGNER_UNKNOWN'),{code:'UPDATE_SIGNER_UNKNOWN'});}
 if(signing?.status!==undefined&&signing.status!==0)throw Error('UPDATE_SIGNER_UNKNOWN');
 const requirement=(typeof signing==='string'?signing:String(signing?.stdout||'')+'\n'+String(signing?.stderr||'')).match(/(?:^|\n)designated => (.+)/)?.[1];
 if(!requirement)throw Error('UPDATE_SIGNER_UNKNOWN');
 if(productSigner)verifyRequirement(requirement);
 try{await command('/usr/bin/codesign',['--verify',`-R=${requirement}`,app],{timeout:30000});}catch{throw Object.assign(Error('UPDATE_SIGNER_MISMATCH'),{code:'UPDATE_SIGNER_MISMATCH'});}
 return requirement;
}

export async function verifyInstalledUpdate({app,version,build,liveContract,command,exec}) {
 if(!app||fs.lstatSync(app).isSymbolicLink()||!fs.statSync(app).isDirectory())throw Error('UPDATE_APP_IDENTITY_MISMATCH');
 await verifyUpdateSignature({app,signerApp:app,command,exec,productSigner:true});
 const plist=path.join(app,'Contents/Info.plist');
 const field=async name=>(await command('/usr/libexec/PlistBuddy',['-c','Print :'+name,plist])).trim();
 const pkg=JSON.parse(fs.readFileSync(path.join(app,'Contents/Resources/runtime/package.json'),'utf8'));
 if(await field('CFBundleIdentifier')!=='com.kenyu.chathand'||await field('CFBundleShortVersionString')!==version.split('-')[0]||await field('CFBundleVersion')!==String(build)||pkg.version!==version||pkg.kenBridge?.build_number!==build||pkg.kenBridge?.bundle_id!=='com.kenyu.chathand')throw Error('UPDATE_APP_IDENTITY_MISMATCH');
 // This is the same inventory used by installation. Its path/type validation is
 // independent of the signature; the pinned codesign resource seal authenticates bytes.
 const inventory=payloadManifest(app,version);verifyPayload(app,inventory.files);
 const expected=candidateUpgradeContract(app);verifyUpgradeContract(liveContract,expected);
 return {version,build,schema_sha256:expected.schema_sha256,verified:true};
}
