/* Offline installation-page checks. Navigation assignments and clipboard calls
   are intercepted in headless Chrome; no desktop app or live service is used. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createDmgText} from './localize.mjs';

const assetRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(assetRoot,'../../..');
const args=process.argv.slice(2),options={locale:'zh',assetsDir:assetRoot};
for(let i=0;i<args.length;i+=2){
 if(!['--assets-dir','--locale'].includes(args[i])||!args[i+1])throw Error('DMG_VERIFY_ARGS_INVALID');
 options[args[i]==='--locale'?'locale':'assetsDir']=args[i+1];
}
const text=createDmgText({locale:options.locale}),assets=path.resolve(options.assetsDir);
const locationToken=text.text('ui.h10.prompts.downloadLocationPlaceholder');
const INSTALL_PROMPT_TEMPLATE=text.text('ui.h10.prompts.installPrompt',{location:locationToken});
const output=process.env.CHATHAND_INSTALL_CHECK_OUTPUT||path.join(os.homedir(),'KenBridge','Artifacts','chathand-v1','1012-install-check');
const after=path.join(output,'after',...(options.locale==='zh'?[]:[options.locale]));fs.mkdirSync(after,{recursive:true});
const pages={jump:'让 ChatGPT 来装.html','first-open':'第一次打开.html'};
const command=fs.readFileSync(path.join(assetRoot,'src/install-command.txt'),'utf8').trim();
const hints={goOk:text.text('dmg.prompt.openCopied'),goFail:text.text('dmg.prompt.openCopyManually'),copyOk:text.text('dmg.prompt.copiedHint'),copyFail:text.text('dmg.prompt.copyFailedHint')};
const report={A:[],B:[],D:[],E:{},F:{},G:[]};
const b=await chromium.launch({executablePath:process.env.CHATHAND_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});

async function open(slug,{theme='light',width=1100,clipboard=true,exec=true,reducedMotion='no-preference',mounted=false,loopback=false}={}){
 const context=await b.newContext({colorScheme:theme,reducedMotion,viewport:{width,height:760},deviceScaleFactor:2});
 await context.addInitScript(({clipboard,exec})=>{
  window.__installCheck={clipboard,exec,events:[],timers:[]};
  window.__installNavigation={set href(text){window.__installCheck.events.push({type:'navigate',text,time:performance.now()})}};
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__installCheck.events.push({type:'clipboard',text});if(!window.__installCheck.clipboard)throw Error('clipboard denied')}}});
  document.execCommand=type=>{window.__installCheck.events.push({type:'exec',text:document.activeElement?.value,command:type});return window.__installCheck.exec};
  const timer=window.setTimeout;window.setTimeout=(fn,delay,...args)=>{if(fn?.name==='openCodex')window.__installCheck.timers.push({name:fn.name,delay,start:performance.now()});return timer(fn,delay,...args)};
  for(const fn of ['print','alert','open'])window[fn]=()=>{throw Error('Unexpected '+fn)};
 },{clipboard,exec});
 const file=path.join(assets,pages[slug]),app=mounted?'/Volumes/ChatHand ISOLATED VERIFY/ChatHand.app':null,url=mounted?pathToFileURL('/Volumes/ChatHand ISOLATED VERIFY/'+pages[slug]).href:loopback?'http://127.0.0.1:41989/'+encodeURIComponent(pages[slug]):pathToFileURL(file).href;
 await context.route('**/*',route=>route.request().url()===url?route.fulfill({contentType:'text/html',body:fs.readFileSync(file,'utf8').replaceAll('location.href=','window.__installNavigation.href=')}):route.continue());
 const page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});page.on('request',r=>requests.push(r.url()));
 await page.goto(url);
 return {context,page,errors,requests,app,url};
}

// 1084（Ken 10/29）：文字颜色只看「同一档同一个色值」，不再按对比度卡。每段字必须是主窗口的某一档
// （--ink 三档、--accent、--accent-ink、绿字 --g-ink、橙字 --o-ink），或者薄荷绿底上的白字。
// 各档的色值从 h10-offline-theme.css（跟主窗口 ui/style.css 同一套值）在同一个 Chrome 里现取，深浅色各一份。
const TIER_NAMES=['--ink','--ink-2','--ink-3','--accent','--accent-ink','--g-ink','--o-ink'];
async function appTiers(theme){
 const context=await b.newContext({colorScheme:theme}),page=await context.newPage();
 await page.setContent('<style>'+fs.readFileSync(path.join(assetRoot,'src/h10-offline-theme.css'),'utf8')+'</style><i></i>');
 const tiers=await page.evaluate(names=>{
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),probe=document.querySelector('i'),out={};
  for(const name of names){probe.style.color='var('+name+')';ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(probe).color;ctx.fillRect(0,0,1,1);out[name]=Array.from(ctx.getImageData(0,0,1,1).data).map((x,i)=>i===3?x/255:x)}
  out.white=[255,255,255,1];return out;
 },TIER_NAMES);
 await context.close();return tiers;
}
const tiers={light:await appTiers('light'),dark:await appTiers('dark')};
report.tiers=tiers;

async function palette(page,label){
 const result=await page.evaluate(tiers=>{
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  function rgba(text){ctx.clearRect(0,0,1,1);ctx.fillStyle=text;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data).map((x,i)=>i===3?x/255:x)}
  const allowed=tiers[matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'];
  const tierOf=c=>Object.keys(allowed).find(k=>allowed[k].every((v,i)=>Math.abs(v-c[i])<=(i===3?.01:2)))||null;
  const rows=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode()){
   const text=node.textContent.trim(),el=node.parentElement;
   if(!text||el.closest('script,style,svg,.sr'))continue;
   const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect(),style=getComputedStyle(el);
   if(!rect.width||!rect.height||style.visibility==='hidden')continue;
   let opacity=1;for(let x=el;x;x=x.parentElement)opacity*=Number(getComputedStyle(x).opacity);
   const color=rgba(style.color);color[3]*=opacity;
   rows.push({text:text.slice(0,70),color,fontSize:style.fontSize,tier:tierOf(color)});
  }
  return {tiers:[...new Set(rows.map(x=>x.tier).filter(Boolean))],failures:rows.filter(x=>!x.tier),rows};
 },tiers);
 // Collect all independent checks before reporting failures.
 report.D.push({label,...result});
}

try{
 // A and D: full matrix, with normal and fully expanded disclosures.
 for(const theme of ['light','dark'])for(const width of [520,760,1100])for(const slug of Object.keys(pages)){
  const t=await open(slug,{theme,width}),p=t.page;
  await p.screenshot({path:path.join(after,`${slug}-${theme}-${width}.png`),fullPage:true});
  const layout=await p.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,heroBottom:document.querySelector('.hero')?.getBoundingClientRect().bottom,folds:[...document.querySelectorAll('main>details')].map(x=>x.open)}));
  assert.equal(layout.scrollWidth,layout.clientWidth);assert.ok(layout.folds.every(x=>!x));
  if(slug==='first-open'&&width===1100)assert.ok(layout.heroBottom<760);
  await palette(p,`${slug}-${theme}-${width}`);
  await p.evaluate(()=>{document.querySelectorAll('details').forEach(x=>x.open=true)});
  await p.screenshot({path:path.join(after,`${slug}-${theme}-${width}-expanded.png`),fullPage:true});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width);
  await palette(p,`${slug}-${theme}-${width}-expanded`);
  assert.deepEqual(t.errors,[]);assert.deepEqual(t.requests.filter(x=>!/^file:|^data:/.test(x)),[]);
  report.A.push({slug,theme,width,...layout,consoleErrors:t.errors,externalRequests:0,expandedOverflow:false});await t.context.close();
 }
 // B: real DOM click handlers, tested with clipboard success, denial/fallback,
 // and failure of both copy paths. The only script substitution is href's sink.
 for(const mode of [{name:'clipboard',clipboard:true,exec:true},{name:'exec-fallback',clipboard:false,exec:true},{name:'both-fail',clipboard:false,exec:false}]){
  const ok=mode.clipboard||mode.exec,t=await open('jump',{...mode,mounted:true}),p=t.page,prompt=INSTALL_PROMPT_TEMPLATE.replace(locationToken,()=>t.app),link='codex://new?prompt='+encodeURIComponent(prompt)+'&mode=codex';
  await p.waitForTimeout(430);
  const auto=await p.evaluate(()=>window.__installCheck);
  assert.equal(auto.timers.length,1);assert.equal(auto.timers[0].delay,300);
  assert.equal(auto.events.filter(x=>x.type==='navigate').length,1);assert.equal(auto.events[0].text,link);
  const elapsed=auto.events[0].time-auto.timers[0].start;
  assert.ok(elapsed>=280&&elapsed<420,`300ms timer fired after ${elapsed}ms`);
  await p.locator('#go').click();
  assert.equal(await p.locator('#after').innerText(),ok?hints.goOk:hints.goFail);
  const clicked=await p.evaluate(()=>window.__installCheck.events);
  assert.equal(clicked.at(-1).type,'navigate');assert.equal(clicked.at(-1).text,link);
  assert.ok(clicked.some(x=>x.type==='clipboard'&&x.text===prompt));
  if(!mode.clipboard)assert.ok(clicked.some(x=>x.type==='exec'&&x.text===prompt));
  if(!ok)assert.equal(await p.locator('#promptDetails').evaluate(x=>x.open),true);
  const count=clicked.filter(x=>x.type==='navigate').length;
  await p.locator('#copy').click();
  assert.equal(await p.locator('#after').innerText(),ok?hints.copyOk:hints.copyFail);
  assert.equal(await p.evaluate(()=>window.__installCheck.events.filter(x=>x.type==='navigate').length),count);
  if(ok){assert.equal(await p.locator('#copy .lbl').innerText(),text.text('dmg.copied'));await p.waitForTimeout(1650);assert.equal(await p.locator('#copy .lbl').innerText(),text.text('dmg.prompt.copyAndSend'))}
  await palette(p,`jump-${mode.name}-result`);
  report.B.push({page:'jump',mode:mode.name,scheduledAutoMs:300,measuredAutoMs:elapsed,autoAttempts:1,mainCopiesBeforeNavigation:true,copyOnlyDoesNotNavigate:true,failureOpensPrompt:!ok,events:await p.evaluate(()=>window.__installCheck.events)});
  assert.deepEqual(t.errors,[]);await t.context.close();

  const u=await open('first-open',{...mode,mounted:true}),q=u.page;
  assert.equal(await q.locator('#cmd').textContent(),command);
  await q.locator('#copybtn').click();
  assert.equal(await q.locator('#copybtn .lbl').innerText(),ok?text.text('dmg.firstOpen.commandCopied'):text.text('dmg.firstOpen.commandCopyFailed'));
  const copied=await q.evaluate(()=>window.__installCheck.events);
  assert.ok(copied.some(x=>x.type===(mode.clipboard?'clipboard':'exec')&&x.text===command));
  assert.equal(await q.locator('#cmd').isVisible(),true); // 1068 起命令框常开（不再是折叠的 details），复制失败时下面一行照旧把命令选中
  if(!ok)assert.equal(await q.evaluate(()=>getSelection().toString()),command);
  await q.locator('.alt>summary').click();await q.locator('[data-open]').click();
  assert.equal(await q.locator('#codexhint').innerText(),ok?hints.goOk:hints.goFail);
  const linkEvents=await q.evaluate(()=>window.__installCheck.events);
  assert.equal(linkEvents.at(-1).type,'navigate');assert.equal(linkEvents.at(-1).text,link);
  if(!ok)assert.equal(await q.locator('#promptDetails').evaluate(x=>x.open),true);
  if(ok){assert.equal(await q.locator('[data-open] .lbl').innerText(),text.text('dmg.copied'));await q.waitForTimeout(1650);assert.equal(await q.locator('[data-open] .lbl').innerText(),text.text('dmg.firstOpen.openAndFill'))}
  await q.locator('#promptDetails').evaluate(x=>x.open=true);await q.locator('#promptDetails [data-copy]').click();
  assert.equal(await q.locator('#codexhint').innerText(),ok?hints.copyOk:hints.copyFail);
  assert.equal(await q.evaluate(()=>window.__installCheck.events.filter(x=>x.type==='navigate').length),1);
  await palette(q,`first-open-${mode.name}-result`);
  report.B.push({page:'first-open',mode:mode.name,commandMatchesTask:true,copyFailureSelectsCommand:!ok,deepLinkExact:true,copyOnlyDoesNotNavigate:true,failureOpensPrompt:!ok,events:await q.evaluate(()=>window.__installCheck.events)});
  assert.deepEqual(u.errors,[]);await u.context.close();
 }
 // E: document/Finder icon layers use PNGs converted from the real ICNS files.
 const iconsDir=path.join(after,'converted-icons');fs.mkdirSync(iconsDir,{recursive:true});
 const iconFiles={jump:path.join(assets,'codexdoc.icns'),app:path.join(root,'ui/assets/app/AppIcon.icns'),applications:'/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/ApplicationsFolderIcon.icns',help:path.join(assets,'helpdoc.icns')};
 const images={};
 for(const [key,file] of Object.entries(iconFiles)){
  const png=path.join(iconsDir,key+'.png');execFileSync('/usr/bin/sips',['-s','format','png',file,'--out',png],{stdio:'ignore'});images[key]='data:image/png;base64,'+fs.readFileSync(png).toString('base64');
 }
 const layout=JSON.parse(fs.readFileSync(path.join(assetRoot,'src/finder-layout.json'))),keys=['jump','app','applications','help'];
 const labels=[text.text('dmg.entry').replace(/\.html$/,''),'ChatHand',text.text('dmg.applications'),text.text('dmg.help').replace(/\.html$/,'')];
 const positions=Object.entries(layout.icon_centers).map(([_name,[x,y]],i)=>({key:keys[i],name:labels[i],x,y}));
 const disk=await b.newPage({viewport:{width:698,height:718},deviceScaleFactor:2});
 await disk.goto(pathToFileURL(path.join(assets,'background.html')).href);
 const clearances=await disk.evaluate(positions=>{
  const ctx=document.createElement('canvas').getContext('2d');ctx.font='12px -apple-system';
  const reserved=positions.flatMap(p=>{const half=(ctx.measureText(p.name).width+8)/2;return [{name:p.key+'-icon',left:p.x-32,top:p.y-32,right:p.x+32,bottom:p.y+32},{name:p.key+'-label',left:p.x-half,top:p.y+34,right:p.x+half,bottom:p.y+54}]});
  const distance=(a,z)=>Math.hypot(Math.max(a.left-z.right,z.left-a.right,0),Math.max(a.top-z.bottom,z.top-a.bottom,0));
  const objects=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode()){if(!node.textContent.trim()||node.parentElement.closest('style,script'))continue;const r=document.createRange();r.selectNodeContents(node);const box=r.getBoundingClientRect();if(box.width&&box.height)objects.push({name:node.textContent.trim(),left:box.left,top:box.top,right:box.right,bottom:box.bottom})}
  for(const selector of ['.logo','.curl','.drag']){const box=document.querySelector(selector).getBoundingClientRect();objects.push({name:selector,left:box.left,top:box.top,right:box.right,bottom:box.bottom})}
  for(const selector of ['.a','.b','.tile']){const r=document.querySelector(selector).getBoundingClientRect();for(const [name,box] of Object.entries({top:{left:r.left,top:r.top,right:r.right,bottom:r.top+1},bottom:{left:r.left,top:r.bottom-1,right:r.right,bottom:r.bottom},left:{left:r.left,top:r.top,right:r.left+1,bottom:r.bottom},right:{left:r.right-1,top:r.top,right:r.right,bottom:r.bottom}}))objects.push({name:selector+'-'+name,...box})}
  return objects.map(o=>({object:o.name,gap:Math.min(...reserved.map(z=>distance(o,z)))}));
 },positions);
 assert.ok(clearances.every(x=>x.gap>=8),`Icon or label clearance below8pt: ${JSON.stringify(clearances.filter(x=>x.gap<8))}`);
 await disk.evaluate(({positions,images})=>{for(const p of positions){const item=document.createElement('div');item.className='finder-item';item.innerHTML=`<img alt="" src="${images[p.key]}" style="position:absolute;left:${p.x-32}px;top:${p.y-32}px;width:64px;height:64px"><span style="position:absolute;left:${p.x-68}px;top:${p.y+34}px;width:136px;height:20px;display:grid;place-items:center;font:12px/20px -apple-system;color:var(--ink);white-space:nowrap">${p.name}</span>`;document.body.appendChild(item)}},{positions,images});
 await disk.screenshot({path:path.join(after,'disk-source-icns-composite-698x718.png')});
 await disk.close();report.E={kind:'source ICNS synthetic composite, not mounted Finder or packaged App acceptance',minIconLabelClearancePt:Math.min(...clearances.map(x=>x.gap)),clearances,contentSize:[698,718],retinaSize:[1396,1436],pngDpi:[72,144]};
 // F: iconutil round-trip verifies that both ICNS containers carry every size.
 const names=['icon_16x16.png','icon_16x16@2x.png','icon_32x32.png','icon_32x32@2x.png','icon_128x128.png','icon_128x128@2x.png','icon_256x256.png','icon_256x256@2x.png','icon_512x512.png','icon_512x512@2x.png'];
 for(const kind of ['codexdoc','helpdoc']){
  const decoded=path.join(iconsDir,kind+'.iconset');fs.rmSync(decoded,{recursive:true,force:true});execFileSync('/usr/bin/iconutil',['-c','iconset',path.join(assets,kind+'.icns'),'-o',decoded]);assert.deepEqual(fs.readdirSync(decoded).sort(),names.sort());report.F[kind]=names;
 }
 const iconPreview=await b.newPage({viewport:{width:660,height:360},deviceScaleFactor:2});
 const tiles=['codexdoc','helpdoc'].map(kind=>`<div style="display:flex;gap:32px;align-items:center;padding:22px 30px">${[16,32,128].map(size=>`<div style="display:flex;gap:12px;align-items:center"><img style="width:${size}px;height:${size}px" src="data:image/png;base64,${fs.readFileSync(path.join(assets,kind+'.iconset',`icon_${size}x${size}.png`)).toString('base64')}"><span style="font:12px -apple-system;color:#5F6661">${size}px</span></div>`).join('')}</div>`).join('');
 await iconPreview.setContent(`<body style="margin:0;background:#F7F8F7">${tiles}</body>`);await iconPreview.screenshot({path:path.join(after,'document-icons-16-32-128.png')});await iconPreview.close();
 // G: raw pages contain no external URL, forbidden old blue, or hard-coded rgba.
 for(const [name,file] of [...Object.entries(pages),['background','background.html']]){
  const html=fs.readFileSync(path.join(assets,file),'utf8');
  for(const forbidden of ['#1F6FEB','http://','https://','window.print','alert(',...(name==='background'?[]:['rgba('])])assert.ok(!html.includes(forbidden),`${name}: forbidden ${forbidden}`);
  const p=await b.newPage();await p.addInitScript(()=>{const timer=window.setTimeout;window.setTimeout=(fn,d,...a)=>fn?.name==='openCodex'?0:timer(fn,d,...a)});await p.goto(pathToFileURL(path.join(assets,file)).href);const visible=await p.locator('body').innerText();if(name==='jump'){assert.ok(visible.includes(text.text('dmg.jump.instructions')));assert.ok(visible.includes(text.text('dmg.prompt.copyAndSend')));}else assert.ok(!visible.includes('Codex'));await p.close();
  report.G.push({name,externalUrls:0,oldBlue:0,hardCodedRgba:(html.match(/rgba\(/g)||[]).length,visibleCodex:(visible.match(/Codex/g)||[]).length});
 }
 for(const mode of [{},{loopback:true}]){const t=await open('jump',mode);await t.page.waitForTimeout(430);assert.equal(await t.page.evaluate(()=>window.__installCheck.events.filter(x=>x.type==='navigate').length),0);assert.equal(await t.page.evaluate(()=>window.__installCheck.timers.length),0);assert.ok((await t.page.locator('body').innerText()).includes(text.text('dmg.localWorkWebWarning')));report.B.push({page:'jump',mode:mode.loopback?'loopback':'ordinary-file',automaticAttempts:0});await t.context.close();}
 const reduced=await open('jump',{reducedMotion:'reduce'});
 report.reducedMotion=await reduced.page.evaluate(()=>{const s=getComputedStyle(document.querySelector('.flow'),'::after');return {animationName:s.animationName,display:s.display}});
 assert.equal(report.reducedMotion.animationName,'none');assert.equal(report.reducedMotion.display,'none');await reduced.context.close();
 fs.writeFileSync(path.join(after,'verification.json'),JSON.stringify(report,null,2)+'\n');
 assert.ok(report.D.every(x=>x.failures.length===0),'text color outside the app text tiers; full findings retained in verification.json');
 console.log(JSON.stringify({A:report.A.length,B:report.B.length,textTiers:[...new Set(report.D.flatMap(x=>x.tiers))],E:report.E.minIconLabelClearancePt,F:Object.keys(report.F),G:report.G.length,output:after},null,2));
}finally{await b.close()}
