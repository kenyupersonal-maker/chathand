import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {privateDir,saveJSON,fail} from '../engine/src/core.mjs';import {normalizeConversation} from './links.mjs';
import {readDesktopDataSnapshot,assertDesktopDataFormat,DESKTOP_DATA_FORMAT} from './v1/data-compatibility.mjs';
import {preserveCorruptSettings,preservedCorruptSettings} from './v1/settings-recovery.mjs';
export class DesktopState {
 constructor(dir,{defaultRoot,deferWorkspace=false,recoverCorrupt=false}={}){
  let snapshot=readDesktopDataSnapshot(dir,{allowCorrupt:recoverCorrupt,requireShape:recoverCorrupt});
  privateDir(dir);this.dir=fs.realpathSync(dir);this.file=path.join(dir,'desktop.json');
  let recovered=false;
  if(snapshot.kind==='corrupt'&&recoverCorrupt){preserveCorruptSettings(this.dir);recovered=true;snapshot={kind:'absent'};}
  if(snapshot.kind==='absent'&&recoverCorrupt)recovered||=preservedCorruptSettings(this.dir);
  this.readOnly=snapshot.kind==='newer';
  this.startupNotice=this.readOnly?{kind:'newer',format_version:snapshot.format_version,min_app_version:snapshot.min_app_version}:null;
  if(snapshot.value&&!this.readOnly)this.data=snapshot.value;else{
   const root=defaultRoot||path.join(os.homedir(),'ChatHand-Workspace');let workspacePath=root;
   if(!deferWorkspace&&!recovered&&!this.readOnly&&typeof root==='string'&&path.isAbsolute(root)&&root.length<=4096&&!root.includes('\0'))try{fs.mkdirSync(root,{recursive:true,mode:0o700});workspacePath=fs.realpathSync(root);}catch(error){if(!/^E[A-Z]+$/.test(error.code||''))throw error;}
   const safe=recovered||this.readOnly;
   this.data={format:DESKTOP_DATA_FORMAT,version:1,projects:[{id:crypto.randomUUID(),name:'默认工作区',path:workspacePath,scope:'folder',...(deferWorkspace&&!safe?{workspace_create_pending:true}:{})}],active:null,mode:'auto',conversations:[],notifications:true,browser:'chrome',onboarding:false,tunnel:null,...(safe?{access_enabled:false,auto_connect:false,auto_update:false,connection_preference:'none',terminal_enabled:false,browser_enabled:false,desktop_enabled:false}:{}),...(recovered?{settings_recovery_notice:true}:{})};this.data.active=this.data.projects[0].id;this.save();}
  // One-time preferences migration. Explicit pause/ask choices remain persisted.
  let changed=false;if(!Object.hasOwn(this.data,'format')){this.data.format=DESKTOP_DATA_FORMAT;changed=true;}for(const [key,value] of Object.entries({browser_backend:'extension',auto_approve_tasks:true,access_enabled:true,auto_connect:true,connection_preference:this.data.tunnel?'tunnel':'none'})){if(this.data[key]===undefined){this.data[key]=value;changed=true;}}if(this.data.browser_mode_version!==2){if(this.data.browser_backend==='personal')this.data.browser_backend='extension';this.data.browser_mode_version=2;changed=true;}if(changed)this.save();
 }
 save(){
  // Temporary preferences can change in memory, but never replace newer data.
  if(this.readOnly)return;
  if(assertDesktopDataFormat(this.data).kind==='newer'||readDesktopDataSnapshot(this.dir).kind==='newer')fail('DATA_FORMAT_NEWER','请使用支持此资料格式的 ChatHand 版本。');
  saveJSON(this.file,this.data);
 }
 project(){return this.data.projects.find(p=>p.id===this.data.active);}
 addProject({name,folder,scope='folder'}){if(!['folder','computer'].includes(scope))fail('ARG_INVALID','工作区范围错误。');if(typeof name!=='string'||!name.trim()||name.length>80)fail('ARG_INVALID','项目名称需为 1–80 字符。');const real=fs.realpathSync(scope==='computer'?'/':folder);if(!fs.statSync(real).isDirectory())fail('ROOT_INVALID','工作区必须是目录。');if(real===this.dir||real.startsWith(this.dir+path.sep))fail('ROOT_STATE_OVERLAP','不能使用程序状态目录。');const existing=this.data.projects.find(p=>p.path===real);if(existing)return existing;const p={id:crypto.randomUUID(),name:name.trim(),path:real,scope};this.data.projects.push(p);this.save();return p;}
 addConversation({url,title,project_id}){const n=normalizeConversation(url);if(!this.data.projects.some(p=>p.id===project_id))fail('PROJECT_MISSING','请先选定项目。');if(typeof title!=='string'||!title.trim()||title.length>150)fail('ARG_INVALID','对话标题需为 1–150 字符。');let c=this.data.conversations.find(x=>x.url===n.url);if(c){c.title=title;c.project_id=project_id;}else{c={id:crypto.randomUUID(),...n,title,project_id,added_at:Date.now()};this.data.conversations.push(c);}this.save();return c;}
 removeConversation(id){this.data.conversations=this.data.conversations.filter(c=>c.id!==id);this.save();}
}
