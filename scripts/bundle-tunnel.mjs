import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
export const TUNNEL_VERSION='0.0.15';
export const TUNNEL_ARCHIVE='tunnel-client-v0.0.15-darwin-arm64.zip';
export const TUNNEL_SHA256='b2cae3aa9df45b4c2fe9b1d700ebacce39f9feb6a6b46b86e6499f9a51bf72ff';
const binaryHashes={'tunnel-client':'f534872593a60b12560b6c74cbbf94adf6f7e1d9fdd67a3f59b8268ff8a8249c','cloudflared':'4cf6ca3f4dde4266cd5a61c55f3fe4d8e752914e9d6187a10bd0daf80d0440a1'};
export function verifyArchive(bytes){if(crypto.createHash('sha256').update(bytes).digest('hex')!==TUNNEL_SHA256)throw Error('TUNNEL_CHECKSUM_MISMATCH');}
export async function bundleTunnel(runtime,{cache=process.env.CHATHAND_VENDOR_CACHE||path.join(os.homedir(),'Library/Caches/ChatHand-build')}={}){
 fs.mkdirSync(cache,{recursive:true});const zip=path.join(cache,TUNNEL_ARCHIVE);
 if(!fs.existsSync(zip)){const response=await fetch(`https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}/${TUNNEL_ARCHIVE}`,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('TUNNEL_DOWNLOAD_FAILED');const bytes=Buffer.from(await response.arrayBuffer());verifyArchive(bytes);fs.writeFileSync(zip,bytes,{flag:'wx'});}
 verifyArchive(fs.readFileSync(zip));
 const files=['tunnel-client','cloudflared','cloudflared-manifest.json','LICENSE','NOTICE',`tunnel-client-v${TUNNEL_VERSION}-darwin-arm64-licenses.txt`];
 for(const name of files){const result=spawnSync('/usr/bin/unzip',['-p',zip,name],{maxBuffer:100*1024*1024,timeout:30000});if(result.status!==0)throw Error('TUNNEL_EXTRACT_FAILED');const bytes=result.stdout;if(binaryHashes[name]&&crypto.createHash('sha256').update(bytes).digest('hex')!==binaryHashes[name])throw Error('TUNNEL_BINARY_CHECKSUM_MISMATCH');const dir=path.join(runtime,binaryHashes[name]?'bin':'licenses/tunnel-client');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name),bytes,{mode:binaryHashes[name]?0o755:0o644});}
 return {version:TUNNEL_VERSION,archive_sha256:TUNNEL_SHA256,binaries:binaryHashes};
}
