import {t,localText} from "../i18n.mjs";
/** AI 能做什么：三个开关（命令、浏览器、桌面控制）、高危命令闸门、「已拦下」记录。
 * 开关和高危命令存在 ChatHand 的状态文件里（和 mode 一样）；运行中以内存为准。
 * 只有 ChatHand 窗口能改（界面凭据，见 server.mjs）；ChatGPT 只能读（bridge_info）。 */
import {permissionHistoryFor} from "./permission-history.mjs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import {blockedReceipt,scopeReceipt} from "./blocked.mjs";
import {confirmationsFor,commandHash} from "./confirmations.mjs";
import { fail, redactErrorText } from "../../engine/src/core.mjs";
import {
  HIGH_RISK,
  HIGH_RISK_IDS,
  NEVER,
  normalizeSwitches,
  classifyCommand,
  parseSudo,
  highRiskError,
  neverError,
  adminFormError,
  riskById,
  whereToEnable,
  commonPermissionDetails,
} from "./high-risk.mjs";

export const SCOPE_WHERE = t("permissions.scope.where");
export const CAPABILITIES = {
  terminal: { key: "terminal_enabled", name: t("permissions.capability.terminal.name"), tools: ["propose_command", "command_input"] },
  browser: {
    key: "browser_enabled",
    name: t("permissions.capability.browser.name"),
    tools: ["browser_open", "browser_tabs", "browser_snapshot", "browser_action", "browser_screenshot", "browser_upload", "browser_download"],
  },
  desktop: { key: "desktop_enabled", name: t("permissions.capability.desktop.name"), tools: ["computer_screenshot", "computer_action", "computer_focus", "computer_applications"] },
};
export const CAPABILITY_IDS = Object.keys(CAPABILITIES);
export const capabilityWhere = (id) => t("permissions.capability.where",{name:CAPABILITIES[id].name});
/** 这个工具调用属于哪一项开关；desktop_action 的「打开网址」算浏览器 */
export function capabilityOf(name, args = {}) {
  if (name === "desktop_action" && args?.action === "open_url") return "browser";
  if (name.startsWith("browser_") && name !== "browser_status") return "browser";
  if (name.startsWith("computer_") && name !== "computer_status") return "desktop";
  return CAPABILITY_IDS.find((id) => CAPABILITIES[id].tools.includes(name)) || null;
}
export const capabilityOn = (state, id) => state.data[CAPABILITIES[id].key] !== false;
export const capabilityAllowed=(state,id,{task_id}={})=>capabilityOn(state,id)||!!confirmationsFor(state)?.allows({task_id,gate:"capability",item:id});
export function capabilityError(id, {command = ""} = {}) {
  const c = CAPABILITIES[id];
  const e = new Error(t("permissions.capability.off",{name:c.name}));
  e.code = "CAPABILITY_OFF";
  e.details = {
    capability: id,
    name: c.name,
    enabled_now: false,
    where_to_enable: capabilityWhere(id),
    instructions_for_ai: [
      "不要重试，也不要换别的工具绕过。",
      `告诉用户「${c.name}」在 App 里关着，请到 ${capabilityWhere(id)} 打开。`,
      "这一步没有执行；继续不依赖这项开关的部分，不等待或重复弹授权卡。",
    ],
  };
  const effects = {terminal:[t("permissions.capability.terminal.what"),t("permissions.capability.terminal.risk")],browser:[t("permissions.capability.browser.what"),t("permissions.capability.browser.risk")],desktop:[t("permissions.capability.desktop.what"),t("permissions.capability.desktop.risk")]};
  e.details.blocked = blockedReceipt({kind:"can_enable",gate:"capability",id,name:c.name,cause:`${command || c.tools[0]}：${e.message}`,can_do:effects[id][0],risk:effects[id][1],path:capabilityWhere(id),link:`chathand://settings/${id === "terminal" ? "commands" : id}`,alternative:t("permissions.capability.alternative")});
  return e;
}
export function needsFullAccessError(reason, { command = "" } = {}) {
  const e = new Error(t("permissions.scope.required",{reason}));
  e.code = "NEEDS_FULL_ACCESS";
  e.details = {
    reason,
    command: String(command).slice(0, 200),
    enabled_now: false,
    where_to_enable: SCOPE_WHERE,
    what_full_access_means: t("permissions.scope.what"),
    instructions_for_ai: [
      "不要反复重试。",
      "说明为什么需要整台电脑，先 request_permission 放确认卡；也可以换只在当前文件夹做的办法。",
      "task_status（wait_ms:20000）最多6次；allowed后同task继续，denied换做法；仍等待就task_checkpoint waiting_user，不finish_task。",
    ],
  };
  e.details.blocked = scopeReceipt({command,reason});
  return e;
}

/** 管理员开关开着时，系统里的规则是不是还在（关着或不是 Mac 时不查，返回 null） */
export function adminReadyFor(state, access) {
  if (!access?.supported?.() || !normalizeSwitches(state.data.high_risk).admin) return null;
  return access.ready();
}

/** Derive from live switches, including old records. Selecting full records intent,
 * never grants administrator rights or enables any danger item. */
export function permissionTier(state) {
  if (state.data.permission_tier_intent === 'custom') return 'custom';
  const sw = normalizeSwitches(state.data.high_risk);
  if (HIGH_RISK.some(r => r.group === "danger" && sw[r.id])) return "custom";
  if (!capabilityOn(state, "terminal") || !capabilityOn(state, "browser")) return "custom";
  const admin = sw.admin || state.data.admin_requested === true;
  if (state.data.mode === "full" && capabilityOn(state, "desktop") && sw.autostart && (admin || state.data.permission_tier_intent === "full")) return "full";
  if (state.data.mode !== "full" && !capabilityOn(state, "desktop") && !sw.autostart && !admin) return "light";
  return "custom";
}

export function scopeNote(state) {
  if (state.data.mode === "full") return null;
  const folder = path.basename(state.project?.()?.path || "") || "当前工作区";
  return `文件范围是『${folder}』：不要改动这个文件夹以外的文件；要下载、保存，存进这个文件夹。`;
}
export function withScopeNote(state, result) {
  const note = scopeNote(state);
  return note && result && typeof result === "object" ? { ...result, details: { ...result.details, scope_note: note } } : result;
}

export function recordPermissionOrigin(state,gate,id,via='settings',since=Date.now()){
 if(!['chat','window','notification','tier','settings'].includes(via))via='settings';
 state.data.permission_origins||={};state.data.permission_origins[gate+':'+id]={since,via};
}
export function alwaysAllowed(state,{adminReady=null}={}){
 const sw=normalizeSwitches(state.data.high_risk),items=[];
 const add=(gate,id,name)=>{const origin=state.data.permission_origins?.[gate+':'+id];items.push({gate,id,name,since:Number.isFinite(origin?.since)?origin.since:null,via:['chat','window','notification','tier','settings'].includes(origin?.via)?origin.via:'settings'});};
 if(state.data.mode==='full')add('scope','full','整台电脑');
 for(const id of CAPABILITY_IDS)if(capabilityOn(state,id))add('capability',id,CAPABILITIES[id].name);
 for(const r of HIGH_RISK)if(sw[r.id]&&(r.id!=='admin'||adminReady===true))add(r.group==='common'?'common':'high_risk',r.id,r.name);
 return items;
}
// File scope never grants control of the ChatGPT UI; this switch is independent.
export function chatgptSelfAllowed(state){return normalizeSwitches(state.data.high_risk).chatgpt_self===true;}
export function chatgptSelfError({command='ChatGPT 控制'}={}){return highRiskError('chatgpt_self',{command});}

export async function applyPermissionTier({ state, store, policy, adminAccess, revokeAdmin, home = os.homedir() }, { tier, folder, defaultSetup = false } = {}) {
  if (!["full", "light"].includes(tier)) fail("ARG_INVALID", "请选择完整或轻量档位；自定义由当前开关计算。");
  if (tier === 'light' && adminAccess?.supported?.() && typeof revokeAdmin !== 'function') fail('ADMIN_REVOKE_COORDINATOR_REQUIRED', '请从设置里的权限档位撤回管理员权限。');
  let root;
  if (tier === "light") {
    if (folder !== undefined && (typeof folder !== "string" || !folder || folder.length > 4096 || /[\0\r\n]/.test(folder))) fail("ARG_INVALID", "文件夹路径无效。");
    let chosen = folder || path.join(home, "ChatHand 工作区");
    if (chosen === "~" || chosen.startsWith("~/")) chosen = path.join(home, chosen.slice(2));
    if (!path.isAbsolute(chosen)) fail("ARG_INVALID", "文件夹需使用完整路径。");
    // Canonicalize the parent before creating a missing leaf; never create system/state directories.
    root = fs.existsSync(chosen) ? fs.realpathSync(chosen) : path.join(fs.realpathSync(path.dirname(chosen)), path.basename(chosen));
    store.checkProtected?.(root, { write: true });
    const stateDir = fs.realpathSync(state.dir);
    if (root === stateDir || root.startsWith(stateDir + path.sep) || stateDir.startsWith(root + path.sep)) fail("ROOT_STATE_OVERLAP", "工作区和状态目录必须分开。");
    const broad = [path.parse(root).root, fs.realpathSync(os.homedir()), path.resolve(home), "/Users", "/Applications", "/System", "/Library", "/private", "/usr", "/etc", "/var", ...["Library", "Documents", "Desktop", "Downloads"].map(n => path.join(os.homedir(), n))];
    if (broad.some(p => { try { return fs.realpathSync(p) === root; } catch { return p === root; } })) fail("ROOT_TOO_BROAD", "请选择专用工作文件夹。");
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    if (!fs.statSync(root).isDirectory()) fail("ROOT_INVALID", "工作区必须是文件夹。");
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  }
  const targetMode=tier === "full" ? "full" : "auto";
  const before = normalizeSwitches(state.data.high_risk);
  // Complete the existing revocation transaction before changing scope. If
  // cleanup fails it retains its recovery fence and the tier is not claimed.
  if (tier === 'light' && adminAccess?.supported?.()) {
    const revoked = await revokeAdmin();
    if (revoked?.ok !== true || state.data.high_risk?.admin !== false) fail('ADMIN_REVOKE_UNCONFIRMED', '管理员权限移除尚未确认，没有切换档位。');
  }
  const after={...normalizeSwitches(null),admin:tier === "full"&&before.admin,autostart:tier === "full"};
  const lowered=(capabilityOn(state,'desktop')&&tier!=="full")||Object.keys(before).some(k=>before[k]&&!after[k]);
  if(state.data.mode!==targetMode||(root&&state.project().path!==root))await policy.setMode(targetMode, tier === "full");
  else if(lowered)policy.revokeAll('permission_changed');
  if (root) {
    const changed = state.project().path !== root;
    store.setRoot(root);
    store.writesEnabled = policy.enabled;store.paused = !policy.enabled;
    let project = state.data.projects.find(p => p.path === root && p.scope !== "computer");
    if (!project) { project = { id: crypto.randomUUID(), name: path.basename(root), path: root, scope: "folder" };state.data.projects.push(project); }
    state.data.active = project.id;
    if (changed) state.data.setup_workspace_confirmed = false;
  }
  state.data.terminal_enabled = true;state.data.browser_enabled = true;state.data.desktop_enabled = tier === "full";
  state.data.admin_requested = tier === "full" && !defaultSetup;
  state.data.high_risk = { ...normalizeSwitches(null), admin: tier === "full" && before.admin, autostart: tier === "full" };
  for(const item of alwaysAllowed(state,{adminReady:adminReadyFor(state,adminAccess)}))recordPermissionOrigin(state,item.gate,item.id,'tier');
  if (tier === "light" || state.data.setup_open_status?.admin === "cancelled") delete state.data.setup_open_status;
  state.data.permission_tier_intent = tier;
  state.save();policy.emit("permissions_changed");
  return { ok: true, permissions: permissionsInfo(state, { adminReady: adminReadyFor(state, adminAccess) }) };
}

export function setupOpenItems(state, { adminReady = null, computer = {}, browser = {}, desktopSupported = true } = {}) {
  const tier = permissionTier(state), sw = normalizeSwitches(state.data.high_risk);
  const ids = tier === "full" ? ["admin", "desktop", "browser"] : tier === "light" ? ["folder", "browser"] : [
    ...(state.data.mode !== "full" ? ["folder"] : []), ...(sw.admin || state.data.admin_requested ? ["admin"] : []),
    ...(capabilityOn(state, "desktop") ? ["desktop"] : []), ...(capabilityOn(state, "browser") ? ["browser"] : []),
  ];
  const permissions = computer.permissions || {}, saved = state.data.setup_open_status || {};
  return ids.map(id => {
    let done = false, status = "todo", detail;
    if (id === "admin") {
      done = sw.admin && adminReady === true;
      detail = { enabled: sw.admin, requested: state.data.admin_requested === true, ready: adminReady === true, requires_computer_password: true };
    } else if (id === "desktop") {
      done = desktopSupported && permissions.accessibility === true && permissions.screen_recording === true;
      detail = { accessibility: permissions.accessibility === true, screen_recording: permissions.screen_recording === true, supported: desktopSupported, needs_restart: permissions.needs_restart === true };
      if (permissions.needs_restart === true) status = "needs_restart";
      else if (["accessibility", "screen_recording"].includes(permissions.step)) status = "waiting";
    } else if (id === "browser") {
      // 1081（Claude，Ken 10/27）：插件装过就算开好了。Chrome 只是没开，用到时 ChatHand 自己打开，首页不提示「还有几项没开通」。
      // ChatHand 打开过 Chrome 插件还是没连上（wake 记着），那是真出了问题，不算开好。
      done = browser.connected === true || browser.backend === "extension" && (browser.installed === true || !!browser.last_seen) && browser.wake?.connected !== false;
      detail = { connected: browser.connected === true, installed: browser.installed === true, last_seen: browser.last_seen || null };
      if (browser.phase === "connecting") status = "waiting";
    } else {
      done = state.data.setup_workspace_confirmed === true;
      detail = { folder: state.project()?.path || null, confirmed: done };
    }
    if (done && status !== "needs_restart") status = "done";
    else if (status === "todo" && ["waiting", "cancelled"].includes(saved[id])) status = saved[id];
    return { id, status, detail };
  });
}

export function markUISeen(state, key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key)) fail("ARG_INVALID", "提示标记无效。");
  const seen = Array.isArray(state.data.ui_seen) ? state.data.ui_seen : [];
  state.data.ui_seen = [...new Set([...seen, key])].slice(-256);state.save();
  return { ok: true, seen: state.data.ui_seen };
}

/** 给 ChatGPT 看的现状（bridge_info）和给界面看的现状（/api/state） */
export function permissionsInfo(state, { adminReady = null } = {}) {
  const sw = normalizeSwitches(state.data.high_risk);
  const full = state.data.mode === "full";
  return {
    tier: permissionTier(state),
    file_scope: full ? "computer" : "folder",
    file_scope_where: SCOPE_WHERE,
    capabilities: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, { name: CAPABILITIES[id].name, enabled: capabilityOn(state, id), where_to_enable: capabilityWhere(id) }])),
    high_risk: HIGH_RISK.map((r) => ({
      id: r.id,
      name: r.name,
      group: r.group,
      enabled: sw[r.id],
      usable_now: sw[r.id] && (r.id==='chatgpt_self'?(capabilityOn(state,'browser')||capabilityOn(state,'desktop')):full) && (r.id !== "admin" || adminReady !== false),
      ...(r.id === "admin" && sw.admin && adminReady === false ? { needs_setup: true } : {}),
      where_to_enable: whereToEnable(r.id),
    })),
    high_risk_note: full ? t("permissions.highRiskNote.full") : t("permissions.highRiskNote.folder"),
    always_allowed: alwaysAllowed(state,{adminReady}),
    history_status: permissionHistoryFor(state)?.status()||{available:true,persisted:true,error_code:null},
    history: permissionHistoryFor(state)?.view({allowed:alwaysAllowed(state,{adminReady}),origins:state.data.permission_origins,tier:permissionTier(state)})||[],
    admin_flow: "sudo 命令：用户回到电脑前打开「以管理员身份运行」（要输电脑密码）后，直接提议「sudo 命令…」就会运行，不用输密码；运行前先用一句话告诉用户要以管理员身份运行什么。不要反复试，不要用 sudo -S，不要在聊天里要密码。",
    download_run_note: "先下载到文件、看过内容再运行。",
    never: NEVER.map((n) => n.name),
  };
}

/** 「已拦下」：同一任务里同一项只记一条，次数累加。只在内存里；每次拦截另记一条审计。 */
export class Blocks {
  constructor({ audit = () => {}, emit = () => {}, limit = 40, now = Date.now } = {}) {
    Object.assign(this, { audit, emit, limit, now });
    this.items = [];
    this.notificationTimes = new Map();
  }
  key(task_id, kind, id) {
    return `${task_id || "-"}:${kind}:${id}`;
  }
  find(task_id, kind, id) {
    const k = this.key(task_id, kind, id);
    return this.items.find((b) => b.key === k && !b.dismissed);
  }
  count(task_id, kind, id) {
    return this.find(task_id, kind, id)?.times || 0;
  }
  record({ kind, id, name, command = "", reason = "", task_id = null, conversation_id = null, blocked = null }) {
    const now = this.now();
    let b = this.find(task_id, kind, id);
    if (b) {
      b.times++;
      b.updated_at = now;
      b.command = redactErrorText(command).slice(0, 240);
    } else {
      b = {
        key: this.key(task_id, kind, id),
        block_id: crypto.randomUUID(),
        kind,
        id,
        name,
        command: redactErrorText(command).slice(0, 240),
        reason: redactErrorText(reason).slice(0, 240),
        task_id,
        conversation_id,
        times: 1,
        created_at: now,
        updated_at: now,
        dismissed: false,
      };
      this.items.push(b);
      if (this.items.length > this.limit) this.items = this.items.slice(-this.limit);
    }
    if (blocked) b.blocked = structuredClone(blocked);
    try {
      this.audit({ event: "blocked", kind, id, task_id, times: b.times });
    } catch {}
    try {
      this.emit("blocked", { task_id, kind, id, block_id: b.block_id, times: b.times });
    } catch {}
    if (["high_risk", "admin_setup"].includes(kind) && ["admin", "autostart"].includes(id)&&!blocked?.confirm) this.notifyPermission(id, { task_id });
    return b;
  }
  notifyPermission(id, { task_id = null } = {}) {
    const now = this.now(), last = this.notificationTimes.get(id);
    if (last !== undefined && now - last < 10 * 60 * 1000) return false;
    this.notificationTimes.set(id, now);
    try { this.emit("permission_required", { task_id, permission_id: id, page: "settings", section: "commands", item: id,
      message: id === "admin" ? localText("native.notification.admin.body") : localText("native.notification.schedule.body") }); } catch {}
    return true;
  }
  dismiss(block_id) {
    const b = this.items.find((x) => x.block_id === block_id);
    if (b) b.dismissed = true;
    return { dismissed: !!b };
  }
  list() {
    return this.items
      .filter((b) => !b.dismissed)
      .map(({ key, ...b }) => b)
      .sort((a, b) => b.updated_at - a.updated_at);
  }
}

/** ChatHand 自己的进程和文件：kill / rm 这些不能打到它们 */
export function selfInfo({ stateDir, appRoot, extraPids = () => [], extraCmdlines = () => [] } = {}) {
  const bundle = appRoot && /\.app\/Contents\/Resources\/runtime\/?$/.test(appRoot) ? path.resolve(appRoot, "../../..") : null;
  return {
    home: os.homedir(),
    paths: [bundle, appRoot, stateDir, path.join(os.homedir(), "Library/Application Support/ChatHand")].filter(Boolean),
    names: [...new Set([path.basename(process.execPath), "tunnel-client", "KenBridge", "ChatHand"])],
    pids: () => [process.pid, Number(process.env.KEN_BRIDGE_OWNER_PID || 0), ...extraPids()].filter((x) => Number.isSafeInteger(x) && x > 1),
    cmdlines: () => [process.argv.join(" "), ...extraCmdlines()].filter(Boolean),
  };
}

const unwrapTop = (program, args) => {
  // 只看顶层是不是 open / osascript：env、nohup 这类外壳剥掉
  const words = [String(program), ...args.map(String)];
  while (words.length && /^(env|nohup|nice|time|command|exec)$/.test(path.basename(words[0]))) {
    words.shift();
    while (words.length && (words[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
  }
  return path.basename(words[0] || "");
};

/** 提交命令时的闸门。顺序：永远不做 → 高危开关关着 → 文件范围不是整台电脑 → 打开应用/AppleScript 要整台电脑 → 管理员写法。
 * 返回 { admin: null | { options, argv, display } }；拦下时抛出带 details 的错误，并记一条「已拦下」。 */
export function gateCommand({ spec, state, blocks, confirmations, task, self, cwd, platform = process.platform }) {
  const program = String(spec.program ?? "");
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const command = redactErrorText([program, ...args].join(" ")).slice(0, 300);
  const full = state.data.mode === "full", hash=commandHash({program,args,cwd}),grants=[];
  const consume=()=>{for(const g of grants)confirmations.allows({...g,consume:true});};
  const block = (kind, id, name, make, reason = "") => {
    const times = (blocks?.count(task?.id, kind, id) || 0) + 1;
    const error = make(times);
    if(error.details?.blocked)confirmations?.create({blocked:error.details.blocked,task_id:task?.id,session_hash:task?.session_hash,conversation_title:task?.conversation_title||task?.title,hash});
    blocks?.record({ kind, id, name, command, reason: reason || error.message, task_id: task?.id ?? null, conversation_id: task?.conversation_id ?? null, blocked:error.details?.blocked });
    error.blockRecorded = true;
    throw error;
  };
  const r = classifyCommand({
    program,
    args,
    cwd: cwd || self?.home || os.homedir(),
    home: self?.home || os.homedir(),
    selfPids: self?.pids?.() || [],
    selfPaths: self?.paths || [],
    selfNames: self?.names,
    selfCmdlines: self?.cmdlines?.() || [],
  });
  if (r.never) {
    const n = NEVER.find((x) => x.id === r.never.id);
    block("never", r.never.id, n?.name || r.never.id, () => neverError(r.never.id, r.never.evidence));
  }
  if (r.hits.some(h => h.id === "erase")) block("never", "erase", "清空或格式化磁盘", () => neverError("erase", command));
  const sw = normalizeSwitches(state.data.high_risk);
  for (const h of r.hits) if (!sw[h.id]) {
    const grant={task_id:task?.id,gate:h.id==="autostart"?"common":"high_risk",item:h.id,hash};
    if(h.id!=="admin"&&confirmations?.allows(grant))grants.push(grant);
    else block("high_risk", h.id, riskById(h.id).name, (times) => highRiskError(h.id, { command, times }));
  }
  if (r.hits.length && !full)
    block("scope", "high_risk", t("permissions.scope.name"), () =>
      needsFullAccessError(`「${r.hits.map((h) => riskById(h.id).name).join("」「")}」只在文件范围是「整台电脑」时可用。`, { command }),
    );
  if (!full && platform === "darwin") {
    const top = unwrapTop(program, args);
    if (top === "open")
      block("scope", "open", t("permissions.scope.name"), () => needsFullAccessError("打开应用、安装包或文件（open）只在「整台电脑」下可用。", { command }));
    if (top === "osascript")
      block("scope", "osascript", t("permissions.scope.name"), () => needsFullAccessError("AppleScript（osascript）要控制其他应用，只在「整台电脑」下可用。", { command }));
  }
  if (!r.hits.some((h) => h.id === "admin")) {consume();return { admin: null, hits: r.hits };}
  // 走到这里：管理员已开、文件范围是整台电脑。只收顶层的「sudo 命令…」。
  const top = path.basename(program);
  if (top !== "sudo")
    block("admin_form", "admin", "以管理员身份运行", () =>
      adminFormError(
        top === "osascript"
          ? "不要用 AppleScript 的 with administrator privileges；直接提议「sudo 命令…」。"
          : "管理员命令只支持直接写「sudo 命令…」，不能放在 sh -c、管道或脚本里。",
      ),
    );
  const s = parseSudo(args);
  if (!s.ok) block("admin_form", "admin", "以管理员身份运行", () => adminFormError(s.reason));
  if (spec.pty === true || spec.stdin_mode === "pipe")
    block("admin_form", "admin", "以管理员身份运行", () => adminFormError("管理员命令不支持交互终端（pty）和输入；改成一次就能跑完的写法。"));
  if (spec.mode === "service") block("admin_form", "admin", "以管理员身份运行", () => adminFormError("管理员命令不能作为常驻服务运行。"));
  if (blocks?.adminAccess?.supported?.() && !blocks.adminAccess.ready()) block("admin_setup", "admin", riskById("admin").name, () => {
    const e = new Error("管理员权限没有生效，命令没有执行。请在这台电脑前重新打开管理员权限。");
    e.code = "ADMIN_SETUP_REQUIRED";
    e.details = { ...commonPermissionDetails("admin"), risk_id: "admin", where_to_enable: whereToEnable("admin") + "（关掉再打开一次）", instructions_for_ai: ["不要反复试，也不要绕过。", "要你回到电脑前打开一次（要输电脑密码）。", "用户说开好了后，先调用 bridge_info 确认，再继续。"] };
    const r = riskById("admin");
    e.details.blocked = blockedReceipt({kind:"needs_user",gate:"admin_setup",id:"admin",name:r.name,cause:`${command}：${e.message}`,can_do:r.what,risk:r.harm,path:e.details.where_to_enable,link:"chathand://settings/commands/admin",alternative:"先做不需要管理员权限的部分；密码只由用户在 macOS 授权框里输入。"});
    return e;
  });
  consume();return { admin: { options: s.options, argv: s.argv, display: [program, ...args] }, hits: r.hits };
}

export { HIGH_RISK, HIGH_RISK_IDS, normalizeSwitches };
