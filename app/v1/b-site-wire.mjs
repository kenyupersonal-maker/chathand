/** 1052 B Site wire v1. Site and device have distinct credentials from A.
 * Contract: fixed-order pairing string array, RFC 8785 canonical arguments,
 * standard Ed25519. No JSON text key order or model identity is trusted. */
import crypto from 'node:crypto';
import {canonicalize} from 'json-canonicalize';
import {fail} from '../../engine/src/core.mjs';

export const PAIR_DOMAIN='chathand-site-pair-v1';
export const PAIR_DOMAIN_V2='chathand-site-pair-v2';
export const JOB_DOMAIN='chathand-site-job-v1';
export const WIRE_VERSION='1';
export const PAIR_FIELDS=Object.freeze(['protocol_version','site_id','site_origin','owner_subject','installation_id','device_public_key_id','pairing_id','client_nonce','server_nonce','issued_at','expires_at']);
export const PAIR_FIELDS_V2=Object.freeze([...PAIR_FIELDS,'pairing_hash','template_version','manifest_sha256','site_public_key']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64=/^[A-Za-z0-9_-]+$/;
const PRIVATE_PREFIX=Buffer.from('302e020100300506032b657004220420','hex');
const PUBLIC_PREFIX=Buffer.from('302a300506032b6570032100','hex');
const bad=(code='B_WIRE_INVALID')=>fail(code,'B Site 声明格式或绑定不正确。');
export function decodeUrl64(value,length){
 if(typeof value!=='string'||!B64.test(value)||value.includes('=')||value.length>2048)bad();
 const bytes=Buffer.from(value,'base64url');
 if(length!==undefined&&bytes.length!==length||bytes.toString('base64url')!==value)bad();
 return bytes;
}
export const encodeUrl64=data=>Buffer.from(data).toString('base64url');
export function siteOrigin(origin){
 if(typeof origin!=='string'||origin.length>2048||!/^https:\/\//i.test(origin))bad('B_ORIGIN_INVALID');
 let url;try{url=new URL(origin);}catch{bad('B_ORIGIN_INVALID');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname||url.origin!==origin.replace(/\/$/,''))bad('B_ORIGIN_INVALID');
 return url.origin;
}
function safeTime(x){if(typeof x!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(x)||!Number.isSafeInteger(Number(x)))bad();return Number(x);}
export function pairingBytes(claim,{now=null,clockSkew=60}={}){
 if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).length!==PAIR_FIELDS.length||
     PAIR_FIELDS.some(k=>!Object.hasOwn(claim,k)||typeof claim[k]!=='string'))bad();
 if(Object.keys(claim).some(k=>!PAIR_FIELDS.includes(k)))bad();
 if(claim.protocol_version!==WIRE_VERSION||!/^[a-zA-Z0-9_-]{4,128}$/.test(claim.site_id)||!claim.owner_subject||claim.owner_subject.length>160||/[\r\n\0]/.test(claim.owner_subject)||!UUID.test(claim.installation_id)||!UUID.test(claim.pairing_id))bad();
 siteOrigin(claim.site_origin);decodeUrl64(claim.device_public_key_id,32);decodeUrl64(claim.client_nonce,32);decodeUrl64(claim.server_nonce,32);
 const issued=safeTime(claim.issued_at),expires=safeTime(claim.expires_at);
 if(expires<=issued||expires-issued>300)bad('B_CHALLENGE_TIME');
 if(now!==null&&(issued>now+clockSkew||expires<now-clockSkew))bad('B_CHALLENGE_EXPIRED');
 return Buffer.from(JSON.stringify([PAIR_DOMAIN,...PAIR_FIELDS.map(k=>claim[k])]),'utf8');
}
export function pairingBytesV2(claim,{now=null,clockSkew=60}={}){
 if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).length!==PAIR_FIELDS_V2.length||
     PAIR_FIELDS_V2.some(k=>!Object.hasOwn(claim,k)||typeof claim[k]!=='string')||
     Object.keys(claim).some(k=>!PAIR_FIELDS_V2.includes(k)))bad();
 if(claim.protocol_version!=='2'||!/^[a-zA-Z0-9_-]{4,128}$/.test(claim.site_id)||
    !claim.owner_subject||claim.owner_subject.length>160||/[\r\n\0]/.test(claim.owner_subject)||
    !UUID.test(claim.installation_id)||!UUID.test(claim.pairing_id)||
    !/^[a-f0-9]{64}$/.test(claim.pairing_hash)||!/^[a-f0-9]{64}$/.test(claim.manifest_sha256)||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(claim.template_version))bad();
 siteOrigin(claim.site_origin);
 for(const k of ['device_public_key_id','client_nonce','server_nonce','site_public_key'])decodeUrl64(claim[k],32);
 const issued=safeTime(claim.issued_at),expires=safeTime(claim.expires_at);
 if(expires<=issued||expires-issued>300)bad('B_CHALLENGE_TIME');
 if(now!==null&&(issued>now+clockSkew||expires<now-clockSkew))bad('B_CHALLENGE_EXPIRED');
 return Buffer.from(JSON.stringify([PAIR_DOMAIN_V2,...PAIR_FIELDS_V2.map(k=>claim[k])]),'utf8');
}
export const PAIR_FIELDS_V3=Object.freeze([...PAIR_FIELDS_V2,'device_name','binding_mode','expected_bindings']);
export function pairingBytesV3(claim,options={}){
 if(!claim||Object.keys(claim).length!==PAIR_FIELDS_V3.length||PAIR_FIELDS_V3.some(k=>typeof claim[k]!=='string')||claim.protocol_version!=='3'||
  claim.device_name.length>80||/[\p{Cc}\p{Cf}]/u.test(claim.device_name)||!['initial','continuity','owner_replace'].includes(claim.binding_mode))bad();
 const v2=Object.fromEntries(PAIR_FIELDS_V2.map(k=>[k,claim[k]]));v2.protocol_version='2';pairingBytesV2(v2,options);
 let expected;try{expected=JSON.parse(claim.expected_bindings);}catch{bad();}
 if(!Array.isArray(expected)||expected.length>16||expected.some(x=>!x||Object.keys(x).sort().join(',')!=='binding_id,generation'||!UUID.test(x.binding_id)||!Number.isSafeInteger(x.generation)||x.generation<1)||new Set(expected.map(x=>x.binding_id)).size!==expected.length)bad();
 return Buffer.from(JSON.stringify(['chathand-site-pair-v3',...PAIR_FIELDS_V3.map(k=>claim[k])]));
}
export function bindingReplacedBytes(value){
 const fields=['kind','site_id','owner_subject','installation_id','binding_id','generation','nonce','device_name','at'];
 if(!value||Object.keys(value).sort().join(',')!==fields.sort().join(',')||value.kind!=='chathand-site-binding-replaced-v1'||
  !UUID.test(value.binding_id)||!UUID.test(value.installation_id)||!Number.isSafeInteger(value.generation)||value.generation<1||
  !Number.isSafeInteger(value.at)||value.at<=0||typeof value.site_id!=='string'||typeof value.owner_subject!=='string'||
  !(value.device_name===null||typeof value.device_name==='string'&&value.device_name.length<=80&&!/[\p{Cc}\p{Cf}]/u.test(value.device_name)))bad('B_REPLACEMENT_INVALID');
 decodeUrl64(value.nonce,32);
 // Preserve fixed key order independently of JSON parser insertion order.
 const notice=Object.fromEntries(['kind','site_id','owner_subject','installation_id','binding_id','generation','nonce','device_name','at'].map(k=>[k,value[k]]));
 return Buffer.from(JSON.stringify(['chathand-site-binding-replaced-v1',notice]));
}
export function precreateHash(installationId,intentId,secret){
 if(!UUID.test(installationId)||!UUID.test(intentId))bad('B_INTENT_INVALID');
 decodeUrl64(secret,32);
 return sha256(Buffer.from(JSON.stringify(['chathand-site-precreate-v1',installationId,intentId,secret])));
}
export function completeProofBytes(claimDigest,installationId,intentId,secret){
 if(!/^[a-f0-9]{64}$/.test(claimDigest)||!UUID.test(installationId)||!UUID.test(intentId))bad('B_PAIRING_PROOF_INVALID');
 decodeUrl64(secret,32);
 return Buffer.from(JSON.stringify(['chathand-site-complete-v2',claimDigest,installationId,intentId,secret]));
}
export function receiptBytesV2({claim_digest,binding_id,generation,receipt_digest,owner_subject,site_id,installation_id,device_credential}){
 if(!/^[a-f0-9]{64}$/.test(claim_digest)||!UUID.test(binding_id)||!Number.isSafeInteger(generation)||generation<1||
    !/^[a-f0-9]{64}$/.test(receipt_digest)||typeof owner_subject!=='string'||!owner_subject||
    !/^[a-zA-Z0-9_-]{4,128}$/.test(site_id)||!UUID.test(installation_id))bad('B_RECEIPT_INVALID');
 decodeUrl64(device_credential,32);
 return Buffer.from(JSON.stringify(['chathand-site-pair-receipt-v2',claim_digest,binding_id,String(generation),receipt_digest,
  owner_subject,site_id,installation_id,device_credential]));
}
export function healthAckBytes(saved,response,{nonce,installationId,templatePin=null,allowTemplatePromotion=false}={}){
 if(!saved||!response||response.site_id!==saved.site_id||response.binding_id!==saved.binding_id||
    response.generation!==saved.generation||response.installation_id!==installationId||response.nonce!==nonce||
    typeof response.signature!=='string')bad('B_HEALTH_UNVERIFIED');
 const v2=saved.trust==='tofu-template-v1';
 if(v2){
  if(!templatePin?.verified_source||!allowTemplatePromotion&&
     (saved.template_version!==templatePin.template_version||saved.manifest_sha256!==templatePin.manifest_sha256)||
     response.protocol_version!=='2'||
     response.template_version!==templatePin.template_version||response.manifest_sha256!==templatePin.manifest_sha256)
   bad('B_TEMPLATE_MISMATCH');
  return Buffer.from(JSON.stringify(['chathand-site-health-ack-v2',saved.site_id,saved.binding_id,
   String(saved.generation),installationId,nonce,response.template_version,response.manifest_sha256]));
 }
 return Buffer.from(JSON.stringify(['chathand-site-health-ack-v1',saved.site_id,saved.binding_id,
  String(saved.generation),installationId,nonce]));
}
export function verifyHealthAck(saved,response,options){
 const signed=healthAckBytes(saved,response,options);
 if(!edVerify(decodeUrl64(saved.site_public_key,32),signed,response.signature))bad('B_HEALTH_SIGNATURE');
 return true;
}
export const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');
export function pairingDigest(claim,options){return sha256(pairingBytes(claim,options));}
export function keyId(publicRaw){return encodeUrl64(crypto.createHash('sha256').update(publicRaw).digest());}
export function rawPublicFromKey(key){
 // createPublicKey(public KeyObject) throws in Node; an existing public key is already usable.
 const publicKey=key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key);
 const der=publicKey.export({format:'der',type:'spki'});
 if(der.length!==PUBLIC_PREFIX.length+32||!der.subarray(0,PUBLIC_PREFIX.length).equals(PUBLIC_PREFIX))bad('B_PUBLIC_KEY_INVALID');
 return der.subarray(PUBLIC_PREFIX.length);
}
export const publicKeyFromRaw=raw=>{if(!Buffer.isBuffer(raw)||raw.length!==32)bad('B_PUBLIC_KEY_INVALID');return crypto.createPublicKey({key:Buffer.concat([PUBLIC_PREFIX,raw]),format:'der',type:'spki'});};
export function privateKeyFromSeed(seed){
 if(!Buffer.isBuffer(seed)||seed.length!==32)bad('B_PRIVATE_KEY_INVALID');
 return crypto.createPrivateKey({key:Buffer.concat([PRIVATE_PREFIX,seed]),format:'der',type:'pkcs8'});
}
export function edSign(privateKey,bytes){return encodeUrl64(crypto.sign(null,Buffer.from(bytes),privateKey));}
export function edVerify(publicRaw,bytes,signature){
 try{return crypto.verify(null,Buffer.from(bytes),publicKeyFromRaw(publicRaw),decodeUrl64(signature,64));}catch{return false;}
}
export async function webEdVerify(publicRaw,bytes,signature,subtle=crypto.webcrypto.subtle){
 const pub=await subtle.importKey('raw',new Uint8Array(publicRaw),{name:'Ed25519'},false,['verify']);
 return subtle.verify({name:'Ed25519'},pub,new Uint8Array(decodeUrl64(signature,64)),new Uint8Array(bytes));
}
export async function webEdSign(privatePkcs8,bytes,subtle=crypto.webcrypto.subtle){
 const pk=await subtle.importKey('pkcs8',new Uint8Array(privatePkcs8),{name:'Ed25519'},false,['sign']);
 return encodeUrl64(await subtle.sign({name:'Ed25519'},pk,new Uint8Array(bytes)));
}
export function canonicalArguments(value){
 if(value===null||typeof value!=='object'||Array.isArray(value))bad('B_ARGS_INVALID');
 const text=canonicalize(value);if(typeof text!=='string'||Buffer.byteLength(text)>65536||text.length<2)bad('B_ARGS_INVALID');
 return Buffer.from(text,'utf8');
}
export function strictCanonicalArguments(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>65536)bad('B_ARGS_INVALID');
 let parsed;try{parsed=JSON.parse(text);}catch{bad('B_ARGS_INVALID');}
 const bytes=canonicalArguments(parsed);
 if(bytes.toString('utf8')!==text)bad('B_ARGS_NOT_CANONICAL'); // also catches repeated JSON object keys
 return {value:parsed,bytes,digest:sha256(bytes)};
}
export function jobDigest(args){return sha256(canonicalArguments(args));}
export function verifiedSiteJob(item,{trustedSitePublic,siteId,installationId,ownerSubject,bindingId,generation,now=Date.now()}={}){
 if(!item||typeof item!=='object'||Object.keys(item).some(k=>!['version','site_id','binding_id','credential_generation','installation_id','owner_subject','op_id','tool_name','arguments','request_digest','created_at','start_before','attempt_id','site_signature'].includes(k))||item.version!==WIRE_VERSION)
   bad('B_JOB_INVALID');
 if(item.site_id!==siteId||item.installation_id!==installationId||item.owner_subject!==ownerSubject||item.binding_id!==bindingId||item.credential_generation!==generation)
   bad('B_JOB_BINDING');
 if(!UUID.test(item.op_id)||typeof item.tool_name!=='string'||!/^[a-z][a-z0-9_]{1,80}$/.test(item.tool_name)||!UUID.test(item.attempt_id)||typeof item.request_digest!=='string'||!/^[a-f0-9]{64}$/.test(item.request_digest))bad('B_JOB_INVALID');
 if(!Number.isSafeInteger(item.created_at)||!Number.isSafeInteger(item.start_before)||item.start_before<item.created_at)bad('B_JOB_EXPIRED');
 const argumentsText=typeof item.arguments==='string'?item.arguments:bad('B_ARGS_NOT_CANONICAL'),decoded=strictCanonicalArguments(argumentsText);
 if(decoded.digest!==item.request_digest)bad('B_JOB_DIGEST');
 const binding=[JOB_DOMAIN,item.version,item.site_id,item.binding_id,String(generation),item.installation_id,item.owner_subject,item.op_id,item.tool_name,item.request_digest,String(item.created_at),String(item.start_before),item.attempt_id];
 const bytes=Buffer.from(JSON.stringify(binding),'utf8');
 if(!edVerify(trustedSitePublic,bytes,item.site_signature))bad('B_JOB_SIGNATURE');
 return {op_id:item.op_id,route:'site',principal:'site:'+ownerSubject,binding_id:bindingId,generation,tool_name:item.tool_name,request_digest:item.request_digest,args:decoded.value,start_before:item.start_before,created_at:item.created_at,attempt_id:item.attempt_id};
}
