/* 打赏气泡（Ken 10/31）：左下角皮肤按钮上面一个咖啡杯圆按钮，样子跟皮肤按钮一样；点开是打赏弹窗。
   收款方式（名字、链接、地址、二维码、图标）不放在源码里，打开弹窗时从官网仓库的 tip.json 读（Ken 10/31：这一块做成在线的，
   PayPal、支付宝的标识不跟着源码走）。这里只有弹窗的样子：读到的东西逐项核过，只当文字和图片用，不跑网上的代码。
   读不到（没网、地址变了、内容不对）就在原地说一句，给一个「重试」。
   可拆：去掉 index.html 里 tip-jar.js 那一行就没有了；也可以在它运行前设 window.CHATHAND_TIP_JAR=false，或网址加 &tipjar=0。
   弹窗用主窗口的 modal()，打开链接用 openURL()（走原生，用系统浏览器打开），复制走剪贴板、不行再走原生；不在主窗口里（没有这些）就不出按钮。 */
(() => {
  'use strict';
  if (window.CHATHAND_TIP_JAR === false || new URLSearchParams(location.search).get('tipjar') === '0') return;
  if (typeof modal !== 'function' || typeof openURL !== 'function' || !window.ChatHandText) return;
  const t = (key, params) => window.ChatHandText.t(key, params);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const locale = () => window.ChatHandText.locale || 'en';

  /* ---------- 收款方式：放在网上，打开弹窗时读一次，读到了这次运行就一直用它 ---------- */
  const SOURCE = 'https://kenyupersonal-maker.github.io/chathand-site/tip.json';
  let methods = null, loading = null, failed = false, current = '', untouched = null, scrollSync = null;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /* 读到的内容逐项核：不对就整份不用。文字只当文字（拼进页面前都转义），图标只收 data: 图片，链接只收 https。 */
  const plain = (v, max = 160) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
  const words = v => {
    if (typeof v === 'string') return plain(v);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    for (const [k, s] of Object.entries(v)) { if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(k) || !plain(s, 200)) return null; out[k] = s; }
    return Object.keys(out).length ? out : null;
  };
  const https = v => { try { const u = new URL(v); return typeof v === 'string' && v.length <= 300 && u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };
  const IMAGE = /^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/]+={0,2}$/;
  const NOTES = ['paypal', 'alipay', 'crypto'];
  function clean(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.methods) || !data.methods.length || data.methods.length > 12) return null;
    const seen = new Set(), list = [];
    for (const m of data.methods) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(m.id) || seen.has(m.id)) return null;
      seen.add(m.id);
      const name = words(m.name), qr = m.qr || {};
      if (!name || !Number.isInteger(qr.n) || qr.n < 21 || qr.n > 57 || typeof qr.hex !== 'string' || qr.hex.length !== Math.ceil(qr.n * qr.n / 4) || !/^[0-9a-f]+$/.test(qr.hex)) return null;
      if (typeof m.logo !== 'string' || m.logo.length > 65536 || !IMAGE.test(m.logo)) return null;
      const link = m.link == null ? null : https(m.link), address = m.address == null ? null : plain(m.address, 128);
      if ((m.link != null && !link) || (m.address != null && !address)) return null;
      const opt = (v, max) => v == null ? null : plain(v, max);
      const item = { id: m.id, name, qr: { n: qr.n, hex: qr.hex }, logo: m.logo, link, address,
        show: opt(m.show, 160), tag: opt(m.tag, 24), network: opt(m.network, 60), min: opt(m.min, 40),
        group: m.group === 'crypto' ? 'crypto' : null, note: NOTES.includes(m.note) ? m.note : m.note == null ? null : words(m.note),
        extra: m.extra === 'btcOnly' ? 'btcOnly' : null };
      if ((m.show != null && !item.show) || (m.tag != null && !item.tag) || (m.network != null && !item.network) || (m.min != null && !item.min) || (m.note != null && !item.note)) return null;
      list.push(item);
    }
    return list;
  }
  function load() {
    if (methods || loading) return;
    failed = false;
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 10000);
    loading = fetch(SOURCE, { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer', signal: stop.signal })
      .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(body => {
        if (body.length > 600000) throw new Error('too large');
        const list = clean(JSON.parse(body)); if (!list) throw new Error('bad data');
        methods = list; if (!list.some(m => m.id === current)) current = list[0].id;
      })
      .catch(() => { failed = true; })
      .finally(() => { clearTimeout(timer); loading = null; if (isOpen()) refresh(); untouched = null; });
  }

  const pickWords = v => { if (typeof v === 'string') return v; const l = locale(); return v[l] ?? v[l.split('-')[0]] ?? v.en ?? Object.values(v)[0]; };
  const nameOf = m => pickWords(m.name);
  /* PayPal 下面不再写说明（Ken 10/31）；网上的 tip.json 还带着 note:"paypal" 也只是不出字 */
  function noteOf(m) {
    const parts = m.note === 'paypal' ? [] : m.note === 'alipay' ? [t('ui.tip.alipayNote')]
      : m.note === 'crypto' ? [m.min && m.network ? t('ui.tip.cryptoNote', { min: m.min, network: m.network }) : ''] : [m.note ? pickWords(m.note) : ''];
    if (m.extra === 'btcOnly') parts.push(t('ui.tip.btcOnly'));
    return parts.filter(Boolean).join(/^zh/.test(locale()) ? '' : ' ');
  }

  /* ---------- 二维码：一格一个圆点，三个定位角画成同心圆，中间按大约 27% 的边长留白放 logo ---------- */
  function qrSvg(m) {
    const { n, hex } = m.qr, bits = [...hex].map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
    const hole = n >= 41 ? 11 : 9, lo = (n - hole) / 2, hi = lo + hole;
    const finder = (r, c) => (r < 7 || r >= n - 7) && (c < 7 || c >= n - 7) && !(r >= n - 7 && c >= n - 7);
    let dots = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (bits[r * n + c] !== '1' || finder(r, c) || (r >= lo && r < hi && c >= lo && c < hi)) continue;
      dots += `M${c + .07} ${r + .5}a.43 .43 0 1 1 .86 0a.43 .43 0 1 1-.86 0z`;
    }
    const eye = (x, y) => `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="3" fill="none" stroke="#000" stroke-width="1"/><circle cx="${x + 3.5}" cy="${y + 3.5}" r="1.5"/>`;
    return `<svg viewBox="0 0 ${n} ${n}" aria-hidden="true" focusable="false"><rect width="${n}" height="${n}" fill="#fff"/><g fill="#000">${eye(0, 0)}${eye(n - 7, 0)}${eye(0, n - 7)}<path d="${dots}"/></g></svg>`
      + `<img class="ch-tip-qrlogo" src="${esc(m.logo)}" alt="" style="--hole:${hole / n}">`;
  }

  /* ---------- 弹窗 ---------- */
  const CUP = '<svg class="ch-tip-cup" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.5 8.5h14v4.75a6.25 6.25 0 0 1-6.25 6.25h-1.5A6.25 6.25 0 0 1 3.5 13.25Z"/><path d="M17.5 10h1.25a2.75 2.75 0 0 1 0 5.5H17.5"/><path d="M3 21.5h15"/><path d="M8.5 1.75c-.9.9-.9 1.6 0 2.4s.9 1.6 0 2.4M12.5 1.75c-.9.9-.9 1.6 0 2.4s.9 1.6 0 2.4"/></svg>';
  const sprite = id => `<svg class="i sm" aria-hidden="true"><use href="#${id}"/></svg>`;
  function tab(m, i, list) {
    const on = m.id === current, first = m.group && !list.slice(0, i).some(x => x.group === m.group);
    return (first ? `<span class="ch-tip-group" aria-hidden="true">${esc(t('ui.tip.crypto'))}</span>` : '')
      + `<button type="button" role="tab" class="ch-tip-tab" id="ch-tip-t-${m.id}" data-tip-pick="${m.id}" aria-controls="ch-tip-p-${m.id}" aria-selected="${on}" tabindex="${on ? 0 : -1}">`
      + `<img class="ch-tip-logo" src="${esc(m.logo)}" alt=""><span class="ch-tip-tn">${esc(nameOf(m))}</span>${m.tag ? `<small>${esc(m.tag)}</small>` : ''}</button>`;
  }
  function page(m) {
    const on = m.id === current, value = m.link || m.address, note = noteOf(m);
    const field = value ? `<div class="ch-tip-field"><span class="ch-tip-label">${esc(t(m.link ? 'ui.tip.link' : 'ui.tip.address'))}</span><code>${esc(m.show || value)}</code>`
      + `<button type="button" class="btn sm ch-tip-copy" data-tip-copy="${esc(value)}">${sprite('i-copy')}<span>${esc(t('ui.tip.copy'))}</span></button></div>` : '';
    return `<div class="ch-tip-page" role="tabpanel" id="ch-tip-p-${m.id}" aria-labelledby="ch-tip-t-${m.id}"${m.group ? ` data-group="${m.group}"` : ''}${on ? '' : ' data-off inert'}>`
      + `<div class="ch-tip-qr" role="img" aria-label="${esc(t('ui.tip.qrAlt', { name: nameOf(m) }))}">${qrSvg(m)}</div>`
      + `<div class="ch-tip-name"><b>${esc(nameOf(m))}</b>${m.network ? `<span>${esc(m.network)}</span>` : ''}</div>`
      + (m.link ? `<button type="button" class="btn primary ch-tip-go" data-tip-open="${esc(m.link)}">${esc(t('ui.tip.paypalGo'))}${sprite('i-arrow-ur')}</button>` : '')
      + field + (note ? `<p class="ch-tip-note">${esc(note)}</p>` : '') + '</div>';
  }
  function body() {
    if (methods) return `<div class="ch-tip-scroll" data-k="tip-ready"><div class="ch-tip-run"><div class="ch-tip"><div class="ch-tip-tabs" data-motion-target="tip-selection" role="tablist" aria-orientation="vertical" aria-label="${esc(t('ui.tip.methods'))}"><span class="ch-tip-highlight" aria-hidden="true"></span>${methods.map(tab).join('')}</div>`
      + `<div class="ch-tip-pages" data-motion-target="tip-card">${methods.map(page).join('')}</div></div></div></div>`;
    if (failed) return `<div class="ch-tip-state" data-k="tip-failed" data-state="failed"><p>${esc(t('ui.tip.failed'))}</p>`
      + `<button type="button" class="btn sm" data-tip-retry>${esc(t('ui.tip.retry'))}</button></div>`;
    return `<div class="ch-tip-state" data-k="tip-loading" data-state="loading" role="status"><span class="spinner" aria-hidden="true"></span><p>${esc(t('ui.tip.loading'))}</p></div>`;
  }
  const html = () => `<div class="ask-icon">${CUP}</div><h2 id="ch-tip-title">${esc(t('ui.tip.title'))}</h2><p class="ch-tip-lede">${esc(t('ui.tip.body'))}</p>`
    + `<div class="ch-tip-body">${body()}</div>`;
  const dialog = () => document.getElementById('modal');
  const isOpen = () => dialog()?.open && dialog().dataset.kind === 'tip';
  /* 弹窗开着时换内容（读到了、没读到、换语言）：就地对齐，不重开弹窗，关掉以后焦点照旧回到咖啡杯按钮 */
  function refresh() {
    const d = dialog(), box = d?.querySelector('.ch-tip-body'); if (!box) return;
    stopScroll();
    // 刚打开、还在读的时候焦点在弹窗默认的位置（没被动过）也算：读到以后焦点落到选中的方式上，跟收款方式写在本地时打开就落在那儿一样
    const a = document.activeElement, inside = box.contains(a) || a === d || a === document.body || (untouched && a === untouched);
    window.ChatHandMorph.align(document.getElementById('modalContent'), html());
    d.setAttribute('aria-labelledby', 'ch-tip-title');
    if (methods) { pick(current, inside && !d.querySelector('.ch-tip-tabs')?.contains(document.activeElement)); mountScroll(); }
    else if (failed && inside) d.querySelector('[data-tip-retry]')?.focus();
  }
  function pick(id, focus) {
    const d = dialog(); if (!d || !methods?.some(m => m.id === id)) return;
    const oldPanel = document.activeElement?.closest('.ch-tip-page');
    if (oldPanel && oldPanel.id !== 'ch-tip-p-' + id) focus = true;
    current = id;
    for (const b of d.querySelectorAll('[data-tip-pick]')) {
      const on = b.dataset.tipPick === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      if (on && focus) {
        b.focus({ preventScroll: true });
        if (!d.querySelector('.ch-tip-scroll[data-scroll]')) b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
    }
    const at = methods.findIndex(m => m.id === id);
    d.querySelectorAll('.ch-tip-page').forEach((p, i) => { const on = i === at; p.toggleAttribute('data-off', !on); p.toggleAttribute('data-before', i < at); p.inert = !on; });
    moveHighlight();
  }
  function moveHighlight() {
    const nav = dialog()?.querySelector('.ch-tip-tabs'), b = nav?.querySelector('[aria-selected="true"]');
    if (!b) return;
    nav.style.setProperty('--ch-tip-x', b.offsetLeft + 'px');
    nav.style.setProperty('--ch-tip-y', b.offsetTop + 'px');
    nav.style.setProperty('--ch-tip-w', b.offsetWidth + 'px');
    nav.style.setProperty('--ch-tip-h', b.offsetHeight + 'px');
    nav.dataset.ready = '';
    const horizontal = getComputedStyle(nav).flexDirection === 'row';
    nav.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
    if (horizontal) nav.scrollTo({ left: Math.max(0, b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }
  function stopScroll() {
    scrollSync?.destroy(); scrollSync = null;
  }
  /* 跟官网一样按原生 scrollTop 换方式：没有 wheel 拦截、手势计时器或动画队列。
     整张卡放不下时保留普通弹窗滚动，点击和方向键仍可逐项查看。 */
  function mountScroll() {
    stopScroll();
    const d = dialog(), root = d?.querySelector('.ch-tip-scroll'), stage = root?.querySelector('.ch-tip');
    if (!root || !stage) return;
    let step = 0, frame = 0, previousLayout = '';
    const onScroll = () => {
      if (!step || !isOpen() || !root.isConnected) return;
      const at = Math.max(0, Math.min(methods.length - 1, Math.round(root.scrollTop / step)));
      if (methods[at].id !== current) pick(methods[at].id);
    };
    const layout = () => {
      frame = 0;
      if (!isOpen() || !root.isConnected) { stopScroll(); return; }
      // offset 尺寸不受主弹窗 0.96 → 1 的入场缩放影响。
      const style = getComputedStyle(d), height = stage.offsetHeight;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const maxHeight = parseFloat(style.maxHeight) + (style.boxSizing === 'border-box' ? 0 : (parseFloat(style.paddingTop) || 0) + paddingBottom);
      let before = 0;
      for (let node = root; node && node !== d; node = node.offsetParent) before += node.offsetTop;
      const fits = methods.length > 1 && height + before + paddingBottom <= maxHeight + 1;
      const nextStep = fits ? Math.round(Math.min(320, Math.max(200, innerHeight * .3))) : 0;
      const signature = [height, nextStep].join(':');
      if (signature !== previousLayout) {
        previousLayout = signature; step = nextStep;
        root.toggleAttribute('data-scroll', fits);
        root.style.setProperty('--ch-tip-height', height + 'px');
        root.style.setProperty('--ch-tip-travel', (methods.length - 1) * step + 'px');
        root.scrollTo({ top: Math.max(0, methods.findIndex(m => m.id === current)) * step, behavior: 'auto' });
      }
      moveHighlight();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(layout); };
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', schedule);
    scrollSync = {
      go(id, focus) {
        const at = methods.findIndex(m => m.id === id); if (at < 0) return;
        if (!step || focus || reducedMotion.matches) pick(id, focus);
        if (step) root.scrollTo({ top: at * step, behavior: focus || reducedMotion.matches ? 'auto' : 'smooth' });
      },
      destroy() { observer.disconnect(); cancelAnimationFrame(frame); root.removeEventListener('scroll', onScroll); window.removeEventListener('resize', schedule); }
    };
    layout();
  }
  function choose(id, focus = false) {
    if (scrollSync) scrollSync.go(id, focus); else pick(id, focus);
  }
  function show() {
    failed = false;
    modal(html(), 'tip');
    const d = dialog(); d.setAttribute('aria-labelledby', 'ch-tip-title');
    if (methods) { pick(current, true); mountScroll(); }
    else { untouched = document.activeElement; load(); }
  }

  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); }
    catch { const r = typeof native === 'function' ? await native('copyText', { text }).catch(() => null) : null; if (!r || r.error) { button.title = t('ui.window.copyText.text'); return; } }
    if (typeof copyPulse === 'function') copyPulse(button);
  }

  /* 弹窗里的点击和方向键（弹窗是主窗口共用的那一个，只管 data-kind="tip" 的时候） */
  const d0 = dialog();
  if (!d0) return;
  d0.addEventListener('click', event => {
    if (!isOpen()) return;
    const b = event.target.closest('button'); if (!b) return;
    if (b.dataset.tipPick) choose(b.dataset.tipPick);
    else if (b.dataset.tipOpen) { const url = https(b.dataset.tipOpen); if (url) openURL(url); }
    else if (b.dataset.tipCopy) copy(b.dataset.tipCopy, b);
    else if (b.hasAttribute('data-tip-retry')) { failed = false; refresh(); load(); }
  });
  d0.addEventListener('keydown', event => {
    if (!isOpen() || !methods || !event.target.closest?.('[data-tip-pick]')) return;
    const at = methods.findIndex(m => m.id === current), step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? methods.length - 1 : step ? (at + step + methods.length) % methods.length : -1;
    if (to < 0) return;
    event.preventDefault(); choose(methods[to].id, true);
  });
  d0.addEventListener('close', stopScroll);

  /* ---------- 左下角的圆按钮：在皮肤按钮正上方；没有皮肤按钮时自己待在左下角 ---------- */
  const host = document.createElement('div');
  host.id = 'ch-tip-tools';
  host.innerHTML = `<button type="button" class="ch-tip-trigger" aria-haspopup="dialog">${CUP}</button>`;
  const trigger = host.firstElementChild;
  const label = () => { const text = t('ui.tip.open'); trigger.setAttribute('aria-label', text); trigger.title = text; };
  label();
  const skin = document.getElementById('ch-skin-tools');
  if (skin?.hasAttribute('data-slot')) { host.dataset.slot = ''; skin.before(host); }
  else { if (!skin) host.dataset.alone = ''; document.body.append(host); }
  trigger.addEventListener('click', show);
  /* 换语言：按钮的读屏名字跟着换；弹窗开着就按新语言重画 */
  window.ChatHandText.subscribe(() => { label(); if (isOpen()) refresh(); });
})();
