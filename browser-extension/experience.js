import {text} from './locale.js';
import {INSTALL_HELPERS, HELPER_VERSION, privateAXNode} from './page-helper.js';
import {frameDocumentId, readFrameTree, resolveNodeInFrame, MAX_FRAME_COUNT} from './frame-tree.js';
import {clickPoint} from './click-target.js';
import {scrollPage} from './scroll-target.js';
import {performUpload, cancelUploads} from './upload.js';

const errorText = () => ({
  FILE_INPUT_REQUIRED: [text('chrome.fileInputRequired'), text('chrome.uploadScope')],
  ELEMENT_AMBIGUOUS: [text('chrome.ambiguousElement'), text('chrome.inspectCandidates')],
  WAIT_TIMEOUT: [text('chrome.waitTimeout'), text('chrome.inspectNoReplay')]
});
const fault = (code, details) => Object.assign(new Error(errorText()[code]?.[0] || code), {code, details});
const chatgptTarget = raw => {try {const u=new URL(String(raw));if(!['http:','https:'].includes(u.protocol))return false;const h=u.hostname.toLowerCase().replace(/\.$/,'');return ['chatgpt.com','chat.openai.com','chat.com'].some(d=>h===d||h.endsWith('.'+d));} catch {return false;}};
const requireChatGPTAccess = (url, allowed) => {if(chatgptTarget(url)&&allowed!==true)throw fault('HIGH_RISK_DISABLED',{gate:'chatgpt_self',command:'browser',replay_safe:false});};
export function browserError(error) {
  const code = /^[A-Z_]{3,80}$/.test(error?.code || '') ? error.code : 'BROWSER_ACTION_FAILED';
  return {code, message: errorText()[code]?.[0] || text('chrome.actionStoppedInspect'), recovery: errorText()[code]?.[1] || text('chrome.observeNoReplay'), ...(error?.details ? {details: error.details} : {})};
}
export function semanticRef(frame, role, name, ordinal = 0) {
  const text = JSON.stringify([frame, role, name, ordinal]);let a = 2166136261, b = 5381;
  for (const character of text) {a = Math.imul(a ^ character.charCodeAt(0), 16777619);b = Math.imul(b, 33) ^ character.charCodeAt(0);}
  return 'r' + (a >>> 0).toString(16) + (b >>> 0).toString(16);
}
export function markdownPage(segments, offset = 0, limit = 20, maxChars = 48000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fault('ARG_INVALID');
  const selected = [];let chars = 0, cursor = offset;
  while (cursor < segments.length && selected.length < limit) {
    const text = String(segments[cursor]);
    // A single unusually large paragraph remains readable via a character cursor.
    if (chars + text.length > maxChars && selected.length) break;
    selected.push(text);chars += text.length;cursor++;
  }
  return {markdown: selected.join('\n\n'), segment_offset: offset, segments_returned: selected.length, total_segments: segments.length, next_offset: cursor < segments.length ? cursor : null};
}
export function conditionMet(condition, state) {
  if (condition.kind === 'text') return state.text.includes(condition.text);
  if (condition.kind === 'text_absent') return !state.text.includes(condition.text);
  if (condition.kind === 'url_change') return state.url !== condition.url;
  if (condition.kind === 'element') return state.elements.some(element => (!condition.role || element.role === condition.role) && (!condition.name || element.name === condition.name));
  if (condition.kind === 'network_idle') return state.network_idle === true;
  throw fault('WAIT_CONDITION_INVALID');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const AUTO_ATTACH = {autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{type: 'iframe', exclude: false}]};
const INTERACTIVE_EXCLUDED = new Set(['StaticText', 'InlineTextBox', 'RootWebArea', 'generic', 'none', 'paragraph']);

/** Add the 1012 experience around the existing generation-guarded input driver. */
export function enableExperience(driver, {idleMs = 30000, settleMs = 3000, pollMs = 50} = {}) {
  const original = Object.fromEntries(['attach', 'execute', 'send', 'detachTab', 'detachAll', 'invalidate'].map(name => [name, driver[name].bind(driver)]));
  driver.childSessions = new Map();driver.childFrameSessions = new Map();driver.experienceFramesTruncated = new Set();driver.locators = new Map();driver.lastObservations = new Map();driver.managedTabs = new Set();driver.idleTimers = new Map();driver.helperContexts = new Map();driver.networkRequests = new Map();driver.networkChanged = new Map();driver.stepReceipts = new Map();
  driver.frameSession = (id, frameId) => driver.childFrameSessions.get(id)?.get(frameId) || [...(driver.childSessions.get(id)?.values() || [])].find(entry => entry.frameId === frameId)?.sessionId || null;
  driver.sendFrame = (id, frameId, method, params, generation) => driver.send(id, method, params, generation, driver.frameSession(id, frameId));
  driver.send = (id, method, params = {}, generation = driver.generation, sessionId = null) => sessionId ? driver.bounded(id, 'CDP_COMMAND', () => driver.api.debugger.sendCommand({tabId: id, sessionId}, method, params), generation) : original.send(id, method, params, generation);
  driver.onEvent = async (source, method, params = {}) => {
    const id = source.tabId;if (!driver.attached.has(id)) return;
    const generation = driver.generation, sessionId = source.sessionId || null;
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      const children = driver.childSessions.get(id) || new Map();driver.childSessions.set(id, children);
      if(children.size>=MAX_FRAME_COUNT){driver.experienceFramesTruncated.add(id);await driver.send(id,'Target.detachFromTarget',{sessionId:params.sessionId},generation,sessionId).catch(()=>{});return;}
      const entry = {sessionId: params.sessionId, frameId: params.targetInfo.targetId, parentSessionId: sessionId, url: params.targetInfo.url};children.set(entry.sessionId, entry);
      try {
        for (const domain of ['Runtime', 'Page', 'Network']) await driver.send(id, domain + '.enable', {}, generation, entry.sessionId);
        await driver.send(id, 'Target.setAutoAttach', AUTO_ATTACH, generation, entry.sessionId);
        const tree = await driver.send(id, 'Page.getFrameTree', {}, generation, entry.sessionId);if (tree.frameTree?.frame) {entry.frameId = tree.frameTree.frame.id;entry.frame = tree.frameTree.frame;}
      } catch (error) {children.delete(entry.sessionId);if (error.code === 'ACTION_CANCELLED') return;}
      return;
    }
    if (method === 'Target.detachedFromTarget') {cancelUploads(driver,id);driver.childSessions.get(id)?.delete(params.sessionId);for (const [frame, session] of driver.childFrameSessions.get(id) || []) if (session === params.sessionId) driver.childFrameSessions.get(id).delete(frame);for(const request of driver.networkRequests.get(id)||[])if(request.startsWith(params.sessionId+':'))driver.networkRequests.get(id).delete(request);return;}
    if (method === 'Runtime.executionContextsCleared' || method === 'Runtime.executionContextDestroyed') {cancelUploads(driver,id);for (const [key, context] of driver.helperContexts) if (context.id === id && context.sessionId === sessionId && (method === 'Runtime.executionContextsCleared' || context.contextId === params.executionContextId)) driver.helperContexts.delete(key);return;}
    if (method === 'Page.frameNavigated' && sessionId) {const entry = driver.childSessions.get(id)?.get(sessionId);if (entry && params.frame) {entry.frameId = params.frame.id;entry.frame = params.frame;}return;}
    if (method === 'Network.requestWillBeSent' && !['WebSocket', 'EventSource'].includes(params.type)) {const requests = driver.networkRequests.get(id) || new Set();requests.add((sessionId || '') + ':' + params.requestId);driver.networkRequests.set(id, requests);driver.networkChanged.set(id, Date.now());}
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {driver.networkRequests.get(id)?.delete((sessionId || '') + ':' + params.requestId);driver.networkChanged.set(id, Date.now());}
  };
  driver.networkIdle = id => !driver.networkRequests.get(id)?.size && Date.now() - (driver.networkChanged.get(id) || 0) >= 500;
  driver.attach = async (id, generation = driver.generation) => {
    const attached = driver.attached.has(id);await original.attach(id, generation);
    if (!attached) {
      for (const domain of ['Page', 'Runtime', 'Network']) await driver.send(id, domain + '.enable', {}, generation);
      await driver.send(id, 'Target.setAutoAttach', AUTO_ATTACH, generation);
      driver.networkChanged.set(id, Date.now());
    }
    return id;
  };
  driver.detachTab = async (id, force = false, token = null) => {
    cancelUploads(driver,id);
    clearTimeout(driver.idleTimers.get(id));driver.idleTimers.delete(id);driver.childSessions.delete(id);driver.childFrameSessions.delete(id);driver.networkRequests.delete(id);
    for (const [key, context] of driver.helperContexts) if (context.id === id) driver.helperContexts.delete(key);
    return original.detachTab(id, force, token);
  };
  driver.noteDetached = id => {cancelUploads(driver,id);clearTimeout(driver.idleTimers.get(id));driver.idleTimers.delete(id);driver.childSessions.delete(id);driver.childFrameSessions.delete(id);driver.networkRequests.delete(id);for (const [key, context] of driver.helperContexts) if (context.id === id) driver.helperContexts.delete(key);};
  driver.detachAll = async () => {cancelUploads(driver);for (const timer of driver.idleTimers.values()) clearTimeout(timer);driver.idleTimers.clear();return original.detachAll();};
  driver.scheduleIdle = id => {clearTimeout(driver.idleTimers.get(id));const timer = setTimeout(() => {driver.idleTimers.delete(id);void driver.detachTab(id);}, idleMs);timer.unref?.();driver.idleTimers.set(id, timer);};
  driver.invalidate = id => {cancelUploads(driver,id);original.invalidate(id);};
  driver.group = async (id, generation) => {
    if (driver.api.tabs.group && driver.api.tabGroups) {
      const groups = await driver.api.tabGroups.query({});driver.assertCurrent(generation);
      const existing = groups.find(group => group.title === 'ChatHand') || groups.find(group => group.title === 'Ken Bridge');
      driver.assertCurrent(generation);const groupId = await driver.api.tabs.group({tabIds: [id], ...(existing ? {groupId: existing.id} : {})});driver.assertCurrent(generation);
      await driver.api.tabGroups.update(groupId, {title: 'ChatHand', color: 'blue'});driver.assertCurrent(generation);
    }
    driver.managedTabs.add(id);
  };
  driver.allowedTab = async (id, args, generation) => {
    const tab = await driver.page(id, generation);
    if (!driver.managedTabs.has(id) && Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 && driver.api.tabGroups?.get) {
      const group = await driver.api.tabGroups.get(tab.groupId);driver.assertCurrent(generation);if (['ChatHand','Ken Bridge'].includes(group.title)) {driver.managedTabs.add(id);if(group.title==='Ken Bridge'){await driver.api.tabGroups.update(tab.groupId,{title:'ChatHand',color:'blue'});driver.assertCurrent(generation);}}
    }
    if (!driver.managedTabs.has(id)) await driver.group(id, generation);
    clearTimeout(driver.idleTimers.get(id));driver.idleTimers.delete(id);return tab;
  };
  driver.assertChatGPTAccess = async (id, options, generation) => {
    const allowed=options?.chatgptSelfAllowed===true,tab=await driver.page(id,generation);
    requireChatGPTAccess(tab.url,allowed);
    await driver.attach(id,generation);
    const info=await readFrameTree(driver,id,generation,tab.url);
    for(const frame of info.frames||[])requireChatGPTAccess(frame.url,allowed);
    return tab;
  };
  driver.helpers = async (id, frame, generation) => {
    const sessionId = driver.frameSession(id, frame.id), key = [id, frame.id, frameDocumentId(frame), sessionId].join(':');
    if (driver.helperContexts.has(key)) return driver.helperContexts.get(key);
    const world = await driver.sendFrame(id, frame.id, 'Page.createIsolatedWorld', {frameId: frame.id, worldName: 'ChatHand.Helpers', grantUniveralAccess: false}, generation);
    const contextId = world.executionContextId;if (!Number.isSafeInteger(contextId)) throw fault('ELEMENT_FRAME_UNSUPPORTED');
    const installed = await driver.send(id, 'Runtime.evaluate', {expression: INSTALL_HELPERS, contextId, returnByValue: true}, generation, sessionId);
    if (installed.exceptionDetails || installed.result?.value !== true) throw fault('PAGE_HELPER_FAILED');
    const context = {id, contextId, sessionId, frameId: frame.id};driver.helperContexts.set(key, context);return context;
  };
  // 1029：元素要放进装了 __ChatHandHelpers 的那个隔离环境里再调 helper。原来用 resolveNodeInFrame 的默认环境
  // （KenBridge.Actionability，另一个隔离环境），那里没有 helper，真 Chrome 里每次点击都报 PAGE_HELPER_FAILED（10/7 复测）。
  driver.resolveInHelpers = async (id, frame, backendNodeId, generation) => {
    const context = await driver.helpers(id, frame, generation);
    const resolved = await driver.send(id, 'DOM.resolveNode', {backendNodeId, executionContextId: context.contextId}, generation, context.sessionId);
    if (!resolved?.object?.objectId) throw fault('ELEMENT_CHANGED');
    return {objectId: resolved.object.objectId};
  };
  driver.evaluateHelper = async (id, frame, expression, generation) => {
    const context = await driver.helpers(id, frame, generation);const result = await driver.send(id, 'Runtime.evaluate', {expression, contextId: context.contextId, returnByValue: true}, generation, context.sessionId);
    if (result.exceptionDetails) throw fault('PAGE_HELPER_FAILED');return result.result?.value;
  };
  driver.allElements = async (id, generation) => {
    const tab = await driver.page(id, generation);await driver.attach(id, generation);
    const info = await readFrameTree(driver, id, generation, tab.url), elements = [], text = [], unsupported_frames = [];let remaining = 16000;
    for (const frame of info.frames) {
      try {
        if (frame.crossOrigin && !driver.frameSession(id, frame.id)) throw fault('CROSS_ORIGIN_FRAME_UNSUPPORTED');
        const tree = await driver.sendFrame(id, frame.id, 'Accessibility.getFullAXTree', {frameId: frame.id}, generation), nodes = (tree.nodes || []).slice(0, Math.min(4000, remaining)), counts = new Map(), byId = new Map(nodes.map(node => [node.nodeId, node])), privateChildren = new Set();remaining -= nodes.length;
        const hide = nodeId => {if(privateChildren.has(nodeId))return;privateChildren.add(nodeId);for(const child of byId.get(nodeId)?.childIds||[])hide(child);};
        for(const node of nodes)if(privateAXNode(node))for(const child of node.childIds||[])hide(child);
        for (const node of nodes) {
          if (node.ignored || privateChildren.has(node.nodeId)) continue;const role = String(node.role?.value || ''), name = String(node.name?.value || '').slice(0, 400);
          if (name) text.push(name);
          if (!node.backendDOMNodeId || INTERACTIVE_EXCLUDED.has(role)) continue;
          const key = JSON.stringify([role, name]), ordinal = counts.get(key) || 0;counts.set(key, ordinal + 1);
          const ref = semanticRef(frame.id, role, name, ordinal), descriptor = {ref, backend: node.backendDOMNodeId, role, name, ordinal, disabled: (node.properties || []).some(property => property.name === 'disabled' && property.value?.value === true), frameId: frame.id, documentId: frameDocumentId(frame), frameUrl: frame.url || tab.url, url: tab.url, nodeId: node.nodeId, childIds: node.childIds || []};
          const urlProperty = (node.properties || []).find(property => property.name === 'url')?.value?.value;try {const href = new URL(urlProperty);if (['http:', 'https:'].includes(href.protocol) && !href.username && !href.password) descriptor.href = href.href;} catch {}
          const keyRef=id+':'+ref,prior=driver.locators.get(keyRef);if(prior&&JSON.stringify([prior.frameId,prior.role,prior.name,prior.ordinal])!==JSON.stringify([descriptor.frameId,descriptor.role,descriptor.name,descriptor.ordinal]))throw fault('ELEMENT_REF_COLLISION');
          if(driver.locators.size>=32000&&!driver.locators.has(keyRef))driver.locators.delete(driver.locators.keys().next().value);
          driver.locators.set(keyRef, descriptor);elements.push(descriptor);
        }
      } catch (error) {driver.assertCurrent(generation);if (/TIMEOUT|CANCELLED/.test(error.code || '') || frame.id === info.root.id) throw error;unsupported_frames.push({frame_id: frame.id, reason: error.code || 'OOPIF_FRAME_UNSUPPORTED'});}
    }
    return {tab, info, elements, text: text.join('\n'), unsupported_frames, ax_nodes_truncated: remaining <= 0};
  };
  const publicElement = element => ({ref: element.ref, role: element.role, name: element.name, ordinal: element.ordinal, disabled: element.disabled, href: element.href || null, frame_id: element.frameId, document_id: element.documentId});
  driver.snapshot = async (id, generation = driver.generation, options = {}) => {
    const all = await driver.allElements(id, generation);let elements = all.elements;
    if (options.scope_ref) {
      const target = await driver.target(id, {ref: options.scope_ref}, generation), frame = all.info.frames.find(candidate => candidate.id === target.frameId);
      const tree = await driver.sendFrame(id, frame.id, 'Accessibility.getFullAXTree', {frameId: frame.id}, generation), nodes = new Map((tree.nodes || []).map(node => [node.nodeId, node])), root = (tree.nodes || []).find(node => node.backendDOMNodeId === target.backend), ids = new Set();
      const visit = nodeId => {if (ids.has(nodeId)) return;ids.add(nodeId);if(privateAXNode(nodes.get(nodeId)))return;for (const childId of nodes.get(nodeId)?.childIds || []) visit(childId);};if (root) visit(root.nodeId);
      elements = elements.filter(element => element.frameId === target.frameId && ids.has(element.nodeId));all.text = [...ids].map(nodeId => nodes.get(nodeId)?.name?.value || '').filter(Boolean).join('\n');
    }
    const offset = options.offset || 0, limit = options.limit || 160;if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 160) throw fault('ARG_INVALID');
    let aria_yaml = '',aria_available=false;try {const value = await driver.evaluateHelper(id, all.info.root, 'window.__ChatHandHelpers.aria()', generation);aria_available=typeof value==='string';aria_yaml=aria_available?value:'';} catch (error) {driver.assertCurrent(generation);if (/CANCELLED|TIMEOUT/.test(error.code || '')) throw error;}
    const lang = await driver.pageLang(id, all.info.root, generation);
    const result = {page_id: String(id), snapshot_id: crypto.randomUUID(), document_id: frameDocumentId(all.info.root), frame_id: all.info.root.id, url: all.tab.url, title: all.tab.title || '', ...(lang ? {lang} : {}), text: all.text.slice(0, 18000), text_truncated: all.text.length > 18000, elements: elements.slice(offset, offset + limit).map(publicElement), total_elements: elements.length, next_offset: offset + limit < elements.length ? offset + limit : null, offset, aria_yaml, aria_available, locator_engine: aria_available?'playwright-injected-' + HELPER_VERSION:'cdp-ax-fallback', unsupported_frames: all.unsupported_frames, frames_truncated: all.info.truncated, ax_nodes_truncated: all.ax_nodes_truncated, untrusted_content: true};
    // 点完以后「多了哪些元素」要和整页比，不只比第一页：整页的列表挂在结果上，但不往外发。
    Object.defineProperty(result, 'all', {value: all.elements.map(element => ({ref: element.ref, role: element.role, name: element.name})), enumerable: false});
    driver.snapshots.set(id, {snapshot_id: result.snapshot_id, refs: new Map(elements.map(element => [element.ref, element])), url: all.tab.url, at: Date.now()});driver.lastObservations.set(id, result);return result;
  };
  /** 页面的语言（html 的 lang，没写就用浏览器的语言）。读不到就算了，不影响别的。同一个文档只读一次。 */
  driver.pageLangs = new Map();
  driver.pageLang = async (id, root, generation) => {
    const key = id + ':' + frameDocumentId(root);if (driver.pageLangs.has(key)) return driver.pageLangs.get(key);
    let lang = '';
    try {lang = String(await driver.evaluateHelper(id, root, '(document.documentElement.lang||navigator.language||"").slice(0,35)', generation) || '');}
    catch (error) {driver.assertCurrent(generation);if (/CANCELLED|TIMEOUT/.test(error.code || '')) throw error;return '';}
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang)) lang = '';
    if (driver.pageLangs.size > 200) driver.pageLangs.delete(driver.pageLangs.keys().next().value);
    driver.pageLangs.set(key, lang);return lang;
  };
  driver.target = async (id, args, generation = driver.generation) => {
    const known = driver.locators.get(id + ':' + args.ref), tab = await driver.page(id, generation);
    if (!known || known.url !== tab.url) throw fault('SNAPSHOT_STALE');
    const info = await readFrameTree(driver, id, generation, tab.url), frame = info.frames.find(candidate => candidate.id === known.frameId);
    if (!frame || known.documentId !== frameDocumentId(frame)) throw fault('SNAPSHOT_STALE');
    const tree = await driver.sendFrame(id, frame.id, 'Accessibility.getFullAXTree', {frameId: frame.id}, generation), matches = (tree.nodes || []).filter(node => !node.ignored && String(node.role?.value || '') === known.role && String(node.name?.value || '').slice(0, 400) === known.name && node.backendDOMNodeId);
    if (matches.length > 1) throw fault('ELEMENT_AMBIGUOUS', {candidates: matches.slice(0, 20).map((node, ordinal) => ({role: known.role, name: known.name, ordinal, frame_id: known.frameId}))});
    if (!matches.length) throw fault('ELEMENT_CHANGED');const node = matches[0];if (node.properties?.some(property => property.name === 'disabled' && property.value?.value === true)) throw fault('ELEMENT_DISABLED');
    const located = await driver.evaluateHelper(id, frame, 'window.__ChatHandHelpers.locate(' + JSON.stringify({role: known.role, name: known.name, exact: true}) + ').length', generation);
    if (located > 1) throw fault('ELEMENT_AMBIGUOUS', {candidates: [{role: known.role, name: known.name, frame_id: known.frameId, count: located}]});
    if (located !== 1) throw fault('ELEMENT_CHANGED');
    const described = await driver.sendFrame(id, frame.id, 'DOM.describeNode', {backendNodeId: node.backendDOMNodeId, depth: 0}, generation), attrs = {};for (let index = 0; index < (described.node?.attributes || []).length; index += 2) attrs[described.node.attributes[index]] = described.node.attributes[index + 1];
    return {...known, backend: node.backendDOMNodeId, attrs, sessionId: driver.frameSession(id, frame.id)};
  };
  driver.settle = async (id, generation) => {
    const start = Date.now();let stable = false;
    do {
      driver.assertCurrent(generation);const info = await readFrameTree(driver, id, generation, (await driver.page(id, generation)).url);
      let quiet = 0;try {quiet = Number(await driver.evaluateHelper(id, info.root, 'window.__ChatHandHelpers.quiet()', generation));} catch (error) {driver.assertCurrent(generation);if (/CANCELLED|TIMEOUT/.test(error.code || '')) throw error;}
      if (quiet >= 500 || driver.networkIdle(id)) {stable = true;break;}
      await sleep(Math.min(pollMs, Math.max(0, settleMs - (Date.now() - start))));
    } while (Date.now() - start < settleMs);
    return {stable, waited_ms: Date.now() - start};
  };
  driver.read = async (id, args, generation) => {
    const all = await driver.allElements(id, generation), segments = [];
    for (const frame of all.info.frames) {
      if (args.frame_id && frame.id !== args.frame_id) continue;
      if (args.scope_ref) {
        const node = await driver.target(id, {ref: args.scope_ref}, generation);if (node.frameId !== frame.id) continue;
        const {objectId} = await driver.resolveInHelpers(id, frame, node.backend, generation);
        try {const result = await driver.sendFrame(id, frame.id, 'Runtime.callFunctionOn', {objectId, functionDeclaration: 'function(){return window.__ChatHandHelpers.read(this);}', returnByValue: true}, generation);if (result.exceptionDetails) throw fault('PAGE_HELPER_FAILED');segments.push(...(result.result?.value || []));} finally {await driver.sendFrame(id, frame.id, 'Runtime.releaseObject', {objectId}, generation).catch(() => {});}
      } else {try {const value = await driver.evaluateHelper(id, frame, 'window.__ChatHandHelpers.read()', generation);if (!Array.isArray(value)) throw fault('PAGE_HELPER_FAILED');segments.push(...value);} catch (error) {driver.assertCurrent(generation);if (frame.id === all.info.root.id || /CANCELLED|TIMEOUT/.test(error.code || '')) throw error;}}
    }
    // Split pathological paragraphs into bounded, lossless chunks before segment pagination.
    const bounded = segments.flatMap(segment => {const text = String(segment);return text.match(/[\s\S]{1,24000}/g) || [];});
    return {page_id: String(id), url: all.tab.url, title: all.tab.title || '', ...markdownPage(bounded, args.offset || 0, args.limit || 20), unsupported_frames: all.unsupported_frames, untrusted_content: true};
  };
  driver.find = async (id, args, generation) => {
    const all = await driver.allElements(id, generation);let scoped = all.elements;
    if (args.scope_ref) {
      const target = await driver.target(id, {ref: args.scope_ref}, generation), tree = await driver.sendFrame(id, target.frameId, 'Accessibility.getFullAXTree', {frameId: target.frameId}, generation), nodes = new Map((tree.nodes || []).map(node => [node.nodeId, node])), root = (tree.nodes || []).find(node => node.backendDOMNodeId === target.backend), ids = new Set();
      const visit = nodeId => {if (ids.has(nodeId)) return;ids.add(nodeId);if(privateAXNode(nodes.get(nodeId)))return;for (const child of nodes.get(nodeId)?.childIds || []) visit(child);};if (root) visit(root.nodeId);scoped = scoped.filter(element => element.frameId === target.frameId && ids.has(element.nodeId));
    }
    let found = scoped.filter(element => (!args.role || element.role === args.role) && (!args.text || (args.exact ? element.name === args.text : element.name.toLocaleLowerCase().includes(args.text.toLocaleLowerCase()))) && (!args.frame_id || element.frameId === args.frame_id));
    // Exercise Playwright's role/text locator in the isolated realm; results never dispatch input.
    const frames = all.info.frames.filter(frame => !args.frame_id || frame.id === args.frame_id);
    for (const frame of frames) {try {await driver.evaluateHelper(id, frame, 'window.__ChatHandHelpers.locate(' + JSON.stringify({role: args.role, name: args.text, text: args.text, exact: args.exact}) + ').length', generation);} catch (error) {driver.assertCurrent(generation);if (/CANCELLED|TIMEOUT/.test(error.code || '')) throw error;}}
    const offset = args.offset || 0, limit = args.limit || 100, page = found.slice(offset, offset + limit), lang = await driver.pageLang(id, all.info.root, generation);
    const elements = page.map(publicElement);
    // 1029（H2）：要看「在哪」时带上这一页每个元素的位置框（这个元素所在框架的视口里的 CSS 像素；每页最多 100），读不到的不带。
    if (args.boxes === true) for (const [index, element] of page.entries()) {const box = await driver.box(id, element, generation);if (box) elements[index].box = box;}
    return {page_id: String(id), url: all.tab.url, ...(lang ? {lang} : {}), elements, total_elements: found.length, next_offset: offset + limit < found.length ? offset + limit : null, unsupported_frames: all.unsupported_frames, untrusted_content: true};
  };
  driver.box = async (id, element, generation) => {
    try {
      const {model} = await driver.sendFrame(id, element.frameId, 'DOM.getBoxModel', {backendNodeId: element.backend}, generation);const quad = model?.border;
      if (!Array.isArray(quad) || quad.length < 8) return null;const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]], tenth = value => Math.round(value * 10) / 10;
      return {x: tenth(Math.min(...xs)), y: tenth(Math.min(...ys)), width: tenth(Math.max(...xs) - Math.min(...xs)), height: tenth(Math.max(...ys) - Math.min(...ys))};
    } catch (error) {driver.assertCurrent(generation);if (/CANCELLED|TIMEOUT/.test(error.code || '')) throw error;return null;}
  };
  // 1029：等的时候页面还在加载、正在跳转，读页面会一时报错（空白页、框架树还没出来、执行环境刚换掉）。
  // 这种错不算等失败，接着等到时间到；到时还没等到，把最后一次的错一起报回去。被撤销、超时、标签页没了，照旧马上停。
  const waitFatal = error => /CANCELLED|TIMEOUT|TAB_INVALID|REF_COLLISION|TASK_/.test(error?.code || '') || /No tab with id/i.test(error?.message || '');
  driver.waitFor = async (id, condition, generation, authorize, requestedAt = Date.now()) => {
    const timeout = condition.timeout_ms ?? 5000;if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000 || !['text', 'text_absent', 'url_change', 'element', 'network_idle'].includes(condition.kind)) throw fault('WAIT_CONDITION_INVALID');
    if (['text', 'text_absent'].includes(condition.kind) && (typeof condition.text !== 'string' || !condition.text)) throw fault('WAIT_CONDITION_INVALID');
    if (condition.kind === 'url_change' && typeof condition.url !== 'string') throw fault('WAIT_CONDITION_INVALID');
    if (condition.kind === 'element' && !condition.role && !condition.name) throw fault('WAIT_CONDITION_INVALID');
    const start = requestedAt;let lastError = null;
    // 网络空闲靠调试会话里的网络事件；还没接上就先接上，不然一开始就算「空闲」。
    if (condition.kind === 'network_idle') await driver.attach(id, generation);
    do {
      driver.assertCurrent(generation);if (authorize) await authorize();driver.assertCurrent(generation);
      let state = null;
      try {state = condition.kind === 'network_idle' ? {network_idle: driver.networkIdle(id)} : await driver.allElements(id, generation);}
      catch (error) {driver.assertCurrent(generation);if (waitFatal(error)) throw error;lastError = error?.code || 'PAGE_NOT_READY';}
      if (state && conditionMet(condition, {...state, url: state.tab?.url || '', elements: state.elements || [], text: state.text || ''})) return {matched: true, waited_ms: Date.now() - start, condition: condition.kind};
      await sleep(Math.min(pollMs, Math.max(0, timeout - (Date.now() - start))));
    } while (Date.now() - start < timeout);
    throw fault('WAIT_TIMEOUT', {condition: condition.kind, waited_ms: Date.now() - start, ...(lastError ? {last_error: lastError} : {})});
  };
  driver.prepare = async (id, action, args, generation) => {
    if (!args.ref) return null;
    const node = await driver.target(id, args, generation), info = await readFrameTree(driver, id, generation, node.url), frame = info.frames.find(candidate => candidate.id === node.frameId);
    const {objectId} = await driver.resolveInHelpers(id, frame, node.backend, generation);
    try {
      const result = await driver.sendFrame(id, frame.id, 'Runtime.callFunctionOn', {objectId, functionDeclaration: 'async function(action){return window.__ChatHandHelpers.check(this,action);}', arguments: [{value: action}], returnByValue: true, awaitPromise: true}, generation);
      if (result.exceptionDetails) throw fault('PAGE_HELPER_FAILED');const value = result.result?.value;if (!value?.ok) throw fault(value?.reason || 'ELEMENT_INVALID');
      // 用户任务的授权仍在每步执行前重验；语义标签不追加确认位。
    } finally {await driver.sendFrame(id, frame.id, 'Runtime.releaseObject', {objectId}, generation).catch(() => {});}
    try {await driver.sendFrame(id, frame.id, 'DOM.enable', {}, generation);await driver.sendFrame(id, frame.id, 'Overlay.enable', {}, generation);await driver.sendFrame(id, frame.id, 'Overlay.highlightNode', {backendNodeId: node.backend, highlightConfig: {showInfo: true, contentColor: {r: 45, g: 130, b: 245, a: 0.15}, borderColor: {r: 45, g: 130, b: 245, a: 0.8}}}, generation);} catch (error) {driver.assertCurrent(generation);if (/CANCELLED|TIMEOUT/.test(error.code || '')) throw error;}
    return node;
  };
  driver.performStep = async (id, action, args, generation, authorize, options = {}) => {
    if (authorize) await authorize();driver.assertCurrent(generation);
    if (action === 'upload') return performUpload(driver,id,args,generation,authorize,options);
    if (action === 'wait_for') return driver.waitFor(id, args.condition || args, generation, authorize, options.requestedAt);
    const node = await driver.prepare(id, action, args, generation);
    if(['click','double_click'].includes(action)&&node?.href)requireChatGPTAccess(node.href,options.chatgptSelfAllowed);
    if (authorize) await authorize();driver.assertCurrent(generation);
    if (action === 'scroll_to') {if (!node) throw fault('ELEMENT_INVALID');await driver.sendFrame(id, node.frameId, 'DOM.scrollIntoViewIfNeeded', {backendNodeId: node.backend}, generation);return {performed: action};}
    if (action === 'scroll') {
      const amount = Number(args.amount ?? 500);if (!Number.isFinite(amount) || Math.abs(amount) > 2000) throw fault('ARG_INVALID');
      let point;if (node) point = await clickPoint(driver, id, node, generation, {timeoutMs: driver.actionabilityTimeoutMs});
      else {const info = await readFrameTree(driver, id, generation, (await driver.page(id, generation)).url);point = await driver.evaluateHelper(id, info.root, '({x:innerWidth/2,y:innerHeight/2})', generation);}
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw fault('ELEMENT_GEOMETRY');
      await scrollPage(driver, id, amount, node, point, generation);return {performed: action};
    }
    if (action === 'click' && args.coordinate === true) {
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw fault('ARG_INVALID');
      const snapshot = driver.lastObservations.get(id);if (!snapshot || !Number.isFinite(snapshot.screenshot_at) || Date.now()-snapshot.screenshot_at>30000 || args.snapshot_id !== snapshot.snapshot_id) throw fault('SNAPSHOT_STALE');
      const info = await readFrameTree(driver, id, generation, snapshot.url);if(snapshot.document_id!==frameDocumentId(info.root)||snapshot.url!==(await driver.page(id,generation)).url)throw fault('SNAPSHOT_STALE');
      const hit = await driver.evaluateHelper(id, info.root, `(() => {const x=${JSON.stringify(args.x)},y=${JSON.stringify(args.y)};if(x<0||y<0||x>=innerWidth||y>=innerHeight)return false;const node=document.elementFromPoint(x,y);return node?.tagName==='CANVAS';})()`, generation);
      if (hit !== true) throw fault('CANVAS_TARGET_REQUIRED');
      if (authorize) await authorize();driver.assertCurrent(generation);
      for (const type of ['mousePressed', 'mouseReleased']) await driver.send(id, 'Input.dispatchMouseEvent', {type, x: args.x, y: args.y, button: 'left', clickCount: 1}, generation);return {performed: 'click', coordinate: true, click: {target: {role: 'canvas'}, point: {x: args.x, y: args.y}}};
    }
    const result = await original.execute(action, args);driver.assertCurrent(generation);
    // 1029：点击回执里写清想点的是哪个元素（角色、名字、编号、所在框架）。
    if (result?.click && node) result.click = {target: {ref: node.ref, role: node.role, name: node.name, frame_id: node.frameId}, ...result.click};
    return result;
  };
  // 1029：点完、填完以后看一眼页面变成什么样。这一步只是观察，动作已经做了：页面正在跳转、一时读不到时隔一会儿再读，
  // 还读不到就照实说没看到（observed:false），不把已经做了的动作说成失败。
  const observeFatal = error => /CANCELLED|TASK_/.test(error?.code || '');
  driver.afterAction = async (id, before, generation) => {
    let stabilization;
    try {stabilization = await driver.settle(id, generation);} catch (error) {driver.assertCurrent(generation);if (observeFatal(error)) throw error;stabilization = {stable: false, error: error?.code || 'SETTLE_FAILED'};}
    let snapshot = null, observeError = null;
    for (let attempt = 0; attempt < 3 && !snapshot; attempt++) {
      try {snapshot = await driver.snapshot(id, generation);}
      catch (error) {driver.assertCurrent(generation);if (observeFatal(error)) throw error;observeError = error?.code || 'SNAPSHOT_FAILED';if (attempt < 2) await sleep(300);}
    }
    if (!snapshot) return {snapshot: null, snapshot_id: null, stabilization, observed: false, observe_error: observeError, changes: {from_url: before?.url || null, url: null, url_changed: null}};
    return {snapshot, snapshot_id: snapshot.snapshot_id, stabilization, changes: driver.changes(before, snapshot)};
  };
  /** 前后两次观察比一比：地址、标题变没变，多了、少了哪些元素（用整页的列表比，多出来的写名字）。 */
  driver.changes = (before, snapshot) => {
    const previous = before?.all || before?.elements || [], current = snapshot.all || snapshot.elements, known = new Set(previous.map(element => element.ref)), now = new Set(current.map(element => element.ref));
    const added = before ? current.filter(element => !known.has(element.ref)) : [], removed = before ? previous.filter(element => !now.has(element.ref)) : [];
    return {from_url: before?.url || null, url: snapshot.url, url_changed: !!before && before.url !== snapshot.url, title_changed: !!before && before.title !== snapshot.title, added: added.slice(0, 12).map(element => ({role: element.role, name: String(element.name).slice(0, 80)})), added_count: added.length, removed_count: removed.length, added_refs: added.map(element => element.ref).slice(0, 30), removed_refs: removed.map(element => element.ref).slice(0, 30)};
  };
  driver.failure = async (id, error, generation) => {
    let snapshot = driver.lastObservations.get(id), snapshot_stale = true;
    if (driver.generation === generation) {try {snapshot = await driver.snapshot(id, generation);snapshot_stale = false;} catch {}}
    return {status: 'failed', error: browserError(error), snapshot: snapshot || null, snapshot_id: snapshot?.snapshot_id || null, snapshot_stale, replay_safe: false};
  };
  driver.execute = async (action, args = {}, options = {}) => {
    const generation = driver.generation;options={...options,requestedAt:Date.now()};
    if (action === 'detect_generating_chat') return {url: null, reason: 'PERSONAL_TAB_REQUIRES_EXPLICIT_REQUEST'};
    if (action === 'detach') return original.execute(action, args);
    if (action === 'tabs') {const result = await original.execute(action, args);for(const tab of result.tabs||[])requireChatGPTAccess(tab.url,options.chatgptSelfAllowed);result.tabs = result.tabs.map(tab => ({...tab, managed: driver.managedTabs.has(Number(tab.page_id))}));return result;}
    if (action === 'new') {requireChatGPTAccess(args.url,options.chatgptSelfAllowed);const result = await original.execute(action, args);await driver.group(Number(result.page_id), generation);return result;}
    const id = Number(args.page_id);await driver.allowedTab(id, args, generation);
    await driver.assertChatGPTAccess(id,options,generation);
    try {
      if (action === 'snapshot') return await driver.snapshot(id, generation, args);
      if (action === 'read') return await driver.read(id, args, generation);
      if (action === 'find') return await driver.find(id, args, generation);
      if (action === 'screenshot') {
        const snapshot = await driver.snapshot(id, generation);if (args.numbered) await driver.numberedOverlay(id, snapshot, generation);
        try {const image=await original.execute(action,args);Object.defineProperty(snapshot,'screenshot_at',{value:Date.now(),enumerable:false});return {...image, snapshot_id: snapshot.snapshot_id, elements: args.numbered ? snapshot.elements.map((element, index) => ({number: index + 1, ...element})) : [], numbered: args.numbered === true};}
        finally {if (args.numbered && generation === driver.generation) await driver.removeNumbered(id, generation).catch(() => {});}
      }
      if (action === 'batch') {
        if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 10 || new Set(args.steps.map(step => step.step_id)).size !== args.steps.length || args.steps.some(step => !/^[-_a-zA-Z0-9]{1,96}$/.test(step.step_id || '') || !['fill', 'click', 'select', 'press', 'wait_for', 'scroll_to'].includes(step.action))) throw fault('BATCH_INVALID');
        const receipts = [];let before = driver.lastObservations.get(id);
        for (const step of args.steps) {
          const key = args.operation_key + ':' + step.step_id;if (driver.stepReceipts.has(key)) return {...await driver.failure(id, fault('STEP_ALREADY_ATTEMPTED'), generation), steps: receipts, failed_step_id: step.step_id};
          driver.stepReceipts.set(key, {status: 'started'});if (driver.stepReceipts.size > 1000) driver.stepReceipts.delete(driver.stepReceipts.keys().next().value);
          try {const result = await driver.performStep(id, step.action === 'select' ? 'select_value' : step.action, {...step, page_id: String(id)}, generation, options.authorize,options);await driver.assertChatGPTAccess(id,options,generation);const after = await driver.afterAction(id, before, generation);before = after.snapshot || before;const receipt = {step_id: step.step_id, status: 'completed', result, snapshot_id: after.snapshot_id, ...(result?.click ? {click: result.click} : {}), changes: after.changes, ...(after.observed === false ? {observed: false} : {})};driver.stepReceipts.set(key, receipt);receipts.push(receipt);}
          catch (error) {if(error?.code==='HIGH_RISK_DISABLED')throw error;const failure = await driver.failure(id, error, generation), receipt = {step_id: step.step_id, status: 'failed_or_unknown', error: failure.error};driver.stepReceipts.set(key, receipt);receipts.push(receipt);return {...failure, steps: receipts, failed_step_id: step.step_id, completed_steps: receipts.filter(receipt => receipt.status === 'completed').length};}
        }
        return {page_id: String(id), status: 'completed', steps: receipts, completed_steps: receipts.length, snapshot: before, snapshot_id: before?.snapshot_id, replay_safe: false};
      }
      if (['select', 'close', 'navigate'].includes(action)) {if(action==='navigate')requireChatGPTAccess(args.url,options.chatgptSelfAllowed);const result=await original.execute(action, args);if(action!=='close')await driver.assertChatGPTAccess(id,options,generation);return result;}
      const before = driver.lastObservations.get(id);
      try {const result = await driver.performStep(id, action, args, generation, options.authorize,options);await driver.assertChatGPTAccess(id,options,generation);return {...result, status: 'completed', page_id: String(id), ...await driver.afterAction(id, before, generation), replay_safe: false};}
      catch (error) {if(error?.code==='HIGH_RISK_DISABLED')throw error;return {page_id: String(id), ...await driver.failure(id, error, generation)};}
    } finally {if (driver.attached.has(id)) driver.scheduleIdle(id);}
  };
  driver.numberedOverlay = async (id, snapshot, generation) => {
    const info = await readFrameTree(driver, id, generation, snapshot.url);
    for (let index = 0; index < snapshot.elements.length; index++) {
      const element = snapshot.elements[index], node = driver.locators.get(id + ':' + element.ref);if (!node) continue;
      const {objectId} = await resolveNodeInFrame(driver, id, node.frameId, node.backend, generation);
      try {await driver.sendFrame(id, node.frameId, 'Runtime.callFunctionOn', {objectId, functionDeclaration: 'function(number){const rect=this.getBoundingClientRect();if(!rect.width||!rect.height)return;let root=document.querySelector("[data-chathand-overlay]");if(!root){root=document.createElement("div");root.setAttribute("data-chathand-overlay","");root.style="position:fixed;inset:0;pointer-events:none;z-index:2147483647";document.documentElement.append(root);}const box=document.createElement("div");box.style="position:absolute;box-sizing:border-box;border:2px solid #1664d8;left:"+rect.left+"px;top:"+rect.top+"px;width:"+rect.width+"px;height:"+rect.height+"px";const label=document.createElement("span");label.textContent=number;label.style="background:#1664d8;color:white;font:bold 12px sans-serif;padding:2px";box.append(label);root.append(box);}', arguments: [{value: String(index + 1)}], returnByValue: true}, generation);} finally {await driver.sendFrame(id, node.frameId, 'Runtime.releaseObject', {objectId}, generation).catch(() => {});}
    }
    return info;
  };
  driver.removeNumbered = async (id, generation) => {const info = await readFrameTree(driver, id, generation, (await driver.page(id, generation)).url);for (const frame of info.frames) await driver.evaluateHelper(id, frame, 'document.querySelector("[data-chathand-overlay]")?.remove()', generation).catch(() => {});};
}
