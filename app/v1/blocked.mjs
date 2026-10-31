import {t} from "../i18n.mjs";
// 1029 H：被拦回执只解释，不授予权限。用户决定是否开启，AI 不得重试或绕开。
import {redactErrorText} from '../../engine/src/core.mjs';
const txt=(v,n=600)=>redactErrorText(String(v??'')).slice(0,n);
const NEXT={
 can_enable:'告诉用户这个功能在 ChatHand 窗口的对应设置中关闭，说明在哪里开启；继续不依赖这个开关的部分，不弹授权卡、不等待批准、不自动重试。',
 needs_user:'照 say_to_user 告诉用户，要本人回电脑前处理。等用户说好了，再调 bridge_info 核对，未确认前不重试、不绕开。',
 never:'直接换不用这类操作的做法，或让用户自己处理。不要重试，也不要换写法绕过。'
};
export function blockedReceipt(o={}){
 const kind=['can_enable','needs_user','never'].includes(o.kind)?o.kind:'never';
 const gate=['high_risk','common','admin_setup','scope','capability','system_permission','browser_helper','never'].includes(o.gate)?o.gate:'never';
 const item={id:txt(o.item?.id||o.id,80),name:txt(o.item?.name||o.name,160)};
 const cause=txt(o.cause,160),effect={can_do:txt(o.effect?.can_do??o.can_do),risk:txt(o.effect?.risk??o.risk)};
 const where=kind==='never'?null:{path:txt(o.where?.path??o.path),link:txt(o.where?.link??o.link,200)};
 const alternative=txt(o.alternative||t("card.blocked.defaultAlternative"));
 return {version:1,kind,gate,item,cause,effect,where,alternative,confirm:null,answer_in_chat:false,
  say_to_user:[cause,txt(t("card.blocked.effect",{canDo:effect.can_do,risk:effect.risk})),where?txt(t("card.blocked.openSettings",{path:where.path})):t("card.blocked.neverNoEntry"),txt(t("card.blocked.otherwise",{alternative}))],next:NEXT[kind]};
}
export const SCOPE_EFFECT={can_do:t("permissions.scope.what"),risk:t("card.blocked.scope.risk")};
export function scopeReceipt({tool=t("card.blocked.scope.defaultTool"),command='',reason=t("card.blocked.scope.defaultReason")}={}){
 return blockedReceipt({kind:'can_enable',gate:'scope',id:'full',name:t("permissions.scope.name"),cause:`${command||tool}：${reason}`,effect:SCOPE_EFFECT,path:t("permissions.scope.where"),link:'chathand://settings/scope',alternative:t("card.blocked.scope.alternative")});
}
// 原生/助手错误只能提供证据，不能提供放行决定。统一在来源和 Tools 最外层补解释。
export function blockedForError(e,{tool='',command='',reason=''}={}){
 if(['SCOPE_REQUIRED','NEEDS_FULL_ACCESS'].includes(e?.code))return scopeReceipt({tool:tool||e.code,command,reason:e.message});
 if(['ACCESSIBILITY_REQUIRED','SCREEN_RECORDING_REQUIRED'].includes(e?.code)){
  const screen=e.code==='SCREEN_RECORDING_REQUIRED',name=screen?t("card.blocked.system.screen"):t("card.blocked.system.accessibility");
  return blockedReceipt({kind:'needs_user',gate:'system_permission',id:screen?'screen_recording':'accessibility',name,cause:`${tool||'computer_observe'}：${e.message||t("card.blocked.system.missing",{name})}`,can_do:screen?t("card.blocked.system.screenWhat"):t("card.blocked.system.accessibilityWhat"),risk:screen?t("card.blocked.system.screenRisk"):t("card.blocked.system.accessibilityRisk"),path:t("card.blocked.system.where",{name}),link:'chathand://settings/desktop',alternative:t("card.blocked.system.alternative")});
 }
 // 1081（Claude，Ken 10/27、ChatGPT 复查 D03/D08）：浏览器这边只在真要用户动手时出回执：没装插件、ChatHand 打开了 Chrome 插件还是没连上、打不开 Chrome。
 // 做到一半连接断了（多半是 Chrome 被关了）不算：下次用浏览器时 ChatHand 自己打开 Chrome。回执里说到「浏览器控制」点哪个按钮，按原因只说一个；开头不带工具名。
 if(e?.code==='EXTENSION_NOT_CONNECTED'||e?.code==='EXTENSION_DISCONNECTED'&&e.details?.retry_after_user_action_only===true){const install=e.code==='EXTENSION_NOT_CONNECTED',noChrome=!install&&reason==='CHROME_NOT_OPENED';return blockedReceipt({kind:'needs_user',gate:'browser_helper',id:install?'install':'connect',name:t("card.blocked.browser.name"),cause:e.message||t("card.blocked.browser.notConnected"),can_do:t("card.blocked.browser.what"),risk:t("card.blocked.browser.risk"),path:t(install?"card.blocked.browser.whereInstall":noChrome?"card.blocked.browser.whereChrome":"card.blocked.browser.where"),link:'chathand://settings/browser',alternative:t("card.blocked.browser.alternative")});}
 return null;
}
