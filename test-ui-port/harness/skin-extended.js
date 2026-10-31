#!/usr/bin/env node
'use strict';
/* 10/3 补充矩阵：仍使用原假服务，仅在这个测试里覆写假状态。基线通过源文件响应覆盖复原，不回写 ui/。 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {start}=require('./server'),fixtures=require('./fixtures');
const {ROOT,NOW,NATIVE_SHIM,FREEZE,FONT_FIX,launchBrowser}=require('./common');
const {OUT,snapshot,sourceHashes,FRAME}=require('./skin-layout');
const EXTRA=[
 {name:'home-connecting',scenario:'offline',extra:'&conn=connecting',assert:'正在连接'},
 {name:'home-paused',scenario:'run',extra:'&paused=1',assert:'暂停'},
 {name:'block-admin',scenario:'run',extra:'&block=admin',assert:'拦下'},
 {name:'update-installing',scenario:'run',extra:'&update=installing',assert:'正在安装'},
 ...[4,5].flatMap(i=>['full','light'].map(tier=>({name:`wizard-${i}-${tier}`,scenario:'idle',extra:`&wizard=${i}&tier=${tier}`,wizard:i,tier}))),
 {name:'scope-menu',scenario:'idle',extra:'',prep:page=>page.evaluate(()=>action('scopeMenu'))}
];
function overlay(state,params){
 if(params.get('conn')==='connecting')state.connection={...state.connection,ready:false,healthy:false,process_running:true,automatic:{phase:'connecting',message:''},control_plane:{...state.connection.control_plane,state:'connecting'}};
 if(params.get('block')==='admin')state.blocks=[{kind:'high_risk',id:'admin',block_id:'skin-test-admin',command:'sudo whoami',task_id:fixtures.IDS.run,times:1}];
 if(params.get('update')==='installing')state.update={...fixtures.updateFor('available'),install:{state:'installing',progress:1,message:'',url:''}};
 if(params.has('tier'))state.mode=params.get('tier')==='full'?'full':'auto';
 return state;
}
async function captureExtra(stage,skin,{baseline=false}={}){
 const dir=path.join(OUT,stage);fs.mkdirSync(dir,{recursive:true});const hashes=sourceHashes(),srv=await start({port:0}),browser=await launchBrowser(),rows=[];
 try{for(const theme of ['light','dark'])for(const st of EXTRA){
  const name=st.name+'-'+theme,ctx=await browser.newContext({viewport:{width:1280,height:860},colorScheme:theme,locale:'zh-CN',timezoneId:'Asia/Shanghai'});await ctx.addInitScript(NATIVE_SHIM);
  const page=await ctx.newPage();await page.clock.setFixedTime(NOW);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==srv.url)return route.abort();
   if(baseline){const file=url.pathname==='/'?'index.html':url.pathname.slice(1);if(['style.css','wizard.css','app.js','index.html','task-widget.html'].includes(file))return route.fulfill({status:200,contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(path.join(OUT,'sources',file),'utf8')});}
   if(url.pathname==='/api/state'){const response=await route.fetch(),body=await response.json(),params=new URL(route.request().headers().referer).searchParams;return route.fulfill({response,json:overlay(body,params)});}return route.continue();
  });
  try{
   await page.goto(`${srv.url}/?s=${st.scenario}&now=${NOW}${st.extra}&skin=${skin}&skinswitch=0#token`);await page.addStyleTag({content:FREEZE+FONT_FIX});await page.waitForSelector('#main > *');
   if(st.prep)await st.prep(page);
   await page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<100&&refreshing;i++)await new Promise(r=>setTimeout(r,10));});await page.waitForTimeout(100);
   const verified=await page.evaluate(({assert,wizard,tier})=>({text:!assert||document.body.innerText.includes(assert),wizard:wizard===undefined||Number(document.querySelector('.setup-step.current')?.textContent.trim().slice(0,1))===wizard+1,tier:tier===undefined||S.mode===(tier==='full'?'full':'auto'),skin:window.ChatHandSkin?.current()||'default'}),{assert:st.assert,wizard:st.wizard,tier:st.tier});
   if(Object.entries(verified).some(([k,v])=>k!=='skin'&&!v)||verified.skin!==(baseline?'default':skin)||errors.length)throw Error(name+':状态未到达 '+JSON.stringify({verified,errors}));
   const snap=await snapshot(page);fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(snap,null,2));await page.screenshot({path:path.join(dir,name+'.png'),animations:'disabled',mask:[page.locator('#wizardTunnel'),page.locator('[data-action="copy"][data-id^="tunnel_"]')]});rows.push({name,state:st.name,theme,urlParameters:`?s=${st.scenario}${st.extra}`,preparation:st.name==='scope-menu'?"action('scopeMenu')":'假服务状态覆盖',verified,nodes:snap.nodes.length});console.log(`${stage} ${rows.length}/${EXTRA.length*2} ${name}`);
  }finally{await ctx.close();}
 }}finally{await browser.close();await srv.close();}
 const stable=JSON.stringify(hashes)===JSON.stringify(sourceHashes());const report={stage,skin,baselineRestoredFromOriginalFiveFiles:baseline,sourceHashes:hashes,baselineHashes:baseline?JSON.parse(fs.readFileSync(path.join(OUT,'source-hashes.json'))):null,sourcesStable:stable,rows};fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(report,null,2));if(!stable)throw Error('补矩阵期间 UI 源改变');return report;
}
async function compareExtra(a,b){
 const issues=[],pixels=[],browser=await launchBrowser();let max=0,nodes=0;
 try{const page=await browser.newPage();for(const theme of ['light','dark'])for(const st of EXTRA){const name=st.name+'-'+theme,x=JSON.parse(fs.readFileSync(path.join(OUT,a,name+'.json'))),y=JSON.parse(fs.readFileSync(path.join(OUT,b,name+'.json')));
  if(a==='baseline-extra'){const remove=new Set(y.nodes.map((n,i)=>n.tag==='SCRIPT'&&n.resource==='/skin-switcher.js'?i:-1).filter(i=>i>=0)),idx=new Map();y.nodes.forEach((n,i)=>{if(!remove.has(i))idx.set(i,idx.size)});y.nodes=y.nodes.filter((n,i)=>!remove.has(i)).map(n=>({...n,parent:n.parent<0?-1:idx.get(n.parent),children:n.children.filter(i=>idx.has(i)).map(i=>idx.get(i))}));}
  if(x.nodes.length!==y.nodes.length)issues.push({name,kind:'node-count',before:x.nodes.length,after:y.nodes.length});
  for(let i=0;i<Math.min(x.nodes.length,y.nodes.length);i++){nodes++;const p=x.nodes[i],q=y.nodes[i];for(const k of ['tag','id','cls','parent','children','text'])if(JSON.stringify(p[k])!==JSON.stringify(q[k]))issues.push({name,node:i,kind:k});for(const k of ['x','y','width','height']){const d=Math.abs(p.rect[k]-q.rect[k]);max=Math.max(max,d);if(d>.5)issues.push({name,node:i,kind:k,delta:d});}for(const k of FRAME)if(p.frame[k]!==q.frame[k])issues.push({name,node:i,kind:'frame.'+k,before:p.frame[k],after:q.frame[k]});}
  if(a==='baseline-extra'){const imgs=[a,b].map(d=>'data:image/png;base64,'+fs.readFileSync(path.join(OUT,d,name+'.png')).toString('base64'));const pixel=await page.evaluate(async imgs=>{const im=await Promise.all(imgs.map(src=>new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(img);img.src=src;}))),c=document.createElement('canvas');c.width=im[0].width;c.height=im[0].height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(im[0],0,0);const a=ctx.getImageData(0,0,c.width,c.height).data;ctx.drawImage(im[1],0,0);const b=ctx.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])n++;return {changed:n,total:c.width*c.height,percent:n/(c.width*c.height)*100};},imgs);pixels.push({name,...pixel,ok:pixel.percent<=.02});}
 }}finally{await browser.close();}
 const report={before:a,after:b,states:EXTRA.length*2,nodes,maxRectDelta:max,layoutOk:!issues.length,issues,pixels,pixelsOk:pixels.every(p=>p.ok),maxPixelPercent:pixels.length?Math.max(...pixels.map(p=>p.percent)):null};fs.writeFileSync(path.join(OUT,`extended-${a}-${b}.json`),JSON.stringify(report,null,2));return report;
}
module.exports={EXTRA,captureExtra,compareExtra};
if(require.main===module)(async()=>{const get=(k,d)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=')[1]||d;if(process.argv.includes('--compare')){const r=await compareExtra(get('before','baseline-extra'),get('after','default-extra'));console.log(JSON.stringify({...r,pixels:r.pixels.filter(x=>!x.ok)},null,2));if(!r.layoutOk||!r.pixelsOk)process.exitCode=1;}else await captureExtra(get('stage','baseline-extra'),get('skin','default'),{baseline:process.argv.includes('--baseline')});})().catch(e=>{console.error(e);process.exitCode=1;});
