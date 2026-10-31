import fs from 'node:fs';
import path from 'node:path';
const invalid=()=>{throw Object.assign(Error('REHEARSAL_UPGRADE_PATH_INVALID'),{code:'REHEARSAL_UPGRADE_PATH_INVALID'});};
const within=(a,b)=>b.startsWith(a+path.sep);
function canonicalDirectory(raw,{privateMode=false}={}){
 if(typeof raw!=='string'||!path.isAbsolute(raw)||raw!==path.normalize(raw)||raw.includes('\0')||raw.split(path.sep).includes('Applications'))invalid();
 const st=fs.lstatSync(raw);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(raw)!==raw||process.getuid&&st.uid!==process.getuid()||privateMode&&(st.mode&0o077)!==0)invalid();
 return raw;
}
/** Only a fully bound native rehearsal can select the real CLI's private HOME upgrades. */
export function rehearsalUpgradeHome({env=process.env,stateDir,appPath}={}){
 if(!env.CHATHAND_REHEARSAL_ROOT&&!env.CHATHAND_REHEARSAL_HOME)return null;
 try{
  const raw=env.CHATHAND_REHEARSAL_ROOT;if(typeof raw!=='string'||!within(fs.realpathSync('/tmp'),raw)||!/^chathand-1060-rehearsal-[A-Za-z0-9_-]+$/.test(path.basename(raw)))invalid();
  const root=canonicalDirectory(raw,{privateMode:true});
  const marker=path.join(root,'.rehearsal-root.json'),st=fs.lstatSync(marker);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096||(st.mode&0o077)!==0||process.getuid&&st.uid!==process.getuid())invalid();
  const value=JSON.parse(fs.readFileSync(marker,'utf8'));if(value.format!==1||value.purpose!=='1060 isolated rehearsal')invalid();
  if(![env.CHATHAND_REHEARSAL_HOME,stateDir,appPath].every(p=>typeof p==='string'&&within(root,p)))invalid();
  const home=canonicalDirectory(env.CHATHAND_REHEARSAL_HOME,{privateMode:true});
  const state=canonicalDirectory(stateDir,{privateMode:true}),app=canonicalDirectory(appPath);
  if(env.HOME!==home||env.CFFIXED_USER_HOME!==home||env.CHATHAND_STATE_DIR!==state||![home,state,app].every(p=>within(root,p)))invalid();
  const paths=[home,state,app];for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(paths[i]===paths[j]||within(paths[i],paths[j])||within(paths[j],paths[i]))invalid();
  const upgrades=path.join(home,'Library','Application Support','ChatHand','upgrades');
  let current=home;for(const part of path.relative(home,upgrades).split(path.sep)){current=path.join(current,part);try{canonicalDirectory(current,{privateMode:true});}catch(e){if(e.code==='ENOENT')break;throw e;}}
  return upgrades;
 }catch{invalid();}
}
