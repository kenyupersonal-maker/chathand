/* ChatHand 皮肤核心。同源样式；主服务首屏、后端设置和网址预览各有明确优先级。 */
(() => {
  'use strict';
  if (window.ChatHandSkin) return;
  const root = document.documentElement, catalog = new Map();
  const media = matchMedia('(prefers-color-scheme: dark)');
  let selected = 'default', request = 0, initial = true, currentLink = null;
  const saved = root.dataset.skinSaved || 'default';
  const params = new URLSearchParams(location.search);
  const preview = params.has('skin') ? params.get('skin') || 'default' : null;
  let wanted = preview ?? saved, edit = 0, pending = null, saveTail = Promise.resolve(), windowOnly = false;
  let save = null, onError = null, serverSkin = saved, serverRevision = -1, lastError = null;
  const announce = () => window.dispatchEvent(new CustomEvent('chathand:skin', {detail:{id:selected, scheme:root.dataset.scheme}}));
  const problem = message => { lastError = message; onError?.(message); };
  function scheme() {
    const forced = root.dataset.theme;
    const next = forced === 'light' || forced === 'dark' ? forced : media.matches ? 'dark' : 'light';
    if (root.dataset.scheme !== next) { root.dataset.scheme = next; announce(); }
  }
  function activate(id, link) {
    const changed = selected !== id || root.dataset.skin !== id;
    selected = id; if (root.dataset.skin !== id) root.dataset.skin = id;
    currentLink = link || null;
    document.querySelectorAll('link[data-chathand-skin]').forEach(item => { if (item !== link) item.remove(); });
    if (changed) announce();
  }
  function load(id, beforePaint = false) {
    const entry = catalog.get(id) || catalog.get('default'), serial = ++request;
    if (entry.id === selected && (entry.id === 'default' || currentLink?.sheet)) {
      return Promise.resolve(selected);
    }
    if (entry.id === 'default') { activate('default'); return Promise.resolve('default'); }
    return new Promise(resolve => {
      const finish = (link, ok) => {
        if (serial !== request) { link?.remove(); resolve(selected); return; }
        activate(ok ? entry.id : 'default', ok ? link : null);
        if (!ok) problem(window.ChatHandText.t("ui.skin.loadFailed"));
        resolve(selected);
      };
      if (beforePaint) {
        const matches = event => event.target?.dataset?.chathandRequest === String(serial);
        const done = event => {
          if (!matches(event)) return;
          document.removeEventListener('load', done, true); document.removeEventListener('error', done, true);
          finish(event.target, event.type === 'load');
        };
        document.addEventListener('load', done, true); document.addEventListener('error', done, true);
        selected = entry.id; root.dataset.skin = entry.id;
        document.write('<link rel="stylesheet" data-chathand-skin="' + entry.id + '" data-chathand-request="' + serial + '" href="' + entry.css + '">');
      } else {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = entry.css; link.dataset.chathandSkin = entry.id;
        link.onload = () => finish(link, true); link.onerror = () => finish(link, false);
        document.head.append(link);
      }
    });
  }
  function accept(id, revision) {
    const next = Number.isSafeInteger(revision) && revision >= 0 ? revision : Math.max(serverRevision, 0);
    if (next < serverRevision) return false;
    serverRevision = next; serverSkin = catalog.has(id) ? id : 'default'; return true;
  }
  function adoptSettings(settings) {
    if (!settings || typeof settings.skin !== 'string') return;
    if (!accept(settings.skin, settings.skin_revision) || preview !== null || pending !== null || windowOnly) return;
    if (wanted === serverSkin) return;
    wanted = serverSkin; void load(wanted);
  }
  async function set(id) {
    // URL previews never save or yield to server choices, including later user clicks.
    if (preview !== null) return load(preview);
    const entry = catalog.get(id) || catalog.get('default'), serial = ++edit;
    pending = serial; wanted = entry.id; lastError = null; windowOnly = false;
    const actual = await load(entry.id);
    if (serial !== edit) return selected;
    const writer = save || (typeof window.api === 'function' ? id => window.api('/api/settings', {skin:id}) : null);
    if (actual !== entry.id || !writer) { pending = null; windowOnly = actual === entry.id; return selected; }
    // Only skin writes are serialised. State adoption never enters this save path.
    const operation = saveTail.then(async () => {
      if (serial !== edit) return selected;
      try {
        const response = await writer(entry.id);
        accept(response?.skin ?? entry.id, response?.skin_revision);
        if (serial === edit) pending = null;
      } catch {
        if (serial === edit) {
          pending = null; windowOnly = true;
        }
      }
      return selected;
    });
    saveTail = operation; return operation;
  }
  function register(entry) {
    if (!entry || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(entry.id) || typeof entry.name !== 'string') return false;
    if (entry.id !== 'default' && entry.css !== '/skins/' + entry.id + '.css') return false;
    if (catalog.has(entry.id)) return false;
    const swatch = Array.isArray(entry.swatch) ? entry.swatch.filter(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0,4) : [];
    // backdrop：这个皮肤默认用的右上角背景（ChatHandBackdrops 的 id，如 'liquid'）；不写就是「柔光」
    const backdrop = typeof entry.backdrop === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(entry.backdrop) ? entry.backdrop : '';
    catalog.set(entry.id, Object.freeze({id:entry.id,name:entry.name,...(typeof entry.nameTextKey==='string'?{nameTextKey:entry.nameTextKey}:{}),scheme:entry.scheme || 'both',css:entry.css || '',swatch:Object.freeze(swatch),...(backdrop ? {backdrop} : {})}));
    if (entry.id === wanted && entry.id !== 'default') void load(entry.id, initial && document.readyState === 'loading');
    return true;
  }
  window.ChatHandSkin = Object.freeze({
    list:() => [...catalog.values()].map(entry => ({...entry,name:entry.nameTextKey?window.ChatHandText.t(entry.nameTextKey):entry.name,swatch:[...entry.swatch]})), current:() => selected, set, register, adoptSettings,
    connect:options => { save = typeof options?.save === 'function' ? options.save : null; onError = typeof options?.onError === 'function' ? options.onError : null; if (lastError) onError?.(lastError); },
    status:() => ({current:selected,requested:wanted,saving:pending !== null,confirmed:serverRevision < 0 ? null : serverSkin,revision:serverRevision,error:lastError})
  });
  register({id:'default',nameTextKey:"ui.skin.classic",name:window.ChatHandText.t("ui.skin.classic"),scheme:'both',css:'',swatch:['#FFFFFF','#171A18','#03D4AA','#FF7B00']});
  root.dataset.skin = 'default'; scheme();
  new MutationObserver(scheme).observe(root, {attributes:true,attributeFilter:['data-theme']});
  if (media.addEventListener) media.addEventListener('change', scheme); else media.addListener(scheme);
  document.addEventListener('DOMContentLoaded', () => { initial = false; announce(); }, {once:true});
  document.write('<script src="/skins/registry.js"><\/script>');
})();
