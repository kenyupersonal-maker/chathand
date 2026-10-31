import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const plan=read('skills/chathand-setup/plan-check.md');
const runbook=read('skills/chathand-setup/references/runbook.md');
const troubleshooting=read('skills/chathand-setup/references/troubleshooting.md');

test('1068 95 only reuses a plugin by stable identity or exact target plus matching instance_id',()=>{
 const section=runbook.split('## 5. 认出 ChatGPT 中这台 Mac 的插件\n')[1].split('\n## 6.')[0].split('\n')[0];
 assert.match(section,/旧插件只认两种/);
 assert.match(section,/`doctor` 的 `chatgpt_app_identity`/);
 assert.match(section,/连接目标正好是这台现在的 Site 地址或通道/);
 assert.match(section,/名字像不算/);
 assert.match(section,/刷新工具/);
 assert.match(section,/`connection_check`/);
 assert.match(section,/`instance_id`/);
 assert.match(section,/对不上，就直接新建/);
 assert.match(section,/不挨个去试列表里别的旧插件/);
});

test('1068 96 leaves Create secret key to the user, AI copies and retries at most three times before closing',()=>{
 const section=runbook.split('## 3. OpenAI 通道\n')[1].split('\n## 4.')[0];
 const userCreate=section.indexOf('用户只点一下「Create secret key」');
 const aiCopy=section.indexOf('AI 自己点框里密钥旁边的 Copy');
 const retry=section.indexOf('最多三次，这期间框一直开着');
 const saveConfirmed=section.indexOf('`saved=true`、`received=true`、`storage_verified=true` 才能关平台密钥弹窗');
 assert.ok(userCreate>=0&&aiCopy>userCreate&&retry>aiCopy&&saveConfirmed>retry,'user creates first, AI copies and retries, and closure waits for verified storage');
 assert.match(section,/这把密钥只用来连接通道，不会产生模型调用费用。/);
 assert.match(plan,/走 OpenAI 通道时，平台上建运行密钥的「Create secret key」这一下（只点创建，复制和交给 ChatHand 由 AI 做）/);
 assert.match(troubleshooting,/跟用户说一句「没读到，我再复制一次」，AI 再点 Copy、再交接，最多三次/);
});

test('1068 97 prefers the user browser for pages that require sign-in',()=>{
 assert.ok(plan.includes('要登录才能用的网页（ChatGPT 设置、Sites、OpenAI 平台），先在用户自己的浏览器里做，那边本来就登录着；控制不了用户的浏览器才用内置浏览器，先跟用户说一句「要在这里再登录一次」。使用用户已登录的账号；未登录只请用户登录。'));
 assert.match(runbook,/AI 在用户自己的浏览器里打开 OpenAI 官方 Secure MCP Tunnel 入口/);
 assert.match(runbook,/AI 在用户自己的浏览器里打开 ChatGPT 的插件设置/);
});

test('1068 98 refreshes from the plugin detail page and retries the Site first-call error once in a new conversation',()=>{
 const section=runbook.split('## 6. 真实测试与交回\n')[1];
 const permission=section.indexOf('权限是「允许使用所有工具」');
 const firstRefresh=section.indexOf('点过「刷新工具」');
 const firstConversation=section.indexOf('从这个插件自己的详情页新开普通对话');
 const firstCallError=section.indexOf('第一次报「Tunnel-client has not been seen for 300 seconds」或 `NOT_FOUND` 不算失败');
 const retryRefresh=section.indexOf('再点一次「刷新工具」',firstCallError);
 const retryConversation=section.indexOf('从详情页新开普通对话再试一次',retryRefresh);
 const stopAfterRetry=section.indexOf('第二次还这样才按故障索引查',retryConversation);
 assert.ok(permission>=0&&firstRefresh>permission&&firstConversation>firstRefresh,'permission and tools refresh precede an ordinary chat opened from this plugin detail page');
 assert.ok(firstCallError>firstConversation&&retryRefresh>firstCallError&&retryConversation>retryRefresh&&stopAfterRetry>retryConversation,'Site first-call error gets one refresh and one new ordinary-chat retry before troubleshooting');
 assert.match(troubleshooting,/走 Site 第一次测试报 `Tunnel-client has not been seen for 300 seconds` 或 `NOT_FOUND`/);
 assert.match(troubleshooting,/从详情页新开普通对话再试一次；第二次还报才查连接/);
 assert.match(section,/OpenAI 通道只有当前挑战 `read_write`、未过期且已 verified/);
 assert.match(section,/Site.*测试回执按 `site_id` 关联且不过期/);
 assert.match(section,/Site 的长期测试回执不代表私有凭据授权/);
});

test('1068 99 opens ChatHand in the background during installation',()=>{
 const guide=read('codex/INSTALL.md');
 assert.match(guide,/open -g "\/Applications\/ChatHand\.app"/);
 assert.doesNotMatch(guide,/^open "\/Applications\/ChatHand\.app"$/m);
});

test('1068 source setup docs remain byte-for-byte mirrored to the generated plugin copy',()=>{
 for(const file of ['plan-check.md','references/runbook.md','references/troubleshooting.md'])
  assert.equal(read('skills/chathand-setup/'+file),read('plugins/chathand/skills/chathand-setup/'+file),file+' mirror');
});
