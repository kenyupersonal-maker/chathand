import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInfo,diagnostic} from './support.mjs';
import {REPAIR_ITEMS,proxyAddress} from './repair.mjs';

const statuses=new Set(['pending','running','ok','fixed','action','failed','skipped']);
const on=(s,id)=>s.settings?.[id+'_enabled']!==false&&s.permissions?.capabilities?.[id]?.enabled!==false;
const version=v=>typeof v==='string'&&/^v?\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?$/.test(v)?v:'未知';
function location(input){
 const executable=input||process.execPath;
 let dir=path.resolve(executable);while(dir!==path.dirname(dir)){if(dir.endsWith('.app'))return {root:dir,bundle:true};dir=path.dirname(dir);}
 return {root:input?path.resolve(input):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),bundle:false};
}
function safeFailure(item){
 // Repair messages are shown as a symptom, but arbitrary snapshot strings stay private.
 const allowed=new Set(['连接程序无法启动','此项检查失败','这台 Mac 无法访问 OpenAI','这台 Mac 无法连接 ChatGPT','代理可用，但无法访问 OpenAI，请尝试更换节点','Chrome 插件登记没修好']);
 if(allowed.has(item?.message))return item.message;
 return '此项检查失败';
}
export function aiBrief({snapshot={},errors=[],repair=null,appPath,home=os.homedir(),osVersion=os.release()}={}){
 const loc=location(appPath),runtime=loc.bundle?path.join(loc.root,'Contents/Resources/runtime'):loc.root;
 const node=loc.bundle?path.join(runtime,'bin/node'):process.execPath;
 const setup=path.join(runtime,'skills/chathand-setup/scripts/setup.mjs'),manual=path.join(runtime,'skills/chathand-setup/references/troubleshooting.md');
 const display=p=>p===home?'~':p.startsWith(home+path.sep)?'~'+p.slice(home.length):p;
 const quote=p=>{const shown=display(p);return shown.startsWith('~/')?"~/'"+shown.slice(2).replace(/'/g,"'\\''")+"'":"'"+shown.replace(/'/g,"'\\''")+"'";};
 const proxy=proxyAddress(snapshot.connection?.control_plane?.proxy),relay=snapshot.settings?.connection_preference==='relay'||snapshot.relay?.online===true;
 const connected=relay?snapshot.relay?.online===true:snapshot.connection?.control_plane?.state==='up';
 const p=snapshot.automation?.computer?.permissions||{},browser=snapshot.automation?.browser?.extension?.connected===true;
 const failed=repair?.items?.find(i=>i.status==='failed');
 const symptom=!connected?(proxy?'ChatGPT 连不上，代理软件开着':'ChatGPT 连不上，没开代理'):on(snapshot,'browser')&&!browser?'Chrome 插件无法连接':failed?safeFailure(failed):'（在这里补一句你遇到的问题）';
 const info=buildInfo(),about=snapshot.about||{},codes=diagnostic(snapshot,errors).errors.slice(-10).map(e=>e.code);
 const cloud=['up','down','unknown','checking'].includes(snapshot.connection?.control_plane?.state)?snapshot.connection.control_plane.state:'unknown';
 const system=typeof osVersion==='string'&&/^\d+(?:\.\d+){0,3}$/.test(osVersion)?osVersion:'未知';
 const build=Number.isSafeInteger(Number(about.build??info.build))&&Number(about.build??info.build)>=0?Number(about.build??info.build):'未知';
 const handoff={format:'chathand-handoff-v1',symptom,diagnostics:'脱敏诊断已生成',allowed_actions:['read_diagnostics','follow_manual'],blocked_actions:['send_secrets','auto_send_chat','change_authorization'],connection:connected?'connected':'unknown'};
 const lines=[
  `版本：${version(about.version??snapshot.version??info.version)}（构建 ${build}）`,
  `macOS 版本：${system}`,
  `本机自检：ready=${snapshot.connection?.ready===true}，healthy=${snapshot.connection?.healthy===true}`,
  `云端状态：${relay?(snapshot.relay?.online===true?'up':'down'):cloud}`,
  `网络：${proxy?'代理 '+proxy.address:'直连'}`,
  `Chrome 插件：${browser?'已连接':'没连上'}`,
  `系统授权：辅助功能=${p.accessibility===true}，屏幕录制=${p.screen_recording===true}`,
  `开关：命令=${on(snapshot,'terminal')}，浏览器控制=${on(snapshot,'browser')}，桌面控制=${on(snapshot,'desktop')}`,
  `文件范围：${snapshot.permissions?.file_scope==='computer'||(!snapshot.permissions?.file_scope&&snapshot.mode==='full')?'整台电脑':'文件夹'}`,
  `最近错误：${codes.length?codes.join('、'):'无'}`,
 ];
 for(const [id] of REPAIR_ITEMS){const item=repair?.items?.find(i=>i.id===id);if(item&&statuses.has(item.status))lines.push(`检查：${id}=${item.status}`);}
 return {handoff,text:`我的 ChatHand（让 ChatGPT 操作这台 Mac 的应用）出了问题：${symptom}
请在这台 Mac 上帮我修好：
1. 先自检：${quote(node)} ${quote(setup)} doctor
2. 照这份手册修：${display(manual)}
3. 有 chathand-setup 技能就直接用它。
4. 规矩：密钥不要出现在聊天、文件和日志里；能做的你直接做完，不要把能自己试的事交还给我；只有系统和 ChatGPT 自己规定要人确认的地方（系统授权框、最后的授权按钮），说清楚卡在哪一步、做完那一步后你接着做；不要重建通道、不要重新填密钥，除非手册写了要这么做。
诊断（不含密钥、文件内容、聊天内容）：
${lines.join('\n')}`};
}
