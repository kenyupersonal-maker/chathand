import fs from 'node:fs';
import path from 'node:path';

// Apply to every locally compiled shipping component, including SwiftPM's
// dependencies. Keep paths in diagnostics on disk, but never in the binaries.
const publicSourceRoot='/chathand/source';
function sourceRoots(root){return [...new Set([path.resolve(root),fs.realpathSync(root)])];}
export function swiftPrivacyFlags(root){
 return ['-gnone','-file-compilation-dir',publicSourceRoot,
  ...sourceRoots(root).flatMap(source=>['-debug-prefix-map',`${source}=${publicSourceRoot}`,'-file-prefix-map',`${source}=${publicSourceRoot}`])];
}
export function clangPrivacyFlags(root){
 return [`-fdebug-compilation-dir=${publicSourceRoot}`,
  ...sourceRoots(root).flatMap(source=>[`-fdebug-prefix-map=${source}=${publicSourceRoot}`,`-ffile-prefix-map=${source}=${publicSourceRoot}`])];
}
export function swiftPackagePrivacyFlags(root){
 return [...swiftPrivacyFlags(root).flatMap(flag=>['-Xswiftc',flag]),...clangPrivacyFlags(root).flatMap(flag=>['-Xcc',flag])];
}

export function copyBundleTree(source,destination,root){
 fs.cpSync(source,destination,{recursive:true,dereference:false,verbatimSymlinks:true,filter:file=>{
  const name=path.basename(file),relative=path.relative(root,file).split(path.sep).join('/');
  return !['.DS_Store','__pycache__','.git'].includes(name)&&!name.startsWith('._')&&!/^scripts\/rehearse-[^/]*(?:\/|$)/.test(relative);
 }});
}
