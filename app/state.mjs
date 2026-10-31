import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {privateDir,saveJSON,fail} from '../engine/src/core.mjs';import {normalizeConversation} from './links.mjs';
export class DesktopState {
 constructor(dir,{defaultRoot}={}){privateDir(dir);this.dir=fs.realpathSync(dir);this.file=path.join(dir,'desktop.json');
  if(fs.existsSync(this.file))this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));else{
   const root=defaultRoot||path.join(os.homedir(),'ChatHand-Workspace');fs.mkdirSync(root,{recursive:true,mode:0o700});
   this.data={version:1,projects:[{id:crypto.randomUUID(),name:'默认工作区',path:fs.realpathSync(root),scope:'folder'}],active:null,mode:'auto',conversations:[],notifications:true,browser:'chrome',onboarding:false,tunnel:null};this.data.active=this.data.projects[0].id;this.save();}
  // One-time preferences migration. Explicit pause/ask choices remain persisted.
  let changed=false;for(const [key,value] of Object.entries({browser_backend:'extension',auto_approve_tasks:true,access_enabled:true,auto_connect:true,connection_preference:this.data.tunnel?'tunnel':'none'})){if(this.data[key]===undefined){this.data[key]=value;changed=true;}}if(this.data.browser_mode_version!==2){if(this.data.browser_backend==='personal')this.data.browser_backend='extension';this.data.browser_mode_version=2;changed=true;}if(changed)this.save();
 }
 save(){saveJSON(this.file,this.data);}
 project(){return this.data.projects.find(p=>p.id===this.data.active);}
 addProject({name,folder,scope='folder'}){if(!['folder','computer'].includes(scope))fail('ARG_INVALID','工作区范围错误。');if(typeof name!=='string'||!name.trim()||name.length>80)fail('ARG_INVALID','项目名称需为 1–80 字符。');const real=fs.realpathSync(scope==='computer'?'/':folder);if(!fs.statSync(real).isDirectory())fail('ROOT_INVALID','工作区必须是目录。');if(real===this.dir||real.startsWith(this.dir+path.sep))fail('ROOT_STATE_OVERLAP','不能使用程序状态目录。');const existing=this.data.projects.find(p=>p.path===real);if(existing)return existing;const p={id:crypto.randomUUID(),name:name.trim(),path:real,scope};this.data.projects.push(p);this.save();return p;}
 addConversation({url,title,project_id}){const n=normalizeConversation(url);if(!this.data.projects.some(p=>p.id===project_id))fail('PROJECT_MISSING','请先选定项目。');if(typeof title!=='string'||!title.trim()||title.length>150)fail('ARG_INVALID','对话标题需为 1–150 字符。');let c=this.data.conversations.find(x=>x.url===n.url);if(c){c.title=title;c.project_id=project_id;}else{c={id:crypto.randomUUID(),...n,title,project_id,added_at:Date.now()};this.data.conversations.push(c);}this.save();return c;}
 removeConversation(id){this.data.conversations=this.data.conversations.filter(c=>c.id!==id);this.save();}
}
