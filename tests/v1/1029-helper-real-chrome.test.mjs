// 1029（H1）：Chrome 助手的真代码在真 Chrome 里跑一遍（不装扩展：chrome.* 用 CDP 包出来，见 tests/support/real-chrome.mjs）。
// 10/7 查到 1012 加的这一层只在假 CDP 上测过，真 Chrome 里点击一律 PAGE_HELPER_FAILED。改 browser-extension/ 必须跑这个。
// Chrome 位置：CHATHAND_TEST_CHROME → /Applications/Google Chrome.app → /opt/pw-browsers 里的 chromium；都没有就跳过。
// 只开本机测试页，不连外网，不碰用户自己的 Chrome 和登录状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import {findChrome, launchChrome, FakeChrome, startServer} from '../support/real-chrome.mjs';
import {BrowserDriver} from '../../browser-extension/driver.js';

const CHROME = findChrome();
const skip = CHROME ? false : '找不到 Chrome（可用 CHATHAND_TEST_CHROME 指定），真浏览器测试跳过';

const html = (title, body, lang = 'zh-CN') => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:16px}.row{margin:6px 0}</style></head><body>${body}</body></html>`;
export const PAGES = {
  // 标签用 for 指过去：输入框包在 label 里时，Chrome 算名字会把框里的值也算进去（「姓名 旧名字」）。
  '/form': html('表单', `<h1>表单</h1>
<div class="row"><label for="name">姓名</label> <input id="name" value="旧名字"></div>
<div class="row"><label for="note">备注</label> <textarea id="note">旧备注</textarea></div>
<div class="row"><div id="rich" contenteditable="true" role="textbox" aria-label="富文本">旧内容</div></div>
<div class="row"><label for="city">城市</label> <select id="city"><option value="bj">北京</option><option value="sh">上海</option></select></div>
<div class="row"><label for="kw">关键词</label> <input id="kw" type="search"></div>
<div class="row"><label for="pw">密码</label> <input id="pw" type="password"></div>
<div class="row"><label for="otp">验证码</label> <input id="otp" autocomplete="one-time-code" inputmode="numeric"></div>
<div class="row"><button id="plain" type="button">普通按钮</button> <button id="dbl" type="button">双击我</button> <button type="button" disabled>不能点</button></div>
<div class="row"><span style="position:relative;display:inline-block"><button id="covered" type="button" onclick="say('挡住的也点到了')">被挡住的按钮</button><span style="position:absolute;inset:0;background:#fff"></span></span></div>
<form id="f" onsubmit="event.preventDefault();window.submitCount=(window.submitCount||0)+1;say('提交了：'+this.q.value)"><label>问题 <input name="q" value="你好"></label> <button type="submit">提交</button></form>
<p id="out">还没动</p>
<script>let n=0;function say(t){document.getElementById('out').textContent=t;}
document.getElementById('plain').onclick=()=>say('点了 '+(++n)+' 次');
document.getElementById('dbl').ondblclick=()=>say('双击了');
document.getElementById('kw').addEventListener('keydown',e=>{if(['Enter','Escape'].includes(e.key))say('按了 '+e.key);});
document.getElementById('city').onchange=e=>say('选了 '+e.target.value);</script>`),
  '/spa': html('单页', `<h1 id="h">第一页</h1><button type="button" id="go">去第二页</button><div id="more"></div>
<script>document.getElementById('go').onclick=()=>{history.pushState({},'','/spa/two');document.title='第二页';document.getElementById('h').textContent='第二页';
const b=document.createElement('button');b.type='button';b.textContent='第二页的按钮';document.getElementById('more').append(b);};</script>`),
  // 点「开始」以后才陆续变：按钮 0.5 秒后出来，字 0.6 秒，「加载中」0.7 秒后消失，地址 0.8 秒后变，还有一个 0.7 秒的慢请求。
  '/late': html('稍后', `<h1>稍后</h1><button type="button" id="start">开始</button><p id="loading">加载中</p><div id="slot"></div>
<script>document.getElementById('start').onclick=()=>{
setTimeout(()=>{const b=document.createElement('button');b.type='button';b.textContent='后来出现的按钮';document.getElementById('slot').append(b);},500);
setTimeout(()=>document.getElementById('slot').append(Object.assign(document.createElement('p'),{textContent:'内容出来了'})),600);
setTimeout(()=>document.getElementById('loading').remove(),700);
setTimeout(()=>history.pushState({},'','/late/next'),800);
setTimeout(()=>fetch('/api/slow?ms=700').then(r=>r.text()).then(t=>document.getElementById('slot').append(t)),50);};</script>`),
  '/slow': async () => {await new Promise(resolve => setTimeout(resolve, 1500));return html('慢页面', '<h1>慢页面</h1><p>慢慢出现</p>');},
  '/api/slow': async (req, res, url) => {await new Promise(resolve => setTimeout(resolve, Number(url.searchParams.get('ms')) || 500));res.setHeader('content-type', 'text/plain; charset=utf-8');return '慢接口回来了';},
  '/long': html('长文', `<main><h1>长文</h1>
<section aria-label="摘要"><h2>摘要</h2><p>这是摘要第一段，里面有<a href="/form">一个链接</a>。</p><ul><li>甲</li><li>乙</li></ul><button type="button">摘要里的按钮</button></section>
<table><tr><th>名字</th><th>数量</th></tr><tr><td>苹果</td><td>3</td></tr></table>
<pre>代码 1
代码 2</pre>
${Array.from({length: 60}, (_, i) => `<p>第 ${i + 1} 段：这一段是用来测分页读的正文。</p>`).join('\n')}
<div id="many">${Array.from({length: 130}, (_, i) => `<button type="button">项目 ${i + 1}</button>`).join('')}</div>
<div style="height:3000px"></div><button type="button" id="bottom" onclick="document.title='点到底了'">最底下的按钮</button></main>`),
  '/frames': (req, res, url, base) => html('框架', `<h1>框架页</h1>
<iframe id="same" title="同源框" src="/inner?who=${encodeURIComponent('同源')}" style="width:420px;height:120px"></iframe>
<iframe id="cross" title="跨源框" src="${base.replace('127.0.0.1', 'localhost')}/inner?who=${encodeURIComponent('跨源')}" style="width:420px;height:120px"></iframe>`),
  '/inner': (req, res, url) => {const who = url.searchParams.get('who') === '跨源' ? '跨源' : '同源';return html('框里', `<button type="button" id="b">${who}框里的按钮</button><script>document.getElementById('b').onclick=()=>fetch('/hit?who='+encodeURIComponent('${who}'));</script>`);},
  '/hit': 'ok',
  '/favicon.ico': ''
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('1029 真 Chrome：助手的真代码在真浏览器里能用', {skip, timeout: 240000}, async t => {
  const chrome = await launchChrome(CHROME);t.after(() => chrome.close());
  const server = await startServer(PAGES);t.after(() => server.close());
  let seq = 0;
  /** 每个小测试一个新的 driver（和扩展里一样，开了 experience），用完把标签页关掉。 */
  async function open(path, options = {}) {
    const api = new FakeChrome(chrome.cdp);
    const driver = api.wire(new BrowserDriver(api, {experience: true, actionabilityTimeoutMs: 800, idleMs: 120000, ...options}));
    const call = async (action, args = {}, extra) => {try {return await driver.execute(action, args, extra);} catch (error) {return {thrown: error.code || error.message};}};
    const opened = await call('new', {url: server.base + path});
    assert.ok(opened.page_id, '开得了标签页：' + JSON.stringify(opened));
    const page_id = opened.page_id, tabId = Number(page_id);
    const ready = async text => {const r = await call('wait_for', {page_id, condition: {kind: 'text', text, timeout_ms: 8000}});assert.equal(r.status, 'completed', '等到「' + text + '」：' + JSON.stringify(r.error || r.thrown));return r;};
    const find = async args => {const r = await call('find', {page_id, ...args});assert.ok(Array.isArray(r.elements), 'find：' + JSON.stringify(r).slice(0, 300));return r;};
    const one = async (role, text) => {const r = await find({role, text, exact: true});assert.equal(r.elements.length, 1, `只有一个 ${role}「${text}」：` + JSON.stringify(r.elements.map(e => e.name)));return r.elements[0];};
    const act = (action, args = {}) => call(action, {page_id, operation_key: 'test:' + (++seq), ...args});
    const evaluate = expression => api.evaluate(tabId, expression);
    t.after(() => api.dispose());
    return {api, driver, call, page_id, tabId, ready, find, one, act, evaluate};
  }

  await t.test('标签页：开、列出、切换、导航、关掉', async () => {
    const p = await open('/form');await p.ready('还没动');
    const listed = await p.call('tabs');assert.ok(listed.tabs.some(tab => tab.page_id === p.page_id && tab.managed === true && tab.url.endsWith('/form')));
    const selected = await p.act('select');assert.equal(selected.selected, true, JSON.stringify(selected));assert.equal(selected.shown, false);const shown=await p.act('select', {show:true});assert.equal(shown.shown,true);assert.equal((await p.api.tabs.get(p.tabId)).active,true);
    const navigated = await p.act('navigate', {url: server.base + '/spa'});assert.equal(navigated.navigated, true, JSON.stringify(navigated));
    await p.ready('第一页');assert.equal((await p.api.tabs.get(p.tabId)).url, server.base + '/spa');
    const closed = await p.act('close');assert.equal(closed.closed, true);
    assert.ok((await p.call('snapshot', {page_id: p.page_id})).thrown, '关掉以后不能再读');
  });

  await t.test('wait_for 五种条件，页面还在加载时也能等', async () => {
    // 页面还没提交（服务器 1.5 秒才回）就开始等：不能直接报错，要一直等到字出来。
    const slow = await open('/slow');
    const waited = await slow.act('wait_for', {condition: {kind: 'text', text: '慢慢出现', timeout_ms: 10000}});
    assert.equal(waited.status, 'completed', JSON.stringify(waited.error || waited.thrown));assert.equal(waited.matched, true);assert.ok(waited.waited_ms >= 800, '真等了：' + waited.waited_ms);
    const p = await open('/late');await p.ready('稍后');
    const url = (await p.api.tabs.get(p.tabId)).url;
    const started = await p.act('click', {ref: (await p.one('button', '开始')).ref});assert.equal(started.status, 'completed', JSON.stringify(started.error));
    assert.equal(await p.evaluate("document.getElementById('loading')!==null"), true, '点完马上回来，后面的变化还没发生，下面是真在等');
    for (const condition of [{kind: 'element', role: 'button', name: '后来出现的按钮'}, {kind: 'text', text: '内容出来了'}, {kind: 'text_absent', text: '加载中'}, {kind: 'url_change', url}, {kind: 'network_idle'}]) {
      const r = await p.act('wait_for', {condition: {...condition, timeout_ms: 8000}});
      assert.equal(r.status, 'completed', condition.kind + '：' + JSON.stringify(r.error || r.thrown));assert.equal(r.matched, true);assert.equal(r.condition, condition.kind);
    }
    const missed = await p.act('wait_for', {condition: {kind: 'text', text: '永远不会出现', timeout_ms: 600}});
    assert.equal(missed.status, 'failed');assert.equal(missed.error.code, 'WAIT_TIMEOUT');
  });

  await t.test('find：角色、文字、exact、scope_ref、分页；snapshot 带 aria；read 整页、局部、分段', async () => {
    const p = await open('/long');await p.ready('长文');
    const all = await p.find({role: 'button', limit: 50});assert.ok(all.total_elements >= 132, '按钮都找得到：' + all.total_elements);assert.equal(all.elements.length, 50);assert.equal(all.next_offset, 50);
    const page2 = await p.find({role: 'button', limit: 50, offset: 50});assert.equal(page2.elements.length, 50);assert.ok(!all.elements.some(e => e.ref === page2.elements[0].ref), '第二页接着第一页');
    const loose = await p.find({text: '项目 1'});assert.ok(loose.total_elements > 10, '不加 exact 是包含');
    const exact = await p.find({text: '项目 1', exact: true});assert.deepEqual(exact.elements.map(e => e.name), ['项目 1']);
    const section = await p.one('region', '摘要');
    const scoped = await p.find({role: 'button', scope_ref: section.ref});assert.deepEqual(scoped.elements.map(e => e.name), ['摘要里的按钮']);
    const snap = await p.call('snapshot', {page_id: p.page_id, limit: 20});
    assert.equal(snap.aria_available, true, 'Playwright 的 aria 快照在真 Chrome 里装得上');assert.match(snap.aria_yaml, /heading "长文"/);assert.match(snap.locator_engine, /^playwright-injected-/);
    assert.equal(snap.elements.length, 20);assert.ok(snap.total_elements > 130);assert.equal(snap.next_offset, 20);
    const read = await p.call('read', {page_id: p.page_id, limit: 20});
    assert.match(read.markdown, /^# 长文/);assert.match(read.markdown, /\[一个链接\]\(http:\/\/127\.0\.0\.1:\d+\/form\)/);assert.match(read.markdown, /\| 名字 \| 数量 \|/);assert.match(read.markdown, /```\n代码 1\n代码 2\n```/);
    assert.equal(read.segments_returned, 20);assert.equal(read.next_offset, 20);assert.ok(read.total_segments > 60);
    const next = await p.call('read', {page_id: p.page_id, offset: read.next_offset, limit: 5});assert.equal(next.segment_offset, 20);assert.equal(next.segments_returned, 5);
    const part = await p.call('read', {page_id: p.page_id, scope_ref: section.ref});assert.equal(part.markdown.includes('第 1 段'), false, '局部读只读这一块：' + part.markdown);assert.match(part.markdown, /这是摘要第一段/);
  });

  await t.test('点击：普通按钮、单页跳转、被挡住、不能点、授权后直接提交、双击', async () => {
    const p = await open('/form');await p.ready('还没动');
    const plain = await p.one('button', '普通按钮');
    let r = await p.act('click', {ref: plain.ref});
    assert.equal(r.status, 'completed', JSON.stringify(r.error || r.thrown));assert.equal(await p.evaluate("document.getElementById('out').textContent"), '点了 1 次');
    // 回执：想点的是谁（角色、名字、编号），它在哪（位置框），实际点在哪（坐标，在框里），和页面上量到的一样。
    assert.deepEqual({role: r.click.target.role, name: r.click.target.name, ref: r.click.target.ref}, {role: 'button', name: '普通按钮', ref: plain.ref});
    const {point, box} = r.click, rect = await p.evaluate("(()=>{const r=document.getElementById('plain').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");
    assert.ok(point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height, '点在框里：' + JSON.stringify(r.click));
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - rect[key]) < 1, `位置框和页面上量的一样（${key}）：` + JSON.stringify({box, rect}));
    r = await p.act('double_click', {ref: (await p.one('button', '双击我')).ref});assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await p.evaluate("document.getElementById('out').textContent"), '双击了');
    r = await p.act('click', {ref: (await p.one('button', '被挡住的按钮')).ref});assert.equal(r.status, 'failed');assert.equal(r.error.code, 'ELEMENT_OBSCURED');
    assert.equal(await p.evaluate("document.getElementById('out').textContent"), '双击了', '挡住的不点');
    r = await p.act('click', {ref: (await p.one('button', '不能点')).ref});assert.equal(r.status, 'failed');assert.equal(r.error.code, 'ELEMENT_DISABLED');
    const submit = await p.one('button', '提交');
    const submitArgs={ref:submit.ref,operation_key:'fixture-submit-once'};
    r = await p.act('click', submitArgs);assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await p.evaluate("document.getElementById('out').textContent"), '提交了：你好');
    assert.equal(await p.evaluate('window.submitCount'),1,'authorized submit needs no extra confirmation');
    const spa = await open('/spa');await spa.ready('第一页');
    r = await spa.act('click', {ref: (await spa.one('button', '去第二页')).ref});
    assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(r.changes.url_changed, true);assert.equal((await spa.api.tabs.get(spa.tabId)).url, server.base + '/spa/two');
    // 点完页面变了什么：从哪到哪、新出来的元素写名字。
    assert.equal(r.changes.from_url, server.base + '/spa');assert.equal(r.changes.url, server.base + '/spa/two');assert.ok(r.changes.added.some(e => e.role === 'button' && e.name === '第二页的按钮'), JSON.stringify(r.changes));
    await spa.one('button', '第二页的按钮');
    const boxed = await spa.find({role: 'button', text: '第二页的按钮', exact: true, boxes: true});assert.ok(boxed.elements[0].box?.width > 0, 'find 也能带位置框');assert.equal(boxed.lang, 'zh-CN');
  });

  await t.test('填写：input、textarea、contenteditable、中文；press；select_value；网页密码和验证码按授权填写', async () => {
    const p = await open('/form');await p.ready('还没动');
    const value = id => p.evaluate(`document.getElementById(${JSON.stringify(id)}).${id === 'rich' ? 'textContent' : 'value'}`);
    let r = await p.act('fill', {ref: (await p.one('textbox', '姓名')).ref, text: '林小桥'});assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await value('name'), '林小桥', '原来的字要换掉，不是接在后面');
    r = await p.act('fill', {ref: (await p.one('textbox', '备注')).ref, text: '第一行\n第二行'});assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await value('note'), '第一行\n第二行');
    r = await p.act('fill', {ref: (await p.one('textbox', '富文本')).ref, text: '富文本里的中文'});assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await value('rich'), '富文本里的中文');
    const kw = await p.one('searchbox', '关键词');
    for (const key of ['Enter', 'Escape']) {r = await p.act('press', {ref: kw.ref, key});assert.equal(r.status, 'completed', key + JSON.stringify(r.error));assert.equal(await p.evaluate("document.getElementById('out').textContent"), '按了 ' + key);}
    r = await p.act('press', {ref: kw.ref, key: 'Tab'});assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await p.evaluate('document.activeElement.id'), 'pw', 'Tab 把焦点挪到下一个');
    r = await p.act('select_value', {ref: (await p.one('combobox', '城市')).ref, text: '上海'});assert.equal(r.status, 'completed', JSON.stringify(r.error));assert.equal(await value('city'), 'sh');assert.equal(await p.evaluate("document.getElementById('out').textContent"), '选了 sh');
    for(const [id,label,text] of [['pw','密码','synthetic-password-only'],['otp','验证码','123456']]){
      r = await p.act('fill', {ref:(await p.one('textbox',label)).ref,text});
      assert.equal(r.status,'completed',JSON.stringify(r.error));assert.equal(await value(id),text,'only isolated fixture input is filled');
    }
  });

  await t.test('滚动：scroll、scroll_to；截图带编号，编号用完就撤', async () => {
    const p = await open('/long');await p.ready('长文');
    let r = await p.act('scroll', {amount: 800});assert.equal(r.status, 'completed', JSON.stringify(r.error));
    await sleep(200);assert.ok(await p.evaluate('scrollY') > 100, '页面往下滚了');
    r = await p.act('scroll_to', {ref: (await p.one('button', '最底下的按钮')).ref});assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.equal(await p.evaluate("(()=>{const r=document.getElementById('bottom').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})()"), true, '滚到看得见');
    const form = await open('/form');await form.ready('还没动');
    const shot = await form.call('screenshot', {page_id: form.page_id, numbered: true});
    assert.ok(shot.image_base64?.length > 1000, '有图：' + JSON.stringify(shot).slice(0, 200));assert.equal(shot.numbered, true);assert.ok(shot.elements.length >= 8);assert.equal(shot.elements[0].number, 1);
    assert.equal(await form.evaluate('document.querySelector("[data-chathand-overlay]")'), null, '截完把编号撤掉');
  });

  await t.test('batch：多步一次做，中间一步不对就停', async () => {
    const p = await open('/form');await p.ready('还没动');
    const name = await p.one('textbox', '姓名'), plain = await p.one('button', '普通按钮');
    const r = await p.act('batch', {steps: [
      {step_id: 'name', action: 'fill', ref: name.ref, text: '批量'},
      {step_id: 'click', action: 'click', ref: plain.ref},
      {step_id: 'wait', action: 'wait_for', condition: {kind: 'text', text: '点了 1 次', timeout_ms: 3000}},
      {step_id: 'missing', action: 'click', ref: 'r0000missing'},
      {step_id: 'never', action: 'click', ref: plain.ref}
    ]});
    assert.equal(r.status, 'failed');assert.equal(r.failed_step_id, 'missing');assert.equal(r.completed_steps, 3);assert.deepEqual(r.steps.map(s => s.status), ['completed', 'completed', 'completed', 'failed_or_unknown']);
    assert.equal(r.steps[1].click.target.name, '普通按钮', 'batch 里每次点击也带回执');assert.ok(r.steps[1].click.point && r.steps[1].click.box);assert.ok(r.steps[1].changes, '每一步都记点完的变化');
    assert.equal(await p.evaluate("document.getElementById('name').value"), '批量');assert.equal(await p.evaluate("document.getElementById('out').textContent"), '点了 1 次', '失败那步后面的不做');
  });

  await t.test('iframe：同源的、跨源的（真 Chrome 里是另一个进程，要子会话）都找得到、点得到', async () => {
    const p = await open('/frames');await p.ready('框架页');
    let found;for (let i = 0; i < 20; i++) {found = await p.find({role: 'button', text: '框里的按钮'});if (found.total_elements === 2) break;await sleep(150);}
    assert.deepEqual(found.elements.map(e => e.name).sort(), ['同源框里的按钮', '跨源框里的按钮']);assert.deepEqual(found.unsupported_frames, []);
    assert.equal(new Set(found.elements.map(e => e.frame_id)).size, 2);
    for (const element of found.elements) {const r = await p.act('click', {ref: element.ref});assert.equal(r.status, 'completed', element.name + JSON.stringify(r.error));}
    for (let i = 0; i < 20 && server.hits.filter(h => h.startsWith('/hit')).length < 2; i++) await sleep(100);
    assert.deepEqual(server.hits.filter(h => h.startsWith('/hit')).map(h => decodeURIComponent(h)).sort(), ['/hit?who=同源', '/hit?who=跨源']);
  });

  await t.test('用户自己动了鼠标：后台 AI 操作照常继续', async () => {
    const p = await open('/form');await p.ready('还没动');
    const plain = await p.one('button', '普通按钮'), generation = p.driver.generation;
    await p.api.userMouseMove(p.tabId, 30, 30);await sleep(100);
    assert.equal(p.driver.generation, generation, '普通鼠标输入不撤销动作');
    const r = await p.act('click', {ref: plain.ref});assert.equal(r.status, 'completed', JSON.stringify(r.error || r.thrown));
    assert.equal(await p.evaluate("document.getElementById('out').textContent"), '点了 1 次');
  });
});
