'use strict';
/* 假的本机服务（浏览器里跑）：把 fetch('/api/...')、原生桥 webkit.messageHandlers.native、/api/events 事件流全部换成假的。
   状态用 URL 参数定，例如 ?conn=offline&task=wait&tier=light&update=downloading&wizard=4
     conn    online | connecting | offline | unset | stopped
     task    none | run | wait | multi     （wait：有一条管理员命令等你批准；multi：三个任务同时在跑）
     tier    full | light | custom
     chrome  ok | none | down              perm  ok | partial | none        admin  off | on | stale
     update  none | checking | available | waiting_tasks | waiting_download | downloading | verifying | installing | failed | failed_rb | updated
     paused  1                             appearance  light | dark | system   auto_update  0 | 1
     wizard  0..6  向导停在第几步（0 开始）   test ok | read | wait   第 4 步测试结果
     block   none | admin | autostart | risk | scope     已拦下卡片
     chatgpt app | web | copy | fail       点首页例句时 openChatGPT 的返回
     sse     on | off                      off：事件流连不上（走 30 秒兜底查询）
     now     固定「现在」的毫秒数（截图用，保证每次一样）
     value   0 | small | low | mid | big | x3 | pro | noplan | old | off   工作量数字样本
     valueLong 1                           工作量文字按原宽度 1.6 倍替换为假英文
     sitenet clear | challenged | unreachable   1083：建 Site 前查网络的结果（/api/setup/site/network-check），默认 clear
   页面上 window.__demo 就是这套参数；改完调用 __push() 会像真服务一样把变化用 patch 推给界面。
   window.__calls 记录所有 POST 和原生调用，测试里用来断言。 */
(function () {
  const F = window.__F, Q = new URLSearchParams(location.search), NOW0 = Q.get('now') ? +Q.get('now') : 0;
  const realNow=Date.now.bind(Date);if(NOW0)Date.now=()=>NOW0;
  const now = () => NOW0 || realNow();
  let setupTestCount=0;
  const D = window.__demo = {
    conn: Q.get('conn') || 'online', task: Q.get('task') || 'run', tier: Q.get('tier') || 'full', chrome: Q.get('chrome') || 'ok', perm: Q.get('perm') || 'ok', admin: Q.get('admin') || 'off',
    update: Q.get('update') || 'none', paused: Q.get('paused') === '1', appearance: Q.get('appearance') || 'system', auto_update: Q.get('auto_update') !== '0',
    wizard: Q.get('wizard'), test: Q.get('test') || 'wait', block: Q.get('block') || 'none', chatgpt: Q.get('chatgpt') || 'app', sse: Q.get('sse') || 'on',
    device_name: 'Ken 的 MacBook Pro', seen: [], keyWatch: Q.get('key')==='wait'?'watching':['got','connected'].includes(Q.get('key'))?'received':'idle', keyDelay: 2500, repair:Q.get('repair')||'idle', host:Q.get('host')||'registered',
    key:Q.get('key')||'off',keyAuto:Q.get('keyauto')==='1',keyAge:Number(Q.get('keyage')||0),noApp:Q.get('noApp')==='1',skill:Q.get('skill')==='1',folder:Q.get('folder')==='done',openStatus:Q.get('openstatus'),store:Q.get('store')==='1',
    skin:document.documentElement.dataset.skinSaved||'default',value:Q.get('value'),valueLong:Q.get('valueLong')==='1',valuePlan:'auto',valueReset:false,
    siteNet:['clear','challenged','unreachable'].includes(Q.get('sitenet'))?Q.get('sitenet'):'clear',
  };
  const progressKey='ui2-progress:'+location.search;let persisted=null;try{persisted=JSON.parse(sessionStorage.getItem(progressKey));}catch{}if(persisted)D.wizard=String(persisted.step);
  let keyRequestCount=D.keyWatch==='watching'?1:0;let keyRequest=D.keyWatch==='watching'?{id:'req1',tunnel_id:F.TUNNEL,expires_at:now()+600e3-D.keyAge*1000}:null;
  window.__calls = [];
  const log = (kind, name, data) => window.__calls.push({ kind, name, data, at: Date.now() });

  /* ---------- 九条高危命令（和 app/v1/high-risk.mjs 一致：group、level） ---------- */
  const RISK = [
    ['admin', '以管理员身份运行', 'sudo', '极高', '获得这台电脑的最高权限，可以修改或删除系统和所有文件。', '一条错误的命令可能清空整块硬盘或导致电脑无法开机；开启期间，电脑上的其他程序也可能借此获得最高权限。', '开启时需输入一次电脑密码（或使用 Touch ID）。开启后 ChatGPT 使用 sudo 时不再询问你；关闭即撤销。', 'common'],
    ['erase', '清空或格式化磁盘', 'diskutil erase… · dd · mkfs', '极高', '把硬盘、U 盘或分区「抹掉重来」。', '里面的文件立刻消失，基本找不回来；选错盘，就清空了不该清的。', '', 'danger'],
    ['bulk_delete', '一次性删除整个大文件夹', 'rm -rf · find -delete · rsync --delete', '高', '用一条命令删除整个文件夹及其中的全部内容。', '文件不会移到废纸篓，删除后无法恢复；多年积累的文件和照片可能一次全部丢失。', '', 'danger'],
    ['keychain', '读取钥匙串里的密码', 'security …', '高', '直接读取 Mac 中保存的账号密码。', '密码会出现在对话中，可能外泄，导致账号被盗。', '', 'danger'],
    ['pipe_run', '下载后不经检查直接运行', 'curl … | sh', '高', '从网上下载程序，不检查内容就立即运行。', '如果程序被篡改，它会以你的身份直接运行，可能窃取文件或安装后门。', '', 'danger'],
    ['gatekeeper', '绕过系统的安全检查', 'xattr -d com.apple.quarantine · spctl · csrutil', '高', '让 macOS 不再检查「从网上下载的程序」。', '恶意程序也可以直接运行，系统不会再发出提醒。', '', 'danger'],
    ['bulk_perm', '批量修改整个大文件夹的权限', 'chmod -R · chown -R', '中', '一次性更改文件夹内所有文件「谁能查看、谁能修改」。', '文件可能被任何人查看，或连你自己也无法打开；App 也可能无法正常工作。', '', 'danger'],
    ['autostart', '开机自启或定时运行', 'launchctl load · crontab · at', '中', '让程序在开机、登录时或按固定间隔自动运行。', '程序可能在你不知情时持续运行，难以发现和关闭；恶意软件常借此长期驻留。', '', 'common'],
    ['power', '关机、重启、睡眠或断网', 'shutdown · reboot · pmset sleepnow · networksetup', '中', '让这台 Mac 关机、重启、睡眠，或关闭网络。', '未保存的内容可能丢失；连接中断后 ChatGPT 将无法继续操作，需要你回到电脑前才能恢复。', '', 'danger'],
  ].map(([id, name, cmd, level, what, harm, enable_note, group]) => ({ id, name, cmd, level, what, harm, ...(enable_note ? { enable_note } : {}), group }));

  /* ---------- 假的服务端数据：和 app/v1/permissions.mjs 同一套算法 ---------- */
  const data = { mode: 'full', terminal_enabled: true, browser_enabled: true, desktop_enabled: true, high_risk: {}, admin_requested: true, project: { path: '/Users/trial/ChatHand 工作区', name: 'ChatHand 工作区' }, workspace_confirmed: false };
  function applyTier(tier, folder) {
    if (tier === 'full') Object.assign(data, { mode: 'full', terminal_enabled: true, browser_enabled: true, desktop_enabled: true, admin_requested: true, high_risk: { autostart: true, admin: D.admin !== 'off' } });
    else if (tier === 'light') { Object.assign(data, { mode: 'auto', terminal_enabled: true, browser_enabled: true, desktop_enabled: false, admin_requested: false, high_risk: {}, project: { path: folder || '/Users/trial/ChatHand 工作区', name: (folder || '/Users/trial/ChatHand 工作区').split('/').pop() }, workspace_confirmed: false }); D.admin = 'off'; }
    else { Object.assign(data, { mode: 'full', terminal_enabled: true, browser_enabled: true, desktop_enabled: true, admin_requested: true, high_risk: { autostart: true, bulk_delete: true } }); }
    D.tier = tier;
  }
  applyTier(D.tier);
  data.workspace_confirmed=D.folder;
  if (D.tier === 'full' && ['on','stale'].includes(D.admin)) data.high_risk.admin = true;
  const sw = () => ({ ...Object.fromEntries(RISK.map(r => [r.id, false])), ...data.high_risk });
  const capOn = id => data[id + '_enabled'] !== false;
  function tier() {
    const s = sw();
    if (RISK.some(r => r.group === 'danger' && s[r.id])) return 'custom';
    if (!capOn('terminal') || !capOn('browser')) return 'custom';
    const admin = s.admin || data.admin_requested;
    if (data.mode === 'full' && capOn('desktop') && s.autostart && admin) return 'full';
    if (data.mode !== 'full' && !capOn('desktop') && !s.autostart && !admin) return 'light';
    return 'custom';
  }
  function permsOf() {
    const s = sw(), full = data.mode === 'full', adminReady = D.admin === 'on';
    const where = id => ({ terminal: '命令', browser: '浏览器控制', desktop: '桌面控制' }[id]);
    return {
      tier: tier(), file_scope: full ? 'computer' : 'folder', file_scope_where: 'ChatHand 首页右边「权限与能力」→ 文件范围 → 选「整台电脑」',
      capabilities: Object.fromEntries(['terminal', 'browser', 'desktop'].map(id => [id, { name: where(id), enabled: capOn(id), where_to_enable: `ChatHand 首页右边「权限与能力」→ ${where(id)} → 打开开关` }])),
      high_risk: RISK.map(r => ({ id: r.id, name: r.name, group: r.group, enabled: s[r.id], usable_now: s[r.id] && full && (r.id !== 'admin' || adminReady), ...(r.id === 'admin' && s.admin && D.admin === 'stale' ? { needs_setup: true } : {}), where_to_enable: `ChatHand 首页右边「权限与能力」→ 命令 → ${r.group === 'common' ? '常用能力' : '高危命令'} → 打开「${r.name}」` })),
      high_risk_note: full ? '已开启的高危命令现在可用，未开启的将被拦截。' : '文件范围是一个文件夹，高危命令都用不了（要改成「整台电脑」）。',
      never: ['代为输入电脑密码', '关闭或改动 ChatHand 本身', '切换成别的账户（su、doas）'],
    };
  }
  function openItems() {
    const t = tier(), s = sw(), ids = t === 'full' ? ['admin', 'desktop', 'browser'] : t === 'light' ? ['folder', 'browser'] : [...(data.mode !== 'full' ? ['folder'] : []), ...(s.admin || data.admin_requested ? ['admin'] : []), ...(capOn('desktop') ? ['desktop'] : []), ...(capOn('browser') ? ['browser'] : [])];
    const p = { accessibility: D.perm !== 'none', screen_recording: ['ok','restart'].includes(D.perm), needs_restart: D.perm === 'restart' };
    return ids.map(id => {
      let done = false, status = 'todo', detail;
      if (id === 'admin') { done = s.admin && D.admin === 'on'; detail = { enabled: s.admin, requested: data.admin_requested, ready: D.admin === 'on', requires_computer_password: true }; if (D.admin === 'waiting') status = 'waiting'; }
      else if (id === 'desktop') { done = p.accessibility && p.screen_recording; detail = { accessibility: p.accessibility, screen_recording: p.screen_recording, supported: true, needs_restart: !!p.needs_restart }; if (p.needs_restart) status = 'needs_restart'; }
      else if (id === 'browser') { done = D.chrome === 'ok'; detail = { connected: done, installed: D.chrome !== 'none', last_seen: D.chrome === 'down' ? now() - 3600e3 : null }; }
      else { done = data.workspace_confirmed; detail = { folder: data.project.path, confirmed: done }; }
      if (done && status !== 'needs_restart') status = 'done';
      if(D.openStatus&&id===D.openStatus.split(':')[0])status=D.openStatus.split(':')[1];
      if(D.store&&id==='browser')detail.store_url='https://chromewebstore.google.com/';
      return { id, status, detail };
    });
  }

  /* ---------- 更新各状态（和 app/v1/update.mjs 的 snapshot 同形） ---------- */
  function updateOf() {
    const u = D.update, base = { status: 'unknown', url: 'https://github.com/kenyupersonal-maker/chathand/releases', checked_at: now() - 120e3, install: { state: 'idle' }, just_updated: null, availability: 'up_to_date', auto_update: D.auto_update, dismissed_version: null };
    const avail = { availability: 'available', version: '1.0.1', build: 1013, notes: '修好了断网后不能自动重连的问题，设置页更好找。', tool_schema_changed: true };
    const dl = { progress: D.dlProgress ?? .42, downloaded_bytes: Math.round((D.dlProgress ?? .42) * 86e6), total_bytes: 86e6 };
    switch (u) {
      case 'unknown': return base;
      case 'none': case 'up_to_date': return { ...base, status: 'up_to_date' };
      case 'checking': return { ...base, status: 'checking', availability: 'unknown' };
      case 'available': return { ...base, ...avail, status: 'available' };
      case 'waiting_tasks': return { ...base, ...avail, status: 'waiting_tasks', install: { state: 'waiting_tasks' } };
      case 'waiting_download': return { ...base, ...avail, status: 'waiting_download', install: { state: 'waiting_download', url: base.url } };
      case 'downloading': return { ...base, ...avail, ...dl, status: 'downloading', install: { state: 'downloading', ...dl } };
      case 'verifying': return { ...base, ...avail, status: 'verifying', install: { state: 'verifying' } };
      case 'installing': return { ...base, ...avail, status: 'installing', install: { state: 'installing' } };
      case 'failed': return { ...base, ...avail, status: 'failed', install: { state: 'failed', message: '安装包核对没通过。', rolled_back: false } };
      case 'failed_rb': return { ...base, ...avail, status: 'failed', install: { state: 'failed', message: '安装没成功，已换回原来的版本。', rolled_back: true } };
      case 'updated': return { ...base, status: 'updated', refresh_tools: true, message: '去 ChatGPT 的插件页，点 ChatHand 的「刷新工具」。', just_updated: { from: '1.0.0', to: '1.0.1', tool_schema_changed: true } };
    }
    return { ...base, status: 'up_to_date' };
  }

  /* ---------- 检查并修复（12 项，和 app/v1/repair.mjs 的 id 一致） ---------- */
  let repair = null;
  const REPAIR_ITEMS = [['paused', 'AI 暂停状态'], ['credentials', '连接设置'], ['tunnel', '连接程序'], ['proxy_match', '系统代理'], ['proxy_alive', '代理软件'], ['cloud', 'ChatGPT 连接'], ['chatgpt_tools', 'ChatGPT 中的工具'], ['browser_host', 'Chrome 助手登记'], ['browser_helper', 'Chrome 助手'], ['desktop_permissions', '桌面控制授权'], ['login_item', '开机启动'], ['upgrade_leftover', '上次升级']];
  function startRepair() {
    repair = { id: 'r' + Date.now(), status: 'running', started_at: Date.now(), finished_at: null, items: REPAIR_ITEMS.map(([id, title]) => ({ id, title, status: 'pending', message: '' })), summary: null };
    let i = 0; repair.items[0].status = 'running'; push();
    const step = () => {
      const it = repair.items[i]; if (!it || !repair) return;
      if (it.id === 'proxy_match' && D.conn === 'offline') { it.status = 'fixed'; it.message = '通道用的是直连，已按现在的系统代理重连'; }
      else if (it.id === 'cloud' && D.conn === 'offline') { it.status = 'failed'; it.message = '代理可用，但无法访问 OpenAI，请尝试更换节点'; }
      else if (it.id === 'browser_helper' && D.chrome !== 'ok') { it.status = 'action'; it.message = D.chrome === 'none' ? 'Chrome 助手还没装' : 'Chrome 助手没连上'; it.action = { kind: D.chrome === 'none' ? 'install_helper' : 'reconnect_browser', label: D.chrome === 'none' ? '安装' : '重新连接' }; }
      else if (it.id === 'desktop_permissions' && D.perm !== 'ok' && capOn('desktop')) { it.status = 'action'; it.message = '缺少屏幕录制授权'; it.action = { kind: 'grant_permission', label: '前往授权' }; }
      else if (it.id === 'browser_host' && !capOn('browser')) { it.status = 'skipped'; it.message = '已关闭，不检查'; }
      else it.status = 'ok';
      i++; if (repair.items[i]) repair.items[i].status = 'running';
      if (!repair.items[i]) {
        const c = k => repair.items.filter(x => x.status === k).length;
        repair.status = 'done'; repair.finished_at = Date.now();
        repair.summary = { text: c('action') || c('failed') ? `${c('action') ? '还有 ' + c('action') + ' 项要你点一下' : ''}${c('action') && c('failed') ? '，' : ''}${c('failed') ? '还有 ' + c('failed') + ' 项没修好，可以点「复制给 AI」' : ''}` : c('fixed') ? `修好了 ${c('fixed')} 项` : '都正常。', fixed: c('fixed'), action_needed: c('action'), failed: c('failed') };
        if (D.conn === 'offline' && c('fixed') && !c('failed')) D.conn = 'online';
        push(); return;
      }
      push(); setTimeout(step, D.repairMs ?? 380);
    };
    setTimeout(step, D.repairMs ?? 380);
  }

  /* ---------- 整份 state ---------- */
  function state() {
    const sc = D.task === 'none' ? 'idle' : 'run';
    const st = F.build(sc, now(), { mode: data.mode, enabled: !D.paused, wizard: D.wizard !== null ? D.wizard : undefined, test: D.test, settings: { appearance: D.appearance, auto_update: D.auto_update, ui_seen_placeholder: undefined } });
    st.mode = data.mode; st.project = { ...data.project };
    st.settings.appearance = D.appearance; st.settings.auto_update = D.auto_update; st.settings.terminal_enabled = capOn('terminal'); st.settings.browser_enabled = capOn('browser'); st.settings.desktop_enabled = capOn('desktop'); st.settings.high_risk = sw();
    st.settings.skin=D.skin;st.settings.permission_model = 2; st.settings.browser_mode_version = 2;
    st.permissions = permsOf(); st.high_risk = { items: RISK.map(r => ({ ...r, enabled: sw()[r.id] })) }; st.high_risk_catalog = RISK.map(r => ({ ...r }));
    st.setup = { key_watch: D.keyWatch === 'received' ? { active: false, received: true, last4: 'a7Qz' } : { active: D.keyWatch === 'watching', received: false, last4: null }, open_items: openItems() };
    st.ui = { seen: [...D.seen] };
    st.setup_skill = { installed: false, managed: false };
    st.setup_skill={installed:D.skill,managed:D.skill};
    st.credentials={tunnel:D.keyWatch==='received',relay:false};
    if(D.testNonce)st.setup_test.nonce=D.testNonce;
    if(persisted){st.settings.setup_step=persisted.step;st.settings.setup_tunnel_id=persisted.tunnel_id;st.settings.setup_complete=false;}
    const runIds = new Set((st.tasks || []).map(t => t.task_id));
    if (sc === 'run' && D.task === 'wait') {
      const t = st.tasks[0]; for (const x of st.tasks) x.title = '装上这台 Mac 的系统更新';
      for (const g of (st.activity && st.activity.items) || []) for (const x of g.tasks || []) if (runIds.has(x.task_id)) x.title = '装上这台 Mac 的系统更新';
      st.approvals = [{ id: 'job_admin_1', task_id: t.task_id, kind: 'admin', status: 'pending_approval', command: 'sudo softwareupdate --install --all', title: t.title, created_at: now() - 40e3 }];
    }
    if (sc === 'run' && D.task === 'multi') {   // 三个任务同时在跑：一个大面板 + 两张小卡片
      const t0 = now(), chat = (id, title) => ({ id, title, conversation_url: 'https://chatgpt.com/c/' + id, link_source: 'auto_match' });
      const extra = [
        { task_id: '4c7d2e9a1b3f4a5c8d6e0f2a3b4c5d61', title: '把下载文件夹按类型整理', status: 'active', created_at: t0 - 6 * 60e3 - 20e3, finished_at: null, jobs: [] },
        { task_id: '7e1a3c5b9d2f4e6a8c0b1d3f5a7c9e82', title: '核对周报里的数字和图表', status: 'active', created_at: t0 - 2 * 60e3 - 40e3, finished_at: null, jobs: [] },
      ];
      st.tasks = [...(st.tasks || []), ...extra.map(x => ({ ...x, mode: 'auto' }))];
      st.activity.items.push({ ...chat('68ee7f10-e3a8-8311-9c2d-downloads', '电脑整理'), tasks: [extra[0]] }, { ...chat('68f09d03-2c6e-8316-b5a9-weekly', '周报'), tasks: [extra[1]] });
    }
    const tk = (st.tasks || [])[0];
    const blk = k => ({ block_id: 'b_' + k, task_id: tk && tk.task_id, times: 1, created_at: now() - 40e3, updated_at: now() - 20e3, dismissed: false });
    st.blocks = ({
      admin: [{ ...blk('admin'), kind: 'high_risk', id: 'admin', name: '以管理员身份运行', command: 'sudo softwareupdate --install --all', reason: '' }],
      autostart: [{ ...blk('auto'), kind: 'high_risk', id: 'autostart', name: '开机自启或定时运行', command: 'launchctl load ~/Library/LaunchAgents/ai.plist', reason: '' }],
      risk: [{ ...blk('risk'), kind: 'high_risk', id: 'bulk_delete', name: '一次性删除整个大文件夹', command: 'rm -rf ~/Documents/old-projects/*', times: 2 }],
      scope: [{ ...blk('scope'), kind: 'scope', id: 'open', name: '整台电脑', command: 'open ~/Downloads/UnityHubSetup.pkg', reason: '打开应用、安装包或文件（open）只在「整台电脑」下可用。' }],
    })[D.block] || [];
    const c = st.connection; c.device_name = D.device_name; c.control_plane = { state: 'up', status: 'ok', last_success_at: now() - 8e3, consecutive_failures: 0, proxy: 'http://127.0.0.1:7890' };
    if (D.conn === 'connecting') { c.ready = false; c.healthy = false; c.process_running = true; c.automatic = { phase: 'connecting' }; delete c.control_plane; }
    if (D.conn === 'offline') c.control_plane = { state: 'down', last_success_at: now() - 200e3, consecutive_failures: 12, proxy: 'direct' };
    if (D.conn === 'stopped') { c.ready = false; c.healthy = false; c.process_running = false; c.automatic = { phase: 'idle' }; delete c.control_plane; }
    if (D.conn === 'unset') { st.settings.tunnel = null; st.settings.connection_preference = 'none'; c.ready = false; c.healthy = false; c.process_running = false; c.automatic = { phase: 'idle' }; delete c.control_plane; st.last_calls = {}; st.connection_check = null; }
    const ext = st.automation.browser.extension; ext.connected = D.chrome === 'ok'; ext.connection_state = D.chrome === 'ok' ? 'connected' : D.chrome === 'down' ? 'disconnected' : 'not_installed'; ext.host_registration = { status: D.host, ...(D.host==='failed'?{message:'这次没能登记 Chrome 助手。'}:{}) };if(D.perm==='unsupported')st.capabilities.desktop_control=false;
    if(D.store){ext.store_url='https://chromewebstore.google.com/';ext.distribution='chrome_web_store';ext.configuration_state='ready';}
    if (D.chrome === 'down') ext.last_seen = now() - 3600e3; else delete ext.last_seen;
    if (data.mode !== 'full') { const n = '文件范围是『' + data.project.name + '』：不要改动这个文件夹以外的文件；要下载、保存，存进这个文件夹。'; ext.details = { scope_note: n }; st.automation.computer.details = { scope_note: n }; }
    st.automation.browser.personal.connected = false;
    const pm = st.automation.computer.permissions; pm.accessibility = D.perm !== 'none'; pm.screen_recording = ['ok','restart'].includes(D.perm); pm.needs_restart = D.perm === 'restart';
    for (const j of st.jobs || []) { if (j.job_id === 'job_fetch') j.last_line = '行情数据已更新'; if (j.job_id === 'job_backtest') j.last_line = '正在验证 24 组参数组合'; }
    st.support = { recent_errors: D.conn === 'offline' ? [{ time: now() - 60e3, code: 'CONTROL_PLANE_TIMEOUT' }, { time: now() - 30e3, code: 'CONNECTION_UNAVAILABLE' }] : [] };
    st.repair = repair ? JSON.parse(JSON.stringify(repair)) : D.repair==='idle'?null:{id:'repair-fixture',status:D.repair,items:REPAIR_ITEMS.map(([id,title],i)=>({id,title,status:D.repair==='running'?i<3?'ok':i===3?'running':'pending':i===3?'fixed':i===5?'failed':i===8?'action':'ok',message:i===5?'网络没有回应。':i===8?'Chrome 助手没连上。':'',...(i===8?{action:{kind:'reconnect_browser',label:'重新连接'}}:{})})),summary:D.repair==='done'?{text:'修好了 1 项，还有 1 项要你点一下，还有 1 项没修好。',fixed:1,action_needed:1,failed:1}:null};
    st.update = updateOf(); st.upgrade_pending = false; st.release = { channel: 'beta', install_ready: true };
    st.about = { version: '1.0.0-beta.4', build: 1012, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }; st.version = '1.0.0-beta.4';
    if(D.value!==null){st.value=F.valueFixture(D.value,now(),{show:D.showValue,plan:D.valuePlan,reset:D.valueReset,since:D.valueSince,running:sc==='run',activeWork:D.valueActiveWork,weeks:D.valueWeeks,price:D.valuePrice,calibrated:D.valueCalibrated,weekTokens:D.valueWeekTokens});st.settings.show_value=st.value.show;st.settings.value_plan=D.valuePlan;st.project={path:'/工作区',name:'工作区'};st.connection.device_name='这台 Mac';const receipt={task_id:F.IDS.fix,value:{work:1200000,io_in:28000,io_out:7000,calls:48}};st.history=D.value==='0'?[]:[receipt];if(D.value!=='0')for(const group of st.activity.items)for(const task of group.tasks)if(task.task_id===F.IDS.fix)task.value={...receipt.value};}
    return st;
  }
  window.__state = state;

  /* ---------- 事件流：state 一次，之后只推变了的块（分组和 app/v1/events.mjs 一致） ---------- */
  const GROUPS = {
    connection: ['connection', 'relay', 'credentials', 'readiness', 'connection_check', 'tunnel_binary_hint'],
    jobs: ['jobs', 'tasks', 'events', 'approvals', 'inputs', 'activity', 'history', 'value', 'last_calls', 'call_trace', 'keep_awake'],
    capabilities: ['capabilities', 'permissions', 'automation', 'terminal', 'high_risk', 'high_risk_catalog', 'blocks', 'enabled', 'mode', 'full_armed', 'interface_protected', 'not_os_sandbox'],
    settings: ['settings', 'project', 'lifecycle', 'ui'], update: ['update', 'upgrade_pending', 'upgrade_guard', 'release'], support: ['support', 'repair', 'about'],
    setup: ['setup', 'setup_test', 'setup_skill', 'onboarding', 'manifest', 'version', 'runtime_api', 'instance_id', 'node', 'platform'],
  };
  const VOLATILE = [/"checked_at":\d+/g, /"last_success_at":\d+/g, /"last_seen":\d+/g, /"created_at":\d+/g];
  const sigOf = o => { let s = JSON.stringify(o); for (const r of VOLATILE) s = s.replace(r, ''); return s; };
  const enc = new TextEncoder(); const streams = new Set(); let last = null;
  const sse = (ev, d) => enc.encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  function push(override) {
    if(override&&typeof override==='object'){for(const c of streams)try{c.enqueue(sse('patch',override));}catch{}last={...last,...override};return;}
    const st = state();
    if (last) {
      const patch = {};
      for (const [g, keys] of Object.entries(GROUPS)) {
        const a = sigOf(Object.fromEntries(keys.map(k => [k, last[k]]))), b = sigOf(Object.fromEntries(keys.map(k => [k, st[k]])));
        if (a !== b) for (const k of keys) if (k in st || k in last) patch[k] = st[k] === undefined ? null : st[k];
      }
      if (Object.keys(patch).length) { window.__patches = (window.__patches || 0) + 1; for (const c of streams) try { c.enqueue(sse('patch', patch)); } catch { streams.delete(c); } }
    }
    last = st;
  }
  window.__push = push;
  window.__dropSse = () => { for (const c of [...streams]) { try { c.close(); } catch {} streams.delete(c); } };
  window.__rawSse=text=>{for(const c of streams)try{c.enqueue(enc.encode(text));}catch{}};
  window.__ping = () => { for (const c of streams) try { c.enqueue(sse('ping', {})); } catch {} };
  setInterval(() => { if (document.hidden||D.noPing) return; for (const c of streams) try { c.enqueue(sse('ping', {})); } catch {} }, 25000);

  /* ---------- fetch ---------- */
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (route, opt = {}) => {
    const url = String(route).split('?')[0]; let b = {}; try { b = opt.body ? JSON.parse(opt.body) : {}; } catch {}
    if (url === '/api/events') {
      const h = opt.headers || {}; log('sse', 'connect', { auth: !!h.Authorization, ui: !!h['X-ChatHand-UI'] });
      if(D.sse==='401'||D.sse==='403')return json({error:{code:D.sse==='401'?'OWNER_AUTH_REQUIRED':'UI_CONFIRM_REQUIRED'}},Number(D.sse));
      if (D.sse === 'off') return json({ error: { code: 'DOWN', message: '连不上' } }, 503);
      if (!h.Authorization || !h['X-ChatHand-UI']) return json({ error: { code: 'UI_CONFIRM_REQUIRED', message: '这一步只能由你本人在 ChatHand 窗口里操作。' } }, 403);
      let ctl; const body = new ReadableStream({ start(c) { ctl = c; streams.add(c); last = state(); c.enqueue(sse('state', last)); }, cancel() { streams.delete(ctl); } });
      if (opt.signal) opt.signal.addEventListener('abort', () => { streams.delete(ctl); try { ctl.close(); } catch {} });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    }
    if (url.startsWith('/api/') || url.startsWith('/__')) {
      if (url === '/api/state') { log('get', url); return json(state()); }
      if(url==='/api/value/reset'||url==='/api/settings'&&('show_value'in b||'value_plan'in b)){const h=opt.headers||{};(window.__valueAuth||=[]).push({route:url,auth:!!h.Authorization,ui:!!h['X-ChatHand-UI']});if(!h.Authorization)return json({error:{code:'OWNER_AUTH_REQUIRED'}},401);if(!h['X-ChatHand-UI'])return json({error:{code:'UI_CONFIRM_REQUIRED'}},403);}
      log('post', url, b);if(D.delayRoute===url)await new Promise(resolve=>setTimeout(resolve,D.routeDelay||1500));if(D.failRoute===url&&(D.failStep===undefined||b.step===D.failStep))return json({error:{code:D.failCode||'FAKE_FAILURE',message:'没设置成功'}},500);
      switch (url) {
        case '/api/settings': {
          if ('skin' in b) { const response=await realFetch('/__skin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skin:b.skin})});if(!response.ok)return response;D.skin=b.skin; }
          if ('appearance' in b) D.appearance = b.appearance; if ('auto_update' in b) D.auto_update = !!b.auto_update;
          if('show_value'in b)D.showValue=!!b.show_value;if('value_plan'in b)D.valuePlan=b.value_plan;
          for (const k of ['terminal_enabled', 'browser_enabled', 'desktop_enabled']) if (k in b) data[k] = !!b[k];
          if (b.high_risk) { Object.assign(data.high_risk, b.high_risk); if ('admin' in b.high_risk) D.admin = b.high_risk.admin ? 'on' : 'off'; }
          break;
        }
        case '/api/permissions/tier': applyTier(b.tier, b.folder);setTimeout(push,120);return json({ok:true,permissions:permsOf()});
        case '/api/value/reset': D.valueReset=true;D.valueSince=now();break;
        case '/api/ui/seen': if (!D.seen.includes(b.key)) D.seen.push(b.key); return json({ ok: true, seen: D.seen });
        case '/api/mode': data.mode = b.mode; break;
        case '/api/access': D.paused = b.enabled === false; break;
        case '/api/automation/stop': case '/api/tasks/stop': D.task = 'none'; break;
        case '/api/jobs/approve': D.task = 'run'; break;
        case '/api/jobs/reject': D.task = 'none'; break;
        case '/api/blocks/dismiss': D.block = 'none'; break;
        case '/api/tunnel/stop': case '/api/relay/stop': D.conn = 'stopped'; break;
        case '/api/projects/add': D.pendingProject = { id: 'p' + Date.now(), name: b.name, path: b.folder }; return json(D.pendingProject);
        case '/api/projects/select': if (D.pendingProject) data.project = { path: D.pendingProject.path, name: D.pendingProject.name }; D.pendingProject = null; break;
        case '/api/setup/workspace': data.workspace_confirmed = true; break;
        case '/api/setup/progress': if(b.restart===true)D.test='wait';D.wizard=String(b.step);persisted={step:b.step,tunnel_id:b.tunnel_id};sessionStorage.setItem(progressKey,JSON.stringify(persisted));break;
        case '/api/setup/skill': D.skill=true;break;
        case '/api/setup/site/network-check': return json(D.siteNet==='unreachable'?{result:'unreachable',checked_at:now(),error_code:'B_SITE_NETWORK_FAILED'}:{result:D.siteNet,checked_at:now(),http_status:D.siteNet==='challenged'?403:404});
        case '/api/setup/test/start': D.test='wait';D.testNonce='fresh'+(++setupTestCount);return json({ nonce: D.testNonce, expired: false, status: 'not_received', verified: false });
        case '/api/setup/await-key': if(D.key==='fail')return json({error:{code:'SETUP_KEY_FAILED',message:'无法自动接收密钥，请回到此处按 ⌘V。'}},400);D.keyWatch='watching';keyRequest={id:'req'+(++keyRequestCount),tunnel_id:b.tunnel_id,expires_at:now()+600e3-D.keyAge*1000};push();setTimeout(()=>{if(D.key==='expired'){D.keyWatch='idle';keyRequest=null;push();}else if(D.keyWatch==='watching'&&D.keyAuto){D.keyWatch='received';keyRequest=null;push();}},D.key==='expired'?100:D.keyDelay);return json({active:true,received:false,last4:null});
        case '/api/setup/await-key/status': {const value={active:D.keyWatch==='watching',received:D.keyWatch==='received',last4:D.keyWatch==='received'?'a7Qz':null,request:D.keyWatch==='watching'?keyRequest:null};if(D.statusDelay)await new Promise(resolve=>setTimeout(resolve,D.statusDelay));return json(value);}
        case '/api/setup/await-key/cancel': if(!b.id||b.id===keyRequest?.id){D.keyWatch='idle';keyRequest=null;}break;
        case '/api/support/repair': startRepair(); return json({ id: repair.id, status: 'running', items: repair.items });
        case '/api/support/ai-brief': return json({ text: '我的 ChatHand（让 ChatGPT 操作这台 Mac 的应用）出了问题：ChatGPT 连不上。请在这台 Mac 上帮我修好……（演示）' });
        case '/api/support/update': D.update = D.update === 'none' ? 'available' : D.update; break;
        case '/api/update/install': { D.update = 'downloading'; D.dlProgress = .05; const t = setInterval(() => { D.dlProgress += .16; if (D.dlProgress >= 1) { clearInterval(t); D.update = 'verifying'; push(); setTimeout(() => { D.update = 'installing'; push(); setTimeout(() => { D.update = 'updated'; push(); }, 1200); }, 1000); } else push(); }, 450); break; }
        case '/api/update/dismiss': D.update = 'none'; break;
        case '/api/update/cancel': D.update = 'available'; break;
        case '/api/update/ack': D.update = 'none'; break;
        case '/api/connect/restore': D.conn = 'online'; break;
        case '/api/browser/extension/reconnect': D.chrome='ok';setTimeout(push,120);return json({reconnecting:true,user_install_confirmation_required:!!D.installConfirmation});
      }
      setTimeout(push, 120); return json({ ok: true });
    }
    return realFetch(route, opt);
  };

  /* ---------- 原生桥 ---------- */
  async function nat(m) {
    log('native', m.action, m.data);if(D.nativeFail===m.action)return {error_code:'FAKE_FAILURE'};
    switch (m.action) {
      case 'chooseFolder': return D.pickFolder === null ? {} : { path: D.pickFolder || '/Users/trial/Documents/项目A' };
      case 'getSetupConversationStatus': return {available:!D.noApp,can_open:!D.noApp};
      case 'getNativeStatus': return { login_item: { supported: true, enabled: true, requires_approval: false } };
      case 'openChatGPT': return ({ app: { copied: false, opened: 'app', prefilled: true }, web: { copied: true, opened: 'web', prefilled: false }, copy: { copied: true, error_code: 'CHATGPT_OPEN_FAILED', prefilled: false }, fail: { copied: false, error_code: 'CHATGPT_OPEN_FAILED', prefilled: false }, invalid:{copied:false,error_code:'CHATGPT_PROMPT_INVALID',prefilled:false} })[D.chatgpt];
      case 'setAppearance': return { ok: true, mode: m.data && m.data.mode };
      case 'restoreTunnel': D.conn = 'connecting'; push(); setTimeout(() => { D.conn = 'online'; push(); }, 1500); return {};
      case 'extensionSetup': return { store_url:D.store?'https://chromewebstore.google.com/':null,extension_folder:'/fixture/ChatHand/browser-extension' };
      case 'openChromeStore': return D.store ? { opened:true,selected_profile:'Default',profiles:[] } : {};
      case 'computerPermissions': return {};
      case 'restartAfterPermissions': D.perm = 'ok'; push(); return {};
      case 'reconnectBrowserHelper': D.chrome = 'ok'; push(); return {};
      case 'pasteRuntimeKey': D.keyWatch = 'received'; push(); return { saved: true, last4: 'a7Qz' };
      case 'copyText': window.__clip = m.data && m.data.text; return {};
      default: return {};
    }
  }
  window.webkit = { messageHandlers: { native: { postMessage(m) { nat(m).then(r => setTimeout(() => window.nativeReply({ id: m.id, result: r }), 20)); } } } };
  window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.fake = '1'; });
  if(D.valueLong){const originals=new WeakMap(),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');let queued=false;const translate=()=>{queued=false;for(const el of document.querySelectorAll('#valueHeader [data-value-copy],#drawerBody [data-value-copy],#drawerBody .value-settings .si-t b,#drawerBody .value-settings .si-t small,#drawerBody .value-reset button,#drawerBody .value-meta span:not([aria-hidden])')){for(const node of el.childNodes){if(node.nodeType!==3||!node.textContent.trim())continue;if(originals.get(node)?.translated===node.textContent)continue;const source=node.textContent,style=getComputedStyle(el);ctx.font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;const originalWidth=ctx.measureText(source).width,target=originalWidth*1.6;let text='Example';while(ctx.measureText(text).width<target)text+=' longer text';originals.set(node,{source,translated:text});(window.__valueLongMeasurements||=[]).push({sourceLength:source.length,sourceWidth:originalWidth,translatedWidth:ctx.measureText(text).width,ratio:ctx.measureText(text).width/originalWidth});node.textContent=text;if(el.classList.contains('value-head-sub')){el.closest('button').title=text;el.closest('button').setAttribute('aria-label',text);}}}};new MutationObserver(()=>{if(!queued){queued=true;requestAnimationFrame(translate);}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});}
})();
