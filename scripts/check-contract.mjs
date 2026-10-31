import fs from 'node:fs';import {TOOLS} from '../app/tools.mjs';import {manifest,CONNECTOR_API} from '../app/product.mjs';
const frozen=JSON.parse(fs.readFileSync(new URL(`../contracts/tools-v${CONNECTOR_API}.json`,import.meta.url),'utf8'));
if([30,31].includes(CONNECTOR_API)){
 const lock=JSON.parse(fs.readFileSync(new URL(`../contracts/api${CONNECTOR_API}-freeze.json`,import.meta.url),'utf8'));
 if(lock.connector_api!==CONNECTOR_API||manifest(frozen).schema_sha256!==lock.schema_sha256)throw Error(`API${CONNECTOR_API}_FROZEN_CONTRACT_CHANGED_REQUIRES_NEW_API_VERSION`);
}
if(JSON.stringify(TOOLS)!==JSON.stringify(frozen)){console.error('CONNECTOR_CONTRACT_CHANGED');process.exitCode=1;}
else console.log(JSON.stringify({status:'CONNECTOR_CONTRACT_MATCH',...manifest(TOOLS)}));
