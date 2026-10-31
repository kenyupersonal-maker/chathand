#!/usr/bin/env node
'use strict';
/* 皮肤专用矩阵：仅本机无头 Chrome + 假服务；包含隐藏节点，不改产品布局。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { start } = require('./server');
const { openProduct, launchBrowser } = require('./common');
const { ROOT } = require('./common');
const { STATES } = require('./states');
const OUT = process.env.CHATHAND_UI_OUTPUT ? path.join(process.env.CHATHAND_UI_OUTPUT,'skin') : path.join(process.env.CHATHAND_BUILDS_ROOT || path.join(os.homedir(), 'Developer', 'ChatHand-builds.noindex'), '1012-skin-check');
fs.mkdirSync(OUT,{recursive:true});
const MATRIX = [...STATES, ...Array.from({length:7}, (_, i) => ({name:`wizard-${i}`,scenario:'idle',extra:`&wizard=${i}${i===4?'&test=ok':''}`}))];
const FRAME = ['display','position','boxSizing','width','height','minWidth','maxWidth','minHeight','maxHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','rowGap','columnGap','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','textAlign','whiteSpace','flex','flexDirection','flexWrap','alignItems','justifyContent','gridTemplateColumns','gridTemplateRows','top','right','bottom','left','transform','overflowX','overflowY'];
function sourceHashes(){const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);return Object.fromEntries(walk(path.join(ROOT,'ui')).filter(f=>/\.(css|js|html)$/.test(f)).map(f=>[path.relative(ROOT,f),crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));}
async function snapshot(page) {
  return page.evaluate(props => {
    const excluded = e => !!e.closest('[data-skin-switcher]');
    const all = [...document.querySelectorAll('body *')].filter(e=>!excluded(e));
    const index = new Map(all.map((e,i)=>[e,i]));
    return { skin:window.ChatHandSkin?.current()||'default',theme:document.documentElement.dataset.theme||'system', scheme:document.documentElement.dataset.scheme||null, system:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light', win:getComputedStyle(document.documentElement).getPropertyValue('--win').trim(), nodes:all.map(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return {tag:e.tagName,id:e.id,cls:e.getAttribute('class')||'',resource:e.tagName==='SCRIPT'?e.getAttribute('src'):null,parent:index.get(e.parentElement)??-1,children:[...e.children].filter(c=>index.has(c)).map(c=>index.get(c)),text:[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(''),rect:{x:r.x,y:r.y,width:r.width,height:r.height},frame:Object.fromEntries(props.map(p=>[p,s[p]]))};
    })};
  }, FRAME);
}
async function capture(stage, skin='default', {only=[]}={}) {
  const dir=path.join(OUT,stage);fs.mkdirSync(dir,{recursive:true});
  const hashes=sourceHashes();
  const srv=await start({port:0}),browser=await launchBrowser(),rows=[];
  try {
    for(const theme of ['light','dark'])for(const state of MATRIX){
      const name=`${state.name}-${theme}`;
      if(only.length&&!only.includes(name))continue;
      const {ctx,page}=await openProduct(browser,srv.url,theme,state.scenario,{size:{width:1280,height:860},extra:(state.extra||'')+`&skinswitch=0&skin=${encodeURIComponent(skin)}`,native:true});
      try {
        if(state.prep)await state.prep(page);
        await page.evaluate(async()=>{await document.fonts.ready;for(let i=0;i<100&&typeof refreshing!=='undefined'&&refreshing;i++)await new Promise(r=>setTimeout(r,10));});
        await page.evaluate(async()=>{await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
        await page.waitForTimeout(100);
        const snap=await snapshot(page);
        if(snap.skin!==skin)throw Error(`${name}: 预期皮肤 ${skin}，实际 ${snap.skin}`);
        if(snap.system!==theme || (snap.theme!=='system'&&snap.theme!==theme) || (snap.scheme&&snap.scheme!==theme))throw Error(`${name}: 实际模式错误 ${JSON.stringify({theme:snap.theme,scheme:snap.scheme,system:snap.system})}`);
        fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(snap,null,2));
        await page.screenshot({path:path.join(dir,name+'.png'),animations:'disabled',mask:[page.locator('#wizardTunnel'),page.locator('[data-action="copy"][data-id^="tunnel_"]')]});
        rows.push({name,theme,state:state.name,skin,nodes:snap.nodes.length,win:snap.win,errors:page.errors});
        console.log(`${stage}: ${rows.length}/48 ${name} (${snap.nodes.length} nodes)`);
      }finally{await ctx.close();}
    }
  }finally{await browser.close();await srv.close();}
  const stable=JSON.stringify(hashes)===JSON.stringify(sourceHashes());
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({stage,skin,size:{width:1280,height:860},sourceHashes:hashes,sourcesStable:stable,rows},null,2));
  if(!stable)throw Error('截图期间 UI 源文件有改动；本阶段不能验收，需冻结源文件再拍。');
  return rows;
}
function compareFrames(a,b) {
  const issues=[];let max=0,nodes=0,allowedResourceNodes=0;
  for(const theme of ['light','dark'])for(const state of MATRIX){
    const name=`${state.name}-${theme}`,before=JSON.parse(fs.readFileSync(path.join(OUT,a,name+'.json'))),after=JSON.parse(fs.readFileSync(path.join(OUT,b,name+'.json')));
    if(a==='baseline'){
      const excluded=after.nodes.map((n,i)=>({n,i})).filter(({n})=>n.tag==='SCRIPT'&&n.resource==='/skin-switcher.js');
      if(excluded.length>1)issues.push({name,kind:'extra-skin-entry',count:excluded.length});
      for(const {n} of excluded)if(Object.values(n.rect).some(v=>v!==0)||n.text||n.children.length)issues.push({name,kind:'skin-entry-not-empty'});
      const removed=new Set(excluded.map(x=>x.i)),indices=new Map();after.nodes.forEach((n,i)=>{if(!removed.has(i))indices.set(i,indices.size);});
      after.nodes=after.nodes.filter((n,i)=>!removed.has(i)).map(n=>({...n,parent:n.parent<0?-1:indices.get(n.parent),children:n.children.filter(i=>indices.has(i)).map(i=>indices.get(i))}));allowedResourceNodes+=excluded.length;
    }
    if(before.nodes.length!==after.nodes.length)issues.push({name,kind:'node-count',before:before.nodes.length,after:after.nodes.length});
    for(let i=0;i<Math.min(before.nodes.length,after.nodes.length);i++){
      const x=before.nodes[i],y=after.nodes[i];nodes++;
      for(const k of ['tag','id','cls','parent','children','text'])if(JSON.stringify(x[k])!==JSON.stringify(y[k]))issues.push({name,node:i,kind:k,before:x[k],after:y[k]});
      for(const k of ['x','y','width','height']){const d=Math.abs(x.rect[k]-y.rect[k]);max=Math.max(max,d);if(d>.5)issues.push({name,node:i,id:x.id,kind:'rect.'+k,before:x.rect[k],after:y.rect[k],delta:d});}
      for(const k of FRAME)if(x.frame[k]!==y.frame[k])issues.push({name,node:i,id:x.id,kind:'frame.'+k,before:x.frame[k],after:y.frame[k]});
    }
  }
  const result={before:a,after:b,states:48,nodes,allowedResourceNodes,maxRectDelta:max,limit:.5,ok:issues.length===0,issues};
  fs.writeFileSync(path.join(OUT,`layout-${a}-${b}.json`),JSON.stringify(result,null,2));return result;
}
module.exports={OUT,MATRIX,FRAME,snapshot,capture,compareFrames,sourceHashes};
if(require.main===module)(async()=>{
  const args=process.argv.slice(2),get=(k,d)=>args.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3)||d;
  if(args.includes('--compare')){const r=compareFrames(get('before','baseline'),get('after','extracted'));console.log(JSON.stringify({...r,issues:r.issues.slice(0,10)},null,2));if(!r.ok)process.exitCode=1;}
  else await capture(get('stage','baseline'),get('skin',process.env.SKIN||'default'),{only:get('only','').split(',').filter(Boolean)});
})().catch(e=>{console.error(e);process.exitCode=1;});
