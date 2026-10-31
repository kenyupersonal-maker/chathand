import crypto from 'node:crypto';

export const REDACTION_SCOPE='identified_sensitive_controls';
const PREFIX='CHATHAND_SCREENSHOT_REDACTION ';
const active=new WeakSet();
const fail=code=>Object.assign(new Error(code),{code});
const limited=Object.freeze(['opaque_shadow_content_not_inspected','secrets_rendered_outside_identified_controls_not_inspected']);

// Runs only in Puppeteer's isolated realm. Never reads values, textContent,
// innerText, innerHTML, DOM snapshots or attribute collections. Nothing from
// page labels leaves this realm. The action vocabulary is private and fixed.
export function sensitiveRealm(action,token,target,options={}){
 const key=Symbol.for('chathand.identified-sensitive-controls.v1');
 let registry=globalThis[key];
 if(!registry||registry.document!==document){registry={document,known:new WeakSet(),references:new Set()};Object.defineProperty(globalThis,key,{value:registry,configurable:true});}
 const metadataSensitive=element=>{
  if(!(element instanceof Element))return false;
  const type=(element.getAttribute('type')||'').toLowerCase();
  const autocomplete=(element.getAttribute('autocomplete')||'').toLowerCase();
  if(type==='password'||/(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/.test(autocomplete))return true;
  const label=[element.getAttribute('aria-label')||'',element.getAttribute('aria-description')||''].join(' ').slice(0,1024);
  const control=element.matches('input,textarea,select,[contenteditable]')||/^(?:textbox|searchbox|combobox|spinbutton)$/.test(element.getAttribute('role')||'')||element.localName.includes('-');
  return control&&/(?:password|passcode|one[- ]?time|\botp\b|private[- ]?key|secret[- ]?key|api[- ]?key|seed[- ]?phrase|mnemonic|recovery[- ]?phrase|密码|驗證碼|验证码|私钥|私鑰|密钥|金鑰|助记词|助記詞)/i.test(label);
 };
 const remember=element=>{
  if(!metadataSensitive(element))return false;
  if(!registry.known.has(element)){registry.known.add(element);registry.references.add(new WeakRef(element));}
  const root=element.getRootNode();
  // A trusted fill target may be inside a closed root. Preserve its actual
  // host identity without discovering/serializing opaque DOM elsewhere.
  if(root instanceof ShadowRoot&&root.mode==='closed'&&!registry.known.has(root.host)){registry.known.add(root.host);registry.references.add(new WeakRef(root.host));}
  return true;
 };
 if(action==='mark'){if(target?.ownerDocument!==document||!target.isConnected)return false;return remember(target);}
 if(action!=='prepare')throw new Error('CHATHAND_SCREENSHOT_ACTION_INVALID');
 const originalDocument=document;
 const viewport=()=>[scrollX,scrollY,innerWidth,innerHeight,devicePixelRatio,visualViewport?.offsetLeft||0,visualViewport?.offsetTop||0,visualViewport?.scale||1];
 const originalViewport=viewport();
 const regions=new Map(),dependencies=new Map(),observers=[];
 let dirty=false,closed=false,reason='CHATHAND_SCREENSHOT_REGION_CHANGED',raf=0,watchdog=0,deadline=performance.now()+options.leaseMs;
 const rect=element=>{const r=element.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
 const protectedBox=element=>{
  const box=rect(element);
  if(!element.matches('[contenteditable],[role="textbox"]'))return box;
  const range=document.createRange();range.selectNodeContents(element);
  const boxes=range.getClientRects();
  if(boxes.length>1000)throw new Error('CHATHAND_SCREENSHOT_REGION_GEOMETRY_UNSUPPORTED');
  let left=box[0],top=box[1],right=box[0]+box[2],bottom=box[1]+box[3];
  for(const part of boxes){left=Math.min(left,part.left);top=Math.min(top,part.top);right=Math.max(right,part.right);bottom=Math.max(bottom,part.bottom);}
  return [left,top,right-left,bottom-top];
 };
 const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>Number.isFinite(v)&&Math.abs(v-b[i])<0.1);
 const own=new Set();
 const invalidate=code=>{dirty=true;reason=code;};
 const visible=element=>{const style=getComputedStyle(element),r=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&r.width>0&&r.height>0;};
 const animated=element=>document.getAnimations().some(animation=>{
  const node=animation.effect?.target;
  return animation.playState==='running'&&node instanceof Element&&(node===element||node.contains(element));
 });
 const maskProperties={position:'fixed',margin:'0',padding:'0',border:'0',background:'#000',color:'#000',opacity:'1',visibility:'visible',display:'block','pointer-events':'none','z-index':'2147483647',transform:'none',filter:'none','backdrop-filter':'none','clip-path':'none',mask:'none','mix-blend-mode':'normal',animation:'none',transition:'none','box-shadow':'none','border-radius':'0',overflow:'hidden','min-width':'0','min-height':'0','max-width':'none','max-height':'none',inset:'auto',contain:'none'};
 const styleState=element=>{const style=getComputedStyle(element);return [style.display,style.visibility,style.opacity];};
 const installMask=element=>{
  if(regions.has(element))return;
  if(animated(element))throw new Error('CHATHAND_SCREENSHOT_PROTECTED_ANIMATION');
  dependencies.set(element,{box:rect(element),style:styleState(element)});
  if(!visible(element))return;
  const box=protectedBox(element);
  if(options.fullPage&&(box[0]<0||box[1]<0||box[0]+box[2]>innerWidth||box[1]+box[3]>innerHeight))throw new Error('CHATHAND_SCREENSHOT_FULLPAGE_REGION_UNSUPPORTED');
  if(box[0]+box[2]<=0||box[1]+box[3]<=0||box[0]>=innerWidth||box[1]>=innerHeight)return;
  const mask=document.createElement('div');own.add(mask);
  mask.setAttribute('popover','manual');mask.setAttribute('aria-hidden','true');
  mask.setAttribute('data-chathand-private-mask',token);
  for(const [name,value] of Object.entries(maskProperties))mask.style.setProperty(name,value,'important');
  for(const [name,value] of Object.entries({left:box[0]+'px',top:box[1]+'px',width:box[2]+'px',height:box[3]+'px'}))mask.style.setProperty(name,value,'important');
  document.documentElement.append(mask);
  if(typeof mask.showPopover!=='function'){mask.remove();throw new Error('CHATHAND_SCREENSHOT_TOP_LAYER_UNSUPPORTED');}
  mask.showPopover();regions.set(element,{mask,box});
 };
 const roots=[];
 let scanned=0;
 const scan=root=>{
  if(!roots.includes(root))roots.push(root);
  for(const element of root.querySelectorAll('*')){
   if(++scanned>40000)throw new Error('CHATHAND_SCREENSHOT_SCAN_LIMIT');
   if(own.has(element))continue;
   if(remember(element)||registry.known.has(element))installMask(element);
   if(element.shadowRoot)scan(element.shadowRoot);
  }
 };
 const cleanup=()=>{
  if(closed)return;closed=true;
  for(const observer of observers)observer.disconnect();
  cancelAnimationFrame(raf);clearTimeout(watchdog);
  // These are references to this original document's nodes only.
  for(const {mask} of regions.values()){try{mask.hidePopover();}catch{}mask.remove();}
  regions.clear();dependencies.clear();
 };
 const verify=()=>{
  if(closed||dirty||document!==originalDocument||!equal(viewport(),originalViewport))return {ok:false,code:dirty?reason:'CHATHAND_SCREENSHOT_DOCUMENT_OR_VIEWPORT_CHANGED'};
  let inspected=0;
  const checkNew=root=>{
   for(const element of root.querySelectorAll('*')){
    if(++inspected>40000)return false;
    if(own.has(element))continue;
    if((metadataSensitive(element)||registry.known.has(element))&&visible(element)&&!regions.has(element)){
     const b=rect(element);if(options.fullPage||b[0]+b[2]>0&&b[1]+b[3]>0&&b[0]<innerWidth&&b[1]<innerHeight)return false;
    }
    if(element.shadowRoot&&!checkNew(element.shadowRoot))return false;
   }
   return true;
  };
  if(!checkNew(document)){invalidate('CHATHAND_SCREENSHOT_NEW_SENSITIVE_CONTROL');return {ok:false,code:reason};}
  for(const [element,{mask,box}] of regions){
   if(!element.isConnected||element.ownerDocument!==originalDocument||!mask.isConnected||!mask.matches(':popover-open')||!equal(protectedBox(element),box)||!equal(rect(mask),box))return {ok:false,code:'CHATHAND_SCREENSHOT_REGION_CHANGED'};
   const style=getComputedStyle(mask);
   if(style.opacity!=='1'||style.display==='none'||style.visibility!=='visible'||style.backgroundColor!=='rgb(0, 0, 0)'||style.transform!=='none'||style.filter!=='none'||style.clipPath!=='none'||style.mixBlendMode!=='normal'||animated(element))return {ok:false,code:'CHATHAND_SCREENSHOT_MASK_INEFFECTIVE'};
   const x=Math.max(0,Math.min(innerWidth-1,box[0]+box[2]/2)),y=Math.max(0,Math.min(innerHeight-1,box[1]+box[3]/2));
   // pointer-events:none excludes the mask from hit testing. Actual coverage is
   // proved by top-layer membership, opaque computed style and exact geometry.
   if(!Number.isFinite(x+y))return {ok:false,code:'CHATHAND_SCREENSHOT_REGION_CHANGED'};
  }
  for(const [element,dependency] of dependencies)if(!element.isConnected||!equal(rect(element),dependency.box)||styleState(element).some((value,index)=>value!==dependency.style[index])||animated(element))return {ok:false,code:'CHATHAND_SCREENSHOT_FRAME_CHANGED'};
  return {ok:true,count:regions.size,protectedDependencies:dependencies.size};
 };
 const relevant=element=>element instanceof Element&&([...regions.keys(),...dependencies.keys()].some(node=>element===node||element.contains(node)||node.contains(element))||own.has(element));
 try{
  scan(document);
  for(const reference of [...registry.references]){
   const known=reference.deref();
   if(!known?.isConnected||known.ownerDocument!==document){registry.references.delete(reference);continue;}
   installMask(known);
  }
  const observerCallback=records=>{
   for(const record of records){
    if(record.type==='attributes'){
     if(relevant(record.target))invalidate('CHATHAND_SCREENSHOT_PROTECTED_MUTATION');
     else if(metadataSensitive(record.target)&&!regions.has(record.target)){remember(record.target);invalidate('CHATHAND_SCREENSHOT_NEW_SENSITIVE_CONTROL');}
    }else{
     const changedElement=record.target instanceof Element?record.target:record.target.parentElement;
     if(changedElement&&[...regions.keys()].some(node=>node===changedElement||node.contains(changedElement)))invalidate('CHATHAND_SCREENSHOT_PROTECTED_MUTATION');
     for(const removed of record.removedNodes||[])if(removed instanceof Element&&relevant(removed))invalidate('CHATHAND_SCREENSHOT_PROTECTED_MUTATION');
     for(const added of record.addedNodes||[]){
      if(!(added instanceof Element)||own.has(added))continue;
      const candidates=[added,...added.querySelectorAll('input,textarea,select,[contenteditable],[aria-label],[autocomplete]')];
      if(candidates.some(element=>metadataSensitive(element)&&!regions.has(element))){for(const element of candidates)remember(element);invalidate('CHATHAND_SCREENSHOT_NEW_SENSITIVE_CONTROL');}
     }
    }
   }
  };
  for(const root of roots){const observer=new MutationObserver(observerCallback);observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['type','autocomplete','role','aria-label','aria-description','style','class','hidden','contenteditable','slot','part']});observers.push(observer);}
  const tick=()=>{const check=verify();if(!check.ok)invalidate(check.code);if(!closed)raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
  const expire=()=>{if(performance.now()>=deadline){invalidate('CHATHAND_SCREENSHOT_LEASE_EXPIRED');cleanup();}else watchdog=setTimeout(expire,Math.max(1,deadline-performance.now()));};watchdog=setTimeout(expire,options.leaseMs);
  return {
   document:originalDocument,verify,cleanup,
   renew:()=>{if(!closed)deadline=performance.now()+options.leaseMs;},
   watchFrame:element=>{if(element.ownerDocument!==originalDocument||!element.isConnected)throw new Error('CHATHAND_SCREENSHOT_FRAME_CHANGED');dependencies.set(element,{box:rect(element),style:styleState(element)});},
   coverFrame:element=>{if(element.ownerDocument!==originalDocument||!element.isConnected)throw new Error('CHATHAND_SCREENSHOT_FRAME_CHANGED');installMask(element);},
  };
 }catch(error){cleanup();throw error;}
}

async function isolatedTarget(handle,backendNodeId){
 const realm=handle.frame.isolatedRealm();
 // IDs are already present in the vendor's existing AX snapshot. Never call
 // backendNodeId()/adoptHandle(): their describeNode serializes attributes.
 if(handle.realm!==realm&&!Number.isInteger(backendNodeId))throw fail('CHATHAND_SCREENSHOT_SENSITIVE_TARGET_UNCONFIRMED');
 return handle.realm===realm?handle.evaluateHandle(node=>node):realm.adoptBackendNode(backendNodeId);
}
export async function isolatedScreenshotTarget(handle,backendNodeId){
 try{return await isolatedTarget(handle,backendNodeId);}finally{await handle.dispose();}
}
export async function rememberSensitiveTarget(handle,backendNodeId){
 const adopted=await isolatedTarget(handle,backendNodeId);
 try{return await adopted.realm.evaluate(sensitiveRealm,'mark',null,adopted,{});}catch{throw fail('CHATHAND_SCREENSHOT_SENSITIVE_TARGET_UNCONFIRMED');}finally{await adopted.dispose();}
}

async function frameOwner(frame){
 const parent=frame.parentFrame();
 const {backendNodeId}=await parent.client.send('DOM.getFrameOwner',{frameId:frame._id});
 if(!Number.isInteger(backendNodeId))throw fail('CHATHAND_SCREENSHOT_FRAME_UNPROTECTABLE');
 return parent.isolatedRealm().adoptBackendNode(backendNodeId);
}

export async function withRedactedScreenshot(page,capture,{signal,fullPage=false,timeoutMs=5000,leaseMs=750}={}){
 if(active.has(page))throw fail('CHATHAND_SCREENSHOT_BUSY');
 if(signal?.aborted)throw fail('CHATHAND_SCREENSHOT_CANCELLED');
 active.add(page);
 const target=page.target(),frames=page.frames(),states=new Map(),token=crypto.randomUUID();
 let changed=false,cssChanged=false,closed=false,heartbeat,timeout,abortListener,cssSession;
 const topology=()=>{changed=true;};
 const clean=[];
 const abortPromise=new Promise((_,reject)=>{
  timeout=setTimeout(()=>reject(fail('CHATHAND_SCREENSHOT_TIMEOUT')),timeoutMs);
  if(signal){abortListener=()=>reject(fail('CHATHAND_SCREENSHOT_CANCELLED'));signal.addEventListener('abort',abortListener,{once:true});}
 });
 // Capture failures/late completions are discarded; no raw image is ever saved
 // or attached by this helper. The vendor may publish only after this resolves.
 const transaction=(async()=>{
  for(const event of ['frameattached','framedetached','framenavigated']){page.on(event,topology);clean.push(()=>page.off(event,topology));}
  cssSession=await page.createCDPSession();
  if(closed){await cssSession.detach();throw fail('CHATHAND_SCREENSHOT_CANCELLED');}
  await cssSession.send('DOM.enable');await cssSession.send('CSS.enable');
  for(const event of ['CSS.styleSheetChanged','CSS.styleSheetAdded','CSS.styleSheetRemoved'])cssSession.on(event,()=>{cssChanged=true;});
  const depth=frame=>{let level=0;while((frame=frame.parentFrame())){if(++level>64)throw fail('CHATHAND_SCREENSHOT_FRAME_DEPTH_UNSUPPORTED');}return level;};
  for(const frame of [...frames].sort((a,b)=>depth(a)-depth(b))){
   if(closed)throw fail('CHATHAND_SCREENSHOT_CANCELLED');
   const parent=frame.parentFrame();
   if(parent&&!states.has(parent))continue; // already enclosed by an opaque ancestor
   let sameOrigin=true;
   if(parent)try{sameOrigin=await frame.isolatedRealm().evaluate(()=>{try{return window.parent.document.nodeType===9;}catch{return false;}});}catch{sameOrigin=false;}
   if(parent&&!sameOrigin){
    const parentState=states.get(parent);
    const element=await frameOwner(frame);
    try{await parentState.evaluate((state,node)=>state.coverFrame(node),element);}finally{await element.dispose();}
    continue;
   }
   try{const state=await frame.isolatedRealm().evaluateHandle(sensitiveRealm,'prepare',token,null,{fullPage,leaseMs});if(closed){try{await state.evaluate(state=>state.cleanup());}finally{await state.dispose();}throw fail('CHATHAND_SCREENSHOT_CANCELLED');}states.set(frame,state);}
   catch(error){throw fail(/^CHATHAND_SCREENSHOT_[A-Z_]+$/.test(error?.message)?error.message:'CHATHAND_SCREENSHOT_FRAME_UNPROTECTABLE');}
  }
  if(!states.has(page.mainFrame()))throw fail('CHATHAND_SCREENSHOT_DOCUMENT_CHANGED');
  for(const [frame,state] of states){
   const parent=frame.parentFrame(),parentState=states.get(parent);
   if(!parentState)continue;
   const check=await state.evaluate(state=>state.verify());
   if(check.count){const element=await frameOwner(frame);try{await parentState.evaluate((state,node)=>state.watchFrame(node),element);}finally{await element.dispose();}}
  }
  let beatBusy=false;
  heartbeat=setInterval(()=>{if(beatBusy||closed)return;beatBusy=true;Promise.all([...states.values()].map(state=>state.evaluate(state=>state.renew()))).catch(()=>{changed=true;}).finally(()=>{beatBusy=false;});},100);
  const verify=async()=>{
   if(closed||signal?.aborted||changed||page.isClosed()||page.target()!==target)throw fail('CHATHAND_SCREENSHOT_DOCUMENT_CHANGED');
   const current=page.frames();if(current.length!==frames.length||frames.some(frame=>!current.includes(frame)))throw fail('CHATHAND_SCREENSHOT_FRAME_CHANGED');
   let protectedCount=0,dependencies=0;
   for(const state of states.values()){const check=await state.evaluate(state=>state.verify());if(!check.ok)throw fail(check.code);protectedCount+=check.count;dependencies+=check.protectedDependencies||0;}
   if(cssChanged&&(protectedCount||dependencies))throw fail('CHATHAND_SCREENSHOT_STYLESHEET_CHANGED');
   return protectedCount;
  };
  // Two paint opportunities; unrelated text-only clocks/chat mutations are not blockers.
  await Promise.all([...states.values()].map(state=>state.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))));
  cssChanged=false;
  const count=await verify();
  const buffer=await capture();
  await verify();
  return {buffer,redaction:{redaction_scope:REDACTION_SCOPE,redaction_limitations:[...limited,...(states.size<frames.length?['cross_origin_frames_masked']:[])],masked_regions:count}};
 })();
 try{return await Promise.race([transaction,abortPromise]);}
 catch(error){if(typeof error?.code==='string'&&error.code.startsWith('CHATHAND_SCREENSHOT_'))throw error;throw fail('CHATHAND_SCREENSHOT_CAPTURE_FAILED');}
 finally{
  closed=true;clearTimeout(timeout);clearInterval(heartbeat);if(abortListener)signal.removeEventListener('abort',abortListener);
  for(const cleanup of clean)cleanup();
  const handles=[...states.values()];
  await Promise.race([Promise.allSettled(handles.map(async state=>{try{await state.evaluate(state=>state.cleanup());}finally{await state.dispose();}})),new Promise(resolve=>setTimeout(resolve,300))]);
  // A late prepare gets no renewed lease and self-cleans in its original realm.
  if(cssSession)try{await cssSession.detach();}catch{}
  active.delete(page);
 }
}
export function redactionResponseLine(metadata){return PREFIX+JSON.stringify(metadata);}
export function readRedactionMetadata(result){
 const entries=[...(result?.content||[]),...(typeof result?.structuredContent?.message==='string'?[{type:'text',text:result.structuredContent.message}]:[])];
 for(const item of entries)if(item.type==='text')for(const line of String(item.text).split('\n'))if(line.startsWith(PREFIX)){
  let value;try{value=JSON.parse(line.slice(PREFIX.length));}catch{throw fail('CHATHAND_SCREENSHOT_METADATA_INVALID');}
  if(value.redaction_scope!==REDACTION_SCOPE||!Array.isArray(value.redaction_limitations)||!value.redaction_limitations.every(x=>[...limited,'cross_origin_frames_masked'].includes(x)))throw fail('CHATHAND_SCREENSHOT_METADATA_INVALID');
  return {redaction_scope:value.redaction_scope,redaction_limitations:[...value.redaction_limitations],...(Number.isInteger(value.masked_regions)&&value.masked_regions>=0?{masked_regions:value.masked_regions}:{})};
 }
 throw fail('CHATHAND_SCREENSHOT_METADATA_MISSING');
}
