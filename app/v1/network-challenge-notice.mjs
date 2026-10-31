import fs from 'node:fs';import path from 'node:path';
import {setupHandoff} from './setup-handoff.mjs';
const validAt=value=>Number.isSafeInteger(value)&&value>=0;
const message=(at,url)=>`请先告诉用户：${new Date(at).toISOString()}，这台 Mac 到 Site 的请求被 Cloudflare 网络验证拦住，可能是代理或 VPN。可[改用 OpenAI 通道](${url})，打开填好提示词的 Work 对话，发出去继续配置。`;
const SKILL_FILES=['SKILL.md','references/runbook.md','references/troubleshooting.md'];
export function networkSetupHandoff({appPath}){const handoff=setupHandoff({appPath,route:'openai'}),url=new URL('https://chatgpt.com/');url.searchParams.set('surface','work');url.searchParams.set('prompt',handoff.prompt);return {url:url.href,prompt:handoff.prompt};}
export function prepareNetworkSetupHandoff({appPath,install}){
 const handoff=networkSetupHandoff({appPath}),root=path.join(appPath,'Contents/Resources/runtime/skills/chathand-setup');
 const complete=folder=>SKILL_FILES.every(file=>{try{return fs.statSync(path.join(folder,file)).isFile();}catch{return false;}});
 if(!complete(root))throw Object.assign(Error('SETUP_SKILL_FILES_MISSING'),{code:'SETUP_SKILL_FILES_MISSING'});
 const receipt=install();if(receipt?.installed!==true||typeof receipt.path!=='string'||!complete(receipt.path))throw Object.assign(Error('SETUP_SKILL_INSTALL_UNCONFIRMED'),{code:'SETUP_SKILL_INSTALL_UNCONFIRMED'});
 return handoff;
}
/** Persist network episodes independently from the notice awaiting a ChatGPT result. */
export class NetworkChallengeNotice {
 constructor({local,notifications=()=>true,changed=()=>{}}){Object.assign(this,{local,db:local.db,notifications,changed});this.db.exec(`CREATE TABLE IF NOT EXISTS setup_network_challenge_notice(id INTEGER PRIMARY KEY CHECK(id=1),episode INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 0,started_at INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,pending_at INTEGER NOT NULL DEFAULT 0,notified_episode INTEGER NOT NULL DEFAULT 0);INSERT OR IGNORE INTO setup_network_challenge_notice(id) VALUES(1);`);}
 row(){return this.db.prepare('SELECT * FROM setup_network_challenge_notice WHERE id=1').get();}
 challenge({at}={}){if(!validAt(at))return false;const result=this.local.tx(()=>{const row=this.row(),fresh=row.active!==1;this.db.prepare('UPDATE setup_network_challenge_notice SET episode=?,active=1,started_at=?,last_at=?,pending=?,pending_at=? WHERE id=1').run(row.episode+(fresh?1:0),fresh?at:row.started_at,at,fresh?1:row.pending,fresh?at:row.pending_at);return fresh;});this.changed();return result;}
 clear(){const result=this.local.tx(()=>this.db.prepare('UPDATE setup_network_challenge_notice SET active=0 WHERE id=1 AND active=1').run().changes>0);if(result)this.changed();return result;}
 activeChallenge(){const row=this.row();return row.active===1?{at:row.last_at}:null;}
 notificationPending(){const row=this.row();return this.notifications()===true&&row.episode>0&&row.notified_episode<row.episode?{episode:row.episode,at:row.started_at}:null;}
 acknowledgeNotification(episode){if(!Number.isSafeInteger(episode)||episode<1)return false;const changed=this.local.tx(()=>this.db.prepare('UPDATE setup_network_challenge_notice SET notified_episode=? WHERE id=1 AND episode=? AND notified_episode<?').run(episode,episode,episode).changes>0);if(changed)this.changed();return changed;}
 async append(result,{prepare,preview,maxEnvelopeChars=Infinity}){
  if(this.row().pending!==1||!Array.isArray(result?.result?.content))return false;
  if(preview&&Number.isFinite(maxEnvelopeChars)){const candidate=await preview(),row=this.row(),content=[...result.result.content,{type:'text',text:message(row.pending_at,candidate.url)}];if(JSON.stringify({...result,result:{...result.result,content}}).length>maxEnvelopeChars)return false;}
  if(this.row().pending!==1)return false;
  const handoff=await prepare();if(typeof handoff?.url!=='string')return false;
  const previous=result.result.content;let appended=false;
  try{this.local.tx(()=>{const row=this.row();if(row.pending!==1)return;
    const text=message(row.pending_at,handoff.url);
    const content=[...previous,{type:'text',text}];
    if(JSON.stringify({...result,result:{...result.result,content}}).length>maxEnvelopeChars)return;
    result.result.content=content;
    this.db.prepare('UPDATE setup_network_challenge_notice SET pending=0 WHERE id=1 AND pending=1').run();appended=true;
  });}catch(error){result.result.content=previous;throw error;}
  if(appended)this.changed();return appended;
 }
}
