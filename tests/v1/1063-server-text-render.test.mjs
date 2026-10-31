import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';

const require=createRequire(import.meta.url);
const fixture=JSON.parse(fs.readFileSync(new URL('../support/1063-window-state.json',import.meta.url)));

test('English window paints emitted backend text in six production components without Chinese fallback',{timeout:45000},async t=>{
 const server=await require('../ui/1012/server.js').start();
 t.after(()=>server.close());
 const browser=await chromium.launch({executablePath:process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:900}});
 await page.goto(server.url+'/?task=none&now=1790957400000#tok.uikey');
 await page.waitForFunction(()=>typeof S!=='undefined'&&S&&typeof localizeServerState==='function');
 const painted=await page.evaluate(input=>{
  window.ChatHandText.installCatalogs({locale:'en'});
  const state={...S,...input,settings:{...S.settings,setup_complete:true,tunnel:{tunnel_id:'fixture'}},relay:{online:false},site_b:{...S.site_b,selected:'openai'},
   automation:{...S.automation,browser:{...S.automation?.browser,extension:{...S.automation?.browser?.extension,...input.automation.browser.extension}}},
   update:{...S.update,status:'failed',install:input.update.install}};
  S=localizeServerState(state);
  const holder=document.createElement('section');holder.id='server-text-proof';holder.style.cssText='position:relative;z-index:9999;background:#fff;color:#171a18;padding:24px;max-width:900px';
  const components={connection:connCard(),repair:repairList(S.repair),tools:toolListNotice(),refresh:toolsRefreshNoteBody(S.tools_refresh),update:bubbleHTML(),helper:helperHomeNotice()};
  for(const [kind,html]of Object.entries(components)){const section=document.createElement('section');section.dataset.proof=kind;section.innerHTML='<h3>'+kind+'</h3>'+html;holder.append(section);}
  document.body.prepend(holder);
  return Object.fromEntries([...holder.children].map(section=>[section.dataset.proof,{text:section.innerText,html:section.innerHTML}]));
 // 1082（Ken 10/28）：工具表「还没确认」（unknown）首页不再显示，这里用「已过期」（stale）那条来验英文。
 },{...fixture,tools_list_status:{...fixture.tools_list_status,state:'stale',message_key:'toolsList.stale.message'}});
 assert.equal(await page.evaluate(status=>{S={...S,tools_list_status:status};return toolListNotice();},fixture.tools_list_status),'','unknown is not shown on the home page');
 for(const [kind,value]of Object.entries(painted)){
  assert.ok(value.text.trim().length>kind.length,kind+' should paint actual status text');
  assert.doesNotMatch(value.text,/\p{Script=Han}/u,kind+' must use window English rather than backend Chinese');
  assert.doesNotMatch(value.text,/ui\.server\./,kind+' must resolve the locale key');
 }
 assert.match(painted.connection.text,/sav|stor/i);
 assert.match(painted.helper.text,/Chrome/i);
 const output=process.env.CHATHAND_1063_RENDER_OUTPUT;
 if(output){fs.mkdirSync(output,{recursive:true});await page.locator('#server-text-proof').screenshot({path:path.join(output,'english-server-components.png')});fs.writeFileSync(path.join(output,'english-server-components.json'),JSON.stringify(painted,null,2)+'\n');}
});
