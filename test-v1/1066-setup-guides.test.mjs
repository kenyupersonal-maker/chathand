import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const names=['codex/INSTALL.md','skills/chathand-setup/SKILL.md','skills/chathand-setup/plan-check.md','skills/chathand-setup/references/runbook.md','skills/chathand-setup/references/troubleshooting.md'];
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
test('main setup guides stay compact with the selected-package installer and recovery entry',()=>{
 const texts=names.map(read),lines=texts.reduce((n,t)=>n+t.trimEnd().split('\n').length,0),chars=texts.reduce((n,t)=>n+[...t].length,0),bytes=texts.reduce((n,t)=>n+Buffer.byteLength(t),0);
 // The approved one-command install/recovery instructions extend the old
 // frozen rewrite budget. Keep a small explicit budget for the entry guides;
 // detailed installer usage lives in its separately linked reference.
 assert.ok(lines<=150);assert.ok(chars<=14000);assert.ok(bytes<=28000);
 const retired=['Ken Bridge','KenBridge','7890','OAuth relay','/api/relay/credentials','本机技能随包续传补充','旧远端模板','docs/ACCEPTANCE','付费快捷配置','Windows','~/Artifacts','从 1066 起','构建 1011'];
 for(const text of texts)for(const term of retired)assert.ok(!text.includes(term),'retired setup content absent: '+term);
 for(const name of names.slice(1))assert.equal(read(name),read(name.replace('skills/','plugins/chathand/skills/')),'generated mirror: '+name);
 for(const file of ['references/install-and-start.md','scripts/install-and-start.sh','scripts/install-and-start.mjs'])
  assert.equal(read('skills/chathand-setup/'+file),read('plugins/chathand/skills/chathand-setup/'+file),'installer mirror: '+file);
});
test('installation, actor rules and setup each have one authoritative location',()=>{
 const install=read(names[0]),skill=read(names[1]),actors=read(names[2]),flow=read(names[3]);
 assert.ok(skill.includes('codex/INSTALL.md'));assert.ok(skill.includes('plan-check.md'));assert.ok(flow.includes('plan-check'));
 assert.ok(install.includes('manual-install/previous.app'));assert.ok(install.includes('只保留最近这一份'));assert.ok(install.includes('未知内容不碰'));
 for(const phrase of ['Touch ID','登录密码','验证码','添加扩展程序','隐私开关','看得见的浏览器','切到最前','允许使用所有工具'])assert.ok(actors.includes(phrase),phrase);
 for(const phrase of ['saved=true','received=true','clipboard_cleared','CONNECTION_PENDING','key-from-clipboard','密钥只在那个框里显示一次'])assert.ok((flow+install+read(names[4])).includes(phrase),phrase);
 assert.ok(flow.indexOf('核 ChatHand 的收到')<flow.indexOf('再关闭交接页面'));
 assert.ok(flow.includes('旧插件只认两种'));assert.ok(flow.includes('`doctor` 的 `chatgpt_app_identity` 记着的那一个'));assert.ok(flow.includes('连接目标正好是这台现在的 Site 地址或通道的那一个'));assert.ok(flow.includes('名字像不算'));assert.ok(flow.includes('找到了先刷新工具'));assert.ok(flow.includes('`instance_id` 跟 `doctor` 的 `instance_id` 一样才沿用'));assert.ok(flow.includes('刷新后再调一次还不通'));assert.ok(flow.includes('不挨个去试列表里别的旧插件'));assert.ok(flow.includes('不从本机伪造调用'));
});
