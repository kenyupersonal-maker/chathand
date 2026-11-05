import fs from 'node:fs';
import path from 'node:path';
import {inspectWorkspace} from './workspace-recovery.mjs';

// No inherited user environment, arguments, logs, or credentials are needed.
process.once('message',({root,stateDir,create=false})=>{
  let result;try{
  if(create&&typeof root==='string'&&path.isAbsolute(root)&&!root.includes('\0')){
   try{fs.mkdirSync(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST'&&!/^E[A-Z]+$/.test(error.code||''))throw error;}
  }
  result=inspectWorkspace(root,stateDir);
  }catch{result={path:root,available:false,writable:false,status:'inaccessible',code:'WORKSPACE_PROBE_FAILED'};}
  process.send?.(result,()=>process.exit(0));
});
