// Runs only in the extension service worker. No page script can invoke this driver.
import {clickPoint} from './click-target.js';
import {scrollPage} from './scroll-target.js';
import {createFrameWorld, frameDocumentId, frameSupport, readFrameTree, resolveNodeInFrame} from './frame-tree.js';
import {enableExperience} from './experience.js';
import {screenshotInputMask, privateAXNode} from './page-helper.js';
export const DEFAULT_COMMAND_TIMEOUT_MS=5000;
const MAX_AX_NODES_PER_FRAME=4000;
const MAX_AX_NODES_TOTAL=16000;

const fault=code=>Object.assign(new Error(code),{code});
const inputFailure=error=>Object.assign(fault(['ACTION_CANCELLED','RESULT_REVOKED','TASK_REVOKED','BROWSER_USER_ACTIVE','CDP_COMMAND_TIMEOUT'].includes(error?.code)?error.code:'BROWSER_INPUT_FAILED'),{details:{delivery_unconfirmed:true,do_not_replay:true,replay_safe:false}});
const tenth=value=>Math.round(value*10)/10;
/** 点击回执：实际点的坐标（point）和元素的位置框（box），页面视口里的 CSS 像素，留一位小数。 */
export function clickReceipt(point){
 if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))return null;
 const receipt={point:{x:tenth(point.x),y:tenth(point.y)}};
 if(Number.isFinite(point.width)&&Number.isFinite(point.height))receipt.box={x:tenth(point.x-point.width/2),y:tenth(point.y-point.height/2),width:tenth(point.width),height:tenth(point.height)};
 return receipt;
}

export class BrowserDriver {
 constructor(api,{commandTimeoutMs=DEFAULT_COMMAND_TIMEOUT_MS,actionabilityTimeoutMs=3000,experience=false,...experienceOptions}={}){
  this.api=api;this.attached=new Set();this.snapshots=new Map();this.attachTokens=new Map();this.pendingAttaches=new Map();this.pendingDetaches=new Map();this.epoch=crypto.randomUUID();this.generation=0;this.commandTimeoutMs=commandTimeoutMs;this.actionabilityTimeoutMs=actionabilityTimeoutMs;
  if(experience)enableExperience(this,experienceOptions);
 }
 assertCurrent(generation){if(generation!==this.generation)throw fault('ACTION_CANCELLED');}
 async bounded(id,label,operation,generation,{detachOnTimeout=true,cancelOnTimeout=true,timeoutMs=this.commandTimeoutMs}={}){
  this.assertCurrent(generation);let timer,timedOut=false;
  const pending=Promise.resolve().then(()=>{this.assertCurrent(generation);return operation();});
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(fault(label+'_TIMEOUT'));},timeoutMs);});
  try{const result=await Promise.race([pending,timeout]);this.assertCurrent(generation);return result;}
  catch(error){if(timedOut&&cancelOnTimeout){this.cancel(id);if(detachOnTimeout)void this.detachTab(id,true);}throw error;}
  finally{clearTimeout(timer);}
 }
 async waitForDetach(existing){let timer;try{await Promise.race([existing,new Promise(resolve=>{timer=setTimeout(resolve,this.commandTimeoutMs);})]);}finally{clearTimeout(timer);}}
 async detachTab(id,force=false,expectedToken=null){const token=this.attachTokens.get(id);if(expectedToken!==null&&token!==expectedToken)return;if(!force&&!this.attached.has(id))return;const existing=this.pendingDetaches.get(id);if(existing){await this.waitForDetach(existing);return;}this.attached.delete(id);if(this.attachTokens.get(id)===token)this.attachTokens.delete(id);const real=Promise.resolve().then(()=>this.api.debugger.detach({tabId:id}));const tracked=real.then(()=>undefined,()=>undefined);this.pendingDetaches.set(id,tracked);tracked.then(()=>{if(this.pendingDetaches.get(id)===tracked)this.pendingDetaches.delete(id);});let timer;try{await Promise.race([tracked,new Promise(resolve=>{timer=setTimeout(resolve,this.commandTimeoutMs);})]);}finally{clearTimeout(timer);} }
 async finishAttachCleanup(id,token,pending){try{await pending;}catch{}if(this.pendingAttaches.get(id)?.token!==token)return;this.pendingAttaches.delete(id);if(this.attachTokens.get(id)===token)await this.detachTab(id,true,token);}
 cancel(id){this.generation++;if(Number.isSafeInteger(id)){this.attached.delete(id);this.invalidate(id);}}
 // 1029：新开的标签页在导航提交以前，真 Chrome 给的 url 是空的，要去的地址在 pendingUrl 里（10/7 真浏览器测试：开完马上 wait_for 一律 PAGE_NOT_ALLOWED）。
 // 这时按要去的地址算；只认还停在空白页上的标签页，已经在别的页面上的不算。
 async page(id,generation=this.generation){if(!Number.isSafeInteger(id)||id<0)throw fault('TAB_INVALID');const tab=await this.api.tabs.get(id);this.assertCurrent(generation);const pending=(!tab.url||tab.url==='about:blank')&&typeof tab.pendingUrl==='string'&&/^https?:\/\//.test(tab.pendingUrl)?tab.pendingUrl:null;if(tab.incognito||!/^https?:\/\//.test(pending||tab.url||''))throw fault('PAGE_NOT_ALLOWED');return pending?{...tab,url:pending,loading:true}:tab;}
 async attach(id,generation=this.generation){await this.page(id,generation);if(this.attached.has(id))return id;const pendingDetach=this.pendingDetaches.get(id);if(pendingDetach){let timer;try{await Promise.race([pendingDetach,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault('CDP_DETACH_BUSY')),this.commandTimeoutMs);})]);this.assertCurrent(generation);}finally{clearTimeout(timer);}}if(this.pendingAttaches.has(id))throw fault('CDP_ATTACH_BUSY');const token=Symbol('attach');const pending=Promise.resolve().then(()=>this.api.debugger.attach({tabId:id},'1.3'));this.attachTokens.set(id,token);this.pendingAttaches.set(id,{token,pending});let keepPending=false;try{await this.bounded(id,'CDP_ATTACH',()=>pending,generation,{detachOnTimeout:false});this.assertCurrent(generation);if(this.attachTokens.get(id)!==token)throw fault('ACTION_CANCELLED');this.attached.add(id);}catch(error){keepPending=true;void this.finishAttachCleanup(id,token,pending);throw error;}finally{if(!keepPending&&this.pendingAttaches.get(id)?.token===token)this.pendingAttaches.delete(id);}return id;}
 async send(id,method,params={},generation=this.generation){return this.bounded(id,'CDP_COMMAND',()=>this.api.debugger.sendCommand({tabId:id},method,params),generation);}
 async captureScreenshot(id,params,generation=this.generation,bounds={}){
  const tab=await this.page(id,generation),info=await readFrameTree(this,id,generation,tab.url),contexts=[],token=crypto.randomUUID();
  if(info.truncated)throw fault('SCREENSHOT_REDACTION_UNAVAILABLE');
  const mask=async(entry,action)=>{const r=await this.sendFrame(id,entry.frameId,'Runtime.evaluate',{expression:'('+screenshotInputMask.toString()+')('+JSON.stringify(action)+','+JSON.stringify(token)+')',contextId:entry.contextId,returnByValue:true},generation);if(r.exceptionDetails||r.result?.value!==true)throw fault('SCREENSHOT_REDACTION_UNAVAILABLE');};
  try{
   for(const frame of info.frames){const support=frameSupport(info,frame);if(!support.supported)throw fault('SCREENSHOT_REDACTION_UNAVAILABLE');const entry={frameId:frame.id,documentId:frameDocumentId(frame),contextId:await createFrameWorld(this,id,frame.id,generation,'ChatHand.ScreenshotRedaction')};contexts.push(entry);await mask(entry,'apply');}
   for(const entry of contexts)await mask(entry,'check');
   const result=await this.bounded(id,'CDP_COMMAND',()=>this.api.debugger.sendCommand({tabId:id},'Page.captureScreenshot',params),generation,bounds);
   const after=await readFrameTree(this,id,generation,(await this.page(id,generation)).url);if(after.truncated||after.frames.length!==contexts.length||contexts.some(entry=>!after.frames.some(frame=>frame.id===entry.frameId&&frameDocumentId(frame)===entry.documentId)))throw fault('SCREENSHOT_REDACTION_UNAVAILABLE');
   for(const entry of contexts)await mask(entry,'check');
   return result;
  }finally{for(const entry of contexts)try{await Promise.race([this.api.debugger.sendCommand({tabId:id},'Runtime.evaluate',{expression:'('+screenshotInputMask.toString()+')("remove",'+JSON.stringify(token)+')',contextId:entry.contextId,returnByValue:true}).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,300))]);}catch{}}
 }

 async sendFrame(id,frameId,method,params={},generation=this.generation){return this.send(id,method,params,generation);}
 invalidate(id){this.snapshots.delete(id);}
 async detachAll(){this.generation++;this.snapshots.clear();const ids=[...this.attached];this.attached.clear();await Promise.all(ids.map(tabId=>this.detachTab(tabId,true)));}
 async snapshot(id,generation=this.generation){
  const tab=await this.page(id,generation);await this.attach(id,generation);const frameInfo=await readFrameTree(this,id,generation,tab.url);this.assertCurrent(generation);const refs=new Map(),elements=[],text=[],unsupported_frames=[];let remaining=18000,axNodesSeen=0,ax_nodes_truncated=false;
  for(const frame of frameInfo.frames){
   const support=frameSupport(frameInfo,frame);if(!support.supported){if(frame.id!==frameInfo.root.id)unsupported_frames.push({frame_id:frame.id,url:frame.url||'',reason:support.reason});continue;}
   let tree;try{tree=await this.send(id,'Accessibility.getFullAXTree',{frameId:frame.id},generation);}catch(error){this.assertCurrent(generation);if(error?.code==='ACTION_CANCELLED'||/TIMEOUT$/.test(error?.code||''))throw error;if(frame.id===frameInfo.root.id)throw error;unsupported_frames.push({frame_id:frame.id,url:frame.url||'',reason:'OOPIF_FRAME_UNSUPPORTED',error:error.code||'CDP_FRAME_UNAVAILABLE'});continue;}
   const nodes=tree.nodes||[],available=Math.max(0,Math.min(MAX_AX_NODES_PER_FRAME,MAX_AX_NODES_TOTAL-axNodesSeen));if(nodes.length>available)ax_nodes_truncated=true;const documentId=frameDocumentId(frame),byId=new Map(nodes.map(n=>[n.nodeId,n])),privateChildren=new Set();const hide=nodeId=>{if(privateChildren.has(nodeId))return;privateChildren.add(nodeId);for(const child of byId.get(nodeId)?.childIds||[])hide(child);};for(const node of nodes)if(privateAXNode(node))for(const child of node.childIds||[])hide(child);for(const n of nodes.slice(0,available)){axNodesSeen+=1;if(n.ignored||privateChildren.has(n.nodeId))continue;const role=String(n.role?.value||''),name=String(n.name?.value||'').slice(0,400);if(name&&remaining>0){text.push(name.slice(0,remaining));remaining-=name.length+1;}if(n.backendDOMNodeId&&elements.length<160&&!['StaticText','InlineTextBox','RootWebArea','generic','none','paragraph'].includes(role)){const ref='e'+(elements.length+1),props=n.properties||[],disabled=props.some(p=>p.name==='disabled'&&p.value?.value===true),rawURL=props.find(p=>p.name==='url')?.value?.value||null;let href=null;try{const u=new URL(String(rawURL||''));if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)href=u.href;}catch{}const value={backend:n.backendDOMNodeId,role,name,disabled,href,frameId:frame.id,documentId,frameUrl:frame.url||tab.url};refs.set(ref,value);elements.push({ref,role,name,disabled,href,frame_id:frame.id,document_id:documentId});}}
  }
  this.assertCurrent(generation);const snapshot_id=crypto.randomUUID();this.snapshots.set(id,{snapshot_id,refs,url:tab.url,at:Date.now()});return {page_id:String(id),snapshot_id,url:tab.url,title:tab.title||'',text:text.join('\n'),text_truncated:remaining<=0,elements,unsupported_frames,frames_truncated:frameInfo.truncated,ax_nodes_truncated,untrusted_content:true};
 }
 async target(id,args,generation=this.generation){const tab=await this.page(id,generation),s=this.snapshots.get(id);if(!s||s.snapshot_id!==args.snapshot_id||Date.now()-s.at>60000||s.url!==tab.url)throw fault('SNAPSHOT_STALE');const n=s.refs.get(args.ref);if(!n||n.disabled)throw fault('ELEMENT_INVALID');const frameInfo=await readFrameTree(this,id,generation,tab.url),frame=frameInfo.frames.find(candidate=>candidate.id===(n.frameId||frameInfo.root.id));const support=frameSupport(frameInfo,frame);if(!support.supported)throw fault(support.reason);if(n.documentId!==undefined&&n.documentId!==frameDocumentId(frame))throw fault('SNAPSHOT_STALE');const tree=await this.send(id,'Accessibility.getPartialAXTree',{backendNodeId:n.backend,fetchRelatives:false},generation);const fresh=tree.nodes?.find(x=>x.backendDOMNodeId===n.backend);if(!fresh||fresh.ignored||String(fresh.name?.value||'').slice(0,400)!==n.name||String(fresh.role?.value||'')!==n.role)throw fault('ELEMENT_CHANGED');if(fresh.properties?.some(p=>p.name==='disabled'&&p.value?.value===true))throw fault('ELEMENT_DISABLED');const {node}=await this.send(id,'DOM.describeNode',{backendNodeId:n.backend,depth:0},generation);const attrs={};for(let i=0;i<(node.attributes||[]).length;i+=2)attrs[node.attributes[i]]=node.attributes[i+1];return {...n,attrs};}
 async click(id,n,double=false,generation=this.generation){
  await this.sendFrame(id,n.frameId,'DOM.scrollIntoViewIfNeeded',{backendNodeId:n.backend},generation);
  // Inactive root widgets can acknowledge Input while having no fresh hit-test frame.
  // Capture one local frame before dispatch; discard its pixels, then redo geometry/AX guards.
  const frames=await readFrameTree(this,id,generation,(await this.page(id,generation)).url);
  // Read native visibility in our root-frame realm; page-defined getters cannot skip the paint guard.
  const contextId=await createFrameWorld(this,id,frames.root.id,generation,'ChatHand.Visibility');
  const visibility=await this.sendFrame(id,frames.root.id,'Runtime.evaluate',{expression:'document.visibilityState',contextId,returnByValue:true},generation);
  if(visibility.exceptionDetails||!['hidden','visible'].includes(visibility.result?.value))throw fault('ELEMENT_FRAME_UNSUPPORTED');
  if(visibility.result.value==='hidden'){
   const painted=await this.send(id,'Page.captureScreenshot',{format:'jpeg',quality:1,captureBeyondViewport:false},generation);
   if(typeof painted.data!=='string'||!painted.data)throw fault('ELEMENT_GEOMETRY');
  }
  const point=await clickPoint(this,id,n,generation,{timeoutMs:this.actionabilityTimeoutMs}),{x,y}=point;
  // A label or enabled state can change while we wait for an overlay to leave.
  const tree=await this.sendFrame(id,n.frameId,'Accessibility.getPartialAXTree',{backendNodeId:n.backend,fetchRelatives:false},generation);
  const live=tree.nodes?.find(node=>node.backendDOMNodeId===n.backend);
  if(!live||live.ignored||String(live.role?.value||'')!==n.role||String(live.name?.value||'').slice(0,400)!==n.name)throw fault('ELEMENT_CHANGED');
  if(live.properties?.some(p=>p.name==='disabled'&&p.value?.value===true))throw fault('ELEMENT_DISABLED');
  // Hidden OOPIFs have no fresh compositor hit-test region in the root widget.
  // Use only the authenticated child session, with coordinates in that session's viewport.
  const childSession=this.frameSession?.(id,n.frameId),input=childSession?{x:point.input_x,y:point.input_y}:{x,y};
  if(!Number.isFinite(input.x)||!Number.isFinite(input.y))throw fault('ELEMENT_GEOMETRY');
  for(let count=1;count<=(double?2:1);count++){
   await this.sendFrame(id,n.frameId,'Input.dispatchMouseEvent',{type:'mousePressed',...input,button:'left',clickCount:count},generation);
   await this.sendFrame(id,n.frameId,'Input.dispatchMouseEvent',{type:'mouseReleased',...input,button:'left',clickCount:count},generation);
  }
  // Input has been dispatched. A navigation can leave capture pending; bound only this observation.
  // Ordinary paint failure keeps a receipt for fresh read-only observation; cancellation still stops.
  let paint=null;
  if(visibility.result.value==='hidden'){
   try{
    const painted=await this.bounded(id,'CDP_COMMAND',()=>this.api.debugger.sendCommand({tabId:id},'Page.captureScreenshot',{format:'jpeg',quality:1,captureBeyondViewport:false}),generation,{detachOnTimeout:false,cancelOnTimeout:false,timeoutMs:Math.min(1000,this.commandTimeoutMs)});
    paint=typeof painted.data==='string'&&painted.data?{observed:true}:{observed:false,error:'ELEMENT_GEOMETRY'};
   }catch(error){
    if(generation!==this.generation||/^(?:ACTION_CANCELLED|SNAPSHOT_STALE|TASK_)/.test(error.code||'')){
     error.details={...error.details,delivery_unconfirmed:true,do_not_replay:true,replay_safe:false};throw error;
    }
    paint={observed:false,error:error.code||'SCREENSHOT_FAILED'};
   }
  }
  // 1029（Ken 10/7：出问题时看得出想点哪、实际点在哪）：回执带实际点的坐标和元素的位置框，都是页面视口里的 CSS 像素。
  return {...clickReceipt(point),...(paint?{paint,do_not_replay:true,replay_safe:false,...(!paint.observed?{delivery_unconfirmed:true}:{})}:{})};
 }
 // Fixed read-only probe: returns one URL or null, never page text or a snapshot.
 async generatingChat(generation=this.generation){
  const tabs=await this.api.tabs.query({url:'https://chatgpt.com/c/*'});this.assertCurrent(generation);
  const candidates=tabs.filter(t=>!t.incognito&&/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(t.url||''));
  if(candidates.length>20)return {url:null};let found=null;
  for(const tab of candidates){
   const alreadyAttached=this.attached.has(tab.id);
   try{const fresh=await this.page(tab.id,generation);if(fresh.url!==tab.url)return {url:null};await this.attach(tab.id,generation);
    const result=await this.send(tab.id,'Runtime.evaluate',{expression:`Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="停止生成回复"]')?.getClientRects().length)`,returnByValue:true},generation);
    if((await this.page(tab.id,generation)).url!==tab.url||result.exceptionDetails||typeof result.result?.value!=='boolean')return {url:null};
    if(result.result.value){if(found)return {url:null};found=tab.url;}
   }catch(error){this.assertCurrent(generation);return {url:null};}
   finally{if(!alreadyAttached)await this.detachTab(tab.id);}
  }
  return {url:found};
 }
 async execute(action,args={}){const generation=this.generation;if(action==='detect_generating_chat')return this.generatingChat(generation);if(action==='tabs'){const tabs=await this.api.tabs.query({});this.assertCurrent(generation);return {tabs:tabs.filter(t=>!t.incognito&&/^https?:\/\//.test(t.url||'')).slice(0,200).map(t=>({page_id:String(t.id),title:t.title||'',url:t.url,selected:!!t.active})),untrusted_content:true};}
 if(action==='new'){const u=new URL(args.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw fault('URL_BLOCKED');const tab=await this.api.tabs.create({url:u.href,active:args.show===true});this.assertCurrent(generation);if(args.show===true){await this.api.windows.update(tab.windowId,{focused:true});this.assertCurrent(generation);}return {page_id:String(tab.id),opened:true,shown:args.show===true};}
 if(action==='detach'){await this.detachAll();return {disconnected:true,chrome_left_open:true};}
 const id=Number(args.page_id);await this.page(id,generation);
 if(action==='select'){if(args.show===true){await this.api.tabs.update(id,{active:true});this.assertCurrent(generation);const t=await this.api.tabs.get(id);this.assertCurrent(generation);await this.api.windows.update(t.windowId,{focused:true});this.assertCurrent(generation);}return {selected:true,shown:args.show===true,page_id:String(id)};}
 if(action==='close'){await this.api.tabs.remove(id);this.assertCurrent(generation);this.invalidate(id);return {closed:true,page_id:String(id)};}
 if(action==='navigate'){const u=new URL(args.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw fault('URL_BLOCKED');await this.api.tabs.update(id,{url:u.href});this.assertCurrent(generation);this.invalidate(id);return {navigated:true,page_id:String(id)};}
 if(action==='snapshot')return this.snapshot(id,generation);
 await this.attach(id,generation);
 if(action==='screenshot'){const r=await this.captureScreenshot(id,{format:'jpeg',quality:60,captureBeyondViewport:false},generation);if(!r.data||r.data.length>4*1024*1024)throw fault('SCREENSHOT_TOO_LARGE');return {page_id:String(id),image_base64:r.data,mimeType:'image/jpeg',redaction_scope:'identified_sensitive_controls',redaction_limitations:['opaque_shadow_content_not_inspected'],untrusted_content:true};}
 if(action==='scroll'){const amount=Number(args.amount??500);await scrollPage(this,id,amount,null,null,generation);this.invalidate(id);return {performed:'scroll'};}
 if(action==='reload'){await this.api.tabs.reload(id);this.assertCurrent(generation);this.invalidate(id);return {performed:action};}
 if(action==='back'||action==='forward'){const h=await this.send(id,'Page.getNavigationHistory',{},generation),index=h.currentIndex+(action==='back'?-1:1);if(h.entries[index])await this.send(id,'Page.navigateToHistoryEntry',{entryId:h.entries[index].id},generation);this.invalidate(id);return {performed:action};}
 const n=await this.target(id,args,generation);
 let click=null;
 if(action==='click'||action==='double_click')click=await this.click(id,n,action==='double_click',generation);
 // 1029：Mac 上 ⌘A 是菜单快捷键，经 CDP 发给页面的按键不会自己变成「全选」（Playwright 也是这样处理的），要带上 selectAll 命令，
 // 不然填写会接在原来的字后面。
 else if(action==='fill'){if(n.attrs.type==='file')throw fault('FILE_INPUT_REQUIRED');if(typeof args.text!=='string'||args.text.length>16000)throw fault('INPUT_INVALID');
  if(/password|密码|one.time.code|验证码|passphrase|private key|私钥|助记词|seed phrase|api.key/i.test([n.name,...['type','autocomplete','aria-label','placeholder','name','title'].map(key=>n.attrs[key]||'')].join(' '))){const {objectId}=await resolveNodeInFrame(this,id,n.frameId,n.backend,generation,'ChatHand.SensitiveTarget');try{const marked=await this.sendFrame(id,n.frameId,'Runtime.callFunctionOn',{objectId,functionDeclaration:'function(){this.setAttribute("data-chathand-sensitive","true");return this.getAttribute("data-chathand-sensitive")==="true";}',returnByValue:true},generation);if(marked.exceptionDetails||marked.result?.value!==true)throw fault('SCREENSHOT_REDACTION_UNAVAILABLE');}finally{await this.sendFrame(id,n.frameId,'Runtime.releaseObject',{objectId},generation).catch(()=>{});}}
  await this.sendFrame(id,n.frameId,'DOM.focus',{backendNodeId:n.backend},generation);const info=await this.api.runtime.getPlatformInfo();this.assertCurrent(generation);const mac=info.os==='mac';await this.send(id,'Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:mac?4:2,...(mac?{commands:['selectAll']}:{})},generation);await this.send(id,'Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:mac?4:2},generation);await this.send(id,'Input.insertText',{text:args.text},generation).catch(error=>{throw inputFailure(error);});}
 else if(action==='press'){const keymap={Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Space:32};if(!Object.hasOwn(keymap,args.key))throw fault('KEY_UNSUPPORTED');if(!['textbox','searchbox','combobox'].includes(n.role))throw fault('FOCUS_TARGET_REQUIRED');await this.sendFrame(id,n.frameId,'DOM.focus',{backendNodeId:n.backend},generation);for(const type of ['keyDown','keyUp'])await this.send(id,'Input.dispatchKeyEvent',{type,key:args.key==='Space'?' ':args.key,windowsVirtualKeyCode:keymap[args.key],...(type==='keyDown'&&['Enter','Space'].includes(args.key)?{text:args.key==='Enter'?'\r':' ',unmodifiedText:args.key==='Enter'?'\r':' '}:{})},generation).catch(error=>{throw inputFailure(error);});}
 else if(action==='upload'){if(n.attrs.type!=='file'||!Array.isArray(args.paths)||args.paths.length<1||args.paths.length>10)throw fault('FILE_INPUT_REQUIRED');await this.sendFrame(id,n.frameId,'DOM.setFileInputFiles',{backendNodeId:n.backend,files:args.paths},generation);}
 else if(action==='select_value'){if(typeof args.text!=='string'||args.text.length>1000)throw fault('ARG_INVALID');const {objectId}=await resolveNodeInFrame(this,id,n.frameId,n.backend,generation,'KenBridge.Select');try{const r=await this.sendFrame(id,n.frameId,'Runtime.callFunctionOn',{objectId,functionDeclaration:'function(v){if(this.tagName!=="SELECT")throw Error("SELECT_REQUIRED");const opt=Array.from(this.options).find(o=>o.value===v||o.text===v);if(!opt)throw Error("OPTION_MISSING");this.value=opt.value;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return true;}',arguments:[{value:args.text}],returnByValue:true},generation);if(r.exceptionDetails)throw fault('SELECT_FAILED');}finally{if(generation===this.generation)await this.sendFrame(id,n.frameId,'Runtime.releaseObject',{objectId},generation).catch(()=>{});}}
 else throw fault('ACTION_UNSUPPORTED');this.assertCurrent(generation);this.invalidate(id);return {performed:action,page_id:String(id),...(click?{click}:{})};
 }
}
