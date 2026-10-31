import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {BrowserDriver} from '../browser-extension/driver.js';
import {pageHelpers, INSTALL_HELPERS} from '../browser-extension/page-helper.js';
import {markdownPage, conditionMet} from '../browser-extension/experience.js';
import {TOOLS, Tools} from '../app/tools.mjs';

const root = {id: 'root', url: 'https://example.test/form', loaderId: 'document-1'};
const ax = (id, role, name) => ({nodeId: String(id), backendDOMNodeId: id, role: {value: role}, name: {value: name}, properties: []});
function fixture({nodes = [ax(11, 'textbox', '姓名'), ax(12, 'button', '下一步'), ax(13, 'button', '提交')], managed = true} = {}) {
  let current = nodes, child = null;const calls = [], tabs = [], objects = new Map();
  const api = {
    tabs: {get: async id => ({id, url: root.url, title: '测试表单', groupId: managed ? 1 : -1, windowId: 1}), query: async () => [], create: async args => ({id: 2, ...args}), update: async () => ({}), remove: async () => {}, reload: async () => {}, group: async args => {tabs.push(args);return 1;}},
    tabGroups: {get: async () => ({title: 'Ken Bridge'}), query: async () => [{id: 1, title: 'Ken Bridge'}], update: async () => ({})},
    windows: {update: async () => {}}, runtime: {getPlatformInfo: async () => ({os: 'mac'})},
    debugger: {
      attach: async target => {calls.push({method: 'attach', target});}, detach: async target => {calls.push({method: 'detach', target});},
      sendCommand: async (target, method, params = {}) => {
        calls.push({target, method, params});
        if (method === 'Page.getFrameTree') return {frameTree: target.sessionId ? {frame: child} : {frame: root, ...(child ? {childFrames: [{frame: child}]} : {})}};
        if (method === 'Accessibility.getFullAXTree') return {nodes: target.sessionId ? [ax(22, 'button', 'iframe 按钮')] : current};
        if (method === 'Accessibility.getPartialAXTree') return {nodes: [...current, ax(22, 'button', 'iframe 按钮')].filter(node => node.backendDOMNodeId === params.backendNodeId)};
        if (method === 'DOM.getDocument') return {root:{nodeId:1,nodeName:'#document',children:[]}};
        if (method === 'DOM.describeNode') return {node: {attributes: ['type', params.backendNodeId === 13 ? 'submit' : 'text']}};
        if (method === 'Page.createIsolatedWorld') return {executionContextId: target.sessionId ? 8 : 7};
        if (method === 'DOM.resolveNode') {const objectId = 'node-' + params.backendNodeId;objects.set(objectId, params.backendNodeId);return {object: {objectId}};}
        if (method === 'DOM.getFrameOwner') return {backendNodeId: 88};
        if (method === 'Runtime.evaluate') {
          const expression = params.expression;
          if (expression === 'document.visibilityState') return {result: {value: 'visible'}};
          if (expression.includes('Helpers.aria')) return {result: {value: '- textbox "姓名"'}};
          if (expression.includes('Helpers.quiet')) return {result: {value: 1000}};
          if (expression.includes('Helpers.read')) return {result: {value: ['# 长文章', '正文第一段', '[链接](https://example.test)', '| A | B |\n| --- | --- |\n| 1 | 2 |']}};
          if (expression.includes('Helpers.locate')) return {result: {value: 1}};
          if (expression.includes('innerWidth/2')) return {result: {value: {x: 500, y: 300}}};
          return {result: {value: true}};
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.functionDeclaration.includes('data-chathand-sensitive')) return {result: {value: true}};
          if (params.functionDeclaration.includes('Helpers.check')) return {result: {value: {ok: true, form: false, submit: objects.get(params.objectId) === 13}}};
          if (params.objectId === 'node-88') return {result: {value: {x: 160, y: 100}}};
          return {result: {value: {x: 60, y: 30, width: 100, height: 40}}};
        }
        if (method === 'Page.captureScreenshot') return {data: 'image-fixture'};
        return {};
      }
    }
  };
  const driver = new BrowserDriver(api, {experience: true, settleMs: 5, pollMs: 1, actionabilityTimeoutMs: 100, idleMs: 30});
  return {driver, calls, tabs, setNodes: value => {current = value;}, crossFrame: async () => {child = {id: 'child', parentId: 'root', url: 'https://iframe.test', loaderId: 'child-document'};await driver.attach(1);await driver.onEvent({tabId: 1}, 'Target.attachedToTarget', {sessionId: 'child-session', targetInfo: {type: 'iframe', targetId: 'child', url: child.url}});}};
}
const mutations = calls => calls.filter(call => call.method.startsWith('Input.'));

test('batch validates each step, stops on missing reference, and returns the failure snapshot', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());const snapshot = await f.driver.execute('snapshot', {page_id: '1'});let authorized = 0;
  const result = await f.driver.execute('batch', {page_id: '1', operation_key: 'task:request', steps: [{step_id: 'name', action: 'fill', ref: snapshot.elements[0].ref, text: '中文姓名'}, {step_id: 'missing', action: 'click', ref: 'missing'}, {step_id: 'never', action: 'click', ref: snapshot.elements[1].ref}]}, {authorize: async () => {authorized++;}});
  assert.equal(result.status, 'failed');assert.equal(result.failed_step_id, 'missing');assert.equal(result.completed_steps, 1);assert.deepEqual(result.steps.map(step => step.step_id), ['name', 'missing']);assert.ok(result.snapshot.snapshot_id);assert.equal(result.snapshot_stale, false);assert.equal(f.calls.filter(call => call.method === 'Input.insertText').length, 1);assert.equal(f.calls.filter(call => call.params?.type === 'mousePressed').length, 0);assert.ok(authorized >= 3);
});

test('batch revocation on the next step prevents all following input', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());const snapshot = await f.driver.execute('snapshot', {page_id: '1'});let checks = 0;
  const result = await f.driver.execute('batch', {page_id: '1', operation_key: 'task:revoked', steps: [{step_id: 'first', action: 'fill', ref: snapshot.elements[0].ref, text: '一次'}, {step_id: 'second', action: 'click', ref: snapshot.elements[1].ref}]}, {authorize: async () => {if (++checks === 3) throw Object.assign(Error('revoked'), {code: 'TASK_REVOKED'});}});
  assert.equal(result.failed_step_id, 'second');assert.equal(result.error.code, 'TASK_REVOKED');assert.equal(f.calls.filter(call => call.params?.type === 'mousePressed').length, 0);
});

test('semantic ref survives node replacement, action returns a new snapshot and changes', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());const snapshot = await f.driver.execute('snapshot', {page_id: '1'});f.setNodes([ax(101, 'textbox', '姓名'), ax(12, 'button', '下一步')]);
  const result = await f.driver.execute('fill', {page_id: '1', ref: snapshot.elements[0].ref, text: '新值'});
  assert.equal(result.status, 'completed');assert.notEqual(result.snapshot_id, snapshot.snapshot_id);assert.equal(result.snapshot.elements[0].ref, snapshot.elements[0].ref);assert.ok(f.calls.some(call => call.method === 'DOM.focus' && call.params.backendNodeId === 101));assert.equal(result.stabilization.stable, true);
});

test('authorized consequential actions accept omitted or false confirm', async t => {
  for (const name of ['登录','提交','发送','付款']) for (const confirm of [undefined,false,true]) {
    const f=fixture({nodes:[ax(12,'button',name)]});t.after(()=>f.driver.detachAll());const snapshot=await f.driver.execute('snapshot',{page_id:'1'});
    const result=await f.driver.execute('click',{page_id:'1',ref:snapshot.elements[0].ref,...(confirm===undefined?{}:{confirm})});assert.equal(result.status,'completed');assert.equal(f.calls.filter(call=>call.params?.type==='mousePressed').length,1);
  }
});

test('ambiguous locator still stops before input', async t => {
  const f=fixture();t.after(()=>f.driver.detachAll());const snapshot=await f.driver.execute('snapshot',{page_id:'1'});f.setNodes([ax(12,'button','下一步'),ax(14,'button','下一步')]);
  const result=await f.driver.execute('click',{page_id:'1',ref:snapshot.elements[1].ref});assert.equal(result.error.code,'ELEMENT_AMBIGUOUS');assert.equal(mutations(f.calls).length,0);assert.equal(result.error.details.candidates.length,2);
});

test('snapshot pagination and find reach elements beyond 160', async t => {
  const f = fixture({nodes: Array.from({length: 200}, (_, index) => ax(index + 1, 'button', '项目 ' + index))});t.after(() => f.driver.detachAll());
  const snapshot = await f.driver.execute('snapshot', {page_id: '1', offset: 160, limit: 40}), found = await f.driver.execute('find', {page_id: '1', text: '项目 199', exact: true});
  assert.equal(snapshot.elements.length, 40);assert.equal(snapshot.total_elements, 200);assert.equal(snapshot.next_offset, null);assert.equal(found.elements[0].name, '项目 199');
});

test('wait conditions are bounded and timeout returns the observed page', async t => {
  const cases = [
    [{kind: 'text', text: '姓名'}, {text: '姓名', elements: [], url: root.url}, true],
    [{kind: 'text_absent', text: '载入中'}, {text: '已完成', elements: []}, true],
    [{kind: 'url_change', url: root.url}, {text: '', url: 'https://example.test/done', elements: []}, true],
    [{kind: 'element', role: 'button', name: '提交'}, {text: '', elements: [{role: 'button', name: '提交'}]}, true],
    [{kind: 'network_idle'}, {text: '', elements: [], network_idle: false}, false]
  ];for (const [condition, state, expected] of cases) assert.equal(conditionMet(condition, state), expected);
  const f = fixture();t.after(() => f.driver.detachAll());const result = await f.driver.execute('wait_for', {page_id: '1', condition: {kind: 'text', text: '没有出现的文字', timeout_ms: 5}});assert.equal(result.error.code, 'WAIT_TIMEOUT');assert.ok(result.snapshot.snapshot_id);assert.equal(mutations(f.calls).length, 0);
});

test('cross-origin child input uses flat session and local coordinates, receipt stays in main viewport', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());await f.crossFrame();const snapshot = await f.driver.execute('snapshot', {page_id: '1'}), inner = snapshot.elements.find(element => element.frame_id === 'child');assert.ok(inner);
  const result = await f.driver.execute('click', {page_id: '1', ref: inner.ref});assert.equal(result.status, 'completed');
  assert.ok(f.calls.some(call => call.method === 'Accessibility.getFullAXTree' && call.target.sessionId === 'child-session'));
  assert.ok(f.calls.some(call => call.method === 'DOM.resolveNode' && call.params.backendNodeId === 22 && call.target.sessionId === 'child-session'));
  const down = f.calls.find(call => call.params?.type === 'mousePressed');assert.equal(down.target.sessionId, 'child-session');assert.equal(down.params.x, 60);assert.equal(down.params.y, 30);assert.deepEqual(result.click.point, {x: 160, y: 100});
});

test('personal tab accepts omitted or false allow_personal and still idles without closing Chrome', async t => {
  for(const allow_personal of [undefined,false,true]){const f=fixture({managed:false});t.after(()=>f.driver.detachAll());const snapshot=await f.driver.execute('snapshot',{page_id:'1',...(allow_personal===undefined?{}:{allow_personal})});assert.ok(snapshot.snapshot_id);assert.equal(f.tabs.length,1);await new Promise(resolve=>setTimeout(resolve,40));assert.ok(f.calls.some(call=>call.method==='detach'));assert.equal(f.driver.attached.size,0);}
});

test('ordinary user input does not cancel background operations or install an input watcher', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());await f.driver.execute('snapshot', {page_id: '1'});const generation = f.driver.generation;
  for (const kind of ['pointermove', 'pointerdown', 'keydown', 'wheel']) await f.driver.onEvent({tabId: 1}, 'Runtime.bindingCalled', {name: '__ChatHandUserInput', executionContextId: 7, payload: JSON.stringify({kind})});
  assert.equal(f.driver.generation, generation);assert.equal(f.driver.resumeUser, undefined);assert.equal(f.calls.some(call => call.method === 'Runtime.addBinding'), false);
  const result = await f.driver.execute('fill', {page_id: '1', ref: (await f.driver.execute('snapshot', {page_id: '1'})).elements[0].ref, text: '照常填写'});assert.equal(result.status, 'completed');
});

test('targeted scrolling uses observed element instead of fixed top-left', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());const snapshot = await f.driver.execute('snapshot', {page_id: '1'});await f.driver.execute('scroll', {page_id: '1', ref: snapshot.elements[1].ref, amount: 500});const wheel = f.calls.find(call => call.params?.type === 'mouseWheel');assert.equal(wheel.params.x, 60);assert.equal(wheel.params.y, 30);
});

test('sensitive input, batch bounds and numbered screenshot preserve input boundaries', async t => {
  const f = fixture({nodes: [ax(11, 'textbox', '密码')]});t.after(() => f.driver.detachAll());const snapshot = await f.driver.execute('snapshot', {page_id: '1'});
  const fake='FAKE_PASSWORD_1060_ONLY',password = await f.driver.execute('fill', {page_id: '1', ref: snapshot.elements[0].ref, text: fake});assert.equal(password.status, 'completed');assert.equal(f.calls.filter(call=>call.method==='Input.insertText').at(-1).params.text,fake);assert.equal(JSON.stringify(password).includes(fake),false);
  for (const steps of [[], Array.from({length: 11}, (_, index) => ({step_id: String(index), action: 'fill'})), [{step_id: 'same', action: 'fill'}, {step_id: 'same', action: 'click'}]]) await assert.rejects(() => f.driver.execute('batch', {page_id: '1', operation_key: 'invalid', steps}), {code: 'BATCH_INVALID'});
  const image = await f.driver.execute('screenshot', {page_id: '1', numbered: true});assert.equal(image.numbered, true);assert.equal(image.elements[0].number, 1);assert.equal(image.elements[0].ref, snapshot.elements[0].ref);assert.ok(f.calls.some(call => call.method === 'Runtime.evaluate' && call.params.expression.includes('data-chathand-overlay') && call.params.expression.includes('remove')));
});

test('cancellation during a late actionability response never dispatches input', async t => {
  const f = fixture();t.after(() => f.driver.detachAll());const snapshot = await f.driver.execute('snapshot', {page_id: '1'}), original = f.driver.api.debugger.sendCommand;let release;
  f.driver.api.debugger.sendCommand = async (target, method, params) => {if (method === 'DOM.scrollIntoViewIfNeeded') return new Promise(resolve => {release = resolve;});return original(target, method, params);};
  const pending = f.driver.execute('click', {page_id: '1', ref: snapshot.elements[1].ref});for (let count = 0; count < 40 && !release; count++) await new Promise(resolve => setImmediate(resolve));assert.equal(typeof release, 'function');await f.driver.detachAll();release({});const result = await pending;assert.equal(result.error.code, 'ACTION_CANCELLED');assert.equal(mutations(f.calls).length, 0);assert.equal(result.snapshot_stale, true);
});

test('page helpers read Markdown links/table and remove sensitive input values', () => {
  function element(tag, children = [], attrs = {}) {const node = {nodeType: 1, tagName: tag, childNodes: children, children: children.filter(child => child.nodeType === 1), hidden: false, getAttribute: key => attrs[key] || null, matches: () => tag === 'INPUT' && attrs.type === 'password', querySelectorAll: selector => {const all = [];const visit = child => {if (selector === 'tr' && child.tagName === 'TR' || selector === 'th,td' && ['TH', 'TD'].includes(child.tagName)) all.push(child);for (const nested of child.childNodes || []) visit(nested);};for (const child of children) visit(child);return all;}};Object.defineProperty(node, 'textContent', {get: () => children.map(child => child.textContent).join('')});return node;}
  const text = value => ({nodeType: 3, textContent: value});
  const article = element('ARTICLE', [element('H1', [text('标题')]), element('P', [text('正文与 '), element('A', [text('链接')], {href: '/source'})]), element('TABLE', [element('TR', [element('TH', [text('名称')]), element('TH', [text('数值')])]), element('TR', [element('TD', [text('中文')]), element('TD', [text('2')])])]), element('INPUT', [text('绝不能出现的密码')], {type: 'password'})]);
  const context = {window: {document: {baseURI: root.url, querySelector: () => article, body: article}, __ChatHandPW: {ariaSnapshotJSON: () => ({json: [{role: 'textbox', name: '密码', children: ['secret-value']}]}), querySelectorAll: () => [], parseSelector: selector => selector}}, URL, performance: {now: () => 0}, MutationObserver: class {observe() {}}};
  const helpers = vm.runInNewContext('(' + pageHelpers.toString() + ')(window)', context), segments = helpers.read();assert.equal(segments[0], '# 标题');assert.equal(segments[1], '正文与 [链接](https://example.test/source)');assert.match(segments[2], /\| 名称 \| 数值 \|\n\| --- \| --- \|/);assert.doesNotMatch(segments.join('\n') + helpers.aria(), /绝不能|secret-value/);
  const first = markdownPage([...segments], 0, 2);assert.equal(first.next_offset, 2);const last = markdownPage([...segments], first.next_offset, 2);assert.equal(last.next_offset, null);new vm.Script(INSTALL_HELPERS);
});

test('new tool schema has no arbitrary-script surface and keeps existing names', () => {
  for (const name of ['browser_batch', 'browser_read', 'browser_find', 'browser_wait_for', 'browser_snapshot', 'browser_action']) {const tool = TOOLS.find(tool => tool.name === name);assert.ok(tool);assert.equal(tool.inputSchema.additionalProperties, false);assert.equal(tool.inputSchema.properties.script, undefined);assert.equal(tool.inputSchema.properties.evaluate, undefined);}
  assert.equal(TOOLS.find(tool => tool.name === 'browser_batch').inputSchema.properties.steps.maxItems, 10);assert.equal(TOOLS.find(tool => tool.name === 'browser_tabs').inputSchema.properties.show.default, false);
});

test('Tools accepts object batch steps and rejects unknown nested script arguments', async () => {
  const state={data:{browser_enabled:true}},automation={state,ops:{run:async(name,args,caller,fn)=>fn()},browser:{extension:{batch:async args=>({completed_steps:args.steps.length})}}},context=Object.assign(Object.create(Tools.prototype),{state,store:{},queue:{},policy:{epoch:1,check(){}},lastCalls:{},automation});
  const args={task_id:'task',request_id:'batch-request',page_id:'page',steps:[{step_id:'field',action:'fill',ref:'reference',text:'中文'}]};
  const result=await Tools.prototype.invoke.call(context,'browser_batch',args,'caller');assert.equal(result.completed_steps,1);
  assert.equal(context.cardControlContext.get('task').scope,'browser');assert.equal(context.cardControlContext.get('task').epoch,1);
  for(const steps of [[{step_id:'field',action:'fill',script:'window.alert(1)'}],[{step_id:'wait',action:'wait_for',condition:{kind:'text',text:'done',evaluate:'document.body'}}]])await assert.rejects(()=>Tools.prototype.invoke.call(context,'browser_batch',{...args,steps},'caller'),{code:'ARG_INVALID'});
});

test('scoped snapshot hides input descendants and canvas rejects same-url document navigation', async t => {
  const region={...ax(20,'region','表单区域'),childIds:['11']},input={...ax(11,'textbox','验证码'),childIds:['10']},secret={...ax(10,'StaticText','private-otp-value')},f=fixture({nodes:[region,input,secret]});t.after(()=>f.driver.detachAll());
  const snapshot=await f.driver.execute('snapshot',{page_id:'1'}),scoped=await f.driver.execute('snapshot',{page_id:'1',scope_ref:snapshot.elements[0].ref});assert.doesNotMatch(snapshot.text+scoped.text,/private-otp-value/);
  const image=await f.driver.execute('screenshot',{page_id:'1'}),old=root.loaderId;root.loaderId='new-document';
  try{const result=await f.driver.execute('click',{page_id:'1',snapshot_id:image.snapshot_id,coordinate:true,confirm:true,x:20,y:30});assert.equal(result.error.code,'SNAPSHOT_STALE');assert.equal(mutations(f.calls).length,0);}finally{root.loaderId=old;}
});
