// skills/chathand-setup is authoritative; plugin packaging is a byte-for-byte mirror.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function syncSetupSkill({repoRoot=root,check=false}={}){
 const source=path.join(repoRoot,'skills/chathand-setup'),dest=path.join(repoRoot,'plugins/chathand/skills/chathand-setup');
 function files(dir,prefix=''){
  const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('SETUP_MIRROR_UNSAFE');
  return fs.readdirSync(dir).sort().flatMap(name=>{
   const rel=path.join(prefix,name),file=path.join(dir,name),s=fs.lstatSync(file);
   if(s.isSymbolicLink())throw Error('SETUP_MIRROR_UNSAFE');
   if(s.isDirectory())return files(file,rel);
   if(!s.isFile()||s.nlink!==1)throw Error('SETUP_MIRROR_UNSAFE');
   return [rel];
  });
 }
 const originals=files(source),copies=files(dest),extra=copies.filter(f=>!originals.includes(f));
 // Never remove stale files silently; integration must resolve them explicitly.
 if(extra.length)throw Error('SETUP_MIRROR_EXTRA_FILES');
 const changed=originals.filter(f=>!copies.includes(f)||!fs.readFileSync(path.join(source,f)).equals(fs.readFileSync(path.join(dest,f))));
 if(check&&changed.length)throw Error('SETUP_MIRROR_DRIFT');
 if(!check)for(const f of changed){fs.mkdirSync(path.dirname(path.join(dest,f)),{recursive:true});fs.copyFileSync(path.join(source,f),path.join(dest,f));}
 return {checked:originals.length,updated:check?0:changed.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.slice(2).some(a=>a!=='--check'))throw Error('SETUP_MIRROR_USAGE');console.log(JSON.stringify(syncSetupSkill({check:process.argv.includes('--check')})));}
 catch(e){console.error(e.message);process.exitCode=1;}
}
