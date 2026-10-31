import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {fail} from '../engine/src/core.mjs';

// Internal transport to the existing packaged helper; paths travel only on stdin.
// Tests can select a freshly compiled helper without installing an application.
function invoke(request){
 if(process.platform!=='darwin')fail('FILE_METADATA_UNSUPPORTED','此平台尚未实现 ACL、扩展属性和时间戳的完整复制；源路径保留。');
 const root=fileURLToPath(new URL('../',import.meta.url));
 const current=path.join(root,'bin/ChatHandArtifactIO');
 const executable=process.env.CHATHAND_FILE_METADATA_HELPER||(fs.existsSync(current)?current:path.join(root,'bin/ken-artifact-io'));
 const result=spawnSync(executable,[],{input:JSON.stringify({version:1,action:'path-metadata',...request}),encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['pipe','pipe','ignore']});
 if(result.error)fail('FILE_METADATA_HELPER_UNAVAILABLE','元数据复制组件不可用或超时；源路径保留，未确认完整复制。');
 let reply;try{reply=JSON.parse(result.stdout);}catch{fail('FILE_METADATA_UNPRESERVED','元数据组件未返回完整校验结果；源路径保留。');}
 if(result.status!==0||reply.error||!/^[a-f0-9]{64}$/.test(reply.fingerprint||'')){
  if(reply.error?.code==='FILE_METADATA_RESOURCE_FORK_LIMIT')fail('FILE_METADATA_RESOURCE_FORK_LIMIT','资源叉超过 Darwin 分段读取的 4 GiB 范围，尚不能完整核对；源路径保留。');
  if(reply.error?.code==='FILE_METADATA_XATTR_LIMIT')fail('FILE_METADATA_XATTR_LIMIT','单个非资源叉扩展属性超过 64 MiB 核对上限；源路径保留。');
  fail('FILE_METADATA_UNPRESERVED','无法完整复制或核对资源叉、扩展属性、ACL、权限位或时间戳（也可能源路径已变化）；源路径保留。');
 }
 return reply.fingerprint;
}
function identity(p){const s=fs.lstatSync(p,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};}
export function captureMetadata(source,expected){return invoke({operation:'capture',source,identity:expected||identity(source)});}
export function copyMetadata(source,destination,fingerprint,atime_ns,sourceIdentity,destinationIdentity){invoke({operation:'copy',source,identity:sourceIdentity||identity(source),destination,destination_identity:destinationIdentity,fingerprint,atime_ns});}
export function verifyMetadata(source,fingerprint,atime_ns,expected){invoke({operation:'verify',source,identity:expected||identity(source),fingerprint,...(atime_ns===undefined?{}:{atime_ns})});}
