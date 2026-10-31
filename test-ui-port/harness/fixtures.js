'use strict';
/* 假数据：4 套状态（run / idle / offline / unset）。
   字段名全部照 ui/app.js、ui/wizard.js 里读的来，不要在这里发明新字段。
   时间全部用 now 往前推；页面 URL 里带 &now=<毫秒> 时 now 由它决定（截图用，保证每次重跑都一样）。 */

const MIN = 60e3, HOUR = 3600e3;
const TUNNEL = 'tunnel_test000000000000000000000001';
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const VERSION = '1.0.0-beta.3';
const WORKSPACE = '/Users/trial/ChatHand-Workspace';

const SCENARIOS = ['run', 'idle', 'offline', 'unset'];

/* 今天 / 昨天的边界；把偏移量夹进对应那一天，任何时刻打开都能同时看到「今天」「昨天」 */
function dayEdges(now) {
  const mid = new Date(now); mid.setHours(0, 0, 0, 0);
  const yMid = new Date(mid); yMid.setDate(yMid.getDate() - 1);
  return { mid: mid.getTime(), yMid: yMid.getTime() };
}
const ago = (now, ms) => now - ms;
function today(now, ms) { const e = dayEdges(now); return Math.min(Math.max(ms, e.mid + MIN), now - 5e3); }
function yesterday(now, ms) { const e = dayEdges(now); return Math.min(Math.max(ms, e.yMid + MIN), e.mid - MIN); }
function older(now, ms) { const e = dayEdges(now); return Math.min(ms, e.yMid - MIN); }

/* ---- 任务 ---- */
const IDS = {
  run: '8f3c9b71d05e4c2a8b6f3e1d90a7a21e',
  fix: '1d2a7c40b93e4f5a86c1d07e3b52c9f4',
  inv: '5b9e21f8a6c04d37b1e2f8c40d61a3e7',
  fetch: 'c47a03e19d5b4826af30b1e7d92c58a0',
  draft: '92e6b1c08f3a47d5b9a0c2e14f6d7b83',
  dl: 'e01f5a83c2d94b67a8f10d3c5e9b4a26',
};

function taskRun(now) {
  return { task_id: IDS.run, title: '整理回测结果，生成周报', status: 'active', created_at: ago(now, 18 * MIN + 13e3), jobs: ['job_fetch', 'job_backtest'], mode: 'auto' };
}
function jobsRun(now) {
  const s1 = ago(now, 15 * MIN + 13e3);
  return [
    { job_id: 'job_fetch', program: 'python', args: ['fetch.py', '--days', '30'], status: 'exited', exit_code: 0, started_at: s1, finished_at: s1 + 6 * MIN + 10e3, process_alive: false, last_line: '行情数据已更新' },
    { job_id: 'job_backtest', program: 'python', args: ['backtest.py', '--grid', 'v2'], status: 'running', exit_code: null, started_at: ago(now, 2 * MIN + 13e3), finished_at: null, process_alive: true, last_line: '正在验证 24 组参数组合' },
  ];
}
function history(now) {
  return {
    fix: { task_id: IDS.fix, title: '修好下载工具的超时', status: 'completed', created_at: today(now, ago(now, 3 * HOUR + 22 * MIN)), finished_at: today(now, ago(now, 3 * HOUR)), jobs: [] },
    inv: { task_id: IDS.inv, title: '把发票 PDF 按月份归档', status: 'completed', created_at: yesterday(now, ago(now, 17 * HOUR + 40 * MIN)), finished_at: yesterday(now, ago(now, 17 * HOUR + 15 * MIN)), jobs: [] },
    fetch: { task_id: IDS.fetch, title: '抓取 30 天行情数据', status: 'stopped', created_at: yesterday(now, ago(now, 18 * HOUR + 50 * MIN)), finished_at: yesterday(now, ago(now, 18 * HOUR + 28 * MIN)), jobs: [] },
    draft: { task_id: IDS.draft, title: '写周报初稿', status: 'completed', created_at: yesterday(now, ago(now, 27 * HOUR)), finished_at: yesterday(now, ago(now, 26 * HOUR + 30 * MIN)), jobs: [] },
    dl: { task_id: IDS.dl, title: '整理下载文件夹里的安装包', status: 'failed', created_at: older(now, ago(now, 3 * 24 * HOUR + 2 * HOUR)), finished_at: older(now, ago(now, 3 * 24 * HOUR + 1.5 * HOUR)), jobs: [] },
  };
}
const CHAT = (id, title) => ({ id, title, conversation_url: 'https://chatgpt.com/c/' + id, link_source: 'auto_match' });

function activity(scenario, now) {
  const h = history(now);
  const keep = scenario === 'run' ? ['fix', 'inv', 'fetch'] : ['fix', 'inv', 'fetch', 'draft', 'dl'];   // run：最近完成正好 3 个
  const pick = k => keep.includes(k) ? [h[k]] : [];
  const run = scenario === 'run' ? [{ task_id: IDS.run, title: taskRun(now).title, status: 'active', created_at: taskRun(now).created_at, finished_at: null, jobs: ['job_fetch', 'job_backtest'] }] : [];
  return { items: [
    { ...CHAT('68f1c0aa-4d10-8329-9b0e-trade', '构建自动交易工具'), tasks: [...run, ...pick('fetch')] },
    { ...CHAT('68f1b7e2-91c4-8321-a7d2-chathand', 'ChatHand 开发'), tasks: pick('fix') },
    { ...CHAT('68f0a51c-7b32-8318-8e40-expense', '报销'), tasks: pick('inv') },
    { ...CHAT('68f09d03-2c6e-8316-b5a9-weekly', '周报'), tasks: pick('draft') },
    { ...CHAT('68ee7f10-e3a8-8311-9c2d-downloads', '电脑整理'), tasks: pick('dl') },
  ].filter(g => g.tasks.length) };
}

/* ---- 文件改动（POST /api/task-changes {id}） ---- */
function changesFor(id, now) {
  if (id === IDS.run) return [
    { time: ago(now, 5 * MIN + 13e3), status: 'applied', tool: 'write_file', path: 'research/grid_v2.json', receipt_id: 'rcpt_02', operation_id: 'op_02' },
    { time: ago(now, 8 * MIN + 13e3), status: 'applied', tool: 'write_file', path: 'reports/summary.md', receipt_id: 'rcpt_01', operation_id: 'op_01' },
  ];
  if (id === IDS.inv) return [
    { time: yesterday(now, ago(now, 17 * HOUR + 20 * MIN)), status: 'applied', tool: 'move_file', path: 'Downloads/发票-2026-08-17.pdf', destination: '发票/2026-08/发票-2026-08-17.pdf', receipt_id: 'rcpt_11', operation_id: 'op_11' },
    { time: yesterday(now, ago(now, 17 * HOUR + 18 * MIN)), status: 'applied', tool: 'move_file', path: 'Downloads/发票-2026-09-02.pdf', destination: '发票/2026-09/发票-2026-09-02.pdf', receipt_id: 'rcpt_12', operation_id: 'op_12' },
    { time: yesterday(now, ago(now, 17 * HOUR + 16 * MIN)), status: 'applied', tool: 'create_directory', path: '发票/2026-09', receipt_id: 'rcpt_13', operation_id: 'op_13' },
  ];
  if (id === IDS.fix) return [
    { time: today(now, ago(now, 3 * HOUR + 10 * MIN)), status: 'applied', tool: 'edit_file', path: 'src/downloader.py', receipt_id: 'rcpt_21', operation_id: 'op_21' },
  ];
  return [];
}
const DIFFS = {
  op_01: { path: 'reports/summary.md', before: '# 周报\n\n本周回测还没跑完。\n', after: '# 周报\n\n## 回测结果\n\n- 网格 v2：年化 18.4%，最大回撤 9.1%\n- 网格 v1：年化 12.7%，最大回撤 11.3%\n\n## 下一步\n\n把 v2 的参数放到 research/ 下留档。\n' },
  op_02: { path: 'research/grid_v2.json', before: '', after: '{\n  "grid": "v2",\n  "step": 0.5,\n  "lookback": 48\n}\n' },
  op_21: { path: 'src/downloader.py', before: 'def fetch(url):\n    return session.get(url)\n', after: 'def fetch(url, timeout=30):\n    return session.get(url, timeout=timeout)\n' },
};
function diffFor(op) {
  return { ...(DIFFS[op] || { path: 'notes.md', before: '', after: '（示例）\n' }), current_differs_from_receipt: false };
}

/* 1011 接口约定：状态和修复结果都只是假数据。 */
const HIGH_RISK_CATALOG = [{"id":"admin","name":"以管理员身份运行","cmd":"sudo","level":"极高","what":"获得这台电脑的最高权限，可以修改或删除系统和所有文件。","harm":"一条错误的命令可能清空整块硬盘或导致电脑无法开机；开启期间，电脑上的其他程序也可能借此获得最高权限。","enable_note":"开启时需输入一次电脑密码（或使用 Touch ID）。开启后 ChatGPT 使用 sudo 时不再询问你；关闭即撤销。"},{"id":"erase","name":"清空或格式化磁盘","cmd":"diskutil erase… · dd · mkfs","level":"极高","what":"把硬盘、U 盘或分区「抹掉重来」。","harm":"里面的文件立刻消失，基本找不回来；选错盘，就清空了不该清的。"},{"id":"bulk_delete","name":"一次性删除整个大文件夹","cmd":"rm -rf · find -delete · rsync --delete","level":"高","what":"用一条命令删除整个文件夹及其中的全部内容。","harm":"文件不会移到废纸篓，删除后无法恢复；多年积累的文件和照片可能一次全部丢失。"},{"id":"keychain","name":"读取钥匙串里的密码","cmd":"security …","level":"高","what":"直接读取 Mac 中保存的账号密码。","harm":"密码会出现在对话中，可能外泄，导致账号被盗。"},{"id":"pipe_run","name":"下载后不经检查直接运行","cmd":"curl … | sh","level":"高","what":"从网上下载程序，不检查内容就立即运行。","harm":"如果程序被篡改，它会以你的身份直接运行，可能窃取文件或安装后门。"},{"id":"gatekeeper","name":"绕过系统的安全检查","cmd":"xattr -d com.apple.quarantine · spctl · csrutil","level":"高","what":"让 macOS 不再检查「从网上下载的程序」。","harm":"恶意程序也可以直接运行，系统不会再发出提醒。"},{"id":"bulk_perm","name":"批量修改整个大文件夹的权限","cmd":"chmod -R · chown -R","level":"中","what":"一次性更改文件夹内所有文件「谁能查看、谁能修改」。","harm":"文件可能被任何人查看，或连你自己也无法打开；App 也可能无法正常工作。"},{"id":"autostart","name":"开机自启或定时运行","cmd":"launchctl load · crontab · at","level":"中","what":"让程序在开机、登录时或按固定间隔自动运行。","harm":"程序可能在你不知情时持续运行，难以发现和关闭；恶意软件常借此长期驻留。"},{"id":"power","name":"关机、重启、睡眠或断网","cmd":"shutdown · reboot · pmset sleepnow · networksetup","level":"中","what":"让这台 Mac 关机、重启、睡眠，或关闭网络。","harm":"未保存的内容可能丢失；连接中断后 ChatGPT 将无法继续操作，需要你回到电脑前才能恢复。"}];
const RELEASES_URL = 'https://github.com/kenyupersonal-maker/chathand/releases';
function updateFor(name = 'none') {
  const base = { status: 'up_to_date', version: '', build: null, notes: '', url: RELEASES_URL, dismissed_version: null, tool_schema_changed: false, checked_at: null, install: { state: 'idle', progress: 0, message: '', url: '' }, just_updated: null };
  const available = { status: 'available', version: '1.0.1', build: 1012, notes: '修好了断网后不能自动重连的问题。\n设置页更好找。' };
  const states = {
    available, downloading: { ...available, install: { ...base.install, state: 'downloading', progress: .32 } },
    waiting_tasks: { ...available, install: { ...base.install, state: 'waiting_tasks' } },
    failed: { ...available, install: { ...base.install, state: 'failed', message: '安装包核对没通过，已换回原来的版本，可以接着用。' } },
    just_updated: { just_updated: { from: VERSION, to: '1.0.1', tool_schema_changed: true } },
  };
  return { ...base, ...(states[name] || {}) };
}
function repairFor(now) {
  const titles = [['paused','AI 暂停状态'],['credentials','连接设置'],['tunnel','连接程序'],['proxy_match','系统代理'],['proxy_alive','代理软件'],['cloud','ChatGPT 连接'],['chatgpt_tools','ChatGPT 中的工具'],['browser_host','Chrome 助手登记'],['browser_helper','Chrome 助手'],['desktop_permissions','桌面控制授权'],['login_item','开机启动'],['upgrade_leftover','上次升级']];
  return { id: 'repair-test', status: 'done', started_at: now - 1000, finished_at: now, items: titles.map(([id,title]) => ({ id, title, status: id === 'browser_host' ? 'fixed' : 'ok', message: id === 'browser_host' ? 'Chrome 助手登记已修好' : '', action: null })), summary: { text: '修好了 1 项', fixed: 1, action_needed: 0, failed: 0 } };
}

/* ---- 整份状态 ---- */
function build(scenario, now, over = {}) {
  if (!SCENARIOS.includes(scenario)) scenario = 'run';
  const unset = scenario === 'unset';
  const online = scenario === 'run' || scenario === 'idle';
  const settings = {
    tunnel: unset ? null : { tunnel_id: TUNNEL },
    connection_preference: unset ? 'none' : 'tunnel',
    keep_awake: true, auto_connect: !unset, notifications: true,
    setup_complete: !unset,
    browser_backend: 'extension',
    last_seen_version: VERSION,
    ...(over.settings || {}),
  };
  const state = {
    version: VERSION,
    about: { version: VERSION, build: 1011, commit: COMMIT },
    update: updateFor(),
    repair: over.repair || null,
    support: { recent_errors: online || unset ? [] : [{ time: now - MIN, code: 'CONTROL_PLANE_TIMEOUT' }] },
    enabled: over.enabled !== undefined ? over.enabled : true,
    mode: over.mode || 'auto',
    project: { path: WORKSPACE, name: 'ChatHand-Workspace' },
    settings,
    connection: {
      ready: online, healthy: online, process_running: online,
      automatic: unset ? { phase: 'idle', message: '' } : online ? { phase: 'connected', message: '已连接' } : { phase: 'failed', message: '通道连不上，检查一下网络后重新连接' },
      tunnel_id: unset ? undefined : TUNNEL,
      client_version: 'v0.9.3',
      proxy: '跟随系统 · 127.0.0.1:7890',
      control_plane: { state: online ? 'up' : 'down', proxy: 'http://127.0.0.1:7890', last_success_at: online ? now - 8000 : null },
    },
    relay: { online: false, paired: false },
    last_calls: unset ? {} : { chatgpt: { time: ago(now, online ? 2 * MIN : 3 * HOUR), tool: 'connection_check' } },
    high_risk_catalog: HIGH_RISK_CATALOG.map(r => ({ ...r })),
    capabilities: { desktop_control: true, terminal: true },
    automation: {
      browser: { extension: { connected: !unset }, personal: { connected: false, chrome: { version: '153.0.7339.80' } } },
      computer: { permissions: { accessibility: !unset, screen_recording: !unset } },
    },
    tasks: scenario === 'run' ? [taskRun(now)] : [],
    activity: unset ? { items: [] } : activity(scenario, now),
    jobs: scenario === 'run' ? jobsRun(now) : [],
    connection_check: unset ? null : { time: today(now, ago(now, 6 * MIN)), ok: true, tool_count: 51 },
    setup_test: { status: 'not_started' },
    manifest: { tools: new Array(51).fill(0).map((_, i) => ({ name: 'tool_' + i })) },
  };
  if (over.setup_test) state.setup_test = over.setup_test;
  if (over.update) state.update = typeof over.update === 'object' ? { ...updateFor(), ...over.update } : updateFor(over.update === true ? 'available' : over.update);
  if (over.pending) { for (const t of state.tasks) t.status = 'pending_approval'; for (const g of state.activity.items) for (const t of g.tasks) if (t.task_id === IDS.run) t.status = 'pending_approval'; }
  /* 向导停在第 N 步（0 开始）：任何状态都可以带 &wizard=N；&test=ok|read|wait 决定第 4 步「测试连接」的结果 */
  if (over.wizard !== undefined) {
    Object.assign(state.settings, { setup_complete: false, setup_step: Number(over.wizard), setup_tunnel_id: TUNNEL });
    const t = { ok: { status: 'read_write', read: true, write: true }, read: { status: 'read_only', read: true, write: false }, wait: { status: 'not_received', read: false, write: false } }[over.test || 'wait'];
    state.setup_test = { nonce: 'k9x2m4', expired: false, ...t };
  }
  return state;
}

module.exports = { SCENARIOS, build, changesFor, diffFor, updateFor, repairFor, IDS, TUNNEL };
