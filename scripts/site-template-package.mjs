/** Verify separate immutable remote and signed local template inputs before an App build. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validateRemoteSiteTemplate,validateLocalSiteTemplate,validateSiteTemplateCapabilities} from '../app/v1/site-template-pin.mjs';
function regular(file,max){
 const st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>max)
  throw Error('SITE_TEMPLATE_SOURCE_UNSAFE');
 return fs.readFileSync(file);
}
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
/** The approved producer uses bounded, uncompressed ZIP entries with no data descriptors. */
function verifyManifest(zip,pin){
 const files=new Map();let offset=0;
 while(offset+4<=zip.length&&zip.readUInt32LE(offset)===0x04034b50){
  if(offset+30>zip.length||zip.readUInt16LE(offset+6)!==0x0800||zip.readUInt16LE(offset+8)!==0)throw Error('SITE_TEMPLATE_ZIP_FORMAT_INVALID');
  const size=zip.readUInt32LE(offset+18),plain=zip.readUInt32LE(offset+22),length=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28),start=offset+30+length+extra,end=start+size;
  if(size!==plain||end>zip.length||length<1)throw Error('SITE_TEMPLATE_ZIP_FORMAT_INVALID');
  const name=zip.subarray(offset+30,offset+30+length).toString('utf8');
  if(files.has(name)||name.startsWith('/')||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('SITE_TEMPLATE_ZIP_FORMAT_INVALID');
  files.set(name,zip.subarray(start,end));offset=end;
 }
 if(offset+4>zip.length||zip.readUInt32LE(offset)!==0x02014b50)throw Error('SITE_TEMPLATE_ZIP_FORMAT_INVALID');
 const bytes=files.get('template-manifest.json');
 if(!bytes||digest(bytes)!==pin.manifest_sha256)throw Error('SITE_TEMPLATE_MANIFEST_SHA_MISMATCH');
 let manifest;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{throw Error('SITE_TEMPLATE_MANIFEST_INVALID');}
 if(manifest.format!=='chathand-site-template'||manifest.template_version!==pin.template_version||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files)||
    Object.keys(manifest.files).length!==files.size-1)throw Error('SITE_TEMPLATE_MANIFEST_INVALID');
 if(pin.capabilities!==undefined&&(!validateSiteTemplateCapabilities(manifest.capabilities)||JSON.stringify(manifest.capabilities)!==JSON.stringify(pin.capabilities)))throw Error('SITE_TEMPLATE_CAPABILITIES_INVALID');
 for(const [name,hash] of Object.entries(manifest.files))
  if(name==='template-manifest.json'||!files.has(name)||digest(files.get(name))!==hash)throw Error('SITE_TEMPLATE_MEMBER_SHA_MISMATCH');
}
function checkArchive(zipFile,pin){
 let zip;try{zip=regular(zipFile,50*1024*1024);}catch{throw Error('SITE_TEMPLATE_ZIP_MISSING_OR_UNSAFE');}
 if(digest(zip)!==pin.template_sha256)throw Error('SITE_TEMPLATE_ZIP_SHA_MISMATCH');
 verifyManifest(zip,pin);
}
export function preflightSiteTemplate(root){
 const pinFile=path.join(root,'connectors/site-template-pin.json');
 const zipFile=path.join(root,'site-template/chathand-site-template.zip');
 let pin;try{pin=JSON.parse(regular(pinFile,4096).toString('utf8'));}
 catch{throw Error('SITE_TEMPLATE_PIN_MISSING_OR_UNSAFE');}
 if(!validateRemoteSiteTemplate(pin))throw Error('SITE_TEMPLATE_PIN_INVALID');
 checkArchive(zipFile,pin);
 const localPinFile=path.join(root,'site-template/local-template-pin.json');
 let local=null;
 let localPresent=false;try{fs.lstatSync(localPinFile);localPresent=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(localPresent){
  let localPin;try{localPin=JSON.parse(regular(localPinFile,4096).toString('utf8'));}
  catch{throw Error('SITE_TEMPLATE_LOCAL_PIN_MISSING_OR_UNSAFE');}
  if(!validateLocalSiteTemplate(localPin))throw Error('SITE_TEMPLATE_LOCAL_PIN_INVALID');
  const localZipFile=path.join(root,'site-template',localPin.template_file);
  checkArchive(localZipFile,localPin);
  local=Object.freeze({pinFile:localPinFile,zipFile:localZipFile,sha256:localPin.template_sha256,pinSha256:digest(regular(localPinFile,4096))});
 }
 return Object.freeze({pinFile,zipFile,sha256:pin.template_sha256,local});
}
export function copySiteTemplate(preflight,runtime){
 const folder=path.join(runtime,'site-template'),destination=path.join(folder,'chathand-site-template.zip');
 fs.mkdirSync(folder,{recursive:true});
 const copy=(source,target,sha256)=>{fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  if(digest(regular(target,50*1024*1024))!==sha256)throw Error('SITE_TEMPLATE_BUNDLE_SHA_MISMATCH');};
 copy(preflight.zipFile,destination,preflight.sha256);
 if(preflight.local){
  copy(preflight.local.zipFile,path.join(folder,path.basename(preflight.local.zipFile)),preflight.local.sha256);
  if(digest(regular(preflight.local.pinFile,4096))!==preflight.local.pinSha256)throw Error('SITE_TEMPLATE_BUNDLE_PIN_MISMATCH');
  fs.copyFileSync(preflight.local.pinFile,path.join(folder,'local-template-pin.json'),fs.constants.COPYFILE_EXCL);
  if(digest(regular(path.join(folder,'local-template-pin.json'),4096))!==preflight.local.pinSha256)throw Error('SITE_TEMPLATE_BUNDLE_PIN_MISMATCH');
 }
 return destination;
}
