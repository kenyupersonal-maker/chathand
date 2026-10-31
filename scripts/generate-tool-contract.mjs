// Source-only API31 generator. Root runs this once after every descriptor hook
// and package.connector_api have been integrated; importing it never writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {TOOLS} from '../app/tools.mjs';
import {CONNECTOR_API,modelTools} from '../app/product.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function toolContractFiles(tools,api){
 if(api!==31)throw Error('API31_PACKAGE_NOT_READY');
 if(!Array.isArray(tools)||new Set(tools.map(t=>t.name)).size!==tools.length)throw Error('TOOL_REGISTRY_INVALID');
 const schema_sha256=crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex');
 return {'contracts/tools-v31.json':JSON.stringify(tools,null,2)+'\n','contracts/api31-freeze.json':JSON.stringify({connector_api:api,schema_sha256,shell_protocol:1},null,2)+'\n'};
}
export function writeToolContract(directory,outputs,{check=false}={}){
 // Validate ALL existing files before writing either. Never replace a prior
 // frozen contract to manufacture a match; Root must review any mismatch.
 for(const [rel,text] of Object.entries(outputs)){
  const file=path.join(directory,rel);
  if(fs.existsSync(file)){
   const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||fs.readFileSync(file,'utf8')!==text)throw Error('FROZEN_CONTRACT_DIFFERS: '+rel);
  }else if(check)throw Error('CONTRACT_NOT_GENERATED: '+rel);
 }
 if(!check)for(const [rel,text] of Object.entries(outputs)){const file=path.join(directory,rel);if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{flag:'wx'});}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const mode=process.argv[2];if(!['--freeze','--check'].includes(mode)||process.argv.length!==3)throw Error('USE_--freeze_OR_--check');
  writeToolContract(root,toolContractFiles(TOOLS,CONNECTOR_API),{check:mode==='--check'});
  console.log(JSON.stringify({connector_api:CONNECTOR_API,tool_count:TOOLS.length,model_tool_count:modelTools(TOOLS).length,private_tool_count:TOOLS.length-modelTools(TOOLS).length,schema_sha256:crypto.createHash('sha256').update(JSON.stringify(TOOLS)).digest('hex')}));
 }catch(e){console.error(e.message);process.exitCode=1;}
}
