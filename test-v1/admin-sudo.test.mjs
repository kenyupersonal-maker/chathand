// 管理员（sudo），10/2 定的第一版：打开开关时 macOS 授权一次，装小助手和 sudoers 规则；之后 sudo 命令直接运行；关掉就撤销。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HELPER_SCRIPT, HELPER_PATH, SUDOERS_PATH, HELPER_OK, installShell, installAppleScript, sudoersLine, AdminAccess } from "../app/v1/admin-command.mjs";
import { createDesktop } from "../app/server.mjs";
import { armUpgradeGuard } from "../app/v08/upgrade-guard.mjs";
import { VERSION } from "../app/product.mjs";

const posix = process.platform !== "win32";

test("小助手：--check、--cd 到带空格的目录、参数原样传、出错有退出码", { skip: !posix }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-helper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 测试里把「以别的用户运行」换成 env，看得出传了哪个用户
  const helper = path.join(dir, "helper.sh");
  fs.writeFileSync(helper, HELPER_SCRIPT.replace(/\/usr\/bin\/sudo -n -u "\$user" -- /g, '/usr/bin/env CHATHAND_AS="$user" '), { mode: 0o755 });
  const run = (...args) => spawnSync("/bin/sh", [helper, ...args], { encoding: "utf8" });
  assert.equal(run("--check").stdout.trim(), HELPER_OK);
  const work = path.join(dir, "My Work");
  fs.mkdirSync(work);
  const r = run("--cd", work, "--", "/bin/sh", "-c", 'pwd; printf "%s|" "$@"', "x", "a b", "它's");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${work}\na b|它's|`);
  assert.match(run("--cd", dir, "--user", "bob", "--", "/usr/bin/env").stdout, /CHATHAND_AS=bob/);
  assert.equal(run("--cd", path.join(dir, "nope"), "--", "/bin/true").status, 125);
  assert.equal(run("--weird").status, 126);
  assert.equal(run("--cd", dir, "--").status, 126);
});

test("装的那一段：只用一次授权框；内容核对过才装；坏了什么都不留", { skip: !posix }, (t) => {
  const user = "ken";
  assert.equal(sudoersLine(user), `ken ALL=(root) NOPASSWD:SETENV: ${HELPER_PATH}`);
  assert.throws(() => sudoersLine("ken ALL=(ALL) ALL"), { code: "ADMIN_SETUP_FAILED" });
  assert.throws(() => sudoersLine(""), { code: "ADMIN_SETUP_FAILED" });
  const script = installAppleScript(user);
  assert.ok(script.startsWith("do shell script "));
  assert.ok(script.endsWith(" with administrator privileges"));
  assert.ok(!/\n/.test(script));
  const sh = installShell(user);
  for (const must of ["/usr/sbin/visudo -cf", "/sbin/md5 -q", "/bin/chmod 440", "/bin/chmod 755", "/usr/sbin/chown root:wheel", SUDOERS_PATH, HELPER_PATH]) assert.ok(sh.includes(must), must);

  // 在一个假的根目录里跑一遍：系统命令换成同名的小替身
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-root-"));
  t.after(() => fs.rmSync(R, { recursive: true, force: true }));
  for (const d of ["usr/bin", "usr/sbin", "bin", "sbin", "Library", "private/etc"]) fs.mkdirSync(path.join(R, d), { recursive: true });
  const shim = (rel, body) => fs.writeFileSync(path.join(R, rel), "#!/bin/sh\n" + body + "\n", { mode: 0o755 });
  shim("usr/bin/base64", 'if base64 -d </dev/null >/dev/null 2>&1; then exec base64 -d; else exec base64 -D; fi');
  shim("usr/sbin/chown", "exit 0");
  shim("usr/sbin/visudo", 'f="$2"; grep -Eq "^[A-Za-z0-9_][A-Za-z0-9_.-]* ALL=\\(root\\) NOPASSWD:SETENV: /" "$f" && [ "$(wc -l < "$f")" -eq 1 ]');
  shim("sbin/md5", '[ "$1" = "-q" ] && shift; if command -v md5sum >/dev/null; then md5sum "$1" | cut -d" " -f1; else /sbin/md5 -q "$1"; fi');
  shim("usr/bin/printf", 'exec /usr/bin/printf "$@"');
  shim("usr/bin/mktemp", 'exec /usr/bin/mktemp "$@"');
  for (const b of ["rm", "mkdir", "chmod", "mv"]) shim(`bin/${b}`, `exec /bin/${b} "$@"`);
  const sim = (text) =>
    text
      .replaceAll("/usr/bin/", `${R}/usr/bin/`)
      .replaceAll("/usr/sbin/", `${R}/usr/sbin/`)
      .replaceAll("/sbin/md5", `${R}/sbin/md5`)
      .replace(/\/bin\/(rm|mkdir|chmod|mv) /g, `${R}/bin/$1 `)
      .replaceAll("/Library/", `${R}/Library/`)
      .replaceAll("/private/etc/", `${R}/private/etc/`);
  const ok = spawnSync("/bin/sh", ["-c", sim(sh)], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /chathand-admin-installed/);
  assert.equal(fs.readFileSync(R + HELPER_PATH, "utf8"), HELPER_SCRIPT);
  assert.equal((fs.statSync(R + HELPER_PATH).mode & 0o777).toString(8), "755");
  assert.equal(fs.readFileSync(R + SUDOERS_PATH, "utf8"), sim(sudoersLine(user)) + "\n", "规则里是小助手的完整路径（假根目录下被一起换了）");
  assert.equal((fs.statSync(R + SUDOERS_PATH).mode & 0o777).toString(8), "440");
  assert.deepEqual(fs.readdirSync(path.dirname(R + SUDOERS_PATH)), ["chathand"], "临时文件都清掉了");

  // 解出来的内容不对（比如 printf 坏了）：什么都不装
  fs.rmSync(R + HELPER_PATH);
  fs.rmSync(R + SUDOERS_PATH);
  shim("usr/bin/printf", "exit 3");
  const bad = spawnSync("/bin/sh", ["-c", sim(sh)], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(R + HELPER_PATH)), []);
  assert.deepEqual(fs.readdirSync(path.dirname(R + SUDOERS_PATH)), []);
});

test("AdminAccess：就绪要小助手归 root、别人改不了、规则真能用；授权框点取消、超时都说清楚", async () => {
  const calls = [];
  let stat = { uid: 0, mode: 0o100755 },
    check = { status: 0, stdout: HELPER_OK + "\n" },
    install = { status: 0, stdout: "chathand-admin-installed\n", stderr: "" };
  let now = 1000;
  const a = new AdminAccess({
    platform: "darwin",
    user: "ken",
    stat: () => stat,
    runSync: (p, args) => (calls.push([p, ...args]), args.includes("--check") ? check : { status: 0 }),
    run: async (p, args) => (calls.push([p, args[0]]), install),
    now: () => now,
  });
  assert.equal(a.ready(), true);
  assert.deepEqual(calls.pop(), ["/usr/bin/sudo", "-n", HELPER_PATH, "--check"]);
  stat = { uid: 501, mode: 0o100755 };
  assert.equal(a.ready(), true, "60 秒内用缓存");
  assert.equal(a.ready({ fresh: true }), false, "不归 root 不算");
  stat = { uid: 0, mode: 0o100777 };
  assert.equal(a.ready({ fresh: true }), false, "别人能改不算");
  stat = { uid: 0, mode: 0o100755 };
  check = { status: 1, stdout: "", stderr: "sudo: a password is required" };
  assert.equal(a.ready({ fresh: true }), false, "规则不在不算");
  check = { status: 0, stdout: HELPER_OK };
  assert.deepEqual(await a.install(), { status: "installed" });
  install = { status: 1, stdout: "", stderr: "0:12: execution error: User canceled. (-128)" };
  assert.equal((await a.install()).status, "cancelled");
  install = { status: null, stdout: "", stderr: "" };
  assert.equal((await a.install()).status, "failed");
  assert.equal(a.uninstall().status, "removed");
  assert.deepEqual(calls.pop(), ["/usr/bin/sudo", "-n", HELPER_PATH, "--uninstall"]);
  const linux = new AdminAccess({ platform: "linux" });
  assert.equal(linux.ready(), false);
  await assert.rejects(() => linux.install(), { code: "ADMIN_TEST_CONTEXT_BLOCKED" }, "测试硬闸先于平台判断，不能把未注入替身的安装报成成功");
});

function fakeAccess({ ready = false, result = "installed" } = {}) {
  const calls = { install: 0, uninstall: 0 };
  const access = {
    calls,
    result,
    isReady: ready,
    supported: () => true,
    ready: () => access.isReady,
    async install() {
      calls.install++;
      if (access.result === "installed") access.isReady = true;
      return access.result === "installed" ? { status: "installed" } : { status: access.result, message: "你在系统授权框里点了取消，管理员权限没有打开。" };
    },
    uninstall() {
      calls.uninstall++;
      access.isReady = false;
      return { status: "removed" };
    },
    uninstallForRevocation() {
      const result = access.uninstall();
      return {...result, absence_confirmed: result?.status === 'removed' && access.isReady === false};
    },
  };
  return access;
}

test("打开开关：先过系统授权框，取消就不开；关掉开关：撤销规则；启动时开关关着、规则还在就撤掉", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-admin-"));
  const work = path.join(base, "work");
  fs.mkdirSync(work);
  const uiKey = "cd".repeat(32);
  const access = fakeAccess({ result: "cancelled" });
  let app = await createDesktop({ stateDir: path.join(base, "state"), defaultRoot: work, uiKey, adminAccess: access });
  t.after(async () => {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const owner = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${app.apiPort}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + app.adminToken, "Content-Type": "application/json", "X-ChatHand-UI": uiKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const cancelled = await owner("/api/settings", { high_risk: { admin: true } });
  assert.equal(cancelled.body.error?.code, "ADMIN_SETUP_CANCELLED");
  assert.equal((await owner("/api/state")).body.settings.high_risk?.admin ?? false, false, "取消了就不开");
  access.result = "installed";
  const on = await owner("/api/settings", { high_risk: { admin: true } });
  assert.equal(on.status, 200);
  assert.equal(access.calls.install, 2);
  let s = (await owner("/api/state")).body;
  assert.equal(s.settings.high_risk.admin, true);
  assert.equal(s.permissions.high_risk.find((r) => r.id === "admin").needs_setup, undefined);
  // 规则被清掉了：界面和 ChatGPT 都看得到要重新开
  access.isReady = false;
  s = (await owner("/api/state")).body;
  assert.equal(s.permissions.high_risk.find((r) => r.id === "admin").needs_setup, true);
  // 再打开一次（开关本来就开着）：重新装
  await owner("/api/settings", { high_risk: { admin: true } });
  assert.equal(access.calls.install, 3);
  const off = await owner("/api/settings", { high_risk: { admin: false } });
  assert.equal(off.status, 200);
  assert.equal(access.calls.uninstall, 1);
  await app.close();
  // 重启：开关关着，规则却还在（比如上次撤销失败）→ 启动时撤掉
  const again = fakeAccess({ ready: true });
  app = await createDesktop({ stateDir: path.join(base, "state"), defaultRoot: work, uiKey, adminAccess: again });
  assert.equal(again.calls.uninstall, 1);
});

test("升级前管理员已开启：验证阶段不撤销规则，提交后仍保持", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-admin-upgrade-"));
  const work = path.join(base, "work");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(work);
  const uiKey = "ef".repeat(32);
  let app = await createDesktop({ stateDir, defaultRoot: work, uiKey, adminAccess: fakeAccess() });
  await app.close();
  armUpgradeGuard(stateDir, VERSION, "admin-upgrade-test", { adminEnabled: true });
  const access = fakeAccess({ ready: true });
  app = await createDesktop({ stateDir, defaultRoot: work, uiKey, adminAccess: access });
  t.after(async () => {
    await app.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.equal(access.calls.uninstall, 0, "验证阶段不能删除系统管理员规则");
  app.state.data.high_risk = { ...(app.state.data.high_risk || {}), admin: true };
  app.state.save();
  const response = await fetch(`http://127.0.0.1:${app.apiPort}/api/upgrade/commit`, {
    method: "POST",
    headers: { Authorization: "Bearer " + app.adminToken, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(access.calls.uninstall, 0, "升级提交后管理员仍开启，不应清理");

  await app.close();
  const stateDirOff = path.join(base, "state-off");
  const workOff = path.join(base, "work-off");
  fs.mkdirSync(workOff);
  app = await createDesktop({ stateDir: stateDirOff, defaultRoot: workOff, uiKey, adminAccess: fakeAccess() });
  await app.close();
  armUpgradeGuard(stateDirOff, VERSION, "admin-upgrade-off-test", { adminEnabled: false });
  const offAccess = fakeAccess({ ready: true });
  app = await createDesktop({ stateDir: stateDirOff, defaultRoot: workOff, uiKey, adminAccess: offAccess });
  assert.equal(offAccess.calls.uninstall, 1, "升级前管理员本来关闭，验证阶段仍应清理残留规则");
});

test("1026：升级校验按规范化比较高危开关；新版本多出的开关项不算不一致", async () => {
  const { retainedUpgradeSetting } = await import("../scripts/upgrade.mjs");
  assert.equal(retainedUpgradeSetting({ high_risk: { admin: true } }, { high_risk: { admin: true, some_new_item: false } }, "high_risk"), true);
  assert.equal(retainedUpgradeSetting({ high_risk: { admin: true } }, { high_risk: { admin: false } }, "high_risk"), false);
  assert.equal(retainedUpgradeSetting({}, { admin_requested: false }, "admin_requested"), true);
  assert.equal(retainedUpgradeSetting({ admin_requested: true }, {}, "admin_requested"), false);
});

test("1026：管理员规则被撤或失效时记下原因（只在本机）", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chathand-admin-log-"));
  const work = path.join(base, "work");fs.mkdirSync(work);
  const stateDir = path.join(base, "state");
  const access = fakeAccess({ ready: true });
  const app = await createDesktop({ stateDir, defaultRoot: work, uiKey: "cd".repeat(32), adminAccess: access });
  t.after(async () => { await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const log = JSON.parse(fs.readFileSync(path.join(stateDir, "admin-events.json"), "utf8"));
  const last = log.at(-1);
  assert.equal(last.event, "uninstall");assert.equal(last.reason, "startup_reconcile");assert.equal(last.switch_on, false);
  assert.ok(!JSON.stringify(log).includes("sudoers"));
});
