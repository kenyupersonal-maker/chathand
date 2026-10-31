import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail} from '../../engine/src/core.mjs';
import {sandboxAvailable} from './sandbox.mjs';
const exec=promisify(execFile);
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:'/var/empty',LANG:'en_US.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_PAGER:'cat'};
export async function systemInspect(store,section='summary'){
  store.checkActive();
  if(section==='summary'){let productVersion=null;if(os.platform()==='darwin'){try{const r=await exec('/usr/bin/sw_vers',['-productVersion'],{env,timeout:3000,maxBuffer:4096});const value=r.stdout.trim();if(/^\d+(?:\.\d+){1,2}$/.test(value))productVersion=value;}catch{}store.checkActive();}return {product_version:productVersion,platform:os.platform(),arch:os.arch(),release:os.release(),node:process.version,cpu:os.cpus()[0]?.model,cpu_count:os.cpus().length,memory_bytes:{total:os.totalmem(),free:os.freemem()},workspace:store.root,terminal_backend_installed:sandboxAvailable(),terminal_backend_verified:false,python:fs.existsSync('/usr/bin/python3'),uptime_seconds:Math.round(os.uptime()),note:'Free memory is an OS snapshot, not a prediction of available model capacity.'};}
  const specs={processes:['/bin/ps',['-axo','pid=,ppid=,%cpu=,%mem=,comm=']],ports:['/usr/sbin/lsof',['-nP','-iTCP','-sTCP:LISTEN']],disk:['/bin/df',['-k',store.root]]};
  if(!specs[section])fail('SECTION_INVALID','选择 summary、processes、ports 或 disk。');
  const [cmd,args]=specs[section];try{const r=await exec(cmd,args,{env,timeout:5000,maxBuffer:512*1024});store.checkActive();return {section,output:r.stdout,read_only:true};}catch(e){if(section==='ports'&&e.code===1&&!e.stdout)return {section,output:'',read_only:true};fail('DIAGNOSTIC_FAILED','系统未返回完整诊断结果。');}
}
export async function gitInspect(store,o){
  store.checkActive();const dir=store.resolve(o.path||'.',{directory:true});
  const safe=['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','pager.diff=false','-C',dir];
  const specs={status:['status','--porcelain=v1','--branch','--untracked-files=normal'],diff:['diff','--no-ext-diff','--no-textconv','--no-color','--'],log:['log','-20','--format=%h%x09%ad%x09%s','--date=iso-strict','--no-decorate'],branch:['branch','--show-current']};
  const args=specs[o.action||'status'];if(!args)fail('GIT_ACTION_INVALID','仅支持 status、diff、log、branch。');
  try{
    const repo=await exec('/usr/bin/git',[...safe,'rev-parse','--show-toplevel'],{env,timeout:5000,maxBuffer:4096});store.resolve(repo.stdout.trim(),{directory:true});
    const r=await exec('/usr/bin/git',[...safe,...args],{env,timeout:7000,maxBuffer:512*1024});store.checkActive();
    return {action:o.action||'status',repository:repo.stdout.trim(),output:r.stdout,read_only:true};
  }catch(e){if(e.code==='SCOPE_REQUIRED'||e.code==='BRIDGE_STATE_PROTECTED')throw e;fail('GIT_READ_FAILED','无法读取仓库，或结果超出 512 KiB。没有修改仓库。');}
}
export async function desktopAction(store,o){
  store.checkActive(o.action!=='reveal');if(process.platform!=='darwin')fail('MAC_REQUIRED','此动作需要 macOS。');
  let args;
  if(o.action==='reveal')args=['-R',store.resolve(o.path)];
  else if(o.action==='open_url'){
    let url;try{url=new URL(o.url);}catch{fail('URL_INVALID','网址格式无效。');}
    if(url.username||url.password||o.url.length>4096||!((url.protocol==='https:')||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))fail('URL_INVALID','仅打开 HTTPS 网页或本机 HTTP 预览。');
    args=[url.href];
  }else fail('DESKTOP_ACTION_INVALID','支持 reveal 和 open_url。');
  await exec('/usr/bin/open',args,{env,timeout:5000,maxBuffer:4096});store.audit({event:'desktop_action',action:o.action});return {action:o.action,requested:true,note:'The OS accepted the request; foreground visibility is not verified.'};
}
