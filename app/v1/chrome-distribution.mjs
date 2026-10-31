import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail} from '../../engine/src/core.mjs';
const developmentID='fdkpegpobipiidkdcjldomfbkemjdpfd';
const pending=reason=>Object.freeze({distribution:'chrome_web_store',configuration_state:'pending',configuration_reason:reason,extension_id:null,store_url:null,store_published:false});
/** Missing configuration never falls back to the old development extension. */
export function chromeDistribution(config,manifest){
 if(config?.distribution!=='chrome_web_store')return pending('DISTRIBUTION_NOT_CONFIGURED');
 const id=config.extension_id,key=config.public_key??manifest?.key;
 if(typeof id!=='string'||id.length!==32||!/^[a-p]{32}$/.test(id)||id===developmentID)return pending('STORE_ID_REQUIRED');
 if(typeof key!=='string'||key.length>8192||!key.length||!(/^[A-Za-z0-9+/]+={0,2}$/).test(key))return pending('STORE_KEY_REQUIRED');
 try{
  const der=Buffer.from(key,'base64'),pub=crypto.createPublicKey({key:der,format:'der',type:'spki'});
  if(pub.asymmetricKeyType!=='rsa'||der.toString('base64')!==key)return pending('STORE_KEY_INVALID');
  const derived=[...crypto.createHash('sha256').update(der).digest().subarray(0,16)].map(v=>String.fromCharCode(97+(v>>4),97+(v&15))).join('');
  if(derived!==id)return pending('STORE_ID_KEY_MISMATCH');
 }catch{return pending('STORE_KEY_INVALID');}
 try{
  const u=new URL(config.store_url);
  if(u.protocol!=='https:'||u.hostname!=='chromewebstore.google.com'||u.port||u.username||u.password||u.search||u.hash||u.href!==config.store_url||u.pathname!=='/detail/'+id)return pending('STORE_URL_INVALID');
  return Object.freeze({distribution:'chrome_web_store',configuration_state:'ready',configuration_reason:null,extension_id:id,store_url:u.href,store_published:config.published===true});
 }catch{return pending('STORE_URL_REQUIRED');}
}
export function readChromeDistribution(root){
 try{return chromeDistribution(JSON.parse(fs.readFileSync(path.join(root,'connectors/browser-extension.json'),'utf8')),JSON.parse(fs.readFileSync(path.join(root,'browser-extension/manifest.json'),'utf8')));}catch{return pending('STORE_CONFIG_UNREADABLE');}
}
/** Explicit test-only selection keeps legacy pure functions testable; production does not select it. */
export function legacyChromeDistribution(){return Object.freeze({distribution:'legacy_unpacked',configuration_state:'legacy'});}
export const storeMode=d=>d?.distribution!=='legacy_unpacked';
export function requireStoreConfiguration(d){if(d?.configuration_state!=='ready')fail('CHROME_STORE_CONFIGURATION_PENDING','Chrome Web Store configuration is not ready.');return d;}
export function requireLegacyInstaller(d){if(storeMode(d))fail('CHROME_INSTALL_LEGACY_DISABLED','The legacy Chrome installer is disabled.');}
