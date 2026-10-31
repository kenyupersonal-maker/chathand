// Fixed, isolated-world helpers. No caller-provided JavaScript or selector is evaluated.
import {source, PLAYWRIGHT_VERSION} from './vendor/playwright-injected.js';

// Fixed screenshot-only masking. Values never leave the page; controls keep their values and geometry.
export function screenshotInputMask(action, token) {
  const key = '__ChatHandScreenshotMasks', states = globalThis[key] || (globalThis[key] = new Map());
  const roots = () => {const all = [];const visit = root => {all.push(root);for (const node of root.querySelectorAll('*')) if (node.shadowRoot) visit(node.shadowRoot);};visit(document);return all;};
  const sensitive = node => node instanceof Element && (node.matches('input,textarea,select,[contenteditable]')) && (node.matches('[type="password"],[autocomplete*="password" i],[autocomplete="one-time-code" i],[data-chathand-sensitive="true"]') || /password|密码|one.time.code|otp|验证码|passphrase|private key|私钥|助记词|seed phrase|api.key/i.test(['aria-label','placeholder','name','title'].map(name => node.getAttribute(name) || '').join(' ')));
  const box = node => {const r = node.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(n => Math.round(n * 10) / 10);};
  const equal = (a,b) => a.every((n,i) => n === b[i]);
  if (action === 'remove') {states.get(token)?.restore();return true;}
  if (action === 'check') {
    const entry = states.get(token);if (!entry || entry.changed || Date.now() - entry.at > 45000) return false;
    for (const root of roots()) for (const node of root.querySelectorAll('input,textarea,select,[contenteditable]')) if (sensitive(node) && node.getClientRects().length && !entry.masks.has(node)) return false;
    for (const [node, item] of entry.masks) {const style = getComputedStyle(item.mask);if (!node.isConnected || !item.mask.isConnected || !item.mask.matches(':popover-open') || !equal(box(node),item.box) || !equal(box(item.mask),item.box) || style.opacity !== '1' || style.visibility !== 'visible' || style.backgroundColor !== 'rgb(0, 0, 0)') return false;}
    return true;
  }
  if (action !== 'apply' || typeof token !== 'string') throw Error('SCREENSHOT_REDACTION_UNAVAILABLE');
  if (states.has(token)) return false;
  const masks = new Map(), observers = [], entry = {masks, changed: false, at: Date.now(), timer: null, restore: () => {clearTimeout(entry.timer);for (const observer of observers) observer.disconnect();for (const {mask} of masks.values()) {try {mask.hidePopover();} catch {}mask.remove();}states.delete(token);}};
  try {
    for (const root of roots()) for (const node of root.querySelectorAll('input,textarea,select,[contenteditable]')) if (sensitive(node) && node.getClientRects().length) {const r = box(node),mask = document.createElement('div');mask.setAttribute('popover','manual');mask.setAttribute('aria-hidden','true');mask.setAttribute('data-chathand-input-mask',token);for (const [name,value] of Object.entries({position:'fixed',left:r[0]+'px',top:r[1]+'px',width:r[2]+'px',height:r[3]+'px',background:'#000',opacity:'1',visibility:'visible',display:'block','z-index':'2147483647','pointer-events':'none',margin:'0',padding:'0',border:'0',transform:'none',animation:'none',transition:'none'})) mask.style.setProperty(name,value,'important');document.documentElement.append(mask);if (typeof mask.showPopover !== 'function') throw Error('SCREENSHOT_REDACTION_UNAVAILABLE');mask.showPopover();masks.set(node,{mask,box:r});}
    for (const root of roots()) {const observer = new MutationObserver(records => {for (const record of records) {if (record.target?.closest?.('[data-chathand-input-mask]')) continue;if (record.type === 'attributes' && (sensitive(record.target) || masks.has(record.target) || record.target.matches?.('style,link[rel="stylesheet"]'))) entry.changed = true;else if (record.type === 'childList') {if ([...masks.keys()].some(node => record.target === node || node.contains(record.target) || record.target.contains?.(node)) || [...record.addedNodes,...record.removedNodes].some(node => node instanceof Element && (sensitive(node) || node.querySelector?.('input,textarea,select,[contenteditable],style,link[rel="stylesheet"]')))) entry.changed = true;}}});observer.observe(root, {subtree: true, childList: true, attributes: true});observers.push(observer);}
    states.set(token, entry);entry.timer = setTimeout(entry.restore, 60000);return true;
  } catch {entry.restore();return false;}
}

export function privateAXNode(node) {
  const role=String(node?.role?.value || ''),name=String(node?.name?.value || '');
  if (/password|密码|one.time.code|otp|验证码|passphrase|private key|私钥|助记词|seed phrase|api.key/i.test(name) || /^(?:securetextfield|passwordfield)$/i.test(role)) return true;
  const richtext=(node?.properties || []).some(property => property.name === 'editable' && property.value?.value === 'richtext');
  return /^(?:textbox|searchbox|combobox|spinbutton)$/i.test(role) && !richtext;
}

export function pageHelpers(window) {
  const document = window.document, pw = window.__ChatHandPW;
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const sensitive = node => node?.type === 'password' || node?.getAttribute?.('data-chathand-sensitive') === 'true' || /(?:current-|new-)?password|one-time-code/i.test(node?.getAttribute?.('autocomplete') || '') || /password|密码|otp|验证码|passphrase|private key|私钥|助记词|seed phrase|api.key/i.test(['aria-label','placeholder','name','title'].map(key => node?.getAttribute?.(key) || '').join(' '));
  const safeURL = value => {
    try {const url = new URL(value, document.baseURI);return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;} catch {return null;}
  };
  const inline = node => {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName) || sensitive(node)) return '';
    const text = Array.from(node.childNodes || []).map(inline).join('');
    if (node.tagName === 'A') {const href = safeURL(node.getAttribute('href'));return href ? `[${clean(text).replace(/\]/g, '\\]')}](${href.replace(/\)/g, '%29')})` : text;}
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${text}**`;
    if (node.tagName === 'EM' || node.tagName === 'I') return `*${text}*`;
    if (node.tagName === 'CODE') return '`' + text.replace(/`/g, '\\`') + '`';
    return text;
  };
  function read(root = document.querySelector('article,main,[role=main]') || document.body) {
    const segments = [];
    function walk(node) {
      if (node.nodeType === 3) {const text = clean(node.textContent);if (text) segments.push(text);return;}
      if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|NAV|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName) || sensitive(node) || node.hidden || node.getAttribute('aria-hidden') === 'true') return;
      if (/^H[1-6]$/.test(node.tagName)) {segments.push('#'.repeat(Number(node.tagName[1])) + ' ' + clean(inline(node)));return;}
      if (node.tagName === 'TABLE') {
        const rows = Array.from(node.querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll('th,td')).map(cell => clean(inline(cell)).replace(/\|/g, '\\|'))).filter(row => row.length);
        if (!rows.length) return;
        const width = Math.max(...rows.map(row => row.length)), row = cells => '| ' + Array.from({length: width}, (_, i) => cells[i] || '').join(' | ') + ' |';
        segments.push([row(rows[0]), row(Array(width).fill('---')), ...rows.slice(1).map(row)].join('\n'));return;
      }
      if (node.tagName === 'PRE') {segments.push('```\n' + Array.from(node.childNodes || []).map(inline).join('').replace(/```/g, '` ` `') + '\n```');return;}
      if (node.tagName === 'UL' || node.tagName === 'OL') {segments.push(Array.from(node.children).filter(child => child.tagName === 'LI').map((child, index) => (node.tagName === 'OL' ? `${index + 1}. ` : '- ') + clean(inline(child))).join('\n'));return;}
      if (/^(P|BLOCKQUOTE|FIGCAPTION)$/.test(node.tagName)) {const text = clean(inline(node));if (text) segments.push(node.tagName === 'BLOCKQUOTE' ? '> ' + text : text);return;}
      for (const child of node.childNodes || []) walk(child);
    }
    walk(root);return segments.filter(Boolean);
  }
  function locate(query, root = document) {
    if (query.role) {
      if (!/^[a-z][a-zA-Z0-9]*$/.test(query.role)) throw Error('ROLE_INVALID');
      const selector = 'internal:role=' + query.role + (query.name !== undefined ? '[name=' + JSON.stringify(query.name) + (query.exact === false ? 'i' : 's') + ']' : '');
      return pw.querySelectorAll(pw.parseSelector(selector), root);
    }
    const selector = 'internal:text=' + JSON.stringify(query.text || '') + (query.exact ? 's' : 'i');
    return pw.querySelectorAll(pw.parseSelector(selector), root);
  }
  function aria(root = document.body) {
    // The JSON tree cannot map generic editable text back to its DOM owner. Omit this ARIA view.
    const hasEditable = node => node?.isContentEditable || Array.from(node?.querySelectorAll?.('*') || []).some(child => child.isContentEditable || (child.shadowRoot && hasEditable(child.shadowRoot)));
    if (hasEditable(root)) return null;
    const snapshot = pw.ariaSnapshotJSON(root, {mode: 'default'}).json;
    // Playwright can include current input values as child text. Never export those.
    const visit = (nodes, depth = 0) => (Array.isArray(nodes) ? nodes : [nodes]).flatMap(node => {
      if (typeof node === 'string') return ['  '.repeat(depth) + '- text: ' + JSON.stringify(clean(node).slice(0, 1200))];
      if (!node || typeof node !== 'object') return [];
      const role = String(node.role || 'generic'), name = clean(node.name).slice(0, 400);
      const line = '  '.repeat(depth) + '- ' + role + (name ? ' ' + JSON.stringify(name) : '');
      return [line, ...(/textbox|searchbox|combobox/.test(role) ? [] : visit(node.children || [], depth + 1))];
    });
    return visit(snapshot).join('\n').slice(0, 18000);
  }
  async function check(node, action) {
    if (action === 'fill' && node?.type === 'file') return {reason: 'FILE_INPUT_REQUIRED'};
    const states = ['visible', 'enabled'];if (action === 'fill') states.push('editable');
    const result = await pw.checkElementStates(node, states);
    if (result) return {reason: result === 'error:notconnected' ? 'ELEMENT_CHANGED' : 'ELEMENT_' + String(result.missingState).toUpperCase()};
    return {ok: true, form: !!node.closest?.('form'), submit: node.matches?.('button[type=submit],input[type=submit],button:not([type])') && !!node.closest?.('form')};
  }
  let lastMutation = performance.now();
  const observer = new MutationObserver(records => {if (records.some(record => !record.target?.closest?.('[data-chathand-overlay]'))) lastMutation = performance.now();});
  observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  return {read, locate, aria, check, quiet: () => performance.now() - lastMutation, safeURL};
}

export const HELPER_VERSION = PLAYWRIGHT_VERSION;
export const INSTALL_HELPERS = `(() => {
 if (!window.__ChatHandPW) {
  const module = {exports:{}};
  ${source}
  // 1029：抽出来的 Playwright 源码里 __export 把导出写成了取值函数（() => InjectedScript），不是类本身，
  // 直接 new 会报「不是构造函数」，helper 一直装不上（10/7 真 Chrome 复测：点击全是 PAGE_HELPER_FAILED）。是取值函数就先取一次。
  // 1.63 的构造参数还要 customEngines（数组）和 frameSeq，不给也会在构造时报错。
  const exported = module.exports.InjectedScript;
  const Injected = typeof exported === 'function' && exported.prototype === undefined ? exported() : exported;
  window.__ChatHandPW = new Injected(window, {isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:2,browserName:'chromium',isUtilityWorld:true,shouldPrependErrorPrefix:false,customEngines:[],frameSeq:0});
 }
 if (!window.__ChatHandHelpers) window.__ChatHandHelpers = (${pageHelpers.toString()})(window);
 return true;
})()`;
