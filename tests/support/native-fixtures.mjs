import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function nativeFixture(name){
 const file=process.env.CHATHAND_NODE_FIXTURES,hash=process.env.CHATHAND_NODE_FIXTURES_SHA256;
 if(!file||!/^[a-f0-9]{64}$/.test(hash||''))throw Error('NODE_FIXTURE_PREFLIGHT_REQUIRED: run scripts/prepare-node-fixtures.mjs before the Node runner');
 if(!fs.lstatSync(file).isFile()||digest(file)!==hash)throw Error('NODE_FIXTURE_MANIFEST_DRIFT');
 const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 if(manifest.schema_version!==1||manifest.purpose!=='explicit-node-fixtures'||manifest.platform!==process.platform||manifest.arch!==process.arch)throw Error('NODE_FIXTURE_PLATFORM_MISMATCH');
 const entry=manifest.binaries?.[name];
 if(!entry||!path.isAbsolute(entry.path)||!fs.lstatSync(entry.path).isFile()||digest(entry.path)!==entry.sha256)throw Error('NODE_FIXTURE_BINARY_MISSING_OR_DRIFTED: '+name);
 for(const dependency of entry.dependencies||[])nativeFixture(dependency);
 for(const source of entry.sources){
  if(!Object.hasOwn(manifest.sources,source)||source.startsWith('/')||source.split('/').includes('..')||digest(path.join(root,source))!==manifest.sources[source])throw Error('NODE_FIXTURE_SOURCE_DRIFT: '+source);
 }
 return entry.path;
}
