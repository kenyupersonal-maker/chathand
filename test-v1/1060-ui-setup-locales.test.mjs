import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {uiText,installCatalogs} from '../ui/local-text.mjs';

const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const zh={...JSON.parse(read('locales/zh.json')),...(process.env.CHATHAND_SETUP_FRAGMENT?JSON.parse(fs.readFileSync(process.env.CHATHAND_SETUP_FRAGMENT,'utf8')):{})};
assert.ok(zh['ui.wizard.tutorial.add.allowTools'],'Merge setup/zh.fragment.json or set CHATHAND_SETUP_FRAGMENT for pre-merge checks.');
const en=Object.fromEntries(Object.entries(zh).filter(([key])=>/^ui\.(wizard|setup|h10|skin|backdrops)\./.test(key)).map(([key,value])=>[key,'@@'+key+'@@ '+[...value.matchAll(/\{[A-Za-z][A-Za-z0-9_]*\}/g)].map(m=>m[0]).join(' ')]));
installCatalogs({locale:'zh',catalogs:{zh,en:{}}});
const prompts=await import('../ui/h10/prompts.mjs');
const views=await import('../ui/h10/views.mjs');
const {assets,assetLabels}=await import('../ui/h10/assets.mjs');
const descriptor={verified_source:true,template_url:'https://github.com/owner/repo/releases/download/test/site-template.zip',template_sha256:'a'.repeat(64),pairing_hash:'b'.repeat(64)};
const reset=()=>installCatalogs({locale:'zh'});

test('pure Node H10 imports preserve the complete approved installation sentence and literal paths',()=>{
 reset();
 const location='/tmp/实际包 $& {pairingHash} <本机>.dmg';
 assert.equal(prompts.installationPrompt({localPath:location}),'帮我安装并配好 ChatHand，包括在 ChatGPT 里替我连上 ChatHand 插件、把它的权限设成「允许使用所有工具」：从 '+location+' 下载，照包里的codex/INSTALL.md做。');
 assert.equal(prompts.INSTALL_PROMPT_TEMPLATE,'帮我安装并配好 ChatHand，包括在 ChatGPT 里替我连上 ChatHand 插件、把它的权限设成「允许使用所有工具」：从 <下载地址> 下载，照包里的codex/INSTALL.md做。');
 const h=prompts.installationHandoff({localPath:location});
 assert.equal(decodeURIComponent(h.deepLink.slice(prompts.INSTALL_DEEP_LINK_PREFIX.length)),h.prompt);
 assert.equal(prompts.installationHandoff().configured,false);
 assert.equal(prompts.installationHandoff().deepLink,null);
 assert.throws(()=>prompts.installationPrompt({localPath:'/tmp/a',downloadURL:'https://example.com/a'}),/Choose downloadURL OR localPath/);
});

test('Site handoffs preserve whole source sentences and every trusted descriptor parameter',()=>{
 reset();
 const d=descriptor;
 assert.equal(prompts.siteCreationHandoff(d).prompt,'帮我建一个只有我自己能用的 ChatHand 连接 Site。模板在 '+d.template_url+'，模板 zip 的 SHA-256 是 '+d.template_sha256+'，对不上就停下告诉我。配对哈希是 '+d.pairing_hash+'。照模板里的 STEPS.md 一步步做，最后把那一段代码放在代码块里给我。不要公开发布。模板下载不了，就停下来跟我说：回 ChatHand 点「ChatGPT 拿不到模板」，我把模板文件拖给你。');
 assert.equal(prompts.siteTemplateFileFollowup(d),'模板文件我拖进来了，SHA-256 应该是 '+d.template_sha256+'，对不上就停下。配对哈希还是 '+d.pairing_hash+'。照里面的 STEPS.md 接着建，最后把那一段代码放在代码块里给我。');
 assert.equal(prompts.siteAssistedSentence(d),'用 chathand-setup 技能，帮我把这台 Mac 上的 ChatHand 连到 ChatGPT（走 ChatGPT Site）。建站资料：模板 '+d.template_url+'，SHA-256 '+d.template_sha256+'，配对哈希 '+d.pairing_hash+'。这里跑不了本机命令的话，就照模板里的 STEPS.md 在 Work 里建，最后把那一段代码放在代码块里给我，我点复制。');
 assert.equal(prompts.siteUpdateHandoff(d,'https://owner.chatgpt.site'),'帮我把 ChatHand 连接 Site（https://owner.chatgpt.site）照新模板更新一次。就在当初建这个 Site 的项目里做，更新的还是这一个 Site。模板在 '+d.template_url+'，模板 zip 的 SHA-256 是 '+d.template_sha256+'，对不上就停下。照模板里 STEPS.md 的「更新已有 Site」做：不新建 Site，不重新配对，原来的密钥、配对记录和数据都留着。');
 assert.equal(prompts.siteCreationHandoff({...d,verified_source:false}).reason,'SITE_TEMPLATE_RELEASE_NOT_VERIFIED');
 assert.equal(prompts.siteUpdateHandoff(d,'https://untrusted.example'),null);
 assert.equal(prompts.sitePairingErrorCopy('UNKNOWN_CODE'),'配对失败（UNKNOWN_CODE）。请回到创建 Site 的对话，向 ChatGPT 获取新的代码，然后点击「复制」。');
 assert.equal(prompts.sitePairingErrorCopy('<unsafe>'),'配对失败。请回到创建 Site 的对话，向 ChatGPT 获取新的代码，然后点击「复制」。');
});

test('H10 text, frozen exported lists, error copy and alt labels follow a later shared locale update',()=>{
 try{
  installCatalogs({locale:'en',catalogs:{en}});
  assert.equal(views.STEP_TITLES[0],en['ui.h10.views.verifyPackageStep']);
  assert.equal(prompts.SITE_PAIRING_ERROR_COPY.B_TEMPLATE_MISMATCH,en['ui.h10.prompts.templateMismatch']);
  assert.ok(prompts.INSTALL_PROMPT_TEMPLATE.startsWith('@@ui.h10.prompts.installPrompt@@'));
  assert.equal(assets.people.alt,en['ui.h10.assets.peopleAlt']);
  assert.equal(assetLabels.siteConnect,en['ui.h10.assets.siteConnectLabel']);
  const html=views.renderH10({screen:'f7',connectionRoute:'site',provenance:'host',steps:[]});
  assert.match(html,/@@ui\.h10\.views\.verifyPackageStep@@/);
  assert.match(html,/@@ui\.h10\.views\.assistedProgressTitle@@/);
 }finally{reset();}
});

test('H10 keeps trusted button and shortcut markup while escaping ordinary parameter text',()=>{
 reset();
 const receive=views.renderH10({screen:'f11',connectionRoute:'site',receiveMode:'automatic-capable'});
 assert.ok(receive.includes('未自动接收？请按 <kbd>⌘V</kbd>'));
 const release=views.renderH10({screen:'f1',connectionRoute:'site',launchState:'fallback'});
 assert.match(release,/未能打开？可能尚未安装 ChatGPT 桌面版 → <button[^>]+data-action="download-chatgpt"/);
 assert.doesNotMatch(receive+release,/\{(?:shortcut|link)\}|&lt;kbd|&lt;button/);
 assert.equal(uiText('ui.wizard.connectionTestPrompt',{nonce:'$& {code} <opaque>'}),'用 ChatHand 做连接测试，暗号 $& {code} <opaque>。先调用 connection_check，再调用 setup_write_probe，两次都用这个暗号。');
});

function classicHarness(file){
 const nodes=[];
 const make=()=>({hidden:true,innerHTML:'',dataset:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;},append(){},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}});
 const app=make(),document={body:{append:node=>nodes.push(node)},head:{append(){}},documentElement:make(),createElement:make,querySelector:()=>app,querySelectorAll:()=>[],addEventListener(){},write(){}};
 const calls=[],store=new Map();
 const context=vm.createContext({document,console,URLSearchParams,location:{search:''},matchMedia:()=>({matches:false,addEventListener(){}}),MutationObserver:class{observe(){}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},addEventListener(){},dispatchEvent(){},navigator:{language:'en-US'},S:{settings:{},credentials:{tunnel:true},setup_test:{verified:true,nonce:'nonce-$&-{}'},permissions:{tier:'full'},setup:{open_items:[]},automation:{browser:{extension:{}},computer:{permissions:{}}}},E:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),api:async(...args)=>{calls.push(args);return {};},connected:()=>false,connectionText:()=>'',icon:()=>'<svg/>',tunnelId:()=>'',fetch:async()=>({json:async()=>JSON.parse(read('ui/assets/tutorial/tutorial.json'))})});
 context.window=context;
 vm.runInContext(read('ui/local-text.js'),context);
 context.ChatHandText.installCatalogs({locale:'zh',catalogs:{zh,en}});
 vm.runInContext(read(file),context);
 return {context,nodes,calls,switchTo:locale=>context.ChatHandText.installCatalogs({locale}),run:source=>vm.runInContext(source,context)};
}

test('wizard renders Chinese independently of navigator.language and update without redoing setup',async()=>{
 const wizard=classicHarness('ui/wizard.js');
 await wizard.context.startWizard({initialStep:0});
 assert.ok(wizard.nodes[0].innerHTML.includes('很多账号无需单独开启开发者模式。请先查看菜单，没有相应选项时再开启。'));
 assert.ok(wizard.nodes[0].innerHTML.includes('创建通道'));
 const wizardCalls=wizard.calls.length;
 wizard.context.S.settings.setup_tunnel_id='tunnel_literal123';
 wizard.switchTo('en');
 assert.match(wizard.nodes[0].innerHTML,/@@ui\.wizard\.createTunnel@@/);
 assert.match(wizard.nodes[0].innerHTML,/@@ui\.wizard\.tutorial\.devmode\.lead@@/);
 assert.equal(wizard.calls.length,wizardCalls);
});

test('registered skin display names refresh while IDs and private names remain literal',()=>{
 const h=classicHarness('ui/skin.js');
 h.run(read('ui/skins/registry.js'));
 assert.equal(h.context.ChatHandSkin.list().find(x=>x.id==='quiet-titanium').name,'钛灰');
 h.context.ChatHandSkin.register({id:'my-private',name:'我的私人名字 $&',css:'/skins/my-private.css'});
 const skinIds=h.context.ChatHandSkin.list().map(x=>x.id).join('|');
 h.switchTo('en');
 assert.equal(h.context.ChatHandSkin.list().find(x=>x.id==='quiet-titanium').name,en['ui.skin.quietTitanium']);
 assert.equal(h.context.ChatHandSkin.list().find(x=>x.id==='my-private').name,'我的私人名字 $&');
 assert.equal(h.context.ChatHandSkin.list().map(x=>x.id).join('|'),skinIds);
});

test('tutorial JSON consumes locale keys and retains real tutorial structure and guarded permissions copy',()=>{
 const tutorial=JSON.parse(read('ui/assets/tutorial/tutorial.json'));
 const visit=value=>{if(!value||typeof value!=='object')return;if('textKey'in value){assert.equal(value.zh,'');assert.equal(value.en,'');assert.ok(zh[value.textKey]);}Object.values(value).forEach(visit);};visit(tutorial);
 const last=tutorial.steps['s-add'].subs.at(-1);
 assert.equal(last.shot,'s5e-tool-permissions');
 assert.equal(tutorial.steps['s-add'].subs.length,5);
 assert.equal(zh[last.textKey],'打开 ChatGPT 的「设置 → 插件 → ChatHand」，在「权限」中选择「允许使用所有工具」。否则写入文件、运行命令等操作会被 ChatGPT 拦截。AI 能执行哪些操作，仍由 ChatHand 的权限设置和高危开关控制。');
 assert.doesNotMatch(read('ui/wizard.js'),/\b(?:item|t|s|a)\.zh\b|navigator\.language/);
});
