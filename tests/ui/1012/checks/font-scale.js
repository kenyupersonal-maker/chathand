'use strict';
const {assert,out,launch,open,save}=require('./ui2-common');
function textMetrics(){
 const bad=[],textBoxes=[],clipping=['auto','scroll','hidden','clip'];
 const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return e.checkVisibility({contentVisibilityAuto:true})&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!e.closest('[hidden],[aria-hidden="true"]')&&!e.closest('#app')?.inert;};
 const port=e=>{const r=e.getBoundingClientRect(),left=r.left+e.clientLeft,top=r.top+e.clientTop;return{left,top,right:left+e.clientWidth,bottom:top+e.clientHeight};};
 // Collisions concern currently painted content; offscreen scroll content remains
 // eligible for the separate reachability/clipping check below.
 function visibleRect(rect,e){
  const v={left:Math.max(0,rect.left),top:Math.max(0,rect.top),right:Math.min(innerWidth,rect.right),bottom:Math.min(innerHeight,rect.bottom)};
  for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a),box=port(a);if(clipping.includes(s.overflowX)){v.left=Math.max(v.left,box.left);v.right=Math.min(v.right,box.right);}if(clipping.includes(s.overflowY)){v.top=Math.max(v.top,box.top);v.bottom=Math.min(v.bottom,box.bottom);}}
  return v.right>v.left&&v.bottom>v.top?v:null;
 }
 // Buttons may be inside a sibling wrapper (open-actions/tut-head). Restrict
 // comparisons to painted rectangles rather than only direct sibling tags.
 const controls=[...document.querySelectorAll('button,input,select,svg,img')].filter(shown).map(e=>({e,box:visibleRect(e.getBoundingClientRect(),e)})).filter(c=>c.box);
 for(const e of document.querySelectorAll('body *')){
  if(!shown(e))continue;const style=getComputedStyle(e);
  if(style.textOverflow==='ellipsis'&&(e.title||e.closest('[title]')))continue;
  for(const node of e.childNodes){if(node.nodeType!==3||!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);
   for(const text of range.getClientRects()){
    if(!text.width||!text.height)continue;const label=node.textContent.trim().slice(0,60),reachable={left:text.left,right:text.right,top:text.top,bottom:text.bottom};textBoxes.push({text:label,...reachable});
    for(let a=e;a;a=a.parentElement){const s=getComputedStyle(a),box=port(a);
     // A scrollable axis can bring content into its viewport. Project to that
     // viewport, then still validate every higher hidden/clip ancestor.
     if(['auto','scroll'].includes(s.overflowX)&&a.scrollWidth>a.clientWidth){reachable.left=box.left;reachable.right=box.right;}
     if(['auto','scroll'].includes(s.overflowY)&&a.scrollHeight>a.clientHeight){reachable.top=box.top;reachable.bottom=box.bottom;}
     if(['hidden','clip'].includes(s.overflowX)&&(reachable.left<box.left-1||reachable.right>box.right+1)||['hidden','clip'].includes(s.overflowY)&&(reachable.top<box.top-1||reachable.bottom>box.bottom+1))bad.push({text:label,kind:'clipped',ancestor:a.tagName+'.'+a.className,reachable:{...reachable},clip:box});
    }
    const area=e.closest('.setup-rail,.setup-main,.col,#drawerBody')?.getBoundingClientRect();
    if(reachable.left<(area?.left??0)-1||reachable.right>(area?.right??innerWidth)+1)bad.push({text:label,kind:'outside-region',left:reachable.left,right:reachable.right,available:area?{left:area.left,right:area.right}:{left:0,right:innerWidth}});
    const painted=visibleRect(text,e);if(!painted)continue;
    for(const{e:control,box}of controls){if(control===e||control.contains(e)||e.contains(control))continue;const ox=[Math.max(painted.left,box.left),Math.min(painted.right,box.right)],oy=[Math.max(painted.top,box.top),Math.min(painted.bottom,box.bottom)];if(ox[1]>ox[0]+1&&oy[1]>oy[0]+1){/* 只在控件真的盖在文字上面时才算重叠；浮在卡片上的提示气泡（文字在上层）不算 */const hit=document.elementFromPoint((ox[0]+ox[1])/2,(oy[0]+oy[1])/2);if(hit&&!control.contains(hit)&&(e.contains(hit)||hit.contains(e)||!hit.closest('button,input,select,svg,img')))continue;bad.push({text:label,kind:'overlaps-control',control:control.tagName,controlClass:control.className?.baseVal??control.className,textRect:painted,controlRect:box});}}
   }
  }
 }
 return{pageOverflow:document.documentElement.scrollWidth>innerWidth,bad,textBoxes};
}
async function enlarge(page){return page.evaluate(()=>{const all=[...document.querySelectorAll('body *')],sizes=all.map(e=>parseFloat(getComputedStyle(e).fontSize));for(let i=0;i<all.length;i++)all[i].style.fontSize=(sizes[i]*1.6)+'px';return sizes.length;});}
async function canaries(browser){
 const page=await browser.newPage({viewport:{width:320,height:200}}),rows=[];
 try{for(const[name,html,kind]of[
  ['closed-details','<details><summary>Summary</summary><div style="margin-top:240px">Hidden tutorial</div></details>',null],
  ['accessible-vertical-scroll','<div style="height:80px;overflow-y:auto"><div style="height:240px"></div><span>Reachable text</span></div>',null],
  ['accessible-horizontal-scroll','<div class="setup-main" style="width:80px;overflow-x:auto"><span style="white-space:nowrap">Scrollable long text</span></div>',null],
  ['clipped-scrollport','<div style="position:relative;width:300px;height:30px;overflow:hidden"><div style="position:absolute;top:40px;width:300px;height:100px;overflow-y:auto"><span>Unreachable text</span><div style="height:180px"></div></div></div>','clipped'],
  ['wrapped-button-overlap','<div style="position:relative;height:60px"><span>Text under button</span><div style="position:absolute;left:0;top:0"><button>Button</button></div></div>','overlaps-control'],
  ['ordinary-text-clip','<div style="width:70px;height:50px;overflow:hidden"><span style="white-space:nowrap">Actually clipped long text</span></div>','clipped']
 ]){await page.setContent('<style>html,body{margin:0;height:100%;overflow:hidden}</style>'+html);await enlarge(page);const metrics=await page.evaluate(textMetrics),ok=kind?metrics.bad.some(b=>b.kind===kind):!metrics.pageOverflow&&!metrics.bad.length&&(name!=='closed-details'||!metrics.textBoxes.some(b=>b.text==='Hidden tutorial'));rows.push({name,expected:kind||'no failure',metrics,ok});}}
 finally{await page.close();save('font-canary.json',rows);}
 const failed=rows.filter(r=>!r.ok);console.log(JSON.stringify({name:'font-canary',passed:rows.length-failed.length,total:rows.length,failed}));assert.equal(failed.length,0);
}
(async()=>{const browser=await launch(),rows=[];try{
 await canaries(browser);
 for(const theme of ['light','dark'])for(const[w,h]of [[1280,860],[980,680]])for(const[name,q]of [['home','task=run'],['tier','wizard=4'],['open','wizard=5&perm=none&chrome=none']]){
  const t=await open(browser,q,{theme,w,h});try{
   const fonts=await enlarge(t.page);
   await t.page.waitForTimeout(100);
   // Inline text may legitimately extend its own width (e.g. mixed CJK/Latin bold).
   // Measure actual text against visible region, clipping ancestors and adjacent controls.
   const metrics=await t.page.evaluate(textMetrics);
   const row={name,theme,w,h,fontScale:1.6,fonts,metrics,errors:t.errors,ok:!metrics.pageOverflow&&!metrics.bad.length&&!t.errors.length};rows.push(row);await t.page.screenshot({path:out+'/after/font-1.6-'+name+'-'+theme+'-'+w+'.png'});
  }finally{await t.close();}
 }
 }finally{await browser.close();save('font-scale.json',rows);}
 const bad=rows.filter(r=>!r.ok);console.log(JSON.stringify({name:'font-scale',passed:rows.length-bad.length,total:rows.length,failed:bad.map(r=>({name:r.name,theme:r.theme,w:r.w,bad:r.metrics.bad,errors:r.errors}))}));assert.equal(bad.length,0);
})().catch(e=>{console.error(e);process.exitCode=1;});
