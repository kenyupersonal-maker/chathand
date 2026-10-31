'use strict';
/* 按稳定键就地对齐。焦点、滚动、展开状态与外部组件由现有节点持有。 */
window.__renderStats={renders:0,nodeWrites:0};
window.ChatHandMorph=(()=>{
 const transient=new Set(['enter','flash','press','hover','step-in','seg-ready']);
 const key=node=>node.nodeType===1?(node.getAttribute('data-k')||node.id||null):null;
 const write=()=>window.__renderStats.nodeWrites++;
 const same=(a,b)=>a.nodeType===b.nodeType&&(a.nodeType!==1||a.tagName===b.tagName);
 /* 1081（Claude）：seg-ready 由 segSlide 加，留着，不每次重画都拿掉再加。
    节点上的 __morphHold（一组属性名）归别的代码管，这里不改不删：最近完成那几行的 hidden 由 fitRecent 按高度算。 */
 function attributes(old,fresh){
  const focused=old===document.activeElement,control=/^(INPUT|TEXTAREA|SELECT)$/.test(old.tagName),held=new Map(),hold=old.__morphHold;
  if(old.hasAttribute('style'))for(const name of ['--d','--glow-delay','--seg-x','--seg-w'])if(old.style.getPropertyValue(name))held.set(name,old.style.getPropertyValue(name));
  for(const attr of [...old.attributes]){if(hold?.has(attr.name)||attr.name==='open'&&old.tagName==='DETAILS'||focused&&control&&['value','checked','selected'].includes(attr.name)||attr.name==='class'||attr.name==='style'&&held.size)continue;if(!fresh.hasAttribute(attr.name)){old.removeAttribute(attr.name);write();}}
  if(fresh.hasAttribute('style'))for(const [name,value] of held)fresh.style.setProperty(name,value);
  for(const attr of [...fresh.attributes]){if(hold?.has(attr.name)||attr.name==='open'&&old.tagName==='DETAILS'||focused&&control&&['value','checked','selected'].includes(attr.name)||attr.name==='class')continue;if(old.getAttribute(attr.name)!==attr.value){old.setAttribute(attr.name,attr.value);write();}}
  if(held.size&&!fresh.hasAttribute('style')){for(const name of [...old.style])if(!held.has(name)){old.style.removeProperty(name);write();}}
  const classes=new Set([...fresh.classList,...[...old.classList].filter(c=>transient.has(c))]);
  if(classes.size!==old.classList.length||[...classes].some(c=>!old.classList.contains(c))){old.setAttribute('class',[...classes].join(' '));write();}
  if(control&&!focused){if('value' in old&&old.value!==fresh.value){old.value=fresh.value;write();}if('checked' in old&&old.checked!==fresh.checked){old.checked=fresh.checked;write();}}
 }
 function children(parent,freshParent){
  const originals=[...parent.childNodes],used=new Set(),keyed=new Map(originals.filter(n=>key(n)).map(n=>[key(n),n]));let cursor=parent.firstChild;
  for(const fresh of [...freshParent.childNodes]){
   const k=key(fresh);let old=k?keyed.get(k):originals.find(n=>!used.has(n)&&!key(n)&&same(n,fresh)&&!(n.nodeType===1&&n.hasAttribute('data-ext')));
   while(cursor?.nodeType===1&&cursor.hasAttribute('data-ext')&&cursor!==old)cursor=cursor.nextSibling;
   if(old&&same(old,fresh)){used.add(old);if(old!==cursor){parent.insertBefore(old,cursor);write();}if(!(old.nodeType===1&&old.hasAttribute('data-ext'))){if(old.nodeType===3||old.nodeType===8){if(old.nodeValue!==fresh.nodeValue){old.nodeValue=fresh.nodeValue;write();}}else if(old.nodeType===1){attributes(old,fresh);if(!(old===document.activeElement&&/^(TEXTAREA|SELECT)$/.test(old.tagName)))children(old,fresh);}}cursor=old.nextSibling;
   }else{const node=fresh.cloneNode(true);parent.insertBefore(node,cursor);write();used.add(node);cursor=node.nextSibling;}
  }
  for(const old of originals)if(!used.has(old)&&!(old.nodeType===1&&(old.hasAttribute('data-ext')||old.tagName==='DIALOG'))){old.remove();write();}
 }
 function align(parent,html){const template=document.createElement('template');template.innerHTML=html;children(parent,template.content);}
 return {align};
})();
