'use strict';
/* 假数据：4 套状态（run / idle / offline / unset）。
   字段名全部照 ui/app.js、ui/wizard.js 里读的来，不要在这里发明新字段。
   时间全部用 now 往前推；页面 URL 里带 &now=<毫秒> 时 now 由它决定（截图用，保证每次重跑都一样）。 */

const MIN = 60e3, HOUR = 3600e3;
const TUNNEL = 'tunnel_6aab92c648748191b945e07dfe8faf41';
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const VERSION = '1.0.0-beta.1';
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
    { job_id: 'job_fetch', program: 'python', args: ['fetch.py', '--days', '30'], status: 'exited', exit_code: 0, started_at: s1, finished_at: s1 + 6 * MIN + 10e3, process_alive: false },
    { job_id: 'job_backtest', program: 'python', args: ['backtest.py', '--grid', 'v2'], status: 'running', exit_code: null, started_at: ago(now, 2 * MIN + 13e3), finished_at: null, process_alive: true },
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
    about: { version: VERSION, build: 1007, commit: COMMIT },
    update: { status: 'up_to_date' },
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
    },
    relay: { online: false, paired: false },
    last_calls: unset ? {} : { chatgpt: { time: ago(now, online ? 2 * MIN : 3 * HOUR), tool: 'connection_check' } },
    capabilities: { desktop_control: true, terminal: true },
    automation: {
      browser: { extension: { connected: !unset }, personal: { connected: false, chrome: { version: '153.0.7339.80' } } },
      computer: { permissions: { accessibility: !unset, screen_recording: !unset } },
    },
    tasks: scenario === 'run' ? [taskRun(now)] : [],
    activity: unset ? { items: [] } : activity(scenario, now),
    jobs: scenario === 'run' ? jobsRun(now) : [],
    connection_check: unset ? null : { time: today(now, ago(now, 6 * MIN)), ok: true, tool_count: 51 },
    setup_test: { status: 'not_started', verified: false },
    manifest: { tools: new Array(51).fill(0).map((_, i) => ({ name: 'tool_' + i })) },
  };
  if (over.setup_test) state.setup_test = over.setup_test;
  if (over.update) state.update = { status: 'available', version: '1.0.0-beta.2', url: 'https://github.com/kenyupersonal-maker/chathand/releases' };
  /* 向导停在第 N 步（0 开始）：任何状态都可以带 &wizard=N；&test=ok|read|wait 决定第 4 步「测试连接」的结果 */
  if (over.wizard !== undefined) {
    Object.assign(state.settings, { setup_complete: false, setup_step: Number(over.wizard), setup_tunnel_id: TUNNEL });
    const t = { ok: { status: 'read_write', read: true, write: true }, read: { status: 'read_only', read: true, write: false }, wait: { status: 'not_received', read: false, write: false } }[over.test || 'wait'];
    state.setup_test = { nonce: 'k9x2m4', expired: false, verified: over.test === 'ok', ...t };
  }
  return state;
}

/* 工作量的独立数字样本。只供试验台，生产界面不持有额度或价格常量。 */
function valueFixture(name, now, options={}) {
  const preset={0:[0,0,0],small:[42000,.03,.18],low:[1560000,1.3,.8],mid:[24000000,20,8.76],big:[130000000,108,46],x3:[310000000,258,110],pro:[130000000,22,46],noplan:[130000000,108,46],old:[0,0,0],off:[130000000,108,46]}[name]||[0,0,0];
  const weeks=options.weeks||{plus:120000000,pro_5x:600000000,pro_20x:2400000000},chosen=options.plan&&options.plan!=='auto'?options.plan:null,id=chosen|| (name==='pro'?'pro_5x':'plus'),names={plus:'Plus',pro_5x:'Pro 5x',pro_20x:'Pro 20x'};
  const source=chosen?'setting':name==='noplan'?'default':'auto',today=new Date(now);today.setHours(0,0,0,0);const since=new Date(today.getFullYear(),6,20).getTime(),empty=name==='0'||options.reset,old=name==='old',has=!empty;
  const work=empty?0:preset[0],share=chosen&&work?work/weeks[id]*100:empty?0:preset[1],daily=[];
  for(let i=181;i>=0;i--){const d=new Date(today);d.setDate(today.getDate()-i);const date=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'),active=has&&d.getTime()>=since&&(!old||i>=7);daily.push({date,work:active?Math.round((Math.sin(i*1.71)+1.05)*18000000):0});}
  return {show:options.show??name!=='off',since:empty?now:options.since||since,plan:{id,name:names[id],source},quota:{week_tokens:options.weekTokens||weeks[id],source:options.calibrated?'calibrated':'table',week_tokens_by_plan:{...weeks}},price:{model:'GPT-6.1 Sol',input_per_m:2,cached_per_m:.1,output_per_m:10,as_of:'2026 年 10 月',source:'OpenAI API 定价页，标准价、短上下文',...options.price},last7:{work,io:{in:empty||old?0:1800000,out:empty||old?0:300000},usd:empty?0:preset[2],share,tasks:empty||old?0:70,calls:{all:empty||old?0:4012,read:empty||old?0:1100,write:empty||old?0:520,command:empty||old?0:418,browser:empty||old?0:1296,desktop:empty||old?0:384,other:empty||old?0:294}},lifetime:{work:has?940000000:0,io:{in:has?12000000:0,out:has?1500000:0},usd:has?310:0,tasks:has?680:0},daily,active:options.running&&has?{[IDS.run]:{work:options.activeWork??1200000,calls:48}}:{},probe:{meta_keys:[],header_names:[]}};
}
module.exports = { SCENARIOS, build, changesFor, diffFor, IDS, TUNNEL, valueFixture };
