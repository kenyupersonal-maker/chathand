/** Signed bundle template sources. Remote and local bytes never share a URL binding. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const pkg=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SHA=/^[a-f0-9]{64}$/;
// Exact previously signed local artifact. It is trusted only for verifying an
// existing binding's health; new enrollment/descriptor always uses current bytes.
const PUBLISHED_LOCAL_HISTORY=Object.freeze([
 {template_version:'1069-site-b-v6',template_sha256:'494b7adb5dc3db99ffcd7b51b593c85d17511e1fb5d31766d7cfbdb364d88de9',manifest_sha256:'443ccd90b546b8ac78cfcb7f5dd1e73817826c13ac2262febd2a7b6a9c7a088d',capabilities:{binding_protocol:3,owner_rebind:1}},
 {"template_version": "1068-site-b-v5", "template_sha256": "48ca4525f5fb72969380c262029f31b338918ce90f1ea4932258a7f3823fe227", "manifest_sha256": "f618072c5e4a24bed6a3ddf08192fe5dbafdf486773bf4ef4174d73db96adac8"},
 {template_version:'1061-site-b-v4',template_sha256:'d5bd2c30a039e734a123266ba059f7d1e1af4a2ab2e5cf7f36f1a7b7eb2624e9',manifest_sha256:'ab55cba372843f492cacf57ee7e51df64f1ce7cb55cba315aa2db95d917a0045'},
 {template_version:'1061-site-b-v4',template_sha256:'1d1163c08b056776794a63831b2ea6daf08dc0496337f154d0cd1e46a2593ee7',manifest_sha256:'9a513137e6f9e1331b3956b087d384648091b2f6a7c8f529962d04b52035667f'},
]);
const common=x=>typeof x.template_version==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(x.template_version)&&SHA.test(x.template_sha256||'')&&SHA.test(x.manifest_sha256||'');
const keys=(x,wanted)=>Object.keys(x).sort().join(',')===wanted.sort().join(',');
function read(file){
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>4096)throw Error('SITE_TEMPLATE_PIN_UNSAFE');
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
export function validateRemoteSiteTemplate(x){
 if(x?.format!=='chathand-site-template-pin'||x.version!==1||!common(x)||
    !keys(x,['format','manifest_sha256','template_sha256','template_url','template_version','version'])||typeof x.template_url!=='string')return false;
 try{const u=new URL(x.template_url);return u.protocol==='https:'&&['github.com','raw.githubusercontent.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.hash&&!u.search;}
 catch{return false;}
}
export function validateSiteTemplateCapabilities(x){return !!x&&typeof x==='object'&&!Array.isArray(x)&&keys(x,['binding_protocol','owner_rebind'])&&x.binding_protocol===3&&[1,2].includes(x.owner_rebind);}
export function validateLocalSiteTemplate(x){
 return x?.format==='chathand-site-template-local-pin'&&x.version===1&&x.source_kind==='bundled_local'&&common(x)&&
  x.template_file==='chathand-site-template-1060-local.zip'&&
  (x.capabilities===undefined||validateSiteTemplateCapabilities(x.capabilities))&&
  keys(x,['format','manifest_sha256','source_kind','template_file','template_sha256','template_version','version',...(x.capabilities===undefined?[]:['capabilities'])]);
}
export function readPinnedSiteTemplate(file=path.join(pkg,'connectors/site-template-pin.json')){
 try{
  const remote=read(file);if(!validateRemoteSiteTemplate(remote))return null;
  const trustedRemote=Object.freeze({...remote,source_kind:'remote',verified_source:true});
  const localFile=path.join(path.dirname(file),'../site-template/local-template-pin.json');
  // A present but invalid local source denies pairing; it cannot silently fall back to old bytes.
  try{fs.lstatSync(localFile);}catch(error){if(error.code==='ENOENT')return trustedRemote;throw error;}
  const local=read(localFile);if(!validateLocalSiteTemplate(local))return null;
  const history=PUBLISHED_LOCAL_HISTORY.filter(old=>old.manifest_sha256!==local.manifest_sha256).map(old=>Object.freeze({...old,source_kind:'bundled_historical',verified_source:true}));
  return Object.freeze({...local,verified_source:true,trusted_templates:Object.freeze([trustedRemote,...history])});
 }catch{return null;}
}
export function pinnedSiteCapabilities(pin){
 if(pin?.verified_source!==true)return null;
 if(validateSiteTemplateCapabilities(pin.capabilities))return pin.capabilities;
 return PUBLISHED_LOCAL_HISTORY.find(x=>x.template_version===pin.template_version&&x.template_sha256===pin.template_sha256&&x.manifest_sha256===pin.manifest_sha256)?.capabilities||null;
}
/** Exact signed catalogue match. No URL, claim or version alone can add trust. */
export function matchPinnedSiteTemplate(pin,metadata){
 if(pin?.verified_source!==true||!metadata)return null;
 for(const candidate of [pin,...(Array.isArray(pin.trusted_templates)?pin.trusted_templates:[])])
  if(candidate?.verified_source===true&&candidate.template_version===metadata.template_version&&candidate.manifest_sha256===metadata.manifest_sha256)return candidate;
 return null;
}
export function siteTemplateDescriptor(pin,pairingHash){
 if(pin?.verified_source!==true||pin.source_kind==='bundled_historical'||!SHA.test(pairingHash||''))return null;
 return {verified_source:true,source_kind:pin.source_kind||'remote',
  ...(pin.source_kind==='bundled_local'?{template_file:pin.template_file}:{template_url:pin.template_url}),
  template_sha256:pin.template_sha256,pairing_hash:pairingHash};
}
