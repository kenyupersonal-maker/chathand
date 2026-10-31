import {readChromeDistribution,storeMode} from '../v1/chrome-distribution.mjs';
import {chromeAccessOperation} from '../v1/chrome-data-access.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {fail} from '../../engine/src/core.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function findTunnelBinary(state){const candidates=[path.join(ROOT,'bin','tunnel-client'),state.data.tunnel?.binary,path.join(os.homedir(),'.local/bin/tunnel-client'),'/opt/homebrew/bin/tunnel-client','/usr/local/bin/tunnel-client'];return candidates.filter(Boolean).find(p=>fs.existsSync(p))||null;}
export function validateSetup({tunnel_id,runtime_key},state){if(typeof tunnel_id!=='string'||!/^tunnel_[a-zA-Z0-9_-]{8,100}$/.test(tunnel_id.trim()))fail('TUNNEL_ID_INVALID','请粘贴通道 ID，不是网页地址。');if(typeof runtime_key!=='string'||runtime_key.trim().length<16||runtime_key.length>8192||/[\r\n\0]/.test(runtime_key))fail('KEY_INVALID','运行密钥格式不正确。');const binary=findTunnelBinary(state);if(!binary)fail('TUNNEL_RUNTIME_MISSING','连接组件尚未安装。请使用完整发行包或让配置 Skill 按官方来源安装，无需填写程序路径。');return {tunnel_id:tunnel_id.trim(),api_key:runtime_key.trim(),binary};}
export function browserHostBinary({root=ROOT,platform=process.platform}={}){
 const legacy=path.join(root,'bin','ken-browser-host');
 const current=path.join(root,'bin/ChatHandBrowserHost');
 return platform==='darwin'&&fs.existsSync(current)?current:legacy;
}
export function registerBrowserHost({root=ROOT,home=os.homedir(),platform=process.platform,io=fs,flow='install',diagnostic=()=>{},registrationOnlyAfterOptIn=false,browserEnabled,browserOptIn=false,distribution}={}){
 // The capability can be enabled by default setup; only a separate owner-recorded opt-in proves intent.
 // Keep the explicit installer primitive compatible; automatic callers must opt into this gate.
 if(registrationOnlyAfterOptIn===true&&(browserEnabled!==true||browserOptIn!==true))return {registered:false,skipped:true,reason:'browser_not_opted_in'};
 distribution??=readChromeDistribution(root);
 if(storeMode(distribution)&&distribution.configuration_state!=='ready')return {...distribution,registered:false,skipped:true,reason:'store_configuration_pending'};
 const access=(operation,pathKind,work)=>chromeAccessOperation({flow,operation,pathKind,diagnostic},work);
 const cfg=storeMode(distribution)?{extension_id:distribution.extension_id,published:distribution.store_published,store_url:distribution.store_url}:JSON.parse(fs.readFileSync(path.join(root,'connectors/browser-extension.json')));
 if(!/^[a-p]{32}$/.test(cfg.extension_id))throw Error('EXTENSION_ID_INVALID');
 const executable=browserHostBinary({root,platform});
 if(!fs.existsSync(executable))fail('HOST_BINARY_MISSING','完整安装包缺少浏览器连接组件。');
 const dir=path.join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts');
 access('mkdir','registration_directory',()=>io.mkdirSync(dir,{recursive:true,mode:0o700}));
 // Register only the current name. Existing legacy files stay untouched for
 // already-loaded older extensions; new installation never recreates them.
 const hostNames=['com.kenyu.chathand.browser'];
 const backups=[];
 for(const name of hostNames){
  const manifest=path.join(dir,name+'.json');
  const registration={name,description:'ChatHand personal browser connection',path:executable,type:'stdio',allowed_origins:[`chrome-extension://${cfg.extension_id}/`]};
  let existing;
  try{existing=access('read','native_host',()=>{const st=io.lstatSync(manifest);if(!st.isFile()||st.isSymbolicLink())fail('HOST_REGISTRATION_INVALID','浏览器连接登记不是普通文件。');return io.readFileSync(manifest,'utf8');});}catch(e){if(e.code!=='ENOENT')throw e;}
  let matches=false;if(existing!==undefined){try{matches=JSON.stringify(JSON.parse(existing))===JSON.stringify(registration);}catch{fail('HOST_REGISTRATION_INVALID','浏览器连接登记格式无效，原文件未改动。');}}
  if(existing!==undefined&&!matches){
   const backup=manifest+'.backup-'+crypto.randomUUID();access('backup','native_host_backup',()=>io.copyFileSync(manifest,backup,fs.constants.COPYFILE_EXCL));backups.push(backup);
  }
  if(!matches)access('write','native_host',()=>{
   const tmp=manifest+'.'+crypto.randomUUID()+'.tmp';
   try{io.writeFileSync(tmp,JSON.stringify(registration,null,2)+'\n',{mode:0o600,flag:'wx'});io.renameSync(tmp,manifest);}finally{try{io.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  });
 }
 return {registered:true,host_names:hostNames,backup_paths:backups,store_url:cfg.published?cfg.store_url:null,...(storeMode(distribution)?{}:{extension_folder:path.join(root,'browser-extension')}),extension_id:cfg.extension_id,user_install_confirmation_required:true};
}

export function installSkill({home=os.homedir(),codexHome=process.env.CODEX_HOME||path.join(home,'.codex')}={}){
 const src=path.join(ROOT,'skills/chathand-setup'),skills=path.join(codexHome,'skills'),dest=path.join(skills,'chathand-setup');
 fs.mkdirSync(skills,{recursive:true});const staged=fs.mkdtempSync(path.join(skills,'.chathand-setup-staging-'));let backup=null;
 try{
  fs.cpSync(src,staged,{recursive:true,verbatimSymlinks:true});
  fs.writeFileSync(path.join(staged,'.chathand-owned.json'),JSON.stringify({format:1,owner:'com.kenyu.chathand',kind:'setup-skill'})+'\n',{mode:0o600,flag:'wx'});
  let existing;try{existing=fs.lstatSync(dest);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){
   if(existing.isSymbolicLink())fail('SKILL_PATH_LINK','既有 Skill 是链接，配置停止；先报告路径冲突。');
   const backups=path.join(codexHome,'skill-backups');fs.mkdirSync(backups,{recursive:true});backup=path.join(backups,'chathand-setup-'+crypto.randomUUID());fs.renameSync(dest,backup);
  }
  try{fs.renameSync(staged,dest);}catch(e){if(backup)fs.renameSync(backup,dest);throw e;}
  return {installed:true,path:dest,backup_path:backup};
 }finally{if(fs.existsSync(staged))fs.rmSync(staged,{recursive:true,force:true});}
}
