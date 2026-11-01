// 闸门、开关、「已拦下」、管理员命令改写：纯逻辑，不需要 Mac。
import test from "node:test";
import assert from "node:assert/strict";
import {
  gateCommand,
  Blocks,
  capabilityOf,
  capabilityError,
  capabilityOn,
  needsFullAccessError,
  permissionsInfo,
  CAPABILITY_IDS,
  SCOPE_WHERE,
} from "../../app/v1/permissions.mjs";
import { shellQuote, appleString, settleAdminJob, adminArgs, adminSetupError, HELPER_PATH } from "../../app/v1/admin-command.mjs";
import { systemProxyEnv, mergePath } from "../../app/v1/full-access.mjs";
import { cleanError } from "../../engine/src/core.mjs";
import { errorRecovery, WORKFLOW_INSTRUCTIONS } from "../../app/v1/workflow.mjs";

const self = { home: "/Users/fixture", paths: ["/Applications/ChatHand.app"], names: ["node", "tunnel-client"], pids: () => [4242], cmdlines: () => ["/x/bin/node /x/app/server.mjs"] };
const stateWith = (data = {}) => ({ data: { mode: "full", ...data } });
const gate = (program, args, { data = {}, blocks = new Blocks(), task = { id: "task-1", conversation_id: null }, platform = "darwin", spec = {} } = {}) =>
  gateCommand({ spec: { program, args, ...spec }, state: stateWith(data), blocks, task, self, cwd: "/Users/fixture/Work", platform });
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

test("平常命令放行，返回不是管理员", () => {
  assert.deepEqual(gate("git", ["status"]).admin, null);
  assert.deepEqual(gate("/bin/zsh", ["-lc", "npm test && ls"]).admin, null);
});

test("高危开关关着：拦下，带完整 details，记一张「已拦下」", () => {
  const blocks = new Blocks();
  const e = code(() => gate("rm", ["-rf", "~/Documents"], { blocks }));
  assert.equal(e.code, "HIGH_RISK_DISABLED");
  assert.equal(e.details.risk_id, "bulk_delete");
  assert.ok(e.details.where_to_enable.includes("高危命令"));
  assert.equal(blocks.list().length, 1);
  assert.equal(blocks.list()[0].kind, "high_risk");
  assert.equal(blocks.list()[0].command, "rm -rf ~/Documents");
  code(() => gate("rm", ["-rf", "~/Documents"], { blocks }));
  const third = code(() => gate("rm", ["-rf", "~/Documents"], { blocks }));
  assert.equal(blocks.list().length, 1, "同一任务同一项只一张卡");
  assert.equal(blocks.list()[0].times, 3);
  assert.equal(third.details.blocked_times, 3);
  assert.ok(third.details.instructions_for_ai.some((x) => x.includes("已多次被拦")));
});

test("清空磁盘永远不做：管理员和旧 erase 开关都不能放行", () => {
  for (const admin of [false, true]) for (const erase of [false, true]) {
    for (const [program, args] of [
      ["diskutil", ["eraseDisk", "APFS", "X", "disk4"]],
      ["sudo", ["diskutil", "eraseDisk", "APFS", "X", "disk4"]],
    ]) {
      const e = code(() => gate(program, args, { data: { high_risk: { admin, erase } } }));
      assert.equal(e.code, "NEVER_ALLOWED");
      assert.equal(e.details.never_id, "erase");
      assert.equal(e.details.blocked.kind, "never");
      assert.equal(e.details.blocked.where, null);
      assert.equal(e.details.blocked.confirm, null);
    }
  }
});

test("开着但文件范围是文件夹：要整台电脑", () => {
  const e = code(() => gate("shutdown", ["-h", "now"], { data: { mode: "auto", high_risk: { power: true } } }));
  assert.equal(e.code, "NEEDS_FULL_ACCESS");
  assert.equal(e.details.where_to_enable, SCOPE_WHERE);
});

test("文件夹档里 open、osascript 直接说要整台电脑（Mac）", () => {
  for (const [p, a] of [
    ["open", ["-a", "Finder"]],
    ["/usr/bin/osascript", ["-e", 'tell application "Finder" to get name of startup disk']],
    ["env", ["FOO=1", "open", "x.pkg"]],
  ]) {
    const e = code(() => gate(p, a, { data: { mode: "auto" } }));
    assert.equal(e?.code, "NEEDS_FULL_ACCESS", p);
  }
  assert.equal(gate("open", ["x.pkg"], { data: { mode: "full" } }).admin, null);
  assert.equal(gate("open", ["x.pkg"], { data: { mode: "auto" }, platform: "linux" }).admin, null);
});

test("永远不做：su、关 ChatHand", () => {
  assert.equal(code(() => gate("su", ["root"])).code, "PROGRAM_BLOCKED");
  assert.equal(code(() => gate("pkill", ["node"])).code, "NEVER_ALLOWED");
  assert.equal(code(() => gate("rm", ["-rf", "/Applications/ChatHand.app"])).code, "NEVER_ALLOWED");
});

test("管理员：只收顶层 sudo 直接写法，返回要执行的 argv", () => {
  const on = { high_risk: { admin: true } };
  const r = gate("sudo", ["-u", "ken", "softwareupdate", "-i", "-a"], { data: on });
  assert.deepEqual(r.admin, { options: ["-u", "ken"], argv: ["softwareupdate", "-i", "-a"], display: ["sudo", "-u", "ken", "softwareupdate", "-i", "-a"] });
  for (const [p, a, extra] of [
    ["/bin/sh", ["-c", "sudo -n true"]],
    ["sudo", ["-S", "ls"]],
    ["sudo", ["-i"]],
    ["osascript", ["-e", 'do shell script "ls" with administrator privileges']],
    ["sudo", ["ls"], { pty: true }],
    ["sudo", ["ls"], { stdin_mode: "pipe" }],
    ["sudo", ["ls"], { mode: "service" }],
  ]) {
    const e = code(() => gate(p, a, { data: on, spec: extra || {} }));
    assert.equal(e?.code, "ADMIN_FORM_UNSUPPORTED", [p, ...a].join(" "));
    assert.ok(e.details.supported_form.includes("sudo"));
  }
});

test("三个开关：哪些工具算哪一项；默认开", () => {
  assert.equal(capabilityOf("propose_command"), "terminal");
  assert.equal(capabilityOf("command_input"), "terminal");
  assert.equal(capabilityOf("browser_open"), "browser");
  assert.equal(capabilityOf("desktop_action", { action: "open_url" }), "browser");
  assert.equal(capabilityOf("desktop_action", { action: "reveal" }), null);
  assert.equal(capabilityOf("computer_action"), "desktop");
  assert.equal(capabilityOf("browser_status"), null);
  assert.equal(capabilityOf("computer_status"), null);
  assert.equal(capabilityOf("read_file"), null);
  for (const id of CAPABILITY_IDS) assert.equal(capabilityOn({ data: {} }, id), true);
  assert.equal(capabilityOn({ data: { browser_enabled: false } }, "browser"), false);
  const e = capabilityError("browser");
  assert.equal(e.code, "CAPABILITY_OFF");
  assert.equal(e.details.where_to_enable, "ChatHand 首页右边「权限与能力」→ 浏览器控制 → 打开开关");
  assert.equal(needsFullAccessError("x").code, "NEEDS_FULL_ACCESS");
});

test("bridge_info 看得到每一项开没开、在哪里打开", () => {
  const info = permissionsInfo({ data: { mode: "auto", terminal_enabled: false, high_risk: { admin: true } } });
  assert.equal(info.file_scope, "folder");
  assert.equal(info.capabilities.terminal.enabled, false);
  assert.equal(info.capabilities.browser.enabled, true);
  const admin = info.high_risk.find((r) => r.id === "admin");
  assert.equal(admin.enabled, true);
  assert.equal(admin.usable_now, false);
  assert.deepEqual(info.high_risk.map(r => r.id), [
    "admin", "bulk_delete", "keychain", "pipe_run", "gatekeeper", "bulk_perm", "autostart", "power", "chatgpt_self",
  ]);
  assert.ok(info.never.includes("清空或格式化磁盘"));
  assert.ok(info.admin_flow.includes("不用输密码"));
  // 开着、但系统里的规则没了：说要重新开一次，现在用不了
  const lost = permissionsInfo({ data: { mode: "full", high_risk: { admin: true } } }, { adminReady: false }).high_risk.find((r) => r.id === "admin");
  assert.equal(lost.needs_setup, true);
  assert.equal(lost.usable_now, false);
  const fine = permissionsInfo({ data: { mode: "full", high_risk: { admin: true } } }, { adminReady: true }).high_risk.find((r) => r.id === "admin");
  assert.equal(fine.usable_now, true);
  assert.equal("needs_setup" in fine, false);
});

test("「已拦下」：收起后同一项再被拦会重新出一张", () => {
  const b = new Blocks();
  const first = b.record({ kind: "high_risk", id: "power", name: "关机", command: "shutdown -h now", task_id: "t" });
  assert.equal(b.dismiss(first.block_id).dismissed, true);
  assert.equal(b.list().length, 0);
  b.record({ kind: "high_risk", id: "power", name: "关机", command: "shutdown -h now", task_id: "t" });
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].times, 1);
  assert.equal("key" in b.list()[0], false);
});

test("cleanError 只给白名单错误码带 details，长度有上限", () => {
  const e = Object.assign(Error("x"), { code: "HIGH_RISK_DISABLED", details: { text: "长".repeat(5000), list: Array(50).fill(1) } });
  const r = cleanError(e);
  assert.equal(r.details.text.length, 1200);
  assert.equal(r.details.list.length, 20);
  assert.equal(cleanError(Object.assign(Error("y"), { code: "SOMETHING_ELSE", details: { a: 1 } })).details, undefined);
  assert.equal(errorRecovery("HIGH_RISK_DISABLED").next_action, "explain_to_user_and_wait");
  assert.equal(errorRecovery("CAPABILITY_OFF").automatic_retry, false);
  assert.match(WORKFLOW_INSTRUCTIONS, /HIGH_RISK_DISABLED/);
  assert.match(WORKFLOW_INSTRUCTIONS.slice(0, 512), /report its receipt once and STOP/);
});

test("管理员命令：经小助手运行，-u/-g 交给小助手，-E/-H 照传，目录带空格也对", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(appleString('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.deepEqual(adminArgs({ program: "/usr/sbin/softwareupdate", argv: ["softwareupdate", "-i", "-a"], options: [], cwd: "/Users/fixture/My Work" }), ["-n", HELPER_PATH, "--cd", "/Users/fixture/My Work", "--", "/usr/sbin/softwareupdate", "-i", "-a"]);
  assert.deepEqual(adminArgs({ program: "/usr/bin/touch", argv: ["touch", "a b"], options: ["-u", "ken", "-EH", "--group=staff"], cwd: "/tmp" }), ["-n", "-E", "-H", HELPER_PATH, "--cd", "/tmp", "--user", "ken", "--group", "staff", "--", "/usr/bin/touch", "a b"]);
});

test("管理员命令结束后：规则没了要说清楚怎么恢复；正常的按退出码", () => {
  const job = (stdout, stderr = "", status = "completed") => ({
    status,
    admin: { display: ["sudo", "x"] },
    events: [...(stdout ? [{ cursor: 0, stream: "stdout", text: stdout }] : []), ...(stderr ? [{ cursor: 1, stream: "stderr", text: stderr }] : [])],
  });
  assert.equal(settleAdminJob(job("hello\n")), "ok");
  const failed = job("", "ls: /nope: No such file\n", "failed");
  assert.equal(settleAdminJob(failed), "command_failed");
  const lost = job("", "sudo: a password is required\n", "failed");
  assert.equal(settleAdminJob(lost), "setup_required");
  assert.match(lost.admin.message, /关掉再打开一次/);
  const stopped = job("", "", "cancelled");
  assert.equal(settleAdminJob(stopped), null, "用户自己停下的不改");
  assert.equal(stopped.status, "cancelled");
  const e = adminSetupError();
  assert.equal(e.code, "ADMIN_SETUP_REQUIRED");
  assert.equal(cleanError(e).details.where_to_enable.includes("关掉再打开一次"), true);
  assert.equal(errorRecovery("ADMIN_SETUP_REQUIRED").next_action, "explain_to_user_and_wait");
});

test("整台电脑的环境：系统代理变成环境变量，PATH 去重", () => {
  const out = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}`;
  const env = systemProxyEnv(out);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.http_proxy, "http://127.0.0.1:7890");
  assert.equal(env.ALL_PROXY, "socks5h://127.0.0.1:7891");
  assert.ok(env.NO_PROXY.split(",").includes(".local"));
  assert.ok(env.NO_PROXY.split(",").includes("localhost"));
  assert.deepEqual(systemProxyEnv("HTTPSEnable : 0"), {});
  assert.equal(mergePath("/a:/b", "/b:/c:relative:/a"), "/a:/b:/c");
});
