/** Only explicit user-saved conversation URLs. No chat text, cookies or history access. */
import {fail} from '../engine/src/core.mjs';
const HOSTS=new Map([
 ['chatgpt.com','chatgpt'],['chat.openai.com','chatgpt'],['claude.ai','claude'],
 ['gemini.google.com','gemini'],['chat.qwen.ai','qwen'],['www.qianwen.com','qwen'],
 ['kimi.com','kimi'],['www.kimi.com','kimi'],['chat.deepseek.com','deepseek'],
 ['www.doubao.com','doubao'],['yuanbao.tencent.com','yuanbao'],['chatglm.cn','zhipu']
]);
export function normalizeConversation(raw){
 let u;try{u=new URL(raw);}catch{fail('CHAT_URL_INVALID','填写浏览器地址栏中的完整对话链接。');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||!HOSTS.has(u.hostname))fail('CHAT_URL_INVALID','只接收已列出的 AI 官方 HTTPS 对话地址。');
 if(raw.length>2048||/%0[ad]/i.test(raw))fail('CHAT_URL_INVALID','链接过长或格式不正确。');
 const provider=HOSTS.get(u.hostname);u.hash='';u.search='';
 if(u.hostname==='chat.openai.com')u.hostname='chatgpt.com';
 u.pathname=u.pathname.replace(/\/+$/,'')||'/';
 const patterns={chatgpt:/\/(?:c)\/[A-Za-z0-9_-]+$/,claude:/^\/chat\/[A-Za-z0-9_-]+$/,gemini:/^(?:\/u\/\d+)?\/app\/[A-Za-z0-9_-]+$/};
 if(patterns[provider]&&!patterns[provider].test(u.pathname))fail('CHAT_URL_NOT_CONVERSATION','需要具体对话的地址，不能使用首页、设置页或分享链接。');
 if(!patterns[provider]&&(u.pathname==='/'||/\/(?:login|settings|share)(?:\/|$)/.test(u.pathname)))fail('CHAT_URL_NOT_CONVERSATION','需要具体对话链接。');
 return {url:u.href,provider};
}
export function chooseNotificationAction(event,conversations){
 if(event.kind==='approval')return {kind:'local',page:'tasks'};
 const chat=conversations.find(c=>c.id===event.conversation_id);
 return chat?{kind:'conversation',conversation_id:chat.id,url:chat.url}:{kind:'local',page:'tasks'};
}
export function pickExistingTab(url,tabs){
 const canonical=normalizeConversation(url).url;
 return tabs.find(t=>{try{return normalizeConversation(t.url).url===canonical;}catch{return false;}})||null;
}
