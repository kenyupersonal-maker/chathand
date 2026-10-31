/* 可拆的皮肤面板：左下角一个圆按钮，点开是皮肤面板，两列大缩略图，点一张就换成那个皮肤。
   皮肤来自 skin.js（经典）和 skins/registry.js（其余）；加皮肤只要放一个 CSS、在 registry.js 里加一行，这里不用改。
   面板自己的颜色跟着当前皮肤走；产品样式只通过皮肤 API 处理。 */
(() => {
  'use strict';
  const skinTextEscape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const api = window.ChatHandSkin;
  if (!api || window.CHATHAND_SKIN_SWITCHER === false || new URLSearchParams(location.search).get('skinswitch') === '0') return;
  const root = document.documentElement;
  const scheme = () => root.dataset.scheme === 'dark' ? 'dark' : 'light';

  /* ---------- 面板骨架 ---------- */
  const host = document.createElement('div');
  host.id = 'ch-skin-tools'; host.dataset.skinSwitcher = '';
  const slot = document.querySelector('[data-skin-slot]');
  if (slot) host.dataset.slot = '';
  host.innerHTML = `<button type="button" class="ch-skin-trigger" data-skin-action="toggle" aria-label="${skinTextEscape(window.ChatHandText.t("ui.skin.panelTitle"))}" aria-expanded="false" aria-controls="ch-skin-panel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 3.6 4.2 5.8 2.6 10.2l3.1 1.4 1.1-2.1v10.7h10.4V9.5l1.1 2.1 3.1-1.4-1.6-4.4-4.4-2.2c-.5 1.5-1.9 2.4-3.4 2.4s-2.9-.9-3.4-2.4Z"/></svg></button>`
    + `<section id="ch-skin-panel" class="ch-skin-panel" role="dialog" aria-label="${skinTextEscape(window.ChatHandText.t("ui.skin.panelTitle"))}" hidden><div class="ch-skin-top"><header><strong>${skinTextEscape(window.ChatHandText.t("ui.skin.panelTitle"))}</strong><button type="button" class="ch-skin-close" data-skin-action="close" aria-label="${skinTextEscape(window.ChatHandText.t("ui.skin.closePanel"))}">×</button></header></div>`
    + `<div class="ch-skin-body" data-skin-scroll><h3 class="ch-skin-group" id="ch-skin-free">${skinTextEscape(window.ChatHandText.t("ui.skin.free"))}</h3><div class="ch-skin-list" data-skin-list role="group" aria-labelledby="ch-skin-free"></div></div></section>`;
  (slot || document.body).append(host);
  const panel = host.querySelector('#ch-skin-panel'), trigger = host.querySelector('[data-skin-action="toggle"]');
  const list = host.querySelector('[data-skin-list]'), scroller = host.querySelector('[data-skin-scroll]');
  const mk = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  /* 列表滚到标题下面时，标题下面加一条淡边线 */
  function edges() {
    if (panel.hidden) return;
    const top = scroller.scrollTop > 1;
    if (top !== panel.hasAttribute('data-over-top')) panel.toggleAttribute('data-over-top', top);
  }
  scroller.addEventListener('scroll', edges, { passive: true });
  host.querySelector('.ch-skin-top').addEventListener('wheel', event => {
    if (event.ctrlKey || scroller.scrollHeight <= scroller.clientHeight) return;
    scroller.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : 1); event.preventDefault();
  }, { passive: false });
  window.addEventListener('resize', edges);
  if (typeof ResizeObserver === 'function') { const watch = new ResizeObserver(edges); watch.observe(scroller); watch.observe(list); }

  /* 选中的皮肤：刚点的那个（样式还在载入时也算）；载入失败、或者不在清单里，就是现在用着的那个 */
  function selectedId() {
    const status = api.status();
    return !status.error && api.list().some(entry => entry.id === status.requested) ? status.requested : status.current;
  }

  /* ---------- 缩略图：一张「封面」，不画真实页面 ----------
     这个皮肤的窗口底色和网点，右上角那团光（跟主窗口一样取 --hue-a 到 --hue-b 那一段颜色），左下角铺一层它自己的底色调，
     名字用这个皮肤的字色写在封面上（见 coverName）。按当前模式画。 */
  const THUMB = ['--win','--dot','--ink','--fill-ink','--fill-mix','--theme-h','--aura-a','--aura-l','--aura-c','--aura-alpha','--hue-a','--hue-b'];
  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.6 8.4 7 10.7l4.5-5"/></svg>';
  const blank = () => ({ both: {}, light: {}, dark: {} });
  let rootTokens = null;
  const skinTokens = new Map();
  function readRootTokens() { // 经典皮肤的变量：style.css 里的 :root 和 :root[data-theme="dark"]
    const light = {}, dark = {};
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules || []) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const into = rule.selectorText === ':root' ? light : rule.selectorText === ':root[data-theme="dark"]' ? dark : null; if (!into) continue;
        for (const name of rule.style) if (name.startsWith('--')) into[name] = rule.style.getPropertyValue(name).trim();
      }
    }
    return { light, dark: { ...light, ...dark } };
  }
  function parseSkinCss(text, id) { // 只看 html[data-skin="id"][data-scheme…]{…} 里的变量
    const out = blank(), src = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0, start = 0, open = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '{') { if (!depth) open = i; depth++; }
      else if (src[i] === '}' && depth && !--depth) {
        const head = src.slice(start, open).trim(), body = src.slice(open + 1, i); start = i + 1;
        if (head.startsWith('@')) continue;
        for (const part of head.split(',')) {
          const m = part.trim().match(/^html\[data-skin="([a-z0-9-]+)"\]\[data-scheme(?:="(light|dark)")?\]$/); if (!m || m[1] !== id) continue;
          for (const decl of body.split(';')) { const at = decl.indexOf(':'), name = decl.slice(0, at).trim(); if (at > 0 && name.startsWith('--')) out[m[2] || 'both'][name] = decl.slice(at + 1).trim(); }
        }
      }
    }
    return out;
  }
  function tokensOf(entry) { // 皮肤 CSS 里的变量；还没读到时返回 null，读到后重画列表
    if (!entry || entry.id === 'default' || !entry.css) return blank();
    const got = skinTokens.get(entry.id); if (got) return got === 'wait' ? null : got;
    skinTokens.set(entry.id, 'wait');
    fetch(entry.css).then(r => r.ok ? r.text() : '')
      .then(text => parseSkinCss(text, entry.id), () => blank())
      .then(tokens => { skinTokens.set(entry.id, tokens); if (!panel.hidden) renderList(); });
    return null;
  }
  const prefetch = () => { for (const entry of api.list()) tokensOf(entry); };
  function thumbFor(entry) {
    const el = mk('span', 'ch-thumb'), mode = scheme(), skin = tokensOf(entry);
    if (!skin) { el.dataset.loading = ''; return el; }
    rootTokens ||= readRootTokens();
    const map = { ...rootTokens[mode], ...skin.both, ...skin[mode] };
    const need = new Set(THUMB), todo = [...THUMB];
    while (todo.length) for (const m of String(map[todo.pop()] || '').matchAll(/var\(\s*(--[\w-]+)/g)) if (!need.has(m[1])) { need.add(m[1]); todo.push(m[1]); }
    for (const token of need) if (map[token]) el.style.setProperty(token, map[token]);
    return el;
  }

  /* 封面上的名字：中文一行，下面英文一行（大写粗体），界面是中文还是英文都一样。
     两种语言的名字都从文案表里取；没有文案键、或者两种写法一样的，只写一行 */
  function coverName(entry) {
    const catalogs = globalThis.__CHATHAND_TEXT_CATALOGS__ || {}, key = entry.nameTextKey;
    const zh = (key && catalogs.zh?.[key]) || entry.name, en = (key && catalogs.en?.[key]) || '';
    const box = mk('span', 'ch-skin-name'); box.setAttribute('aria-hidden', 'true');
    if (!en || en.toLowerCase() === String(zh).toLowerCase()) box.append(mk('span', 'ch-skin-name-solo', zh));
    else box.append(mk('span', 'ch-skin-name-zh', zh), mk('span', 'ch-skin-name-en', en));
    return box;
  }

  /* ---------- 皮肤列表：两列，一个皮肤一张封面，名字写在封面上（上下居中、靠左）。整张都能点；选中的细绿框、右下角一个绿色角标对勾 ---------- */
  function card(entry, on) {
    const box = mk('div', 'ch-skin-card'); box.dataset.skinCard = entry.id; if (on) box.dataset.on = '';
    const pick = mk('button', 'ch-skin-pick'), frame = mk('span', 'ch-skin-frame'), thumb = thumbFor(entry);
    pick.type = 'button'; pick.dataset.skinAction = 'select'; pick.dataset.skinId = entry.id; pick.setAttribute('aria-pressed', String(on)); pick.setAttribute('aria-label', entry.name);
    thumb.append(coverName(entry));
    frame.append(thumb);
    if (on) { const check = mk('span', 'ch-skin-check'); check.setAttribute('aria-hidden', 'true'); check.innerHTML = CHECK; frame.append(check); }
    pick.append(frame);
    box.append(pick);
    return box;
  }
  const focusPick = id => list.querySelector(`[data-skin-card="${id}"] [data-skin-action="select"]`)?.focus();
  function renderList() {
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('[data-skin-card]')?.dataset.skinCard : null, on = selectedId();
    list.replaceChildren(...api.list().map(entry => card(entry, entry.id === on)));
    if (focused) focusPick(focused);
    edges();
  }
  /* 点卡片：马上标上选中，样式载进来（或者没载成）以后再画一次 */
  function choose(id) {
    const redraw = () => { if (!panel.hidden) renderList(); };
    api.set(id).then(redraw, redraw);
    renderList(); focusPick(id);
  }

  /* ---------- 开关面板 ---------- */
  function close() {
    if (panel.hidden) return;
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (!host.classList.contains('ch-pointer') || host.contains(document.activeElement)) trigger.focus({ preventScroll: true });
  }
  function open() {
    prefetch(); renderList(); panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); edges();
    focusPick(selectedId());
  }

  /* ---------- 事件 ---------- */
  host.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || !host.contains(button)) return;
    const action = button.dataset.skinAction;
    if (action === 'toggle') panel.hidden ? open() : close();
    else if (action === 'close') close();
    else if (action === 'select') choose(button.dataset.skinId);
  });
  document.addEventListener('pointerdown', event => { if (!panel.hidden && !host.contains(event.target)) close(); });
  host.addEventListener('keydown', event => {
    if (panel.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') { // Tab 只在面板里转
      const targets = [...panel.querySelectorAll('button')], first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  /* 用鼠标点的时候不显示焦点圈（WebKit 里点按钮不拿焦点，之后代码把焦点挪过去会被当成键盘焦点，出一圈怪描边）；一按 Tab 之类的键就显示 */
  host.addEventListener('pointerdown', () => host.classList.add('ch-pointer'), true);
  window.addEventListener('keydown', event => { if (!['Shift','Control','Alt','Meta'].includes(event.key)) host.classList.remove('ch-pointer'); }, true);
  trigger.addEventListener('pointerenter', prefetch, { once: true });
  trigger.addEventListener('focus', prefetch, { once: true });
  /* 换皮肤、换浅色深色都会发 chathand:skin：面板开着就重画（缩略图按当前模式画） */
  window.addEventListener('chathand:skin', () => { if (!panel.hidden) renderList(); });
  /* 换语言：标题、分组名、读屏名字和皮肤名字跟着换 */
  window.ChatHandText.subscribe(() => {
    const title = window.ChatHandText.t("ui.skin.panelTitle");
    host.querySelector('.ch-skin-top header strong').textContent = title;
    host.querySelector('.ch-skin-group').textContent = window.ChatHandText.t("ui.skin.free");
    trigger.setAttribute('aria-label', title); panel.setAttribute('aria-label', title);
    host.querySelector('[data-skin-action="close"]').setAttribute('aria-label', window.ChatHandText.t("ui.skin.closePanel"));
    if (!panel.hidden) renderList();
  });
})();
