#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {start}=require('./server');
const {launchBrowser,NATIVE_SHIM,NOW,FREEZE,FONT_FIX,ROOT}=require('./common');
const {OUT,sourceHashes}=require('./skin-layout');
/* 皮肤机制：核心、面板可拆、CSP、减少动态、和产品按钮不重叠、不请求外网；
   皮肤面板只有一个皮肤列表：键盘开关、Tab 只在面板里转、点卡片换皮肤、选中标记。 */
async function mechanismReport(skin){
 const only=(process.argv.find(a=>a.startsWith('--only='))?.slice(7)||'').split(',').filter(Boolean);
 const hashes=sourceHashes(),srv=await start({port:0}),browser=await launchBrowser(),checks=[],external=[];
 const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,...(detail===undefined?{}:{detail})});console.log(`${ok?'通过':'失败'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
 async function open({query='',st='idle',theme='light',init,drop=[],css404=false,slot=false,reduce=false,freeze=false,csp=false,saved='default'}={}){
  await fetch(srv.url+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skin:saved})});
  const ctx=await browser.newContext({viewport:{width:1280,height:860},colorScheme:theme,reducedMotion:reduce?'reduce':'no-preference',locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  await ctx.addInitScript(NATIVE_SHIM);if(init)await ctx.addInitScript(init);
  await ctx.addInitScript(()=>{window.__skinCspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__skinCspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));});
  const page=await ctx.newPage();await page.clock.setFixedTime(NOW);const errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(srv.url)&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))external.push(r.url());});
  if(drop.length||slot||csp)await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===srv.url&&(url.pathname==='/'||url.pathname==='/index.html')){let body=fs.readFileSync(path.join(ROOT,'ui/index.html'),'utf8').replace('<html lang="zh-CN"',`<html lang="zh-CN" data-skin-saved="${saved}"`);for(const file of drop)body=body.replace(new RegExp(`<script\\s+src=["']/${file.replaceAll('.','\\.')}["']\\s*><\\/script>`,'g'),'');if(slot)body=body.replace('<script src="/skin-switcher.js">','<div data-skin-slot id="skin-test-slot" style="position:fixed;left:500px;top:5px"></div><script src="/skin-switcher.js">');return route.fulfill({status:200,contentType:'text/html',headers:csp?{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"}:{},body});}return route.continue();});
  if(css404)await page.route('**/skins/'+skin+'.css',r=>r.fulfill({status:404,contentType:'text/css',body:''}));
  await page.goto(`${srv.url}/?s=${st}&now=${NOW}${query}#token`);await page.addStyleTag({content:FONT_FIX+(freeze?FREEZE:'')});await page.waitForSelector('#main > *');await page.waitForTimeout(120);
  return {ctx,page,errors};
 }
 const state=page=>page.evaluate(()=>({skin:window.ChatHandSkin?.current()||'default',scheme:document.documentElement.dataset.scheme||null,win:getComputedStyle(document.documentElement).getPropertyValue('--win').trim(),main:document.querySelector('#main').innerText.length,roots:document.querySelectorAll('[data-skin-switcher]').length,skinStyleNodes:[...document.querySelectorAll('style[data-skin-tune]')].map(e=>e.outerHTML)}));
 async function run(name,options,fn){if(only.length&&!only.includes(name))return;let r;try{r=await open(options);await fn(r);check(name+'：无页面异常',!r.errors.length,r.errors);}catch(e){check(name,false,e.message);}finally{await r?.ctx.close();}}
 const current=(page,id)=>page.waitForFunction(id=>window.ChatHandSkin.current()===id,id,{timeout:5000});
 try{
  for(const [name,options] of [
    ['删切换器脚本',{query:'&skin='+skin,drop:['skin-switcher.js']}],
    ['全局禁用切换器',{query:'&skin='+skin,init:()=>{window.CHATHAND_SKIN_SWITCHER=false;}}],
    ['URL禁用切换器',{query:'&skin='+skin+'&skinswitch=0'}]
  ])await run(name,options,async({page})=>{const s=await state(page);check(name+'：皮肤有效且关闭无痕',s.skin===skin&&s.main>0&&s.roots===0&&s.skinStyleNodes.length===0,s);});
  await run('删核心',{query:'&skin='+skin,drop:['skin.js']},async({page})=>{const s=await state(page);check('删核心：默认皮肤、业务正常、无切换器',s.skin==='default'&&s.win.toLowerCase()==='#ffffff'&&s.main>0&&s.roots===0,s);});
  await run('storage异常',{saved:skin,init:()=>{Storage.prototype.getItem=function(){throw new Error('fake denied read');};Storage.prototype.setItem=function(){throw new Error('fake denied write');};Storage.prototype.removeItem=function(){throw new Error('fake denied remove');};}},async({page})=>{
   await page.evaluate(async()=>{await ChatHandSkin.set('default');});check('storage异常：set默认正常',(await state(page)).skin==='default');await page.evaluate(async id=>{await ChatHandSkin.set(id);},skin);const s=await state(page);check('storage异常：URL及动态切换正常',s.skin===skin&&s.main>0,s);
  });
  await run('后端保存新窗口',{saved:skin,init:()=>localStorage.setItem('chathand-skin','default')},async({page})=>{
   check('新窗口读取后端保存皮肤且忽略旧localStorage',(await state(page)).skin===skin&&await page.evaluate(id=>document.documentElement.dataset.skinSaved===id,skin));
   await page.evaluate(()=>ChatHandSkin.set('default'));await page.reload();await page.waitForSelector('#main > *');check('刷新后使用已保存默认皮肤',(await state(page)).skin==='default');
   await page.evaluate(id=>ChatHandSkin.set(id),skin);const newWindow=await page.context().browser().newContext();try{const p=await newWindow.newPage();await p.goto(srv.url+'/?s=idle#token');await p.waitForSelector('#main > *');check('全新窗口保持用户保存皮肤',await p.evaluate(id=>ChatHandSkin.current()===id&&document.documentElement.dataset.skinSaved===id,skin));}finally{await newWindow.close();}
  });
  await run('URL优先',{saved:skin,query:'&skin=default&skinswitch=0'},async({page})=>{check('URL参数优先于后端保存选择',(await state(page)).skin==='default');await page.evaluate(id=>ChatHandSkin.set(id),skin);check('URL固定最高优先且点击不保存',(await state(page)).skin==='default'&&srv.log.filter(x=>x.method==='POST'&&x.url==='/api/settings').at(-1)?.body.skin===skin);});
  await run('未知id',{query:'&skin=does-not-exist&skinswitch=0'},async({page})=>{const s=await state(page);check('未知id退默认',s.skin==='default'&&s.win.toLowerCase()==='#ffffff',s);});
  await run('CSS404',{query:'&skin='+skin+'&skinswitch=0',css404:true},async({page})=>{const s=await state(page);check('CSS404静默退默认不空白',s.skin==='default'&&s.win.toLowerCase()==='#ffffff'&&s.main>0,s);});
  await run('API',{saved:skin,query:'&skinswitch=0'},async({page})=>{
   const api=await page.evaluate(()=>({names:['list','current','set','register'].every(k=>typeof ChatHandSkin[k]==='function'),ids:ChatHandSkin.list().map(e=>e.id),links:document.querySelectorAll('link[data-chathand-skin]').length}));check('接口完整且清单包含默认/新皮肤',api.names&&api.ids.includes('default')&&api.ids.includes(skin)&&api.links===1,api);
   const registered=await page.evaluate(async()=>{let count=0;addEventListener('chathand:skin',()=>count++);const accepted=ChatHandSkin.register({id:'test-local-missing',name:'验收用',scheme:'both',css:'/skins/test-local-missing.css',swatch:['#ffffff']});await ChatHandSkin.set('default');return {accepted,count,links:document.querySelectorAll('link[data-chathand-skin]').length};});check('register与切换事件，默认不加载皮肤文件',registered.accepted&&registered.count>0&&registered.links===0,registered);
   const catalog=await page.evaluate(()=>({kept:ChatHandSkin.register({id:'test-with-bd',name:'带背景',css:'/skins/test-with-bd.css',backdrop:'soft'})&&ChatHandSkin.list().find(e=>e.id==='test-with-bd'),badPath:ChatHandSkin.register({id:'test-bad-path',name:'坏路径',css:'/other/test-bad-path.css',backdrop:'liquid'}),badBackdrop:ChatHandSkin.register({id:'test-bad-bd',name:'坏背景',css:'/skins/test-bad-bd.css',backdrop:'Bad Id!'})&&ChatHandSkin.list().find(e=>e.id==='test-bad-bd')}));
   check('清单保留 backdrop，仍校验 /skins/<id>.css',catalog.kept?.backdrop==='soft'&&catalog.kept.css==='/skins/test-with-bd.css'&&catalog.badPath===false&&catalog.badBackdrop&&!('backdrop' in catalog.badBackdrop),catalog);
  });
  await run('模式跟随',{query:'&skin='+skin+'&skinswitch=0'},async({page})=>{
   check('系统浅色',(await state(page)).scheme==='light');await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.scheme==='dark');check('系统动态变深色',(await state(page)).scheme==='dark');await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.waitForTimeout(30);check('手动浅色覆盖系统深色',(await state(page)).scheme==='light');await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.waitForTimeout(30);check('手动深色',(await state(page)).scheme==='dark');await page.emulateMedia({colorScheme:'light'});await page.waitForTimeout(30);check('手动深色不受系统浅色影响',(await state(page)).scheme==='dark');await page.evaluate(()=>delete document.documentElement.dataset.theme);await page.waitForTimeout(30);check('取消手动恢复系统浅色',(await state(page)).scheme==='light');
  });
  await run('减少动态',{query:'&skin='+skin+'&skinswitch=0',reduce:true},async({page})=>{const running=await page.evaluate(()=>[...document.querySelectorAll('body *')].flatMap(e=>[null,'::before','::after'].map(p=>({e:e.tagName+'#'+e.id,p,s:getComputedStyle(e,p)}))).filter(x=>x.s.animationName!=='none'||x.s.transitionDuration.split(',').some(t=>parseFloat(t)>0)).map(x=>({node:x.e,pseudo:x.p,animation:x.s.animationName,transition:x.s.transitionDuration})));check('减少动态：全部产品及伪元素无动画/过渡',running.length===0,running);});
  await run('减少动态·皮肤工具',{saved:skin,reduce:true},async({page})=>{
   await page.locator('[data-skin-action="toggle"]').click();await page.waitForTimeout(150);
   const moving=async()=>page.evaluate(()=>[...document.querySelectorAll('#ch-skin-tools,#ch-skin-tools *')].flatMap(e=>[null,'::before','::after'].map(p=>({e:e.tagName+'.'+e.className,s:getComputedStyle(e,p)}))).filter(x=>x.s.animationName!=='none'||x.s.transitionDuration.split(',').some(t=>parseFloat(t)>0)).map(x=>x.e));
   const a=await moving();check('减少动态：皮肤面板无动画/过渡',!a.length,a);
  });
  await run('静态CSP',{query:'&skin='+skin,csp:true},async({page})=>{
   check('实际静态CSP下首屏皮肤正常',(await state(page)).skin===skin);await page.locator('[data-skin-action="toggle"]').click();await page.waitForTimeout(150);await page.screenshot({path:path.join(OUT,'switcher-open.png'),animations:'disabled'});
   const thumbs=await page.evaluate(()=>[...document.querySelectorAll('.ch-thumb')].map(e=>({loading:e.hasAttribute('data-loading'),win:e.style.getPropertyValue('--win')})));check('实际静态CSP下缩略图读到每个皮肤的颜色',thumbs.length>=3&&thumbs.every(t=>!t.loading&&t.win),thumbs);
   const violations=await page.evaluate(()=>window.__skinCspViolations);check('实际静态CSP下打开面板无拒绝',violations.length===0,violations);
  });
  await run('键盘与选皮肤',{saved:skin,csp:true},async({page})=>{
   const trigger=page.locator('[data-skin-action="toggle"]'),panel=page.locator('#ch-skin-panel');await trigger.focus();await page.keyboard.press('Enter');check('键盘Enter打开面板并进入列表',await panel.isVisible()&&await page.evaluate(()=>document.activeElement.hasAttribute('data-skin-id')));
   await page.keyboard.press('Escape');check('Esc关闭且焦点回按钮',!await panel.isVisible()&&await trigger.evaluate(e=>e===document.activeElement));await trigger.click();
   const last=page.locator('#ch-skin-panel [data-skin-action="select"]').last();await last.focus();await page.keyboard.press('Tab');check('面板Tab末尾回到第一个按钮',await page.locator('[data-skin-action="close"]').evaluate(e=>e===document.activeElement));await page.keyboard.press('Shift+Tab');check('面板Shift+Tab回末尾',await last.evaluate(e=>e===document.activeElement));
   await page.locator('[data-skin-id="default"]').focus();await page.keyboard.press('Enter');await page.waitForTimeout(50);check('键盘选默认皮肤',(await state(page)).skin==='default');await page.locator(`[data-skin-id="${skin}"]`).click();await current(page,skin);check('皮肤列表选中标记正确',await page.locator(`[data-skin-id="${skin}"]`).getAttribute('aria-pressed')==='true');
   await page.dispatchEvent('body','pointerdown');check('点面板外关闭',!await panel.isVisible());
   const violations=await page.evaluate(()=>window.__skinCspViolations);check('实际静态CSP约束下首屏与选皮肤无拒绝',violations.length===0,violations);
  });
  await run('速度曲线',{st:'run',csp:true},async({page})=>{
   const frames=()=>page.evaluate(()=>document.getElementById('tp-spin')?.textContent||'');const deg=(f,pct)=>parseFloat((f.match(new RegExp('(?:^|})'+pct.replace('.','\\.')+'%\\{rotate:([\\d.]+)deg'))||[])[1]);
   const anim=()=>page.evaluate(()=>{const a=document.querySelector('.tp.run .tp-ring')?.getAnimations({subtree:true}).find(x=>x.animationName.startsWith('tpspin'));window.__spinAnim??=a;return {same:a===window.__spinAnim};});await anim();
   let f=await frames();const n=f=>(f.match(/%\{/g)||[]).length;
   check('默认「过山车」：241 帧、最后 360°',n(f)===241&&/100\.000%\{rotate:360\.00deg\}/.test(f),f.slice(-60));
   const speeds=await page.evaluate(()=>{const b=document.querySelector('.tp.run').getBoundingClientRect(),m=window.ChatHandGlowCurve,{v,a}=m.read(getComputedStyle(document.documentElement)),c=m.build(b.width,b.height,v,a),at=x=>c.speed(c.start+x*c.L);let lo=9,lx=0,hi=0,hx=0;for(let k=0;k<200;k++){const s=at(k/200);if(s<lo){lo=s;lx=k/200;}if(s>hi){hi=s;hx=k/200;}}let jump=0;for(let k=0;k<2000;k++)jump=Math.max(jump,Math.abs(at((k+1)/2000)-at(k/2000)));return {lx,hx,ratio:hi/lo,jump};});
   check('过山车：左上角最慢、右边最快，一圈速度连续',speeds.lx<.02&&speeds.hx>.25&&speeds.hx<.55&&speeds.ratio>2.5&&speeds.jump<.05,speeds);
  });
  await run('界面大小',{},async({page})=>{
   await page.evaluate(()=>openDrawer('settings'));await page.waitForTimeout(400);
   const row=await page.locator('.sg.sg-inline').evaluate(e=>{const h=e.querySelector('h4').getBoundingClientRect(),s=e.querySelector('.seg').getBoundingClientRect();return {same:Math.abs((h.top+h.bottom)/2-(s.top+s.bottom)/2)<3,right:s.left>h.right};});
   check('设置里「外观」一行：左边名字、右边按钮；没有「界面大小」',row.same&&row.right&&!await page.locator('[data-action="uiScale"],.ui-scale-seg').count(),row);
   await page.evaluate(()=>window.showZoom(1.125));await page.waitForTimeout(80);check('原生改了大小会提示一句',(await page.locator('#toast').innerText()).includes('界面大小 112.5%'));
  });
  await run('整页滚动',{},async({page})=>{
   await page.setViewportSize({width:980,height:560});await page.waitForTimeout(300);
   const before=await page.evaluate(()=>{const pad=parseFloat(getComputedStyle(document.querySelector('.dash')).paddingTop);setWindowChrome({fullscreen:true});const fs=parseFloat(getComputedStyle(document.querySelector('.dash')).paddingTop);setWindowChrome({fullscreen:false});return {pad,fs,main:getComputedStyle(document.querySelector('#main')).overflowY,rail:getComputedStyle(document.querySelector('#rail')).overflowY,sticky:getComputedStyle(document.querySelector('#rail .rail-stick')).position,railHead:getComputedStyle(document.querySelector('#rail>.col-h')).position,osb:getComputedStyle(document.documentElement).overscrollBehaviorY,tall:document.scrollingElement.scrollHeight>innerHeight,up:document.querySelector('.to-top')?.classList.contains('on')};});
   check('两栏不各自滚，整页滚；右栏卡片停住、标题不停',before.main==='visible'&&before.rail==='visible'&&before.sticky==='sticky'&&before.railHead==='static'&&before.tall,before);
   check('滚到顶、到底不再回弹（overscroll-behavior: none）',before.osb==='none',before);
   check('全屏时顶上和窗口时一样高',before.pad===before.fs&&before.pad>=48,before);
   check('首屏不出「回到顶部」',before.up===false,before);
   await page.mouse.move(400,300);await page.mouse.wheel(0,4000);await page.waitForTimeout(500);
   const after=await page.evaluate(()=>{const r=document.querySelector('#rail .rail-stick').getBoundingClientRect(),head=document.querySelector('#rail>.col-h').getBoundingClientRect(),u=document.querySelector('.to-top').getBoundingClientRect(),t=document.querySelector('[data-skin-action="toggle"]').getBoundingClientRect(),bar=document.querySelector('body>.sbar');return {sy:scrollY,headGone:head.bottom<=48,railBottom:Math.round(r.bottom),railTop:Math.round(r.top),ih:innerHeight,up:document.querySelector('.to-top').classList.contains('on'),above:u.bottom<=t.top-4&&Math.abs(u.left-t.left)<1,bar:!!bar&&!bar.hidden&&bar.classList.contains('on'),strip:getComputedStyle(document.querySelector('.drag-strip'),'::before').opacity};});
   check('滚到底：「设置」标题滚走，卡片停在顶上（或底边露出来停住）',after.sy>0&&after.headGone&&(after.railTop===48||Math.abs(after.railBottom+56-after.ih)<=1),after);
   check('滚下去出「回到顶部」，在皮肤按钮正上方',after.up&&after.above,after);
   check('滚动时右边出细滚动条，顶上一条淡出',after.bar&&after.strip==='1',after);
   await page.click('.to-top');await page.waitForTimeout(900);
   check('点「回到顶部」回到最上面',await page.evaluate(()=>scrollY)===0);
   const still=await page.evaluate(()=>{document.documentElement.style.setProperty('--bg-motion','0');dispatchEvent(new CustomEvent('chathand:fx'));const on=document.documentElement.classList.contains('bg-still');document.documentElement.style.removeProperty('--bg-motion');dispatchEvent(new CustomEvent('chathand:fx'));return {on,off:!document.documentElement.classList.contains('bg-still')};});
   check('背景「动起来」关掉：停住；打开恢复',still.on&&still.off,still);
  });
  await run('缺省图波纹',{},async({page})=>{
   const r=await page.evaluate(async()=>{const host=document.createElement('div');host.id='wave-test';host.style.cssText='position:fixed;left:200px;top:200px';host.innerHTML=emptyIllustration();document.body.append(host);waveApply();
    const rings=[...host.querySelectorAll('.ew-ring')].map(e=>e.getBoundingClientRect().width),art=host.querySelector('.empty-art').getBoundingClientRect().width,gaps=rings.map((w,i)=>(w-(i?rings[i-1]:art))/2);
    const off=[...host.querySelectorAll('.ew-wave')].every(e=>!e.__wave&&!e.getAnimations().length);
    const set=(k,v)=>{document.documentElement.style.setProperty(k,v);dispatchEvent(new CustomEvent('chathand:fx'));};
    const timing=()=>[...host.querySelectorAll('.ew-wave')].filter(e=>e.__wave).map(e=>({start:e.__wave.startTime,delay:e.__wave.effect.getTiming().delay}));
    set('--wave-motion','1');set('--wave-count','2');await new Promise(r=>setTimeout(r,120));set('--wave-count','3');set('--wave-gap','200');set('--wave-trend','1.5');const t=timing();
    for(const k of ['--wave-motion','--wave-count','--wave-gap','--wave-trend'])document.documentElement.style.removeProperty(k);dispatchEvent(new CustomEvent('chathand:fx'));const stopped=[...host.querySelectorAll('.ew-wave')].every(e=>!e.__wave);host.remove();return {gaps,off,t,stopped};});
   check('静止的三圈间距一样',r.gaps.every(g=>Math.abs(g-r.gaps[0])<.5),r.gaps);
   check('波纹默认不动',r.off);
   check('打开后：几道波同一个起点，间隔按「每下间隔」和「间隔变化」排（加一下后也对得上）',r.t.length===3&&r.t.every(x=>x.start===r.t[0].start)&&r.t.map(x=>x.delay).join()==='0,200,500',r.t);
   check('关掉后波纹停',r.stopped);
  });
  await run('槽位',{query:'&skin='+skin,slot:true},async({page})=>{const placed=await page.locator('[data-skin-switcher]').evaluate(e=>({parent:e.parentElement.id,position:getComputedStyle(e).position}));check('有槽位时按钮嵌入槽位',placed.parent==='skin-test-slot'&&placed.position==='static',placed);});
  await run('更新与Toast不重叠',{query:'&skin='+skin+'&update=available'},async({page})=>{
   await page.evaluate(()=>toast('皮肤验收提示'));const overlap=await page.evaluate(()=>{const trigger=document.querySelector('[data-skin-action="toggle"]'),r=trigger.getBoundingClientRect(),hits=[];for(const e of document.querySelectorAll('body button,.bubble,#toast')){if(e.closest('[data-skin-switcher]')||e.hidden||!e.getClientRects().length)continue;const s=getComputedStyle(e),b=e.getBoundingClientRect();if(s.visibility==='hidden'||s.display==='none'||!b.width||!b.height)continue;if(Math.min(r.right,b.right)>Math.max(r.left,b.left)&&Math.min(r.bottom,b.bottom)>Math.max(r.top,b.top))hits.push({tag:e.tagName,id:e.id,text:e.innerText.slice(0,80)});}return {trigger:{x:r.x,y:r.y,width:r.width,height:r.height},hits};});check('按钮与全部可见原按钮、Toast、更新气泡不重叠',overlap.hits.length===0,overlap);await page.screenshot({path:path.join(OUT,'switcher-toast-update.png'),animations:'disabled'});
  });
  check('运行期间无外网资源请求',external.length===0,external);
 }finally{await browser.close();await srv.close();}
 const stable=JSON.stringify(hashes)===JSON.stringify(sourceHashes()),report={skin,sourceHashes:hashes,sourcesStable:stable,ok:stable&&checks.every(c=>c.ok),passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok).length,checks};fs.writeFileSync(path.join(OUT,only.length?'mechanism-extra.json':'mechanism.json'),JSON.stringify(report,null,2));return report;
}
module.exports={mechanismReport};
if(require.main===module)mechanismReport(process.argv.find(a=>a.startsWith('--skin='))?.split('=')[1]||process.env.SKIN||'quiet-titanium').then(r=>{console.log(JSON.stringify({ok:r.ok,passed:r.passed,failed:r.failed,sourcesStable:r.sourcesStable},null,2));if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
