import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setupHandoff,setupMismatchReply,SETUP_PROMPT_TEMPLATE,LOCAL_WORK_WEB_WARNING} from '../app/v1/setup-handoff.mjs';

const appPath='/private/synthetic/My ChatHand.app';
const siteOrigin='https://repair.example';
const buttons={
 setup:{zh:['让 ChatGPT 帮我配','我自己配'],en:['Let ChatGPT Set It Up','Set Up Myself']},
 repair:{zh:['让 ChatGPT 修','我自己修'],en:['Let ChatGPT Fix It','Fix It Myself']},
 add:{zh:['让 ChatGPT 帮我添加','我自己添加'],en:['Let ChatGPT Add It','Add It Myself']}
};

test('1070 omitted intent defaults to OpenAI and retains the shared Chinese setup template for either route',()=>{
 const h=setupHandoff({appPath});
 assert.equal(h.route,'openai');assert.equal(h.intent,'setup');assert.equal(h.locale,'zh');
 assert.equal(h.web_warning,LOCAL_WORK_WEB_WARNING);assert.equal(h.auto_sent,false);
 for(const route of ['site','openai']){
  const result=setupHandoff({appPath,route});
  assert.equal(result.prompt.replaceAll(appPath,'<app>').replace(route==='site'?'ChatGPT Site':'OpenAI 通道','<route>'),SETUP_PROMPT_TEMPLATE);
 }
});

test('setup recovery names the matching actions without inventing a cloud environment',()=>{
 for(const [intent,locales] of Object.entries(buttons))for(const [locale,[ai,manual]] of Object.entries(locales)){
  const text=setupMismatchReply({intent,locale});
  assert.ok(text.includes(ai)&&text.includes(manual),intent+'/'+locale);
  assert.match(text,/Codex/);
  assert.doesNotMatch(text,/我现在是在云端|I'm running in a cloud session/);
 }
});

test('1070 setup follows the disk installer wording with the actual App and selected route',()=>{
 for(const locale of ['zh','en'])for(const route of ['site','openai']){
  const h=setupHandoff({appPath,route,intent:'setup',locale});
  assert.ok(h.prompt.includes(appPath));
  assert.match(h.prompt,/codex\/INSTALL\.md/);
  assert.match(h.prompt,locale==='zh'?/^帮我安装并配好 ChatHand/:/^Install and set up ChatHand for me/);
  assert.match(h.prompt,locale==='zh'?/允许使用所有工具/:/Allow all tools/);
  assert.doesNotMatch(h.prompt,/自检无法运行时说明原因并停止|If doctor cannot run, report why and stop/);
  assert.equal(h.prompt.includes(h.web_warning),false);
  assert.ok(h.prompt.length<500,locale+'/'+route);
  if(route==='openai')assert.doesNotMatch(h.prompt,/ChatGPT Site|site-start|template_path/);
  if(route==='site')assert.doesNotMatch(h.prompt,/OpenAI 通道|OpenAI Tunnel/);
  assert.equal(h.intent,'setup');assert.equal(h.locale,locale);assert.equal(h.route,route);assert.equal(h.auto_sent,false);
 }
});

test('1070 the referenced setup instructions retain doctor, healthy connections and completion checks',()=>{
 const install=fs.readFileSync(new URL('../codex/INSTALL.md',import.meta.url),'utf8');
 const skill=fs.readFileSync(new URL('../skills/chathand-setup/SKILL.md',import.meta.url),'utf8');
 const runbook=fs.readFileSync(new URL('../skills/chathand-setup/references/runbook.md',import.meta.url),'utf8');
 assert.match(install,/chathand-setup\/SKILL\.md.*照它配置/);
 assert.match(skill,/配置流程.*references\/runbook\.md/);
 assert.match(runbook,/先 `setup doctor`/);
 assert.match(runbook,/保留已有插件和健康连接/);
 assert.match(runbook,/桌面 ChatHand 的配置窗口到了完成页才算配完/);
 assert.match(runbook,/不把自检失败当成云端会话的证据/);
});

test('repair and add use concise task instructions and diagnose actual errors',()=>{
 for(const intent of ['repair','add'])for(const locale of ['zh','en'])for(const route of ['site','openai']){
  const h=setupHandoff({appPath,route,intent,locale,siteOrigin});
  assert.match(h.prompt,locale==='zh'?/^帮我为这台 Mac 上已安装的 ChatHand/:/ChatHand already installed on this Mac/);
  assert.equal(h.prompt.includes(h.web_warning),false);
  assert.ok(h.prompt.includes(appPath+'/Contents/Resources/runtime/skills/chathand-setup/SKILL.md'));
  assert.match(h.prompt,/\$chathand-setup/);assert.match(h.prompt,/doctor/);
  assert.match(h.prompt,locale==='zh'?/按实际错误排查/:/diagnose any actual errors/);
  assert.doesNotMatch(h.prompt,/只能原样回复|我现在是在云端|ONLY.*exactly as written|I'm running in a cloud session|codex\/INSTALL\.md/);
  assert.match(h.prompt,locale==='zh'?/保留窗口，由我点击「完成」/:/leave it open for me to click “Done”|Leave the completion page open for me to click “Done”/);
  assert.ok(h.prompt.length<(locale==='zh'?500:1200),intent+'/'+locale+'/'+route);
  assert.equal(h.intent,intent);assert.equal(h.locale,locale);assert.equal(h.route,route);assert.equal(h.auto_sent,false);
  assert.doesNotMatch(h.prompt,/<(?:app|route|origin)>/);
 }
});

test('1070 repair names only its target and cannot start pairing, create objects or switch routes',()=>{
 for(const locale of ['zh','en'])for(const route of ['site','openai']){
  const h=setupHandoff({appPath,route,intent:'repair',locale,siteOrigin});
  assert.equal(h.prompt.includes(siteOrigin),route==='site');
  assert.doesNotMatch(h.prompt,/site-start|template_path/);
  assert.match(h.prompt,locale==='zh'?/不得启动 Site 配对，不新建 Site 或 ChatGPT 插件，不换路线/:/Do not start Site pairing, create a Site or ChatGPT plugin, switch routes/);
  assert.match(h.prompt,locale==='zh'?/无法修复时说明实际原因和下一步/:/If repair fails, explain the actual cause and next step/);
 }
});

test('1070 add preserves the other connection and waits for real tests before switching',()=>{
 for(const locale of ['zh','en']){
  const h=setupHandoff({appPath,route:'site',intent:'add',locale});
  assert.match(h.prompt,locale==='zh'?/只添加 ChatGPT Site/:/Add only ChatGPT Site/);
  assert.match(h.prompt,locale==='zh'?/保留另一条连接的设置、密钥和 Site/:/Preserve the other connection’s settings, keys, and Site/);
  assert.match(h.prompt,locale==='zh'?/新普通对话中通过真实读写测试后再切换，旧连接留作备用/:/Switch only after real read\/write tests pass in a new ordinary chat; keep the old connection as a backup/);
  assert.match(h.prompt,locale==='zh'?/桌面 ChatHand 到达完成页才算配完/:/desktop ChatHand reaches its completion page/);
  assert.match(h.prompt,locale==='zh'?/连接对应插件.*允许使用所有工具/:/Connect its ChatGPT plugin.*Allow all tools/);
  assert.match(h.prompt,locale==='zh'?/不删除任何 ChatGPT 插件/:/Do not delete any ChatGPT plugin/);
 }
});

test('1070 invalid intents, locales and ambiguous repair targets fail without echoing supplied values',()=>{
 for(const intent of [null,'other',[],['setup'],{},'__proto__','constructor'])assert.throws(()=>setupHandoff({appPath,intent}),{code:'SETUP_INTENT_INVALID'});
 for(const locale of [null,'fr','en-US'])assert.throws(()=>setupHandoff({appPath,locale}),{code:'SETUP_LOCALE_INVALID'});
 for(const intent of ['repair','add'])assert.throws(()=>setupHandoff({appPath,intent}),{code:'SETUP_ROUTE_INVALID'});
 for(const value of [undefined,'http://repair.example','https://repair.example/mcp','https://synthetic@repair.example','https://repair.example?test=1','https://repair.example#fragment','not-an-origin']){
  assert.throws(()=>setupHandoff({appPath,route:'site',intent:'repair',siteOrigin:value}),error=>error.code==='SETUP_SITE_ORIGIN_UNAVAILABLE'&&!error.message.includes(String(value)));
 }
 assert.ok(setupHandoff({appPath,route:'site',intent:'repair',siteOrigin:siteOrigin+'/'}).prompt.includes(siteOrigin));
});

test('1070 the handoff safely quotes a legitimate App path containing spaces and apostrophes',()=>{
 const h=setupHandoff({appPath:"/private/synthetic/Ken's ChatHand.app"});
 assert.ok(h.prompt.includes("'/private/synthetic/Ken'\\''s ChatHand.app'"));
 assert.throws(()=>setupHandoff({appPath:'/private/synthetic/ChatHand.app\n'}),{code:'SETUP_APP_PATH_UNAVAILABLE'});
});
