import path from 'node:path';

const BUTTONS={
 setup:{zh:['让 ChatGPT 帮我配','我自己配'],en:['Let ChatGPT Set It Up','Set Up Myself']},
 repair:{zh:['让 ChatGPT 修','我自己修'],en:['Let ChatGPT Fix It','Fix It Myself']},
 add:{zh:['让 ChatGPT 帮我添加','我自己添加'],en:['Let ChatGPT Add It','Add It Myself']}
};
function fail(code,message){throw Object.assign(Error(message),{code});}
function checkOptions(intent,locale){
 if(typeof intent!=='string'||!Object.hasOwn(BUTTONS,intent))fail('SETUP_INTENT_INVALID','无法确认配置操作，请从 ChatHand 应用里重新打开助手。');
 if(!['zh','en'].includes(locale))fail('SETUP_LOCALE_INVALID','无法确认配置语言，请从 ChatHand 应用里重新打开助手。');
}
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";

export function setupMismatchReply({intent='setup',locale='zh'}={}){
 checkOptions(intent,locale);
 const [chatgpt,manual]=BUTTONS[intent][locale];
 // Recovery guidance describes the next action without guessing the session's environment.
 return locale==='zh'
  ?`请在这台 Mac 的桌面 ChatGPT 中切到「Codex」，粘贴提示词并发送。也可回到 ChatHand，点击「${chatgpt}」重试，或选择「${manual}」。`
  :`Open Codex in the ChatGPT desktop app on this Mac, then paste and send the prompt. You can also retry “${chatgpt}” in ChatHand or choose “${manual}”.`;
}
function promptText({appPath,routeName,intent,locale,siteOrigin}){
 const runtime=appPath+'/Contents/Resources/runtime';
 const skill=shellQuote(runtime+'/skills/chathand-setup/SKILL.md');
 if(intent==='setup'){
  return locale==='zh'
   ?`帮我安装并配好 ChatHand，包括在 ChatGPT 里替我连上 ChatHand 插件、把它的权限设成「允许使用所有工具」：ChatHand App 位于 ${shellQuote(appPath)}，照包里的codex/INSTALL.md做。使用我选的 ${routeName}。`
   :`Install and set up ChatHand for me, including connecting the ChatHand plugin in ChatGPT and setting its permission to “Allow all tools”: the ChatHand app is at ${shellQuote(appPath)}. Follow codex/INSTALL.md in the app. Use my selected ${routeName}.`;
 }
 const instructions=locale==='zh'
  ?`App 位于 ${shellQuote(appPath)}。使用 $chathand-setup；技能未加载时，读取 ${skill}。先按技能运行 doctor，遇到问题按实际错误排查。`
  :`The app is at ${shellQuote(appPath)}. Use $chathand-setup; if unavailable, read ${skill}. Run doctor as the skill describes and diagnose any actual errors.`;
 if(intent==='repair'){
  const target=routeName+(siteOrigin?' ('+siteOrigin+')':'');
  return locale==='zh'
   ?`帮我为这台 Mac 上已安装的 ChatHand 只修复 ${target}。${instructions}不得启动 Site 配对，不新建 Site 或 ChatGPT 插件，不换路线，也不修改另一条连接。不删除任何 ChatGPT 插件。无法修复时说明实际原因和下一步，只报告实际修复与测试结果。到了完成页保留窗口，由我点击「完成」。`
   :`Repair only ${target} for ChatHand already installed on this Mac. ${instructions} Do not start Site pairing, create a Site or ChatGPT plugin, switch routes, or modify the other connection. Do not delete any ChatGPT plugin. If repair fails, explain the actual cause and next step. Report actual repairs and tests only. Leave the completion page open for me to click “Done”.`;
 }
 return locale==='zh'
  ?`帮我为这台 Mac 上已安装的 ChatHand 只添加 ${routeName}，并在 ChatGPT 中连接对应插件，将权限设为「允许使用所有工具」。${instructions}保留另一条连接的设置、密钥和 Site，不删除任何 ChatGPT 插件。新连接在新普通对话中通过真实读写测试后再切换，旧连接留作备用。桌面 ChatHand 到达完成页才算配完，保留窗口，由我点击「完成」。`
  :`Add only ${routeName} to ChatHand already installed on this Mac. Connect its ChatGPT plugin and set permission to “Allow all tools”. ${instructions} Preserve the other connection’s settings, keys, and Site. Do not delete any ChatGPT plugin. Switch only after real read/write tests pass in a new ordinary chat; keep the old connection as a backup. Finish when desktop ChatHand reaches its completion page, and leave it open for me to click “Done”.`;
}
function repairSiteOrigin(value){
 try{
  if(typeof value!=='string'||/\s/.test(value))throw Error();
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();
  return url.origin;
 }catch{fail('SETUP_SITE_ORIGIN_UNAVAILABLE','无法确认要修复的 Site 地址，请从 ChatHand 的对应连接打开修复助手。');}
}
export const LOCAL_WORK_WEB_WARNING=setupMismatchReply();
export const SETUP_PROMPT_TEMPLATE=promptText({appPath:'<app>',routeName:'<route>',intent:'setup',locale:'zh'});

export function setupHandoff({appPath,route,intent='setup',locale='zh',siteOrigin}={}){
 if(typeof appPath!=='string'||!path.isAbsolute(appPath)||!appPath.endsWith('.app')||/[\r\n\0]/.test(appPath))fail('SETUP_APP_PATH_UNAVAILABLE','本机应用路径还无法确认，请从 ChatHand 应用里打开设置助手。');
 checkOptions(intent,locale);
 if(route===undefined&&intent==='setup')route='openai';
 if(!['site','openai'].includes(route))fail('SETUP_ROUTE_INVALID','无法确认已选连接方式，请从 ChatHand 应用里重新打开设置助手。');
 const origin=intent==='repair'&&route==='site'?repairSiteOrigin(siteOrigin):null;
 const routeName=route==='site'?'ChatGPT Site':locale==='zh'?'OpenAI 通道':'OpenAI Tunnel';
 return {prompt:promptText({appPath,routeName,intent,locale,siteOrigin:origin}),route,intent,locale,web_warning:setupMismatchReply({intent,locale}),auto_sent:false};
}
