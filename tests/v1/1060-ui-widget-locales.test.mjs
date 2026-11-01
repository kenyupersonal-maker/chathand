import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {generatedUILocaleFiles} from '../../scripts/ui-locale-resources.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const base=JSON.parse(fs.readFileSync(new URL('../../locales/zh.json',import.meta.url),'utf8'));
const fragment=process.env.CHATHAND_WIDGET_FRAGMENT?JSON.parse(fs.readFileSync(process.env.CHATHAND_WIDGET_FRAGMENT,'utf8')):{};
const zh=Object.fromEntries(Object.entries({...base,...fragment}).filter(([key])=>/^ui\.(taskWidget|imageBatch)\./.test(key)));
// Deliberately synthetic tokens exercise substitutions without authoring English copy.
const en=Object.fromEntries(Object.entries(zh).map(([key,value])=>[key,'@@'+key+'@@ '+[...value.matchAll(/\{[A-Za-z][A-Za-z0-9_]*\}/g)].map(m=>m[0]).join(' ')]));
const tables={zh,en};
const fixedNow=1_800_000_000_000;
class Element {
 constructor(tag,owner){this.tagName=tag;this.owner=owner;this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.hidden=false;this.disabled=false;this.className='';this._text='';this.style={setProperty(name,value){this[name]=value;},removeProperty(name){delete this[name];}};this.classList={add:name=>{this.className=[...new Set([...this.className.split(' ').filter(Boolean),name])].join(' ');},remove:name=>{this.className=this.className.split(' ').filter(x=>x!==name).join(' ');}};}
 get isConnected(){return this===this.owner.documentElement||!!this.parentNode?.isConnected;}
 get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
 set textContent(value){this.replaceChildren();this._text=String(value??'');}
 set innerHTML(value){assert.equal(value,'','widgets only clear HTML');this.replaceChildren();}
 append(...nodes){for(let node of nodes){if(typeof node==='string'){const text=this.owner.createTextNode(node);node=text;}node.remove();node.parentNode=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this._text='';this.append(...nodes);}
 remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null;}}
 getBoundingClientRect(){return {height:200};}
}
function documentFor(html){
 const document={ids:new Map(),events:new Map(),visibilityState:'visible',createElement(tag){return new Element(tag,this);},createTextNode(text){const node=new Element('#text',this);node.textContent=text;return node;},getElementById(id){return this.ids.get(id)||null;},addEventListener(name,fn){this.events.set(name,fn);}};
 document.documentElement=new Element('html',document);
 const stack=[document.documentElement];
 const markup=html.replace(/<script[^>]*>[\s\S]*?<\/script>|<style[^>]*>[\s\S]*?<\/style>/g,'');
 for(const token of markup.match(/<[^>]+>|[^<]+/g)||[]){
  if(/^<\//.test(token)){if(stack.length>1)stack.pop();continue;}
  if(/^<!/.test(token))continue;
  if(token[0]!=='<'){stack.at(-1).append(document.createTextNode(token));continue;}
  const tag=/^<([\w-]+)/.exec(token)?.[1];if(!tag||tag==='html')continue;
  const node=document.createElement(tag);
  for(const [,name,value] of token.matchAll(/([\w-]+)="([^"]*)"/g)){node.attributes[name]=value;if(name==='id'){node.id=value;document.ids.set(value,node);}if(name==='class')node.className=value;if(name.startsWith('data-'))node.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
  node.hidden=/\shidden(?:\s|>)/.test(token);stack.at(-1).append(node);
  if(!['meta','link','input','br','hr'].includes(tag)&&!token.endsWith('/>'))stack.push(node);
 }
 const all=()=>{const list=[];const walk=node=>{list.push(node);node.children.forEach(walk);};walk(document.documentElement);return list;};
 document.querySelectorAll=selector=>{if(selector==='[data-local-text]')return all().filter(x=>x.dataset.localText);if(selector==='#permissionButtons button,#blockerOptions button')return all().filter(x=>x.tagName==='button'&&['permissionButtons','blockerOptions'].includes(x.parentNode?.id)||x.tagName==='button'&&x.parentNode?.parentNode?.id==='blockerOptions');throw Error('Unhandled selector '+selector);};
 document.querySelector=selector=>selector==='.card'?all().find(x=>x.className.split(' ').includes('card')):null;
 return document;
}
function harness(name){
 assert.ok(zh['ui.taskWidget.documentTitle']&&zh['ui.imageBatch.documentTitle'],'Root must merge widgets/zh.fragment.json, or set CHATHAND_WIDGET_FRAGMENT for pre-merge checks');
 const files=generatedUILocaleFiles(root,tables),html=files['ui/'+name+'.html'];
 const document=documentFor(html),timers=new Map(),events=new Map(),calls=[],messages=[];let seq=0;
 const context=vm.createContext({document,console,Map,Set,Date:class extends Date {static now(){return fixedNow;}},crypto:{randomUUID:()=> 'test-request'},setTimeout:(callback,ms)=>{timers.set(++seq,{callback,ms});return seq;},clearTimeout:id=>timers.delete(id),queueMicrotask:fn=>fn(),ResizeObserver:class {observe(){}},addEventListener:(name,fn)=>events.set(name,fn),postMessage:message=>messages.push(message),navigator:{language:'en-US'}});
 context.window=context;context.parent=context;
 for(const [,script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)){vm.runInContext(script,context);if(context.ChatHandText&&!context.__checkedText){const translate=context.ChatHandText.t;context.ChatHandText.t=(key,params)=>{assert.ok(Object.hasOwn(zh,key),'missing widget Chinese key '+key);return translate(key,params);};context.__checkedText=true;}}
 return {context,document,timers,calls,messages,run:source=>vm.runInContext(source,context),get:id=>document.getElementById(id),switchTo:locale=>context.ChatHandText.installCatalogs({locale})};
}
const snapshot=h=>h.run('JSON.stringify({cardNonce,cardSubmitted,relayToken,relayPermit,relayGeneration,cardKind,mySeq,collapsed,polls,timer,timerDue,permissionTimer,permissionPoll,armTimer,cardReadyAt})');

test('widgets use a generated inline runtime, default Chinese, and no external requests',()=>{
 for(const name of ['task-widget','image-batch-widget']){
  const source=fs.readFileSync(new URL("../../ui/"+name+'.html',import.meta.url),'utf8');
  assert.equal((source.match(/<!-- CHATHAND_LOCAL_TEXT_INLINE -->/g)||[]).length,1);
  assert.doesNotMatch(source,/<script[^>]+src=|\bfetch\(|navigator\.language|native\(/);
  const h=harness(name);assert.equal(h.context.ChatHandText.locale,'zh');assert.equal(h.document.documentElement.lang,'zh-CN');
  assert.equal(h.get('title').textContent,name==='task-widget'?'正在读取任务':'正在读取');
  h.switchTo('en');assert.match(h.get('title').textContent,/^@@ui\./);h.switchTo('zh');assert.match(h.get('title').textContent,/^正在读取/);
 }
});
test('task text updates keep progress, relay credentials, buttons, and scheduling unchanged',()=>{
 const h=harness('task-widget');h.context.openai={callTool:async(...args)=>{h.calls.push(args);return {};},sendFollowUpMessage:async()=>{throw Error('locale repaint must never send');}};
 h.run(`acceptMetadata({'chathand/relay_card_token':'a'.repeat(64)});render({task_id:'task-1',status:'active',checkpoint_seq:0,last_checkpoint:{block:2,total:4,next:'原始下一步'},recent_steps:[{tool:'write_file',target:'/tmp/原文.txt',at:Date.now()-10000}],relay:{available:true,checkpoint_seq:0,state:'manual_ready',manual_allowed:true,purpose:'interruption'},scope:'full'});`);
 assert.equal(h.get('block').textContent,'第 2/4 块');assert.equal(h.get('now').textContent,'10 秒前：写入 /tmp/原文.txt');assert.equal(h.get('alertText').textContent,'已中断');
 const button=h.get('alertBtn').children[0],before=snapshot(h),timers=[...h.timers.keys()];
 h.switchTo('en');assert.match(h.get('now').textContent,/@@ui.taskWidget.write@@/);assert.match(h.get('alertText').textContent,/@@ui.taskWidget.manualStalled@@/);assert.match(button.textContent,/@@ui.taskWidget.manualContinue@@/);
 assert.equal(h.get('alertBtn').children[0],button);assert.equal(snapshot(h),before);assert.deepEqual([...h.timers.keys()],timers);assert.equal(h.calls.length,0);assert.doesNotMatch(h.document.documentElement.textContent,/a{64}/);
 h.switchTo('zh');assert.equal(h.get('block').textContent,'第 2/4 块');
});
test('permission locale repaint preserves armed buttons and consumes the private nonce once',async()=>{
 const h=harness('task-widget');h.context.openai={callTool:async(name,args)=>{h.calls.push({name,args});return {structuredContent:{ok:true,state:'allowed',result_line:'原始回执',ai_waiting:true}};}};
 h.run(`acceptMetadata({'chathand/card_nonce':'b'.repeat(64)});render({card:'permission',item:{name:'原始能力'},cause:'原始原因',effect:{can_do:'原始作用',risk:'原始风险'},chat_ok:true,scopes:['always'],expires_at:Date.now()+120000});cardReadyAt=Date.now()-1;renderPermission(permissionData);`);
 const buttons=h.get('permissionButtons').children.slice(),before=snapshot(h),timers=[...h.timers.keys()];
 assert.equal(h.get('title').textContent,'允许「原始能力」？');assert.equal(h.get('permissionExpiry').textContent,'2 分钟内有效');assert.equal(buttons[0].textContent,'允许');assert.equal(buttons[0].disabled,false);
 h.switchTo('en');assert.match(h.get('title').textContent,/原始能力/);assert.equal(h.get('permissionCause').textContent,'原始原因');assert.equal(buttons[0].disabled,false);assert.deepEqual(h.get('permissionButtons').children,buttons);assert.equal(snapshot(h),before);assert.deepEqual([...h.timers.keys()],timers);
 await h.run(`answerCard('always')`);const after=snapshot(h);h.switchTo('zh');assert.equal(h.get('compactText').textContent,'原始回执 · ChatGPT 将继续执行');assert.equal(snapshot(h),after);assert.equal(buttons[0].disabled,true);await h.run(`answerCard('deny')`);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'card_answer');assert.equal(h.calls[0].args.nonce,'b'.repeat(64));assert.equal(h.calls[0].args.choice,'always');assert.doesNotMatch(h.document.documentElement.textContent,/b{64}/);
});
test('completed and compact task cards update full sentences while preserving raw paths and outcomes',()=>{
 const h=harness('task-widget');h.run(`render({task_id:'done-1',status:'completed',intermediate_errors:2,changes:[{tool:'write_file',path:'/tmp/原文.txt'},{tool:'write_file',path:'/tmp/原文.txt'}]});`);
 assert.equal(h.get('action').textContent,'无需操作。');assert.equal(h.get('action').className,'v none');assert.equal(h.get('changes').children[0].textContent,'写入 原文.txt · 2 次 …/tmp/');assert.equal(h.get('summary').textContent,'过程中出现 2 次错误，均已处理。');
 h.switchTo('en');assert.match(h.get('changes').textContent,/@@ui.taskWidget.write@@/);assert.match(h.get('action').textContent,/@@ui.taskWidget.noAction@@/);assert.equal(h.get('changes').children[0].title,'/tmp/原文.txt');
 h.run(`renderCompact({block:2,total:4,done:'原始成果'});`);const before=snapshot(h);h.switchTo('zh');assert.equal(h.get('compactText').textContent,'第 2/4 块 · 原始成果');assert.equal(snapshot(h),before);
});
test('image batches redraw complete next and finish sentences without changing observation or polling',()=>{
 const h=harness('image-batch-widget');h.run(`readMetadata({'chathand/image_batch_observation_nonce':'c'.repeat(64)});render({batch_id:'batch-1',total:2,saved:1,items:[{index:1,name:'原始图片一',status:'saved'},{index:2,name:'原始图片二',status:'pending'}]});`);
 assert.equal(h.get('next').textContent,'发送「继续」以生成第 2/2 张：原始图片二');assert.equal(h.get('next').children[0].textContent,'发送「继续」');assert.equal(h.get('list').children[1].textContent,'原始图片二 · 待生成');
 const before=h.run('JSON.stringify({view,observationNonce,seq,polls,timer})'),timers=[...h.timers.keys()];h.switchTo('en');assert.match(h.get('next').textContent,/@@ui.imageBatch.next@@/);assert.match(h.get('list').children[1].textContent,/@@ui.imageBatch.pending@@/);assert.equal(h.run('JSON.stringify({view,observationNonce,seq,polls,timer})'),before);assert.deepEqual([...h.timers.keys()],timers);
 h.switchTo('zh');h.run(`render({batch_id:'batch-1',total:2,saved:1,done:true,save_dir:'/tmp/{literal}<raw>',items:[{index:1,name:'原始图片一',status:'saved'},{index:2,name:'原始图片二',status:'failed'}]});`);
 assert.equal(h.get('done').textContent,'已完成，1 张失败：/tmp/{literal}<raw>');h.switchTo('en');assert.match(h.get('done').textContent,/@@ui.imageBatch.finishedWithFailuresPath@@/);assert.match(h.get('done').textContent,/\/tmp\/\{literal\}<raw>/);assert.doesNotMatch(h.document.documentElement.textContent,/c{64}/);
 h.switchTo('zh');h.run(`render({batch_id:'batch-1',total:1,saved:1,done:true,items:[{index:1,name:'原始图片一',status:'saved'}]});`);assert.equal(h.get('done').textContent,'1 张已全部保存');
});

test('checkpoint blocker and relay countdown branches have complete Chinese semantic keys',()=>{
 const h=harness('task-widget');
 h.run(`acceptMetadata({'chathand/card_nonce':'d'.repeat(64)});render({card:'checkpoint',task_id:'checkpoint-1',checkpoint_seq:1,checkpoint:{block:1,total:3,waiting_user:true,blocked:{step:'原始步骤',error:'原始错误',why:'原始原因',options:[{label:'原始选项',cost:'原始代价',action:'retry'},{label:'原始说明'}]}}});`);
 assert.equal(h.get('title').textContent,'进度已记录');assert.equal(h.get('blockerStep').textContent,'受阻步骤：原始步骤');assert.equal(h.get('blockerError').textContent,'错误信息：原始错误');assert.equal(h.get('blockerWhy').textContent,'原因：原始原因');assert.equal(h.get('blockerReply').textContent,'如需补充说明，请在下方输入框回复。');
 const option=h.get('blockerOptions').children[0].children[0],before=snapshot(h);h.switchTo('en');assert.match(h.get('title').textContent,/@@ui.taskWidget.progressRecorded@@/);assert.match(h.get('blockerError').textContent,/原始错误/);assert.equal(h.get('blockerOptions').children[0].children[0],option);assert.equal(option.textContent,'原始选项');assert.equal(snapshot(h),before);h.switchTo('zh');
 for(const [relay,expected] of [
  [{},'5 秒后继续'],[{prompt_kind:'split_smaller'},'5 秒后拆分为更小的步骤继续'],
  [{wait:{state:'done'}},'命令已完成 · 5 秒后继续'],[{wait:{state:'done'},prompt_kind:'split_smaller'},'命令已完成 · 5 秒后拆分为更小的步骤继续'],
  [{wait:{state:'over'}},'命令仍在运行 · 5 秒后继续'],[{wait:{state:'over'},prompt_kind:'split_smaller'},'命令仍在运行 · 5 秒后拆分为更小的步骤继续'],
  [{purpose:'interruption'},'已中断 · 5 秒后继续'],[{purpose:'interruption',prompt_kind:'split_smaller'},'同一块再次中断 · 5 秒后拆分为更小的步骤继续']
 ])assert.equal(h.run('relayCountdown('+JSON.stringify(relay)+',5)'),expected);
 for(const key of h.run('[...Object.values(names),...Object.values(VERB)]'))assert.ok(zh['ui.taskWidget.'+key]);
});
// 1081 N053（Claude，Ken 10/27）：命令的进程没确认清干净时，收尾那张卡照实写「清理没确认」，错误次数改说「记录到」；
// 错误码、命令编号不写在卡上。没有这个警告时卡上跟原来一样。窗口里的任务详情在 1081-cleanup-unconfirmed 里测。
test('finish cards say cleanup was not confirmed without codes, and stay unchanged without the warning',()=>{
 const warning={code:'CLEANUP_UNCONFIRMED',message:'清理没确认',message_en:'Cleanup not confirmed',jobs:[{job_id:'job-7f3a',cleanup_confirmed:false,cleanup_state:'unconfirmed',reason_code:'WINDOWS_JOB_QUERY_FAILED'}]};
 const finish=over=>'render('+JSON.stringify({task_id:'done-c',status:'completed',terminal:true,summary:'整理好了。',user_action:'不用做什么。',intermediate_errors:1,reply_format:{zh:'x'},...over})+');';
 const h=harness('task-widget');h.run(finish({cleanup_warning:warning}));
 assert.equal(h.get('summary').textContent,'过程中记录到 1 次错误。');assert.equal(h.get('summary').hidden,false);
 assert.equal(h.get('cleanup').textContent,'清理未确认：此任务运行的命令可能仍有进程未结束。');assert.equal(h.get('cleanup').hidden,false);
 assert.doesNotMatch(h.document.documentElement.textContent,/CLEANUP_UNCONFIRMED|job-7f3a|WINDOWS_JOB_QUERY_FAILED|均已处理/);
 h.switchTo('en');assert.match(h.get('cleanup').textContent,/@@ui.taskWidget.cleanupUnconfirmed@@/);assert.match(h.get('summary').textContent,/@@ui.taskWidget.errorsRecorded@@/);
 h.switchTo('zh');assert.equal(h.get('cleanup').textContent,'清理未确认：此任务运行的命令可能仍有进程未结束。');
 const failed=harness('task-widget');failed.run(finish({status:'failed',summary:'没做完。',intermediate_errors:2,cleanup_warning:warning}));
 assert.equal(failed.get('summary').textContent,'过程中记录到 2 次错误。');assert.equal(failed.get('cleanup').hidden,false);
 for(const over of [{},{cleanup_warning:{code:'SOMETHING_ELSE'}}]){
  const plain=harness('task-widget');plain.run(finish(over));
  assert.equal(plain.get('summary').textContent,'过程中出现 1 次错误，均已处理。');assert.equal(plain.get('cleanup').hidden,true);assert.equal(plain.get('cleanup').textContent,'');
 }
 const running=harness('task-widget');running.run('render('+JSON.stringify({task_id:'run-c',status:'active',intermediate_errors:1,cleanup_warning:warning})+');');
 assert.equal(running.get('cleanup').hidden,true);
});
