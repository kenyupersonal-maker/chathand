import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {fail} from '../../engine/src/core.mjs';

export const KEY_PATTERN=/^sk-[A-Za-z0-9_-]{17,}$/;
export const APPEARANCES=['light','dark','system'];
export const UI_ZOOMS=[1,1.125,1.25,1.375,1.5];
export const SKIN_ID=/^[a-z0-9][a-z0-9-]{0,31}$/;
const SKIN_DIRECTORY=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../ui/skins');
// Settings and anonymous CSS serving share this exact filename/existence rule.
export function skinFile(id,directory=SKIN_DIRECTORY){
 if(typeof id!=='string'||!SKIN_ID.test(id))return null;
 const file=path.join(directory,id+'.css');
 try{return fs.lstatSync(file).isFile()?file:null;}catch{return null;}
}
export const isSkinAvailable=(id,directory)=>id==='default'||!!skinFile(id,directory);
export function clientSettings(data={}) {
 const skin=data.skin===undefined?'default':isSkinAvailable(data.skin)?data.skin:'default';
 return {appearance:APPEARANCES.includes(data.appearance)?data.appearance:'system',ui_zoom:UI_ZOOMS.includes(data.ui_zoom)?data.ui_zoom:1.25,auto_update:typeof data.auto_update==='boolean'?data.auto_update:true,skin,skin_revision:Number.isSafeInteger(data.skin_revision)&&data.skin_revision>=0&&data.skin_revision<Number.MAX_SAFE_INTEGER?data.skin_revision:0};
}
export function initializeClientSettings(state) {
 const defaults=clientSettings(state.data);let changed=false;
 for(const [key,value] of Object.entries(defaults))if(state.data[key]!==value){state.data[key]=value;changed=true;}
 if(changed)state.save?.();return defaults;
}
// Validate the whole patch before mutating settings.
export function validateClientSettings(body) {
 const patch={};
 if(body.appearance!==undefined){if(!APPEARANCES.includes(body.appearance))fail('ARG_INVALID','外观选项错误。');patch.appearance=body.appearance;}
 if(body.ui_zoom!==undefined){if(!UI_ZOOMS.includes(body.ui_zoom))fail('ARG_INVALID','界面大小选项错误。');patch.ui_zoom=body.ui_zoom;}
 if(body.auto_update!==undefined){if(typeof body.auto_update!=='boolean')fail('ARG_INVALID','自动更新选项错误。');patch.auto_update=body.auto_update;}
 if(body.skin!==undefined){if(!isSkinAvailable(body.skin))fail('ARG_INVALID','皮肤选项错误。');patch.skin=body.skin;}
 return patch;
}
export function applyClientSettings(state,body){const patch=validateClientSettings(body);Object.assign(state.data,patch);return patch;}
export const automaticUpdatesAllowed=({isolated,appPath})=>isolated===false&&typeof appPath==='string'&&appPath.endsWith('.app');
// exceptTask: the task that asked for this update (request_update) does not hold the install back.
export const updateWorkPending=({tasks=[],jobs=[],exceptTask=null})=>{const except=new Set((Array.isArray(exceptTask)?exceptTask:[exceptTask]).filter(Boolean));return jobs.some(j=>j.process_alive||j.cleanup_pending)||tasks.some(t=>!except.has(t.task_id)&&['active','pending_approval'].includes(t.status));};
const CONNECTION_UI_ROUTES=new Set(['/api/connect','/api/connect/restore','/api/setup/connect','/api/tunnel/configure','/api/tunnel/start','/api/tunnel/stop','/api/tunnel/forget','/api/relay/pair','/api/relay/restore','/api/relay/stop','/api/relay/forget','/api/support/repair','/api/shutdown','/api/lifecycle/quit','/api/setup/await-key','/api/setup/await-key/status','/api/setup/await-key/cancel','/api/site-b/revoke']);
export function clientNeedsInterface(route,body={}) {
 return CONNECTION_UI_ROUTES.has(route)||route==='/api/access'&&body?.enabled===true||route==='/api/settings'&&(body?.appearance!==undefined||body?.ui_zoom!==undefined||body?.auto_update!==undefined||body?.auto_connect!==undefined||body?.skin!==undefined);
}
export function requireClientInterface(route,body,provided,expected) {
 if(!clientNeedsInterface(route,body))return;
 const equal=typeof expected==='string'&&expected.length>=32&&typeof provided==='string'&&Buffer.byteLength(expected)===Buffer.byteLength(provided)&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(provided));
 if(!equal)fail('UI_CONFIRM_REQUIRED','这一步只在 ChatHand 窗口里进行，AI 不能代做。');
}
export function computerName({platform=process.platform,exec=execFileSync,fallback=os.hostname}={}) {
 if(platform==='darwin')try{const name=String(exec('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8',timeout:2000,maxBuffer:4096})).trim();if(name)return name.slice(0,255);}catch{}
 return String(fallback()).slice(0,255);
}
export function macModel({platform=process.platform,exec=execFileSync}={}) {
 if(platform!=='darwin')return 'Mac';
 try{
  const info=JSON.parse(exec('/usr/sbin/system_profiler',['-json','-detailLevel','mini','SPHardwareDataType'],{encoding:'utf8',timeout:2000,maxBuffer:8192}));
  const name=info?.SPHardwareDataType?.[0]?.machine_name;
  if(typeof name==='string'){const model=name.replace(/[\u0000-\u001f\u007f]/g,'').trim().replace(/\s+/g,' ').slice(0,60);if(model)return model;}
 }catch{}
 return 'Mac';
}
export class KeyWatchBroker {
 constructor({now=Date.now}={}){this.now=now;this.current=null;this.value={active:false,received:false,last4:null};}
 expire(){if(this.current&&this.now()>=this.current.expires_at){this.current=null;this.value.active=false;}}
 start(tunnel_id){if(typeof tunnel_id!=='string'||!/^tunnel_[A-Za-z0-9_-]{8,100}$/.test(tunnel_id))fail('TUNNEL_ID_INVALID','通道 ID 格式不正确。');this.current={id:crypto.randomUUID(),tunnel_id,expires_at:this.now()+600000};this.value={active:true,received:false,last4:null};return this.snapshot();}
 snapshot(){this.expire();return {...this.value};}
 request(){this.expire();return {...this.value,request:this.current?{...this.current}:null};}
 received(tunnel_id,last4,{allowUnwatched=false}={}){this.expire();if(this.current?this.current.tunnel_id!==tunnel_id:!allowUnwatched)return false;if(last4!==null&&(typeof last4!=='string'||!/^[A-Za-z0-9_-]{4}$/.test(last4)))return false;this.current=null;this.value={active:false,received:true,last4};return true;}
 cancel(id){if(id&&this.current?.id!==id)return this.snapshot();this.current=null;this.value.active=false;return this.snapshot();}
 close(){this.cancel();}
}
function canonicalUncreated(file){let parent=path.resolve(file),tail=[];while(!fs.existsSync(parent)){tail.unshift(path.basename(parent));const next=path.dirname(parent);if(next===parent)throw Error('ISOLATED_UPDATE_PATH_REQUIRED');parent=next;}return path.join(fs.realpathSync(parent),...tail);}
export function assertTemporaryUpdatePaths(...files) {
 const roots=[os.tmpdir(),'/tmp','/private/tmp'].filter(fs.existsSync).map(root=>fs.realpathSync(root));
 for(const file of files){if(typeof file!=='string'||!path.isAbsolute(file))throw Error('ISOLATED_UPDATE_PATH_REQUIRED');const real=canonicalUncreated(file);if(!roots.some(root=>real.startsWith(root+path.sep)))throw Error('ISOLATED_UPDATE_PATH_REQUIRED');}
}
