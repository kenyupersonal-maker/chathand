// 真服务、真 HTTP：开关只认 ChatHand 窗口的界面凭据；关着的能力和高危命令返回带 details 的错误；「已拦下」能收起。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDesktop, needsInterface } from "../app/server.mjs";
import { SCOPE_WHERE } from "../app/v1/permissions.mjs";
import { whereToEnable } from "../app/v1/high-risk.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-perm-")),
  work = path.join(base, "work");
fs.mkdirSync(work);
const uiKey = "ab".repeat(32);
const adminAccess = { supported: () => false, ready: () => false };
const app = await createDesktop({ stateDir: path.join(base, "state"), defaultRoot: work, uiKey, adminAccess });
test.after(async () => {
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});
const owner = async (route, body, { ui = false } = {}) => {
  const r = await fetch(`http://127.0.0.1:${app.apiPort}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + app.adminToken, "Content-Type": "application/json", ...(ui ? { "X-ChatHand-UI": uiKey } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() };
};
let rid = 0, sessionSerial = 0, currentSession = "permissions-http-initial";
const call = async (name, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${app.mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ken-Bridge-Token": app.mcpToken, Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args, _meta: { "openai/session": currentSession } } }),
  });
  return (await r.json()).result;
};
// Each independent task fixture has a distinct conversation; calls within it retain this identity.
const task = async () => { currentSession = "permissions-http-task-" + (++sessionSerial); return (await call("begin_task", { request_id: "perm-task-" + Date.now() + "-" + rid, title: "权限测试" })).structuredContent.task_id; };

test("界面地址带上界面凭据；哪些操作只认窗口", () => {
  assert.ok(app.ui.endsWith("#" + app.adminToken + "." + uiKey));
  assert.equal(needsInterface("/api/settings", { keep_awake: true }), false);
  assert.equal(needsInterface("/api/settings", { high_risk: { admin: true } }), true);
  assert.equal(needsInterface("/api/settings", { browser_enabled: false }), true);
  assert.equal(needsInterface("/api/access", { enabled: false }), false);
  assert.equal(needsInterface("/api/access", { enabled: true }), true);
  for (const r of ["/api/mode", "/api/projects/add", "/api/projects/select", "/api/jobs/approve", "/api/inputs/approve", "/api/tasks/approve", "/api/actions/approve"])
    assert.equal(needsInterface(r, {}), true, r);
  assert.equal(needsInterface("/api/jobs/reject", {}), false);
});

test("只有管理令牌改不了开关、批准不了命令；带界面凭据可以", async () => {
  for (const [route, body] of [
    ["/api/settings", { high_risk: { admin: true } }],
    ["/api/settings", { terminal_enabled: false }],
    ["/api/mode", { mode: "full", confirm: true }],
    ["/api/access", { enabled: true }],
    ["/api/jobs/approve", { id: "x" }],
  ]) {
    const r = await owner(route, body);
    assert.equal(r.status, 403, route);
    assert.equal(r.body.error.code, "UI_CONFIRM_REQUIRED");
  }
  assert.equal((await owner("/api/settings", { keep_awake: true })).status, 200, "普通设置不受影响");
  const ok = await owner("/api/settings", { high_risk: { admin: true } }, { ui: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.permissions.high_risk.find((r) => r.id === "admin").enabled, true);
  const s = (await owner("/api/state")).body;
  assert.equal(s.settings.high_risk.admin, true);
  assert.equal(s.settings.high_risk.erase, false);
  assert.equal(s.interface_protected, true);
  assert.deepEqual(s.high_risk_catalog.map(r => r.id), [
    "admin", "bulk_delete", "keychain", "pipe_run", "gatekeeper", "bulk_perm", "autostart", "power", "chatgpt_self",
  ]);
  assert.ok(s.high_risk_catalog.some(r=>r.id==="chatgpt_self"&&r.group==="danger"));
  assert.equal((await owner("/api/settings", { high_risk: { nope: true } }, { ui: true })).body.error.code, "ARG_INVALID");
  assert.equal((await owner("/api/settings", { high_risk: { admin: "yes" } }, { ui: true })).body.error.code, "ARG_INVALID");
  await owner("/api/settings", { high_risk: { admin: false } }, { ui: true });
});

test("改状态文件不影响运行中的开关；旧 erase 即使打开也永远不执行", async () => {
  const file = path.join(base, "state", "desktop.json");
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  disk.high_risk = { ...(disk.high_risk || {}), erase: true, bulk_delete: true };
  fs.writeFileSync(file, JSON.stringify(disk));
  const t = await task();
  const r = await call("propose_command", { task_id: t, request_id: "perm-erase-01", program: "diskutil", args: ["eraseDisk", "APFS", "X", "disk9"] });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "NEVER_ALLOWED");
  assert.equal(r.structuredContent.details.never_id, "erase");
  assert.equal(r.structuredContent.details.blocked.confirm, null);
  const live = (await owner("/api/state")).body;
  assert.equal(live.settings.high_risk.erase, false);
  assert.equal(live.settings.high_risk.bulk_delete, false);
  const stillOff = await call("propose_command", { task_id: t, request_id: "perm-disk-switch", program: "rm", args: ["-rf", "~/Documents"] });
  assert.equal(stillOff.structuredContent.code, "HIGH_RISK_DISABLED");
  assert.equal(stillOff.structuredContent.details.risk_id, "bulk_delete");
  // 旧配置可读不代表存在可开启的 erase 能力；所有命令都在执行前拒绝。
  const legacy = await owner("/api/settings", { high_risk: { erase: true } }, { ui: true });
  assert.equal(legacy.status, 200);
  assert.equal((await owner("/api/state")).body.settings.high_risk.erase, true);
  assert.ok(!legacy.body.permissions.high_risk.some(r => r.id === "erase"));
  const never = await call("propose_command", { task_id: t, request_id: "perm-erase-on", program: "diskutil", args: ["eraseDisk", "APFS", "X", "disk9"] });
  assert.equal(never.isError, true);
  assert.equal(never.structuredContent.code, "NEVER_ALLOWED");
  assert.equal(never.structuredContent.details.never_id, "erase");
  assert.equal(never.structuredContent.details.blocked.kind, "never");
  assert.equal(never.structuredContent.details.blocked.where, null);
  assert.equal(never.structuredContent.details.blocked.confirm, null);
  assert.deepEqual((await call("task_status", { task_id: t })).structuredContent.confirmations, []);
  await owner("/api/settings", { high_risk: { erase: false } }, { ui: true });
});

test("关掉的能力：调用返回 CAPABILITY_OFF 和打开的位置；打开后恢复", async () => {
  assert.equal((await owner("/api/settings", { browser_enabled: false }, { ui: true })).status, 200);
  const t = await task();
  const r = await call("browser_open", { task_id: t, request_id: "perm-browser-01", url: "https://example.com/" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "CAPABILITY_OFF");
  assert.equal(r.structuredContent.details.capability, "browser");
  assert.equal(r.structuredContent.recovery.next_action, "explain_to_user_and_wait");
  const info = (await call("bridge_info")).structuredContent;
  assert.equal(info.permissions.capabilities.browser.enabled, false);
  const s = (await owner("/api/state")).body;
  assert.ok(s.blocks.some((b) => b.kind === "capability" && b.id === "browser"));
  await owner("/api/settings", { browser_enabled: true }, { ui: true });
  const again = await call("browser_open", { task_id: t, request_id: "perm-browser-02", url: "https://example.com/" });
  assert.notEqual(again.structuredContent?.code, "CAPABILITY_OFF");
});

test("高危命令被拦：说明 App 开关位置，不发确认卡；拦截记录仍可收起", async () => {
  const t = await task();
  const r = await call("propose_command", { task_id: t, request_id: "perm-rm-01", program: "/bin/sh", args: ["-c", "rm -rf ~/Documents"] });
  assert.equal(r.structuredContent.code, "HIGH_RISK_DISABLED");
  const d = r.structuredContent.details;
  assert.equal(d.risk_name, "一次性删除整个大文件夹");
  assert.ok(!d.say_to_user_template.includes("rm -rf ~/Documents"));
  assert.ok(d.say_to_user_template.includes(d.risk_name));
  assert.ok(d.blocked.cause.includes("rm -rf ~/Documents"));
  assert.equal(d.where_to_enable, whereToEnable("bulk_delete"));
  assert.deepEqual(d.instructions_for_ai, [d.blocked.next, "继续不依赖这个开关的部分，不弹授权卡、不重试、不绕过。"]);
  assert.ok(d.blocked.next.includes(d.where_to_enable));
  assert.match(d.blocked.next, /此功能在 ChatHand 中已关闭/);
  assert.match(d.blocked.next, /此步骤未执行/);
  assert.equal(d.blocked.confirm, null);
  assert.equal(d.blocked.answer_in_chat, false);
  let s = (await owner("/api/state")).body;
  assert.deepEqual(s.confirmations.filter(c=>c.task_id===t), []);
  assert.deepEqual((await call("task_status", { task_id: t })).structuredContent.confirmations, []);
  const card = s.blocks.find((b) => b.kind === "high_risk" && b.task_id === t);
  assert.ok(card);assert.equal(card.blocked?.kind,"can_enable");
  assert.equal((await owner("/api/blocks/dismiss", { id: card.block_id })).body.dismissed, true);
  s = (await owner("/api/state")).body;
  assert.ok(!s.blocks.some((b) => b.block_id === card.block_id));
});

test("管理员命令在文件夹档：要整台电脑；管理员关着：先说管理员", async () => {
  const reset=await owner("/api/settings",{high_risk:{admin:false}},{ui:true});assert.equal(reset.status,200);
  assert.equal(reset.body.permissions.high_risk.find(r=>r.id==="admin").enabled,false);
  const t = await task();
  const off = await call("propose_command", { task_id: t, request_id: "perm-sudo-01", program: "sudo", args: ["true"] });
  assert.equal(off.structuredContent.code, "HIGH_RISK_DISABLED");
  assert.equal(off.structuredContent.details.risk_id, "admin");
  const adminDetails = off.structuredContent.details;
  assert.equal(adminDetails.where_to_enable, whereToEnable("admin"));
  assert.equal(adminDetails.requires_computer_password, true);
  assert.equal(adminDetails.blocked.confirm, null);
  assert.equal(adminDetails.blocked.answer_in_chat, false);
  assert.ok(adminDetails.blocked.next.includes(adminDetails.where_to_enable));
  assert.deepEqual((await call("task_status", { task_id: t })).structuredContent.confirmations, []);
  const enabled=await owner("/api/settings", { high_risk: { admin: true } }, { ui: true });assert.equal(enabled.status,200);
  const folder = await call("propose_command", { task_id: t, request_id: "perm-sudo-02", program: "sudo", args: ["true"] });
  assert.equal(folder.structuredContent.code, "NEEDS_FULL_ACCESS");
  const scopeDetails = folder.structuredContent.details;
  assert.equal(scopeDetails.where_to_enable, SCOPE_WHERE);
  assert.equal(scopeDetails.blocked.confirm, null);
  assert.equal(scopeDetails.blocked.answer_in_chat, false);
  assert.ok(scopeDetails.blocked.next.includes(SCOPE_WHERE));
  assert.deepEqual((await call("task_status", { task_id: t })).structuredContent.confirmations, []);
  await owner("/api/settings", { high_risk: { admin: false } }, { ui: true });
});

test("整台电脑：命令不套沙箱直接跑，环境里没有 ChatHand 的令牌", { skip: process.platform === "win32" }, async () => {
  assert.equal((await owner("/api/mode", { mode: "full", confirm: true }, { ui: true })).status, 200);
  const t = await task();
  const r = await call("propose_command", { task_id: t, request_id: "perm-full-01", program: "/bin/sh", args: ["-c", 'echo "user=$USER"; env'], wait_ms: 5000 });
  const job = r.structuredContent;
  assert.equal(job.status, "completed", JSON.stringify(job).slice(0, 400));
  assert.equal(job.sandbox?.backend, "none");
  assert.match(job.stdout, /user=\S+/);
  assert.ok(!job.stdout.includes(app.adminToken));
  assert.ok(!job.stdout.includes(app.mcpToken));
  assert.ok(!job.stdout.includes(uiKey));
  assert.ok(!/GIT_CONFIG_NOSYSTEM/.test(job.stdout));
  const info = (await call("bridge_info")).structuredContent;
  assert.equal(info.permissions.file_scope, "computer");
  assert.equal(info.terminal.backend, "none");
  // 真实已批准的规范系统 cat 纯 pipe 按数据接收；shell/解释器仍检查。
  const shell = (await call("propose_command", { task_id: t, request_id: "perm-full-02", program: "/bin/cat", args: [], stdin_mode: "pipe" })).structuredContent;
  assert.equal(shell.status, "running");
  const typed = await call("command_input", { task_id: t, job_id: shell.job_id, request_id: "perm-input-01", text: "rm -rf ~/Documents\n" });
  assert.equal(typed.isError, false);
  assert.equal(typed.structuredContent.status, "sent");
  const sudoTyped = await call("command_input", { task_id: t, job_id: shell.job_id, request_id: "perm-input-02", text: "sudo ls\n" });
  assert.equal(sudoTyped.isError, false, JSON.stringify(sudoTyped.structuredContent));
  assert.equal(sudoTyped.structuredContent.status, "sent");
  const echoed = (await call("command_result", { job_id: shell.job_id, wait_ms: 1000 })).structuredContent;
  assert.equal(echoed.stdout, "rm -rf ~/Documents\nsudo ls\n");
  // 这两个消费端只回显，测试内容不会执行；其 shell/解释器规格仍不能获数据豁免。
  const executableConsumers = [];
  for (const [index, program, args] of [
    [0, "/bin/sh", ["-c", "exec /bin/cat"]],
    [1, process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]],
  ]) {
    const consumer = (await call("propose_command", { task_id: t, request_id: "perm-consumer-" + index, program, args, stdin_mode: "pipe" })).structuredContent;
    assert.equal(consumer.status, "running");
    executableConsumers.push(consumer);
    const marker = "FAKE_PRIVATE_STDIN_1060";
    const blocked = await call("command_input", { task_id: t, job_id: consumer.job_id, request_id: "perm-executable-" + index, text: "rm -rf ~/Documents; # " + marker + "\n" });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.code, "HIGH_RISK_DISABLED");
    assert.equal(blocked.structuredContent.details.risk_id, "bulk_delete");
    assert.equal(blocked.structuredContent.details.blocked.confirm, null);
    assert.ok(!JSON.stringify(blocked).includes(marker));
    const state = (await owner("/api/state")).body;
    assert.ok(!JSON.stringify([state.blocks, state.confirmations]).includes(marker));
  }
  assert.deepEqual((await call("task_status", { task_id: t })).structuredContent.confirmations, []);
  for (const consumer of executableConsumers) await call("cancel_command", { job_id: consumer.job_id });
  await owner("/api/settings", { high_risk: { admin: true } }, { ui: true });
  // 权限变化后旧输入授权失效；重新开任务/消费端，独立核对管理员格式。
  const adminTask = await task();
  for (const [index, program, args] of [
    [0, "/bin/sh", ["-c", "exec /bin/cat"]],
    [1, process.execPath, ["-e", "process.stdin.pipe(process.stdout)"]],
  ]) {
    const consumer = (await call("propose_command", { task_id: adminTask, request_id: "perm-admin-consumer-" + index, program, args, stdin_mode: "pipe" })).structuredContent;
    assert.equal(consumer.status, "running");
    const sudoBlocked = await call("command_input", { task_id: adminTask, job_id: consumer.job_id, request_id: "perm-executable-sudo-" + index, text: "sudo ls\n" });
    assert.equal(sudoBlocked.structuredContent.code, "ADMIN_FORM_UNSUPPORTED");
    const passwordBlocked = await call("command_input", { task_id: adminTask, job_id: consumer.job_id, request_id: "perm-executable-password-" + index, text: "visudo\n" });
    assert.equal(passwordBlocked.structuredContent.code, "NEVER_ALLOWED");
    assert.equal(passwordBlocked.structuredContent.details.never_id, "password");
    await call("cancel_command", { job_id: consumer.job_id });
  }
  await owner("/api/settings", { high_risk: { admin: false } }, { ui: true });
  const fine = await call("command_input", { task_id: t, job_id: shell.job_id, request_id: "perm-input-03", text: "hello\n", close: true });
  assert.equal(fine.isError,true);assert.equal(fine.structuredContent.code,"PERMISSION_CHANGED","permission downshift invalidates the old task/input grant");
  const nextTask=await task(),fresh=(await call("propose_command",{task_id:nextTask,request_id:"perm-full-fresh",program:"/bin/cat",args:[],stdin_mode:"pipe"})).structuredContent;
  const permitted=await call("command_input",{task_id:nextTask,job_id:fresh.job_id,request_id:"perm-input-fresh",text:"hello\n",close:true});assert.ok(!permitted.isError,JSON.stringify(permitted.structuredContent));
  await call("cancel_command", { job_id: fresh.job_id });
  await owner("/api/mode", { mode: "auto" }, { ui: true });
});

test("测连接：已连接时不再报 TUNNEL_RUNNING（这里没配通道，照旧要求先填）", async () => {
  const r = await owner("/api/tunnel/doctor", {});
  assert.equal(r.body.error.code, "TUNNEL_UNCONFIGURED");
});
