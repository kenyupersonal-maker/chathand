import {INSTALL_PROMPT_TEMPLATE,installationHandoff} from '../../ui/h10/prompts.mjs';
import {setupHandoff,SETUP_PROMPT_TEMPLATE} from '../../app/v1/setup-handoff.mjs';
import {setupSkillStatus} from '../../app/v1/setup-skill-status.mjs';
import {installUiTextContext} from '../support/ui-text-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const installPrompt='进入 Work 模式，帮我安装 ChatHand 并连上 ChatGPT。安装包在「下载」文件夹里，步骤写在安装包里的 ChatHand.app/Contents/Resources/codex/INSTALL.md。';
const setupPrompt=setupHandoff({appPath:'/Applications/ChatHand.app',route:'openai'}).prompt;
const checkPrompt='用 chathand-setup 技能检查本机 ChatHand 连接，只检查，不修改已有健康连接。';
const allowReminder='在 ChatGPT 里打开 设置 → 插件 → ChatHand，在「权限」里选「允许使用所有工具」。不改的话，写文件、跑命令会被拦下，或者每次都要你点允许。ChatHand 能做什么，仍由它自己的权限档位和高危开关决定。';

test('installation prompt stays in the install docs and the DMG keeps the reviewed HTML entries',()=>{
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  for(const file of ['README.zh-CN.md','docs/INSTALL.md','docs/release-notes-1.0.0-beta.4-draft.md'])
    assert.ok(read(file).includes(installPrompt),`${file} must contain the exact installation prompt`);
  const manual='把 ChatHand 拖进「应用程序」，再双击安装盘里的「第一次打开」，照页面复制命令，到终端粘贴、回车，ChatHand 会自己打开。';
  assert.equal(read('docs/release-notes-1.0.0-beta.2-draft.md').split(manual).length-1,1,'the earlier release draft keeps its reviewed manual path');
  assert.ok(read('README.zh-CN.md').includes('双击安装盘里的「第一次打开」，点「复制命令」，到「终端」粘贴、回车。'),'the README now leads with the copyable terminal command');
  for(const step of ['1. 双击安装盘里的「第一次打开」，点「复制命令」。','2. 打开「终端」：按 ⌘空格，输入「终端」，再按回车。','3. 在终端里按 ⌘V 粘贴，再按回车。ChatHand 会自己打开。'])
    assert.ok(read('docs/INSTALL.md').includes(step),`the installation guide retains the manual step: ${step}`);
  assert.ok(read('docs/INSTALL.md').includes('这行命令只做三件事：没装的话，从安装盘装进「应用程序」；去掉 ChatHand 的下载标记；打开它。不改系统设置。'));
  for(const [file,ejected] of [['README.zh-CN.md','安装盘已经推出、找不到「第一次打开」？去「下载」里重新双击 DMG。'],['docs/INSTALL.md','安装盘已经推出、找不到「第一次打开」：去「下载」里重新双击 DMG。']]){
    const text=read(file),at=text.indexOf(ejected),step=text.lastIndexOf('双击安装盘里的「第一次打开」',at);
    assert.ok(at>=0&&step>=0&&at-step<300,`${file} must put the ejected-disk hint right next to the 第一次打开 instructions`);
  }
  for(const file of ['docs/release-notes-1.0.0-beta.2-draft.md'])
    assert.ok(read(file).includes('首次打开需要放行一次：双击安装盘里的「第一次打开」，照页面操作（交给 Codex 装的话它会处理）。'),`${file} points first-time users at 第一次打开`);
  for(const file of ['README.zh-CN.md','docs/INSTALL.md','docs/release-notes-1.0.0-beta.2-draft.md','docs/release-notes-1.0.0-beta.4-draft.md','scripts/build-dmg.py','ui/assets/dmg/background.html','ui/assets/dmg/让 ChatGPT 来装.html'])
    for(const stale of ['打不开时点这里','复制放行命令']) assert.ok(!read(file).includes(stale),`${file} must not mention ${stale}`);
  const background=read('ui/assets/dmg/background.html');
  for(const text of ['让 ChatGPT 来装','双击右侧的「让 ChatGPT 来装」','浏览器问要不要打开 ChatGPT，点「打开」','ChatGPT 填好提示词后，按「回车」','将 ChatHand 拖入「应用程序」','打不开时，双击「第一次打开」'])
    assert.ok(background.includes(text),`the disk background keeps its reviewed action: ${text}`);
  const builder=read('scripts/build-dmg.py');
  assert.ok(builder.includes("'让 ChatGPT 来装.html'"));
  assert.ok(!fs.existsSync(path.join(root,'ui/assets/dmg/让 Codex 来装.html')),'the old Finder entry name is gone');
  assert.equal(builder.split("'第一次打开.html'").length-1,2,'the builder takes the renamed page from the assets and ships it under the same name');
  assert.ok(builder.includes("str(assets / 'helpdoc.icns'), str(help_page)"),'the page keeps the helpdoc icon');
  assert.match(builder,/'hide_extensions': \[entry_name, help_page\.name\]/);
  assert.ok(builder.includes("'icon_size': 64"));
  assert.ok(builder.includes("'text_size': 12"));
  assert.match(builder,/entry_name: \(565, 276\)/);
  const helpPosition=builder.match(/help_page\.name: \((\d+), (\d+)\)/);assert.ok(helpPosition);const [helpX,helpY]=helpPosition.slice(1).map(Number);assert.deepEqual([helpX,helpY],[610,578],'reviewed help entry remains in its lower-right DMG slot');
  const entry=read('ui/assets/dmg/让 ChatGPT 来装.html');
  const prerequisites=text=>text.match(/## 用之前要准备的\n\n([\s\S]*?)\n\n## /)?.[1];
  assert.ok(prerequisites(read('README.zh-CN.md')));
  assert.equal(prerequisites(read('docs/release-notes-1.0.0-beta.4-draft.md')),prerequisites(read('README.zh-CN.md')),'the new release draft copies the prerequisites exactly');
  assert.equal(JSON.parse(entry.match(/const template=("(?:\\.|[^"])*");/)[1]),INSTALL_PROMPT_TEMPLATE);
  const tips=entry.match(/<details class="fallback fold"><summary>遇到问题？<\/summary><ul class="tips">([\s\S]*?)<\/ul><\/details>/);
  assert.ok(tips,'entry page carries the exact 遇到问题？ list in a disclosure closed by default');
  assert.deepEqual([...tips[1].matchAll(/<li>([^<]*)<\/li>/g)].map(m=>m[1]),[
    '停在普通聊天？点左上角「ChatGPT ⌄」切到「Codex」，再发一次。',
    '没有桌面版或 Codex？回安装盘选「自己安装」。',
    '弹出权限确认请点「允许」；误点「拒绝」就发一句「继续」。'
  ],'exactly the three fallback items');
  assert.ok(!entry.includes('<p class="after">没自动转到'),'the old one-line note is replaced by the list');
  assert.ok(!entry.includes('<ol class="steps">'),'the two old steps are incorporated into the one-line introduction');
  assert.ok(entry.includes('<title>正在打开 ChatGPT 桌面版</title>')&&entry.includes('id="gptmark"'));
  assert.ok(entry.indexOf('id="go"')<entry.indexOf('<summary>遇到问题？'),'the fallback follows the main action');
  assert.ok(entry.includes('setTimeout(openCodex,300)'));
  assert.ok(entry.includes("const link='codex://new?prompt='+encodeURIComponent(prompt)+'&mode=codex';"),'the deep link requests Codex mode and carries the prompt');
  assert.ok(!/[?&]path=/.test(entry),'DMG entry never sends a separate path query');
  assert.ok(entry.includes("f.startsWith('/Volumes/')")&&entry.includes('if(app)setTimeout(openCodex,300)'),'only a mounted local file schedules automatic launch');
  const prompt=INSTALL_PROMPT_TEMPLATE.replace('<下载地址>','/Volumes/ChatHand TEST/ChatHand.app'),url=new URL(installationHandoff({localPath:'/Volumes/ChatHand TEST/ChatHand.app'}).deepLink);
  assert.equal(url.protocol,'codex:');
  assert.equal(url.host,'new');
  assert.equal(url.pathname,'');
  assert.equal(url.searchParams.get('prompt'),prompt);
  assert.equal(url.searchParams.has('path'),false);
});

const helpFile='ui/assets/dmg/第一次打开.html';
const openCommand='A=/Applications/ChatHand.app; [ -d "$A" ] || { S=$(sh -c \'ls -d /Volumes/ChatHand*/ChatHand.app\' 2>/dev/null | head -n1); [ -n "$S" ] && ditto "$S" "$A"; }; if [ -d "$A" ]; then xattr -dr com.apple.quarantine "$A" 2>/dev/null; open "$A"; else echo "没找到 ChatHand：先双击打开安装盘，再粘贴一次。"; fi';
const decodeEntities=text=>text.replace(/&(amp|lt|gt|quot|#39);/g,(all,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[name]);
function pageCommand(){
  const html=fs.readFileSync(path.join(root,helpFile),'utf8');
  assert.equal(html.split('id="cmd"').length-1,1,'the page has exactly one command element');
  const match=html.match(/<code id="cmd">([^<]*)<\/code>/);
  assert.ok(match,'the command sits in <code id="cmd">');
  assert.ok(html.includes('id="copybtn" type="button" data-copy="cmd"'),'the copy button copies that element');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|#39;)/.test(match[1]),'every ampersand in the command is escaped');
  return decodeEntities(match[1]).trim();
}

test('first-open page puts one copyable install-and-open command first, in a gray box, and keeps the ChatGPT and system-settings paths',()=>{
  const html=fs.readFileSync(path.join(root,helpFile),'utf8');
  assert.ok(!fs.existsSync(path.join(root,'ui/assets/dmg/打不开时点这里.html')),'the old file name is gone');
  assert.ok(html.includes('<title>第一次打开 ChatHand</title>')&&html.includes('<h1>第一次打开 ChatHand</h1>'));
  assert.ok(html.includes('<p>ChatHand 还没做苹果公证，macOS 第一次会拦一下。复制下面这行命令，到终端粘贴、回车，ChatHand 会自己打开。以后直接从「应用程序」打开就行。</p>'),'subtitle');
  for(const expected of ['复制命令','完成','移到废纸篓','仍要打开','取消','打开「隐私与安全性」','打开 ChatGPT 并填好'])
    assert.ok(html.includes(expected),`first-open page must include ${expected}`);
  assert.ok(html.indexOf('复制命令')<html.indexOf('打开 ChatGPT 并填好'),'terminal first, ChatGPT second');
  assert.ok(html.includes("$('openChatGPT').dataset.open='codex://new?prompt='+encodeURIComponent(installPrompt)+'&mode=codex'"),'button requests Codex mode and derives the link at runtime');
  assert.equal(JSON.parse(html.match(/const template=("(?:\\.|[^"])*");/)[1]),INSTALL_PROMPT_TEMPLATE);
  assert.ok(html.includes('id="prompt" hidden></div>'));
  assert.ok(!/[?&]path=/.test(html),'first-open page never sends a separate path query');
  assert.ok(html.includes("f.startsWith('/Volumes/')"),'only actual mounted local page provides a path');
  for(const stale of ['信任文件夹','切到「工作」','上方「工作」','打不开时点这里','复制放行命令','No such file','先确认 ChatHand 已经拖进','没拖就先拖','从安装盘把 ChatHand 重新拖进','还没把 ChatHand 拖进','只去掉 ChatHand 的下载标记'])
    assert.ok(!html.includes(stale),`first-open page must not mention ${stale}`);
  const lines={
    top:'先把 ChatHand 拖进「应用程序」。没拖也没关系，这行命令会自己从安装盘装进去。',
    blocked:'已经双击过、被拦了？没关系，照样做这一步。',
    keys:'⌘ 空格打不开搜索？从 启动台 → 其他 → 终端 打开。',
    term:'看到“没找到 ChatHand”？先双击打开安装盘，再粘贴一次。',
    tip:'这行命令只做三件事：没装的话，从安装盘装进「应用程序」；去掉 ChatHand 的下载标记；打开它。不改系统设置。',
    trash:'点了「移到废纸篓」？安装盘还开着的话，直接做上面的命令就行，它会重新装进去。'
  };
  for(const [name,line] of Object.entries(lines)) assert.equal(html.split(line).length-1,1,`first-open page carries the ${name} line exactly once`);
  assert.match(html,new RegExp(`<p class="note top">${lines.top}</p>\\s*<p class="note top">${lines.blocked}</p>`),'the already-blocked line comes right after the drag line');
  assert.ok(html.indexOf('id="copybtn"')<html.indexOf('</ol>')&&html.indexOf('</ol>')<html.indexOf(lines.top),'the copy button leads; the quiet fallback lines sit below the terminal steps');
  assert.ok(html.includes('<details class="alt fold">')&&html.includes('<summary>有 ChatGPT 桌面版？交给它</summary>'),'the ChatGPT alternative is closed by default');
  assert.ok(html.includes('<details class="guide fold">'),'the system-settings alternative is closed by default');
  assert.ok(html.indexOf('</ol>')<html.indexOf(lines.keys)&&html.indexOf(lines.keys)<html.indexOf('class="ill term"'),'the 启动台 fallback sits under the keycap steps');
  assert.ok(html.indexOf('class="ill term"')<html.indexOf(lines.term),'the not-found line sits under the terminal illustration');
  assert.ok(html.indexOf('<p class="tip">')<html.indexOf(lines.tip),'the reassurance sentence is the tip');
  assert.ok(html.indexOf('<div class="guide-body">')<html.indexOf(lines.trash)&&html.indexOf(lines.trash)<html.indexOf('<div class="steps">'),'the 移到废纸篓 line opens the system-settings section');
  const box=html.match(/<div class="cmdbox"><code id="cmd">[^<]*<\/code><button class="btn primary" id="copybtn" type="button" data-copy="cmd"[^>]*>[\s\S]*?<\/button><\/div>\s*<p class="tip">/);
  assert.ok(box,'the command is shown in a gray box with the copy button at its bottom right, and the tip right under it');
  assert.ok(!html.includes('<details class="cmdbox">')&&!html.includes('查看完整命令'),'the collapsed command row is gone');
  assert.ok(html.includes("const d=src.closest('details');if(d)d.open=true;"),'a failed copy opens the box so the command can be selected by hand');
  assert.ok(html.includes('~ %</tspan> A=/Applications/ChatHand.app; …</text>')&&html.includes('>open "$A"</text>'),'the terminal picture shows the shortened form');
  assert.ok(!html.includes('xattr -dr com.apple.quarantine</text>'),'the picture no longer shows the old two-step command');
  assert.equal(pageCommand(),openCommand,'the button copies exactly the shipped command');
});

test('the first-open page copy button puts exactly the command on the clipboard, and a failed copy opens the collapsed box',async()=>{
  const script=fs.readFileSync(path.join(root,helpFile),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const click=async({clipboard,exec})=>{
    const details={open:false},label={textContent:'复制命令'};
    const button={dataset:{copy:'cmd',ok:'已复制，去终端粘贴',fail:'复制没成功，请手动选中命令'},querySelector:()=>label,closest:selector=>selector==='[data-copy]'?button:null};
    const command={textContent:`  ${pageCommand()}  `,hidden:false,closest:selector=>selector==='details'?details:null};
    const elements={copybtn:button,cmd:command,live:{textContent:''},prompt:{textContent:''},openChatGPT:{dataset:{}}};
    let listener=null,copied=null,selected=null;
    const sandbox={
      setTimeout:()=>0,clearTimeout(){},location:{},
      navigator:{clipboard:{writeText:async text=>{if(!clipboard)throw Error('blocked');copied=text;}}},
      getSelection:()=>({removeAllRanges(){},addRange(){}}),
      document:{
        getElementById:id=>elements[id],addEventListener:(type,handler)=>{listener=handler;},activeElement:null,body:{appendChild(){}},
        createElement:()=>({style:{},value:'',select(){},remove(){}}),execCommand:()=>exec,createRange:()=>({selectNodeContents:node=>{selected=node;}})
      }
    };
    vm.createContext(sandbox);installUiTextContext(sandbox);
    vm.runInContext(script,sandbox);
    await listener({target:button});
    return {copied,detailsOpen:details.open,selected,command,state:button.dataset.state};
  };
  const good=await click({clipboard:true,exec:true});
  assert.equal(good.copied,openCommand,'the clipboard gets exactly the shipped command, without the surrounding whitespace');
  assert.equal(good.state,'ok');
  assert.equal(good.detailsOpen,false,'a successful copy leaves the command collapsed');
  const bad=await click({clipboard:false,exec:false});
  assert.equal(bad.copied,null);
  assert.equal(bad.state,'fail');
  assert.equal(bad.detailsOpen,true,'a failed copy opens the box');
  assert.equal(bad.selected,bad.command,'and selects the command for copying by hand');
});

test('the first-open command installs from the disk when needed, only looks at the disks when the app is missing, opens even when the flag is already gone, and stays quiet in bash, sh and zsh',()=>{
  const command=pageCommand();
  assert.equal(command,openCommand);
  const child=command.match(/\bsh -c '([^']*)'/);
  assert.ok(child,'the disks are listed by a child sh whose script is one single-quoted argument');
  assert.equal(child[1],'ls -d /Volumes/ChatHand*/ChatHand.app','the child sh only lists ChatHand disks');
  assert.equal(command.split('*').length,2,'the glob character appears once, inside that argument');
  assert.ok(!/[*?]/.test(command.replace(child[0],'').replace(/"[^"]*"/g,'')),'no glob character is left for the shell the user pastes into: zsh would stop with "no matches found"');
  const appLine='A=/Applications/ChatHand.app;',lsPart='ls -d /Volumes/ChatHand*/ChatHand.app';
  assert.equal(command.split(appLine).length,2);
  assert.equal(command.split(lsPart).length,2);
  const appHarness='A="$TEST_APPLICATIONS/ChatHand.app";',lsHarness='ls -d "$TEST_VOLUMES"/ChatHand*/ChatHand.app';
  const harness=command.replace(appLine,()=>appHarness).replace(lsPart,()=>lsHarness);
  assert.equal(harness.replace(appHarness,()=>appLine).replace(lsHarness,()=>lsPart),command,'the harness copy differs from the shipped command only in the two path prefixes');
  const shells={bash:['--noprofile','--norc','-c'],sh:['-c'],zsh:['-f','-c']};
  const available=Object.keys(shells).filter(name=>spawnSync(name,['-c','exit 0']).status===0);
  assert.ok(available.includes('bash')&&available.includes('sh'),'bash and sh exist on the machine running the tests');
  const message='没找到 ChatHand：先双击打开安装盘，再粘贴一次。\n';
  const stubScript=(extra='')=>['#!/bin/sh','printf \'%s\' "${0##*/}" >> "$TEST_LOG"','for a in "$@"; do printf \'\\t%s\' "$a" >> "$TEST_LOG"; done','printf \'\\n\' >> "$TEST_LOG"',extra].filter(Boolean).join('\n')+'\n';
  const realLs=['/bin/ls','/usr/bin/ls'].find(candidate=>fs.existsSync(candidate));
  assert.ok(realLs,'a real ls exists for the recording stub to hand over to');
  const stubs={
    xattr:'if [ "$TEST_XATTR_STATUS" != 0 ]; then echo "xattr: No such xattr: com.apple.quarantine" >&2; exit "$TEST_XATTR_STATUS"; fi',
    open:'',
    ditto:'if [ "$TEST_DITTO_STATUS" != 0 ]; then echo "ditto: $2: Permission denied" >&2; exit "$TEST_DITTO_STATUS"; fi\ncp -R "$1" "$2"',
    ls:'exec "$TEST_REAL_LS" "$@"'
  };
  const scenarios=[
    {name:'the app is already in place',app:true,disks:['ChatHand 1.0.0-beta.2']},
    {name:'the app is in place and xattr exits 1 because the flag is already gone',app:true,disks:[],xattr:1},
    {name:'the app is in place and the disks folder cannot even be read',app:true,disks:['ChatHand 1.0.0-beta.2'],lockVolumes:true},
    {name:'the app is only on the mounted disk',disks:['ChatHand 1.0.0-beta.2']},
    {name:'the app arrives from the disk and xattr exits 1',disks:['ChatHand 1.0.0-beta.2'],xattr:1},
    {name:'the disk name has spaces and a numeric suffix',disks:['ChatHand 1.0.0-beta.2 1']},
    {name:'the same disk is mounted twice',disks:['ChatHand 1.0.0-beta.2','ChatHand 1.0.0-beta.2 1']},
    {name:'neither the app nor a ChatHand disk is there',disks:[]},
    {name:'the copy fails',disks:['ChatHand 1.0.0-beta.2'],ditto:1}
  ];
  for(const shell of available) for(const scenario of scenarios){
    const label=`${shell}: ${scenario.name}`,inPlace=scenario.app===true,copies=!inPlace&&scenario.disks.length>0,installed=inPlace||(copies&&!scenario.ditto);
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-open-'));
    try{
      const applications=path.join(tmp,'Applications dir'),volumes=path.join(tmp,'Volumes'),bin=path.join(tmp,'bin'),log=path.join(tmp,'calls.log'),app=path.join(applications,'ChatHand.app');
      for(const dir of [applications,volumes,bin]) fs.mkdirSync(dir);
      if(inPlace){fs.mkdirSync(app);fs.writeFileSync(path.join(app,'marker.txt'),'installed');}
      for(const disk of scenario.disks){
        fs.mkdirSync(path.join(volumes,disk,'ChatHand.app'),{recursive:true});
        fs.writeFileSync(path.join(volumes,disk,'ChatHand.app','marker.txt'),disk);
      }
      fs.mkdirSync(path.join(volumes,'Other disk','ChatHand.app'),{recursive:true});
      fs.mkdirSync(path.join(volumes,'ChatHand Backup'));
      fs.mkdirSync(path.join(volumes,'ChatHand Deep','sub','ChatHand.app'),{recursive:true});
      for(const [name,extra] of Object.entries(stubs)){
        fs.writeFileSync(path.join(bin,name),stubScript(extra));
        fs.chmodSync(path.join(bin,name),0o755);
      }
      if(scenario.lockVolumes) fs.chmodSync(volumes,0o000);
      const result=spawnSync(shell,[...shells[shell],harness],{encoding:'utf8',env:{...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,LC_ALL:'C',TEST_APPLICATIONS:applications,TEST_VOLUMES:volumes,TEST_LOG:log,TEST_REAL_LS:realLs,TEST_XATTR_STATUS:String(scenario.xattr||0),TEST_DITTO_STATUS:String(scenario.ditto||0)}});
      const calls=(fs.existsSync(log)?fs.readFileSync(log,'utf8'):'').split('\n').filter(Boolean).map(line=>line.split('\t'));
      const named=name=>calls.filter(call=>call[0]===name);
      assert.equal(result.status,0,label);
      if(installed){
        assert.equal(result.stdout,'',`${label}: nothing is printed`);
        assert.equal(result.stderr,'',`${label}: nothing is complained about, not even by xattr`);
        if(inPlace) assert.deepEqual(named('ls'),[],`${label}: the disks are not even listed when the app is already there`);
        assert.deepEqual(calls.map(call=>call[0]),copies?['ls','ditto','xattr','open']:['xattr','open'],`${label}: the disks are listed only when the app is missing, then copy, then remove the flag, then open`);
        assert.deepEqual(named('xattr'),[['xattr','-dr','com.apple.quarantine',app]],`${label}: the download flag is removed from the app in Applications`);
        assert.deepEqual(named('open'),[['open',app]],`${label}: that app is opened, whatever xattr said`);
        if(copies){
          const [listing]=named('ls');
          assert.deepEqual(listing.slice(1).sort(),['-d',...scenario.disks.map(disk=>path.join(volumes,disk,'ChatHand.app'))].sort(),`${label}: only the ChatHand disks are listed`);
          const [ditto]=named('ditto');
          assert.equal(ditto.length,3,`${label}: ditto gets exactly a source and a destination`);
          assert.equal(ditto[2],app,`${label}: the destination is the app path`);
          assert.ok(scenario.disks.some(disk=>ditto[1]===path.join(volumes,disk,'ChatHand.app')),`${label}: the source is a mounted ChatHand disk`);
          assert.equal(fs.readFileSync(path.join(app,'marker.txt'),'utf8'),path.basename(path.dirname(ditto[1])),`${label}: the app really arrived from that disk`);
        } else assert.equal(fs.readFileSync(path.join(app,'marker.txt'),'utf8'),'installed',`${label}: an app that is already there is left alone`);
      } else {
        assert.equal(result.stdout,message,`${label}: says it could not find ChatHand`);
        assert.ok(!fs.existsSync(app),`${label}: nothing is installed`);
        assert.ok(!/no matches found/.test(result.stderr),`${label}: no shell complains about a glob`);
        if(copies){
          assert.match(result.stderr,/^ditto: .*ChatHand\.app: Permission denied\n$/,`${label}: the reason the copy failed stays visible`);
          assert.deepEqual(calls.map(call=>call[0]),['ls','ditto'],`${label}: nothing is unblocked or opened after a failed copy`);
        } else {
          assert.equal(result.stderr,'',`${label}: nothing else is printed`);
          assert.deepEqual(calls.map(call=>call[0]),['ls'],`${label}: the disks are looked at once, nothing is copied, unblocked or opened`);
        }
      }
    } finally {
      try{fs.chmodSync(path.join(tmp,'Volumes'),0o755);}catch{}
      fs.rmSync(tmp,{recursive:true,force:true});
    }
  }
});

test('setup handoff uses the shared prompt template',()=>{
  assert.equal(setupPrompt.replaceAll('/Applications/ChatHand.app','<app>'),SETUP_PROMPT_TEMPLATE.replace('<route>','OpenAI 通道'));
});

test('first-run auto-open goes straight to the configuring screen only when the setup skill is installed and the Mac is not connected',t=>{
  const source=fs.readFileSync(path.join(root,'ui/wizard.js'),'utf8');
  const installed={installed:true,managed:true},missing={installed:false,managed:false};
  const run=(state,{linked=false,refreshes=1}={})=>{
    if(linked)state={...state,credentials:{tunnel:true}};const events=[];
    const element=()=>({hidden:true,innerHTML:'',dataset:{},setAttribute(){},append(){},addEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]});
    const sandbox={
      document:{createElement:element,body:{append(){}},querySelector:()=>({inert:false})},
      window:{addEventListener(){}},fetch:async()=>({json:async()=>({steps:{}})}),
      E:String,S:{settings:state.settings},connected:()=>linked,connectionText:()=>'',
      api:async()=>({}),native:async()=>({}),toast(){},refresh:async()=>{},userMessage:String,action:async()=>{},PROMPTS:[''],PROMPT_COPY_HINT:''
    };
    vm.createContext(sandbox);installUiTextContext(sandbox);
    vm.runInContext(source,sandbox);
    const win=sandbox.window;
    win.startWizard=async()=>{events.push(['wizard']);};win.startH10=entry=>events.push(['h10',entry.route,entry.screen]);
    for(let i=0;i<refreshes;i++) win.wizardRefresh(state);
    return events;
  };
  const first={settings:{setup_complete:false}};
  // 1083（Claude，Ken 10/28 21:38）：没选过连接方式默认 OpenAI 通道（原来是 Site），帮我配的进度也照这条画。
  assert.deepEqual(run({...first,setup_skill:installed}),[['h10','openai','f7']],'an installed setup skill hands the user to current H10 assisted progress on the OpenAI Tunnel');
  assert.deepEqual(run({...first}),[['h10','openai','f6']],'no skill state: the first screen, as before');
  assert.deepEqual(run({...first,setup_skill:missing}),[['h10','openai','f6']],'skill not installed: the first screen, as before');
  const codexHome=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-setup-welcome-'));t.after(()=>fs.rmSync(codexHome,{recursive:true,force:true}));
  const legacy=path.join(codexHome,'skills/chathand-setup');fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'SKILL.md'),'---\nname: chathand-setup\n---\n');
  const legacyStatus=setupSkillStatus({codexHome});assert.deepEqual(legacyStatus,{installed:false,managed:true});
  assert.deepEqual(run({...first,setup_skill:legacyStatus}),[['h10','openai','f6']],'an unmarked legacy skill still opens the welcome screen');
  assert.deepEqual(run({...first,setup_skill:installed},{linked:true}),[],'skill installed but already connected: no configuring screen');
  assert.deepEqual(run({settings:{setup_complete:true,tunnel:'tunnel_configured01'},setup_skill:installed}),[],'setup complete and saved connection: nothing opens');
  assert.deepEqual(run({settings:{tunnel:'tunnel_configured01'},setup_skill:installed}),[],'a saved tunnel without a setup step: nothing opens');
  for(const step of [0,2]) assert.deepEqual(run({settings:{setup_step:step},setup_skill:installed}),[...(step===0?[['h10','openai','f7']]:[['wizard']])],`an unfinished setup (step ${step}) resumes the current flow`);
  assert.deepEqual(run({...first,setup_skill:installed},{refreshes:3}),[['h10','openai','f7']],'it opens once; later refreshes do not reopen a setup flow');
});

test('Work-mode check prompt is used, and the allow reminder appears only in the unobtrusive places',()=>{
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  const app=read('ui/app.js');
  assert.ok(app.includes('case\'codexTest\':await openChatGPT(T("ui.window.action.codexTest.text"),{work:true});return;'),'the localized check prompt opens ChatGPT in Work mode');
  const zh=JSON.parse(fs.readFileSync(path.join(root,'locales/zh.json'),'utf8')),en=JSON.parse(fs.readFileSync(path.join(root,'locales/en.json'),'utf8'));
  assert.equal(zh['ui.window.action.codexTest.text'],checkPrompt);assert.ok(en['ui.window.action.codexTest.text']);
  assert.ok(app.includes("mode:work?'work':'chat'"),'openChatGPT sends the requested mode to the native open action');
  // Current setup policy retains local switch boundaries, healthy connections and target-chat evidence.
  const docsAllowReminder=allowReminder;
  assert.ok(read('README.zh-CN.md').includes(docsAllowReminder),'README retains the explicit ChatGPT setting location and bounded permission reminder');
  const install=read('docs/INSTALL.md');assert.match(install,/AI 自己在 ChatGPT 里打开 设置 → 插件 → ChatHand/);assert.match(install,/把「权限」设为「允许使用所有工具」/);assert.match(install,/ChatHand 能做什么，仍由它自己的权限档位和高危开关决定/);
  for(const folder of ['skills/chathand-setup','plugins/chathand/skills/chathand-setup']){
    assert.match(read(folder+'/SKILL.md'),/Default to OpenAI tunnel/);
    const runbook=read(folder+'/references/runbook.md');
    assert.ok(runbook.includes('按 plan-check 请用户打开当前 ChatHand 的辅助功能、屏幕录制开关'),'system permission handoff remains explicit');
    assert.ok(runbook.includes('不从本机伪造调用'),'target-chat proof cannot be forged locally');
    assert.ok(read(folder+'/SKILL.md').includes('不重配健康连接'),folder+' must preserve setup scope');
    assert.ok(read(folder+'/SKILL.md').includes('不把本机自检冒充 ChatGPT 真实验收'),folder+' must preserve local-versus-real acceptance boundaries');
  }
  const wizard=read('ui/wizard.js');
  assert.ok(wizard.includes('const stageKeys=["ui.wizard.createTunnel","ui.wizard.addToChatGPT","ui.wizard.testConnection","ui.wizard.complete"]'));
  assert.ok(!wizard.includes(docsAllowReminder),'the manual wizard uses current localized screens rather than stale embedded reminder copy');
  assert.ok(!wizard.includes('永远允许'),'the manual wizard does not imply permanent tool permission');
  assert.ok(read('docs/INSTALL.md').includes('把「权限」设为「允许使用所有工具」'),'the current install guide explains the permission step');
});

test('the ChatGPT check fallback awaits copying before its hint, and only copies when opening failed',async()=>{
  const source=fs.readFileSync(path.join(root,'ui/app.js'),'utf8');
  const start=source.indexOf('async function openChatGPT(');
  const end=source.indexOf('\nasync function applyTier',start);
  const helper=source.slice(start,end);
  assert.ok(helper,'the shared ChatGPT open helper is present');
  const hint='这句话已经复制好了，在 ChatGPT 里粘贴发送';
  const execute=reply=>{
    const events=[],button={};let resolveCopy,rejectCopy;
    const copied=new Promise((resolve,reject)=>{resolveCopy=resolve;rejectCopy=reject;});
    const sandbox={PROMPT_COPY_HINT:hint,native:async(action,args)=>{events.push(['native',action,args.prompt,args.mode]);if(reply instanceof Error)throw reply;return reply;},copyText:async(text)=>{events.push(['copy',text]);await copied;},toast:text=>events.push(['toast',text])};
    vm.createContext(sandbox);installUiTextContext(sandbox);
    const pending=vm.runInContext(`${helper}\nopenChatGPT('${checkPrompt}',{work:true})`,sandbox);
    return {events,pending,resolveCopy,rejectCopy};
  };
  const ready=execute({opened:'web',prefill_requested:true,copied:false,prefilled:false});await ready.pending;
  assert.deepEqual(ready.events,[['native','openChatGPT',checkPrompt,'work'],['toast','已打开 ChatGPT，请确认输入框中的内容后发送']],'a successful prefill request reports dispatch honestly without copying');
  for(const reply of [{error:'NATIVE_APP_REQUIRED'},null,new Error('bridge down')]){
    const t=execute(reply);for(let i=0;i<3;i++)await Promise.resolve();
    assert.deepEqual(t.events,[['native','openChatGPT',checkPrompt,'work'],['copy',checkPrompt]],'the fallback copies the exact Work prompt and waits for the clipboard');
    t.resolveCopy();await t.pending;
    assert.deepEqual(t.events.at(-1),['toast',hint]);
    assert.equal(t.events.filter(x=>x[0]==='copy').length,1);
  }
  const failure=execute({error:'NATIVE_APP_REQUIRED'});failure.rejectCopy(Error('copy denied'));
  const failed=await failure.pending;assert.equal(failed.error_code,'CHATGPT_OPEN_FAILED');assert.equal(failed.copied,false);assert.equal(failed.prefilled,false);
  assert.deepEqual(failure.events,[['native','openChatGPT',checkPrompt,'work'],['copy',checkPrompt],['toast','无法打开 ChatGPT，提示词也未能复制，请稍后重试']],'a failed copy returns an honest failure and never claims the sentence was copied');
});

test('signed app build copies the offline guide to Resources/codex',()=>{
  const build=fs.readFileSync(path.join(root,'scripts/build-v09.mjs'),'utf8');
  assert.match(build,/copy\(path\.join\(root,'codex'\),path\.join\(contents,'Resources\/codex'\)\)/);
  assert.ok(fs.statSync(path.join(root,'codex/INSTALL.md')).isFile());
});

test('trial source snapshot includes the offline installation guide',()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-source-export-'));
  const destination=path.join(parent,'snapshot');
  try {
    execFileSync(process.execPath,[path.join(root,'scripts/export-trial-source.mjs'),destination],{cwd:root,stdio:'pipe'});
    assert.deepEqual(fs.readFileSync(path.join(destination,'codex/INSTALL.md')),fs.readFileSync(path.join(root,'codex/INSTALL.md')));
    assert.deepEqual(fs.readFileSync(path.join(destination,'docs/release-notes-1.0.0-beta.2-draft.md')),fs.readFileSync(path.join(root,'docs/release-notes-1.0.0-beta.2-draft.md')));
  } finally {
    fs.rmSync(parent,{recursive:true,force:true});
  }
});

test('offline guide checks the publisher identity and preserves existing setup',()=>{
  const guide=fs.readFileSync(path.join(root,'codex/INSTALL.md'),'utf8'),plan=fs.readFileSync(path.join(root,'skills/chathand-setup/plan-check.md'),'utf8');
  assert.match(guide,/只配置且已装/);assert.match(guide,/只有没有 App、也没有可用包才请用户提供/);
  for(const expected of ['codesign --verify --deep --strict','com.kenyu.chathand','13D3EF5EB9C743427123452CD966CBC8FD9ECF2D','ditto','mktemp -d','xattr -dr com.apple.quarantine'])assert.ok(guide.includes(expected),'offline guide retains safeguard: '+expected);
  assert.match(plan,/不使用 sudo/);assert.match(guide,/健康连接保留|已有健康连接/);assert.match(fs.readFileSync(path.join(root,'skills/chathand-setup/references/runbook.md'),'utf8'),/setup doctor/);
  assert.ok(guide.includes('$HOME/Library/Application Support/ChatHand/manual-install/previous.app'));assert.match(guide,/只保留最近这一份/);assert.match(guide,/目录逐级拒绝符号链接/);assert.match(guide,/旧备份存在时先核同一 bundle ID 和证书/);assert.match(guide,/只有确认是自己的旧 App 才移除以替换/);assert.match(guide,/未知内容不碰并报告冲突/);
  assert.match(guide,/把 `\/Applications\/ChatHand\.app` 移到这个固定位置/);assert.match(guide,/不复制或清理 `data\/`、凭据、连接或历史/);assert.match(guide,/确认目标 App 已不存在/);assert.match(guide,/失败副本移入用 mktemp -d 创建的临时隔离目录/);assert.match(guide,/旧备份移回原 App 路径并正常打开/);assert.match(guide,/整个过程不改用户资料/);
  assert.ok(!guide.includes('ditto "/Applications/ChatHand.app" "$BACKUP_DIR/ChatHand.app"'),'the old app is moved, never copied over the update path');
});

test('manual wizard add-connection step carries the two muted fallback hints',()=>{
  const wizard=fs.readFileSync(path.join(root,'ui/wizard.js'),'utf8');
  const addStep=wizard.slice(wizard.indexOf('case 2:{'),wizard.indexOf('case 3:return'));
  assert.ok(addStep.includes('copyTunnel')&&addStep.includes('ui.wizard.developerModeWebOnly'),'the add-connection step exposes the current copy control and developer-mode explanation');
  assert.ok(addStep.includes('ui.wizard.noCreateOption'),'developer-mode guidance remains available in the closed help disclosure');
  const zh=JSON.parse(fs.readFileSync(path.join(root,'locales/zh.json'),'utf8')),en=JSON.parse(fs.readFileSync(path.join(root,'locales/en.json'),'utf8'));
  for(const key of ['ui.wizard.developerModeWebOnly','ui.wizard.noCreateOption'])assert.ok(zh[key]&&en[key],`${key} has zh/en copy`);
});

test('setup skill and runbook preserve OpenAI-default routing and the local versus target-ChatGPT verification boundary',()=>{
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  const skill=read('skills/chathand-setup/SKILL.md'),runbook=read('skills/chathand-setup/references/runbook.md');
  assert.match(skill,/Default to OpenAI tunnel/);assert.match(skill,/不重配健康连接/);assert.match(skill,/本机自检冒充 ChatGPT 真实验收/);
  for(const line of ['ChatGPT Site','doctor','connected=true','connection_check','setup_write_probe','instance_id','read_write'])assert.ok(runbook.includes(line),`runbook must carry current proof boundary: ${line}`);
  assert.ok(runbook.indexOf('首次未选路线默认 OpenAI 通道')<runbook.indexOf('## 2. ChatGPT Site'),'the OpenAI default is stated before the explicit Site route');
  assert.ok(runbook.indexOf('setup doctor')<runbook.indexOf('setup test-start'),'local diagnostic precedes target-chat verification');
});

test('setup skill and runbook preserve the OpenAI-default direction, require explicit A authorization, and keep each pair identical',()=>{
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  const pairs=[['skills/chathand-setup/SKILL.md','plugins/chathand/skills/chathand-setup/SKILL.md'],['skills/chathand-setup/references/runbook.md','plugins/chathand/skills/chathand-setup/references/runbook.md']];
  for(const [source,plugin] of pairs){
    assert.equal(read(source),read(plugin),`${plugin} is byte-identical to ${source}`);
    const text=read(source);
    if(source.endsWith('SKILL.md')){assert.match(text,/Default to OpenAI tunnel/);assert.match(text,/不读运行信息/);}
    else {for(const line of ['ChatGPT Site','connected=true','connection_check','setup_write_probe','instance_id','read_write'])assert.ok(text.includes(line),`${source} keeps current verification boundary: ${line}`);assert.ok(text.includes('默认/已选 OpenAI 执行本节'),'runbook states the default OpenAI route');}
  }
  for(const file of pairs.map(([,plugin])=>plugin).filter(file=>file.endsWith('references/runbook.md')))
    assert.ok(read(file).includes('key-from-clipboard')&&read(file).includes('不进对话、日志和回复'),`${file} keeps credential handoff private`);
});

test('offline guide installs the setup skill before the first open and tells Codex to finish the setup in the same conversation',()=>{
  const guide=fs.readFileSync(path.join(root,'codex/INSTALL.md'),'utf8'),skill=fs.readFileSync(path.join(root,'skills/chathand-setup/SKILL.md'),'utf8'),runbook=fs.readFileSync(path.join(root,'skills/chathand-setup/references/runbook.md'),'utf8');
  const install='"$PWD/bin/node" --input-type=module -e \'import("./app/v09/local-setup.mjs").then(({installSkill}) => console.log(JSON.stringify(installSkill())))\'';
  assert.equal(guide.split(install).length-1,1,'one authoritative first-install command, with no later duplicate');
  const blocks=[...guide.matchAll(/```sh\n([\s\S]*?)\n```/g)].map(match=>match[1]),first=blocks.filter(block=>block.includes(install));assert.equal(first.length,1);const block=first[0].split('\n');
  const line=text=>{const found=block.flatMap((value,index)=>value.includes(text)?[index]:[]);assert.equal(found.length,1,'the first-open block has one '+text);return found[0];};
  const order=[line('ditto '),line('codesign --verify --deep --strict'),line('xattr -dr com.apple.quarantine'),line('QUARANTINE_STILL_PRESENT'),line('cd "/Applications/ChatHand.app/Contents/Resources/runtime"'),line(install),line('open -g "/Applications/ChatHand.app"')];assert.deepEqual(order,[...order].sort((a,b)=>a-b),'copy, identity, cleared-and-verified quarantine, bundled runtime, skill, then open');assert.equal(order.at(-1),block.length-1,'opening the app is the final first-open command');
  assert.match(guide,/已有健康连接的更新可跳过.*安装配置助手/);assert.match(guide,/复制、签名或清标记失败时，不运行新 App/);assert.match(guide,/读取 `Contents\/Resources\/runtime\/skills\/chathand-setup\/SKILL\.md`/);
  assert.match(skill,/\]\(plan-check\.md\)/);assert.match(skill,/\]\(references\/runbook\.md\)/);assert.match(runbook,/保持当前配置对话的续接点/);assert.match(runbook,/别用新任务抹掉旧失败/);
});

test('offline guide tells Codex how to talk to the user, just before the final report',()=>{
  const guide=fs.readFileSync(path.join(root,'codex/INSTALL.md'),'utf8'),skill=fs.readFileSync(path.join(root,'skills/chathand-setup/SKILL.md'),'utf8'),plan=fs.readFileSync(path.join(root,'skills/chathand-setup/plan-check.md'),'utf8');
  assert.match(guide,/plan-check 统一规定/);assert.match(guide,/分别报告；未验证不能算通过/);assert.match(skill,/\]\(plan-check\.md\)/);
  const ai=plan.split('\n').find(line=>line.startsWith('AI ')&&line.includes('允许使用所有工具'));assert.ok(ai);for(const step of ['安装','配置','平台 Copy','助手交接','创建或复用','连接','开发者模式','允许使用所有工具','新对话测试'])assert.ok(ai.includes(step),'AI role covers '+step);
  for(const step of ['电脑密码','Touch ID','登录密码','验证码','Chrome','添加扩展程序','辅助功能','屏幕录制'])assert.ok(plan.includes(step),'human-only scope includes '+step);
  assert.match(plan,/用户完成后接着做/);assert.match(plan,/不能代输密码/);assert.match(plan,/绕过平台实际拒绝/);assert.match(plan,/用户看得见的浏览器/);assert.match(plan,/正确页面切到最前/);assert.match(plan,/一句话说清哪个窗口、点哪里/);assert.match(plan,/不要把隐藏浏览器里的页面交给用户找/);assert.match(plan,/完成后核实际结果再继续/);assert.match(plan,/不再逐项问要不要继续/);assert.match(plan,/报错先说正在做什么、卡在哪、影响什么、下一步怎么继续/);assert.match(plan,/原因未知就明确说未知/);
});

test('manual tutorial tool permissions remain a fifth sub-step with a real PNG and valid crop metadata',()=>{
  const tutorial=JSON.parse(fs.readFileSync(path.join(root,'ui/assets/tutorial/tutorial.json'),'utf8'));
  const subs=tutorial.steps['s-add'].subs;
  assert.equal(subs.length,5);
  const instruction=subs.at(-1);
  assert.equal(instruction.textKey,'ui.wizard.tutorial.add.allowTools');
  const zh=JSON.parse(fs.readFileSync(path.join(root,'locales/zh.json'),'utf8')),en=JSON.parse(fs.readFileSync(path.join(root,'locales/en.json'),'utf8'));
  assert.match(zh[instruction.textKey],/允许使用所有工具/);assert.match(en[instruction.textKey],/Allow all tools/i);
  assert.equal(instruction.shot,'s5e-tool-permissions');
  const png=fs.readFileSync(path.join(root,'ui/assets/tutorial',instruction.shot+'.png'));
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  assert.ok(width>=400&&height>=200&&width<=8192&&height<=8192,'real tutorial PNG has reasonable pixel dimensions');
  const bounds=[width/2,height/2];
  const inside=rect=>assert.ok(Array.isArray(rect)&&rect.length===4&&rect.every(Number.isFinite)&&rect[0]>=0&&rect[1]>=0&&rect[2]>0&&rect[3]>0&&rect[0]+rect[2]<=bounds[0]&&rect[1]+rect[3]<=bounds[1],'crop/ring fits screenshot CSS coordinates');
  if(instruction.focus!==null)inside(instruction.focus);
  for(const ring of instruction.rings)inside(ring);
  const wizard=fs.readFileSync(path.join(root,'ui/wizard.js'),'utf8');
  assert.ok(wizard.includes('["ui.wizard.createTunnel","ui.wizard.addToChatGPT","ui.wizard.testConnection","ui.wizard.complete"]'));
  for(const key of ['ui.wizard.createTunnel','ui.wizard.addToChatGPT','ui.wizard.testConnection','ui.wizard.complete','ui.wizard.writeProbeBlocked'])assert.ok(zh[key]&&en[key],`${key} has current zh/en UI copy`);
  assert.match(zh['ui.wizard.writeProbeBlocked'],/写入被 ChatGPT 拦了/);assert.match(en['ui.wizard.writeProbeBlocked'],/blocked write/i);
});
