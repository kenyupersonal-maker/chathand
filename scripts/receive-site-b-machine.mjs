/** ONE1052: separate Site machine bearer consumer.
 * Source implementation only. Invoked later by root through a hidden stdin
 * stream. Never CLI argv/env/file/log.
 * This is not an authorization to create or retrieve a real SIWC token.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CredentialStore} from '../app/credentials.mjs';
import {bundledSiteTarget} from '../app/v1/b-site-trust.mjs';
import {siteOrigin} from '../app/v1/b-site-wire.mjs';

export function validatedMachineValue(value,{resolveDeployment=bundledSiteTarget}={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!=='bearer,site_id,site_origin')throw Error('B_MACHINE_INPUT_INVALID');
 if(typeof value.bearer!=='string'||value.bearer.length<32||value.bearer.length>4096||
  /[\s\r\n\0]/.test(value.bearer))throw Error('B_MACHINE_INPUT_INVALID');
 const target=resolveDeployment(value.site_id);
 if(!target||target.verified!==true||target.site_id!==value.site_id||
  target.site_origin!==siteOrigin(value.site_origin))throw Error('B_SITE_TARGET_UNVERIFIED');
 return {site_id:target.site_id,site_origin:target.site_origin,bearer:value.bearer};
}
export function consumeMachineValue(value,{credentials,resolveDeployment}={}){
 if(!credentials||typeof credentials.set!=='function')throw Error('B_MACHINE_STORE_UNAVAILABLE');
 const v=validatedMachineValue(value,{resolveDeployment});
 // Never write machine bearer into the A tunnel/relay or pairing device section.
 credentials.set('site_b_machine',{site_id:v.site_id,site_origin:v.site_origin,bearer:v.bearer,format:1});
 return Object.freeze({saved:true,site_id:v.site_id,origin_verified:true,secret_visible:false});
}
export async function consumeHiddenStdin({input=process.stdin,maxBytes=8192}={}){
 if(input.isTTY)throw Error('B_HIDDEN_INPUT_REQUIRED');
 const chunks=[];let total=0;
 for await(const part of input){total+=Buffer.byteLength(part);if(total>maxBytes)throw Error('B_MACHINE_INPUT_TOO_LARGE');chunks.push(Buffer.from(part));}
 const raw=Buffer.concat(chunks).toString('utf8').trim();
 let value;try{value=JSON.parse(raw);}catch{throw Error('B_MACHINE_INPUT_INVALID');}
 return value;
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--state-dir')throw Error('B_MACHINE_CLI_ARGS');
 const stateDir=args[1];
 if(!path.isAbsolute(stateDir))throw Error('B_MACHINE_CLI_ARGS');
 // Input is received only through hidden stdin and stored by the local encrypted-file backend.
 const value=await consumeHiddenStdin();
 const credentials=new CredentialStore(stateDir);
 return consumeMachineValue(value,{credentials});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{
  const allow=new Set(['B_MACHINE_CLI_ARGS','B_MACHINE_INPUT_INVALID','B_MACHINE_INPUT_TOO_LARGE',
   'B_HIDDEN_INPUT_REQUIRED','B_SITE_TARGET_UNVERIFIED',
   'B_MACHINE_STORE_UNAVAILABLE']);
  process.stderr.write((allow.has(error?.message)?error.message:'B_MACHINE_CONSUMER_FAILED')+'\n');
  process.exitCode=1;
 });
}
