/** 管理员命令（Ken 10/2 定，第一版从简）：
 * - 在 ChatHand 窗口里打开「以管理员身份运行」时，macOS 弹一次系统授权框（电脑密码；系统支持时可用 Touch ID），
 *   装一个只有 root 能改的小助手和一条 sudoers 规则：当前账户可以不输密码、以 root 运行这个小助手。
 * - 之后 ChatGPT 提议的「sudo 命令…」直接经小助手以管理员身份运行，ChatHand 不再弹卡片、不发通知；
 *   远程时的提醒交给 ChatGPT 对话里自带的确认卡片。
 * - 关掉开关时，小助手把规则和它自己删掉，不用再输密码。
 * 代价（写进了这一项的「危害」）：开着期间，这台 Mac 上以这个账户运行的其它程序也能借这条规则拿到管理员权限。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fail } from "../../engine/src/core.mjs";
import { dataDirectory } from "../v07/paths.mjs";
import { highRiskError } from "./high-risk.mjs";

/** Test/isolated instances must never probe or mutate the machine's admin helper. */
export class NoopAdminAccess {
  constructor(reason = "isolated_instance") { this.lastReason = reason; }
  supported() { return false; }
  ready() { return false; }
  async install() { return { status: "blocked", reason: this.lastReason }; }
  uninstall() { return { status: "blocked", reason: this.lastReason }; }
}

/** Fail closed unless this is the normal persisted desktop instance.
 * Short-circuit tests before even looking up the real user's data directory.
 * Explicit fake adminAccess objects are injected by the caller, not enabled by a flag. */
export function createDefaultAdminAccess({ stateDir, isolated = false } = {}) {
  if (process.env.NODE_TEST_CONTEXT) return new NoopAdminAccess("test_environment");
  if (isolated || typeof stateDir !== "string" || !path.isAbsolute(stateDir)) return new NoopAdminAccess();
  try {
    if (fs.realpathSync(stateDir) !== fs.realpathSync(dataDirectory())) return new NoopAdminAccess();
  } catch { return new NoopAdminAccess("state_directory_unverified"); }
  return new AdminAccess();
}

export const HELPER_PATH = "/Library/PrivilegedHelperTools/com.kenyu.chathand.admin";
export const SUDOERS_PATH = "/private/etc/sudoers.d/chathand";
export const HELPER_OK = "chathand-admin-ok";
const INSTALLED = "chathand-admin-installed";
const ROOT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** shell 单引号：' → '\'' */
export const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** AppleScript 字符串：只需要转义 \ 和 " */
export const appleString = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

/** 找到程序的完整路径（以 root 运行时 PATH 很短，所以先在用户的 PATH 里找好） */
export function resolveProgram(name, searchPath) {
  if (typeof name !== "string" || !name || name.length > 1024 || /[\0\r\n]/.test(name)) fail("PROGRAM_INVALID", "程序名称不正确。");
  const ok = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (name.includes("/")) {
    if (!path.isAbsolute(name)) fail("PROGRAM_INVALID", "sudo 后面的程序请写完整路径或程序名。");
    if (ok(name)) return name;
    fail("PROGRAM_MISSING", "找不到 sudo 后面的程序。");
  }
  for (const dir of [...String(searchPath || "").split(":"), ...ROOT_PATH.split(":")].filter(Boolean)) {
    const p = path.join(dir, name);
    if (ok(p)) return p;
  }
  fail("PROGRAM_MISSING", `找不到程序「${name}」；可以写完整路径。`);
}

/** 装到 /Library/PrivilegedHelperTools 的小助手（root:wheel 755）。
 * 用法：com.kenyu.chathand.admin --cd 目录 [--user 名字] [--group 名字] -- 程序 参数…
 *       com.kenyu.chathand.admin --check | --uninstall */
export const HELPER_SCRIPT = `#!/bin/sh
# ChatHand 管理员小助手：由 ChatHand 安装，只有 root 能改。
# 只在 ChatHand「高危命令 → 以管理员身份运行」打开时存在；关掉开关时 ChatHand 用 --uninstall 删掉规则和它自己。
case "$1" in
  --check) echo ${HELPER_OK}; exit 0 ;;
  --uninstall) /bin/rm -f ${SUDOERS_PATH}; /bin/rm -f ${HELPER_PATH}; exit 0 ;;
esac
dir=/; user=; group=
while [ $# -gt 0 ]; do
  case "$1" in
    --cd) dir=$2; shift 2 ;;
    --user) user=$2; shift 2 ;;
    --group) group=$2; shift 2 ;;
    --) shift; break ;;
    *) echo "chathand-admin: bad arguments" >&2; exit 126 ;;
  esac
done
[ $# -gt 0 ] || { echo "chathand-admin: nothing to run" >&2; exit 126; }
cd "$dir" || exit 125
if [ -n "$user" ] && [ -n "$group" ]; then exec /usr/bin/sudo -n -u "$user" -g "$group" -- "$@"; fi
if [ -n "$user" ]; then exec /usr/bin/sudo -n -u "$user" -- "$@"; fi
if [ -n "$group" ]; then exec /usr/bin/sudo -n -g "$group" -- "$@"; fi
exec "$@"
`;

/** sudoers 里那一行：只允许这个账户以 root 运行小助手；SETENV 让「sudo -E」照常能用 */
export function sudoersLine(user) {
  if (typeof user !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(user)) fail("ADMIN_SETUP_FAILED", "没认出当前账户名，没法设置管理员权限。");
  return `${user} ALL=(root) NOPASSWD:SETENV: ${HELPER_PATH}`;
}

/** 系统授权框里执行的那一段（root 的 /bin/sh）：小助手和规则的内容都写在这段里，不经过临时文件，中途不会被换掉；
 * 规则先用 visudo 检查，过了才放进 sudoers.d（名字带点的临时文件 sudo 会跳过）。 */
export function installShell(user) {
  const helper = Buffer.from(HELPER_SCRIPT).toString("base64");
  const helperMd5 = crypto.createHash("md5").update(HELPER_SCRIPT).digest("hex");
  return [
    "set -e",
    "umask 022",
    'h=; s=; trap \'/bin/rm -f "$h" "$s"\' EXIT',
    "/bin/mkdir -p /Library/PrivilegedHelperTools /private/etc/sudoers.d",
    "h=$(/usr/bin/mktemp /Library/PrivilegedHelperTools/.chathand.XXXXXX)",
    `/usr/bin/printf '%s' ${shellQuote(helper)} | /usr/bin/base64 -D > "$h"`,
    // 管道里前面失败 set -e 拦不住：解出来的内容先核对，不对就停，不会装上一个空的小助手
    `[ "$(/sbin/md5 -q "$h")" = ${shellQuote(helperMd5)} ]`,
    '/usr/sbin/chown root:wheel "$h"',
    '/bin/chmod 755 "$h"',
    `/bin/mv -f "$h" ${HELPER_PATH}`,
    "s=$(/usr/bin/mktemp /private/etc/sudoers.d/.chathand.XXXXXX)",
    `/usr/bin/printf '%s\\n' ${shellQuote(sudoersLine(user))} > "$s"`,
    '/usr/sbin/chown root:wheel "$s"',
    '/bin/chmod 440 "$s"',
    '/usr/sbin/visudo -cf "$s" >/dev/null',
    `/bin/mv -f "$s" ${SUDOERS_PATH}`,
    `echo ${INSTALLED}`,
  ].join("; ");
}

export const INSTALL_PROMPT = "ChatHand 要打开「以管理员身份运行」。打开后，ChatGPT 运行 sudo 命令不用再输密码；在 ChatHand 里关掉就撤销。";

export function installAppleScript(user) {
  return `do shell script ${appleString(installShell(user))} with prompt ${appleString(INSTALL_PROMPT)} with administrator privileges`;
}

/** ChatGPT 提议的「sudo [选项] 程序 参数…」→ 实际运行的 /usr/bin/sudo 参数 */
export function adminArgs({ program, argv, options = [], cwd }) {
  const out = ["-n"];
  const via = [];
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (o === "-u" || o === "--user") via.push("--user", options[++i]);
    else if (o === "-g" || o === "--group") via.push("--group", options[++i]);
    else if (o.startsWith("--user=")) via.push("--user", o.slice(7));
    else if (o.startsWith("--group=")) via.push("--group", o.slice(8));
    else if (o === "--preserve-env" || (/^-[EHnP]+$/.test(o) && o.includes("E"))) out.includes("-E") || out.push("-E");
    if (o === "--set-home" || (/^-[EHnP]+$/.test(o) && o.includes("H"))) out.includes("-H") || out.push("-H");
  }
  return [...out, HELPER_PATH, "--cd", cwd, ...via, "--", program, ...argv.slice(1)];
}

/** 开关开着、但规则不在了（系统更新清掉、或被手动删了）：不执行，说清楚怎么恢复 */
export function adminSetupError() {
  const e = new Error("管理员权限没有生效（可能被系统更新清掉了），命令没有执行。");
  e.code = "ADMIN_SETUP_REQUIRED";
  e.details = {
    where_to_enable: "ChatHand 首页右边「权限与能力」→ 命令 → 高危命令 →「以管理员身份运行」：关掉再打开一次（要在这台 Mac 前输一次电脑密码，或用 Touch ID）",
    instructions_for_ai: ["不要重试，不要换写法绕过。", "告诉用户：要在 Mac 上把「以管理员身份运行」关掉再打开一次。", "用户说好了以后，先调用 bridge_info 确认，再重新提议这条命令。"],
  };
  const blocked = highRiskError("admin",{command:"sudo 命令"}).details.blocked;
  e.details.blocked = {...blocked,kind:"needs_user",gate:"admin_setup",cause:"sudo 命令："+e.message};
  e.details.blocked.say_to_user[0] = e.details.blocked.cause;
  return e;
}

/** 命令结束后：规则不在了（被系统更新或别的程序清掉）时说清楚怎么恢复 */
const NO_RULE = /sudo: (a password is required|a terminal is required|sorry, you are not allowed)|is not allowed to (execute|run sudo)|not in the sudoers file/i;
export function settleAdminJob(job) {
  const err = job.events.filter((e) => e.stream === "stderr").map((e) => e.text).join("");
  if (NO_RULE.test(err)) {
    if (["completed", "failed"].includes(job.status)) job.status = "failed";
    job.admin.result = "setup_required";
    job.admin.message = "管理员权限没有生效（可能被系统更新清掉了），命令没有执行。请用户在 ChatHand 里把「以管理员身份运行」关掉再打开一次（要输一次电脑密码）。";
    return job.admin.result;
  }
  if (job.status === "completed") job.admin.result = "ok";
  else if (job.status === "failed") job.admin.result = "command_failed";
  return job.admin.result || null;
}

const runAsync = (program, args, { timeout }) =>
  new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      done = false;
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(null);
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

/** 管理员小助手装没装、能不能用；装上、撤销。平台、账户、执行都可以换掉，方便测试。 */
export class AdminAccess {
  #createdInTest;
  #fakeEffects;
  #fakeRemovalStat;
  constructor(options = {}) {
    const { platform = process.platform, user = os.userInfo().username, run = runAsync, runSync = spawnSync, stat = fs.statSync, lstat = fs.lstatSync, now = Date.now } = options;
    Object.assign(this, { platform, user, run, runSync, stat, lstat, now });
    this.#fakeRemovalStat = Object.hasOwn(options, "lstat") && typeof lstat === "function" && lstat !== fs.lstatSync ? lstat : null;
    this.cache = null;
    this.#createdInTest = !!process.env.NODE_TEST_CONTEXT;
    // Existing unit tests explicitly inject ALL system effects. Partial injection
    // or a boolean opt-out must not leave a real default executor reachable.
    this.#fakeEffects = ["run", "runSync", "stat"].every(k => Object.hasOwn(options, k) && typeof options[k] === "function")
      && run !== runAsync && runSync !== spawnSync && stat !== fs.statSync
      ? Object.freeze({ run, runSync, stat }) : null;
  }
  #effectsAllowed() {
    if (!this.#createdInTest && !process.env.NODE_TEST_CONTEXT) return true;
    const f = this.#fakeEffects;
    return !!f && this.run === f.run && this.runSync === f.runSync && this.stat === f.stat
      && this.run !== runAsync && this.runSync !== spawnSync && this.stat !== fs.statSync;
  }
  #requireEffects() {
    if (!this.#effectsAllowed()) {
      const e = new Error("测试环境禁止使用真实管理员能力；请显式注入完整的假管理员对象或全部系统调用替身。");
      e.code = "ADMIN_TEST_CONTEXT_BLOCKED";
      throw e;
    }
  }
  supported() {
    return this.platform === "darwin";
  }
  /** 小助手在、归 root、别人改不了，而且规则让当前账户不输密码就能运行它。结果缓存 60 秒。 */
  ready({ fresh = false } = {}) {
    if (!this.#effectsAllowed()) { this.cache = null; this.lastReason = "test_context_blocked"; return false; }
    if (!this.supported()) return false;
    if (!fresh && this.cache && this.now() - this.cache.at < 60000) return this.cache.ready;
    let ready = false, reason = "helper_missing";
    try {
      const s = this.stat(HELPER_PATH);
      if (s.uid === 0 && (s.mode & 0o022) === 0) {
        const r = this.runSync("/usr/bin/sudo", ["-n", HELPER_PATH, "--check"], { encoding: "utf8", timeout: 5000 });
        ready = r.status === 0 && String(r.stdout || "").includes(HELPER_OK);
        reason = ready ? "ok" : r.status === null ? "check_timeout" : "sudo_check_failed_" + r.status;
      } else reason = "helper_unsafe";
    } catch {}
    // 1026：记下为什么没生效（小助手不在 / 归属不对 / sudo 核对失败），从「好的」变成「不好」时报一次，方便以后查是谁弄没的。
    const was = this.cache?.ready;
    this.cache = { at: this.now(), ready };this.lastReason = reason;
    if (was === true && !ready) try { this.onUnready?.(reason); } catch {}
    return ready;
  }
  /** 弹系统授权框装上。返回 installed / cancelled / failed */
  async install() {
    this.#requireEffects();
    if (!this.supported()) return { status: "installed", note: "not_darwin" };
    const r = await this.run("/usr/bin/osascript", ["-e", installAppleScript(this.user)], { timeout: 5 * 60 * 1000 });
    this.cache = null;
    if (r.status === 0 && r.stdout.includes(INSTALLED) && this.ready({ fresh: true })) return { status: "installed" };
    if (/\(-128\)/.test(r.stderr)) return { status: "cancelled", message: "你在系统授权框里点了取消，管理员权限没有打开。" };
    if (r.status === null) return { status: "failed", message: "等系统授权框超时了，管理员权限没有打开。" };
    return { status: "failed", message: "macOS 没有完成授权，管理员权限没有打开。" };
  }
  #requireRemovalEffects() {
    this.#requireEffects();
    if ((this.#createdInTest || process.env.NODE_TEST_CONTEXT) && (!this.#fakeRemovalStat || this.lstat !== this.#fakeRemovalStat)) {
      const error = new Error("测试环境禁止探查真实管理员文件；请显式注入 lstat 替身。");
      error.code = "ADMIN_TEST_CONTEXT_BLOCKED"; throw error;
    }
  }
  /** Fresh, exact file-entry evidence. Missing symlink targets are not absence. */
  removalEvidence() {
    this.#requireRemovalEffects();
    const paths = [SUDOERS_PATH, HELPER_PATH].map(file => {
      try { this.lstat(file); return {path: file, state: "present"}; }
      catch (error) { return {path: file, state: error?.code === "ENOENT" ? "absent" : "unknown"}; }
    });
    return {status: paths.every(item => item.state === "absent") ? "absent" : paths.some(item => item.state === "unknown") ? "unknown" : "present", paths};
  }
  /** Only the new revocation transaction uses this stronger, confirmed remover.
   * Existing ready() false and uninstall() not_installed are never evidence. */
  uninstallForRevocation() {
    this.#requireRemovalEffects();
    const removed = evidence => ({status: "removed", absence_confirmed: true, evidence});
    if (this.removalEvidence().status === "absent") return removed("fresh_lstat");
    if (!this.supported()) return {status: "unconfirmed", absence_confirmed: false};
    // A matching marker is evidence only when the current privileged launcher
    // is a root-owned, non-writable regular file. Never trust a symlink, a
    // user-controlled helper, or an unreadable ownership/mode observation.
    try {
      const helper = this.lstat(HELPER_PATH);
      if (helper.uid !== 0 || !Number.isSafeInteger(helper.mode) || (helper.mode & 0o170000) !== 0o100000 || (helper.mode & 0o022) !== 0) return {status: "unconfirmed", absence_confirmed: false};
    } catch { return {status: "unconfirmed", absence_confirmed: false}; }
    const receipt = "chathand-admin-removed-" + crypto.randomBytes(32).toString("hex");
    // The existing root-owned helper already accepts this fixed exec form.
    // No user arguments enter the script. Success requires both entries absent,
    // including dangling symlinks, before the fresh receipt can be emitted.
    const script = ["set -e", `/bin/rm -f ${shellQuote(SUDOERS_PATH)} ${shellQuote(HELPER_PATH)}`,
      ...[SUDOERS_PATH, HELPER_PATH].map(file => `[ ! -e ${shellQuote(file)} ] && [ ! -L ${shellQuote(file)} ] || exit 1`),
      `/usr/bin/printf '%s\\n' ${shellQuote(receipt)}`].join("; ");
    try {
      const result = this.runSync("/usr/bin/sudo", ["-n", HELPER_PATH, "--cd", "/", "--", "/bin/sh", "-c", script], {encoding: "utf8", timeout: 5000, maxBuffer: 4096});
      if (result.status === 0 && String(result.stdout || "").trim() === receipt) {
        this.cache = null; return removed("privileged_absence_receipt");
      }
    } catch {}
    this.cache = null;
    // A timeout may have completed removal, but only a fresh independent proof
    // of both absences can resolve that ambiguity; all other outcomes stay shut.
    return this.removalEvidence().status === "absent" ? removed("fresh_lstat") : {status: "unconfirmed", absence_confirmed: false};
  }
  /** 撤销：小助手自己删掉规则和自己，不用密码。规则已经不在时什么也不做。 */
  uninstall() {
    this.#requireEffects();
    if (!this.supported()) return { status: "removed", note: "not_darwin" };
    let ok = false;
    try {
      const r = this.runSync("/usr/bin/sudo", ["-n", HELPER_PATH, "--uninstall"], { encoding: "utf8", timeout: 5000 });
      ok = r.status === 0;
    } catch {}
    this.cache = null;
    return { status: ok ? "removed" : "not_installed" };
  }
}
