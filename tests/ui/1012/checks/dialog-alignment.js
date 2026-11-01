'use strict';
const path=require('node:path');
const {open}=require('../shoot');
const {result,settle,OUT}=require('./common');

const checks=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,...(detail?{detail}:{})});
const logo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=';
const methods=['paypal','alipay'].map((id,i)=>({id,name:i?'Alipay':'PayPal',logo,qr:{n:21,hex:'0'.repeat(111)},...(i?{address:'fixture-address'}:{link:'https://example.com/tip'})}));

async function footer(page){return page.locator('#modal .actions').last().evaluate(row=>{
 const r=row.getBoundingClientRect();
 return {right:r.right,buttons:[...row.querySelectorAll('button')].map(button=>{const b=button.getBoundingClientRect(),s=getComputedStyle(button);return {action:button.dataset.action,right:b.right,height:b.height,font:s.fontSize,weight:s.fontWeight};})};
});}
function footerOK(value){return value.buttons.length>0&&Math.abs(value.right-value.buttons.at(-1).right)<1.5&&value.buttons.every(b=>Math.abs(b.height-40)<1&&b.font==='14px'&&Number(b.weight)>=600);}

(async()=>{
 for(const [locale,theme] of [['zh','light'],['zh','dark'],['en','light']]){
  const ctx=await open('task=none&store=1&appearance='+theme,{theme,w:1050,h:820,dsf:1}),p=ctx.page;
  try{
   await p.evaluate(locale=>ChatHandText.installCatalogs({locale}),locale);
   await p.route('**/chathand-site/tip.json',async route=>{await new Promise(r=>setTimeout(r,150));await route.fulfill({status:200,json:{version:1,methods}});});
   await p.click('.ch-tip-trigger');
   await p.waitForSelector('#modal .ch-tip-tab[aria-selected="true"]');
   await p.waitForTimeout(300);
   const pointer=await p.locator('#modal .ch-tip-tab[aria-selected="true"]').evaluate(e=>({active:e===document.activeElement,input:document.documentElement.dataset.input,outline:getComputedStyle(e).outlineStyle,selected:e.getAttribute('aria-selected')}));
   check(`${locale} ${theme}: pointer open keeps selection without focus border`,pointer.input==='pointer'&&pointer.active&&pointer.selected==='true'&&pointer.outline==='none',pointer);
   await p.locator('#modal').screenshot({path:path.join(OUT,`tip-${locale}-${theme}.png`)});
   await p.keyboard.press('ArrowDown');
   const keyboard=await p.locator('#modal .ch-tip-tab[aria-selected="true"]').evaluate(e=>({active:e===document.activeElement,input:document.documentElement.dataset.input,outline:getComputedStyle(e).outlineStyle,id:e.dataset.tipPick}));
   check(`${locale} ${theme}: keyboard navigation retains focus border`,keyboard.input==='keyboard'&&keyboard.active&&keyboard.outline==='solid'&&keyboard.id==='alipay',keyboard);
   await p.keyboard.press('ArrowUp');
   await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('#modal').open);
   await p.click('.ch-tip-trigger');await p.waitForSelector('#modal .ch-tip-tab[aria-selected="true"]');
   const cached=await p.locator('#modal .ch-tip-tab[aria-selected="true"]').evaluate(e=>({input:document.documentElement.dataset.input,outline:getComputedStyle(e).outlineStyle}));
   check(`${locale} ${theme}: cached reopen has no pointer focus border`,cached.input==='pointer'&&cached.outline==='none',cached);
   await p.locator('#modal').screenshot({path:path.join(OUT,`tip-cached-${locale}-${theme}.png`)});
   await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('#modal').open);
   await p.evaluate(()=>showChromeStore({phase:'intro'}));await settle(p);await p.waitForTimeout(250);
   const intro=await footer(p);
   check(`${locale} ${theme}: setup confirmation buttons are right aligned and match reference size`,footerOK(intro)&&intro.buttons.map(b=>b.action).join(',')==='chromeStoreOpen,closeModal',intro);
   await p.locator('#modal').screenshot({path:path.join(OUT,`store-${locale}-${theme}.png`)});
   const before=await p.evaluate(()=>window.__calls.filter(c=>c.name==='/api/settings').length);
   await p.click('#modal [data-action="closeModal"]');await p.waitForFunction(()=>!document.querySelector('#modal').open);
   check(`${locale} ${theme}: cancel does not change settings`,await p.evaluate(before=>window.__calls.filter(c=>c.name==='/api/settings').length===before,before));
   await p.evaluate(()=>showChromeStore({phase:'opening'}));await settle(p);await p.waitForTimeout(250);
   const opening=await footer(p);check(`${locale} ${theme}: setup progress cancel is right aligned`,footerOK(opening)&&opening.buttons[0].action==='extensionCancel',opening);
   await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('#modal').open);
   await p.evaluate(()=>showChromeInstall({phase:'loading',active:true,stage:'waiting_accessibility'}));await settle(p);await p.waitForTimeout(250);
   const install=await footer(p);check(`${locale} ${theme}: permission progress cancel is right aligned`,footerOK(install)&&install.buttons.map(b=>b.action).join(',')==='computerPermissions,extensionCancel',install);
   await p.locator('#modal').screenshot({path:path.join(OUT,`install-${locale}-${theme}.png`)});
   check(`${locale} ${theme}: no browser errors`,ctx.errs.length===0,ctx.errs);
  }finally{await ctx.close();}
 }
 const ctx=await open('task=none&wizard=5&chrome=none&store=1',{w:640,h:680,dsf:1}),p=ctx.page;
 try{
  await p.waitForSelector('#setupWizard [data-item="browser"]');
  const settingsBefore=await p.evaluate(()=>window.__calls.filter(c=>c.name==='/api/settings').length);
  await p.click('#setupWizard [data-item="browser"]');
  await p.waitForSelector('#modal[data-kind="chrome-store"] [data-action="chromeStoreOpen"]');
  await p.waitForTimeout(250);
  const intro=await footer(p);
  check('setup flow reaches the resized confirmation at a narrow window',footerOK(intro),intro);
  check('opening confirmation does not start Chrome',await p.evaluate(()=>!window.__calls.some(c=>['openChromeStore','extensionSetup'].includes(c.name))));
  await p.click('#modal [data-action="closeModal"]');await p.waitForFunction(()=>!document.querySelector('#modal').open);
  check('cancelling setup confirmation leaves Chrome and permissions untouched',await p.evaluate(before=>!window.__calls.some(c=>['openChromeStore','extensionSetup'].includes(c.name))&&window.__calls.filter(c=>c.name==='/api/settings').length===before,settingsBefore));
  await p.evaluate(()=>{ChatHandText.installCatalogs({locale:'en'});showChromeStore({phase:'stopped',code:'CHROME_DATA_ACCESS_DENIED'});});
  await p.waitForTimeout(250);
  const narrow=await p.evaluate(()=>{const d=document.querySelector('#modal'),row=d.querySelector('.actions'),r=row.getBoundingClientRect();return {scroll:row.scrollWidth,client:row.clientWidth,right:r.right,buttons:[...row.querySelectorAll('button')].map(b=>{const x=b.getBoundingClientRect();return {left:x.left,right:x.right};})};});
  check('long English actions remain inside the narrow dialog',narrow.scroll<=narrow.client&&narrow.buttons.every(b=>b.left>=narrow.right-narrow.client-1&&b.right<=narrow.right+1),narrow);
 }finally{await ctx.close();}
 result('dialog-alignment',checks);
})().catch(error=>{console.error(error);process.exitCode=1;});
