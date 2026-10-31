// Explicit legacy fixtures only. Product/store manifests are never rewritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extensionVersion} from '../../scripts/generate-version.mjs';
import {assertTemporaryUpdatePaths} from '../../app/v1/client-features.mjs';
const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));
export function alignLegacyFixtureManifest(root){
 assertTemporaryUpdatePaths(root);
 const file=path.join(root,'browser-extension/manifest.json');
 assertTemporaryUpdatePaths(file);
 const manifest=JSON.parse(fs.readFileSync(file,'utf8')),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 fs.writeFileSync(file,JSON.stringify({...manifest,...extensionVersion(pkg)},null,2)+'\n');
 return root;
}
export function createLegacyChromeInstallSource(t,{sourceRoot=repositoryRoot,targetRoot}={}){
 const root=targetRoot??fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-legacy-source-')));
 assertTemporaryUpdatePaths(root);
 if(targetRoot===undefined)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const relative of ['browser-extension','package.json','app/v09/extension-host.mjs']){
  const target=path.join(root,relative);assertTemporaryUpdatePaths(target);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.cpSync(path.join(sourceRoot,relative),target,{recursive:true});
 }
 return alignLegacyFixtureManifest(root);
}
