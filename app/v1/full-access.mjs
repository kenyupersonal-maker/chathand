/** 「整台电脑」档：命令直接启动，不套 sandbox-exec（pty 同样）；按当前账户权限运行。
 * 「只在这个文件夹里」仍然永远走系统沙箱（app/v06/sandbox.mjs）。
 * 环境：沿用白名单打底，补上 USER/LOGNAME/SHELL、登录 shell 的 PATH、系统代理、SSH_AUTH_SOCK；
 * 不改临时目录和缓存目录；永远不带 ChatHand 自己的密钥和令牌。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { safeEnvironment } from "../../engine/src/commands.mjs";
import { fail } from "../../engine/src/core.mjs";

const cache = { loginPath: null, loginPathAt: 0, warming: null, proxy: null, proxyAt: 0, ssh: undefined, sshAt: 0, tmp: null };
const user = () => {
  try {
    return os.userInfo();
  } catch {
    return { username: process.env.USER || "", shell: process.env.SHELL || "/bin/zsh" };
  }
};

/** scutil --proxy 的输出 → HTTP(S)_PROXY / ALL_PROXY / NO_PROXY（大小写各一份） */
export function systemProxyEnv(output) {
  const text = String(output || "");
  const field = (k) => text.match(new RegExp(`^\\s*${k}\\s*:\\s*([^\\r\\n]+?)\\s*$`, "m"))?.[1] ?? null;
  const hostOk = (h) => !!h && /^[A-Za-z0-9.\-:\[\]]+$/.test(h);
  const portOk = (p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) < 65536;
  const url = (scheme, h, p) => `${scheme}://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${Number(p)}`;
  const env = {};
  if (field("HTTPEnable") === "1" && hostOk(field("HTTPProxy")) && portOk(field("HTTPPort"))) env.HTTP_PROXY = url("http", field("HTTPProxy"), field("HTTPPort"));
  if (field("HTTPSEnable") === "1" && hostOk(field("HTTPSProxy")) && portOk(field("HTTPSPort"))) env.HTTPS_PROXY = url("http", field("HTTPSProxy"), field("HTTPSPort"));
  if (field("SOCKSEnable") === "1" && hostOk(field("SOCKSProxy")) && portOk(field("SOCKSPort"))) env.ALL_PROXY = url("socks5h", field("SOCKSProxy"), field("SOCKSPort"));
  if (!Object.keys(env).length) return {};
  const list = text.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/)?.[1] || "";
  const exceptions = [...list.matchAll(/^\s*\d+\s*:\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/^\*\./, ".")).filter((x) => /^[A-Za-z0-9.\-:\/*]+$/.test(x));
  env.NO_PROXY = [...new Set(["localhost", "127.0.0.1", "::1", ...exceptions])].join(",");
  for (const k of Object.keys(env)) env[k.toLowerCase()] = env[k];
  return env;
}
function proxyEnv() {
  if (process.platform !== "darwin") return {};
  if (cache.proxy && Date.now() - cache.proxyAt < 30000) return cache.proxy;
  try {
    cache.proxy = systemProxyEnv(execFileSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 1500, maxBuffer: 65536 }));
  } catch {
    cache.proxy = {};
  }
  cache.proxyAt = Date.now();
  return cache.proxy;
}
function sshAuthSock() {
  if (process.platform !== "darwin") return process.env.SSH_AUTH_SOCK || null;
  if (cache.ssh !== undefined && Date.now() - cache.sshAt < 60000) return cache.ssh;
  try {
    const v = execFileSync("/bin/launchctl", ["getenv", "SSH_AUTH_SOCK"], { encoding: "utf8", timeout: 1500, maxBuffer: 4096 }).trim();
    cache.ssh = v && v.startsWith("/") && !/[\0\r\n]/.test(v) ? v : null;
  } catch {
    cache.ssh = null;
  }
  cache.sshAt = Date.now();
  return cache.ssh;
}
function userTemp() {
  if (cache.tmp) return cache.tmp;
  let dir = null;
  if (process.platform === "darwin")
    try {
      dir = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", timeout: 1500 }).trim();
    } catch {}
  cache.tmp = dir && path.isAbsolute(dir) && fs.existsSync(dir) ? dir.replace(/\/+$/, "") : os.tmpdir();
  return cache.tmp;
}
/** 登录 shell 的 PATH：后台取一次（不阻塞服务），10 分钟内复用；取不到就用现有 PATH */
export function warmFullEnvironment({ timeoutMs = 6000 } = {}) {
  if (process.platform !== "darwin") return Promise.resolve(null);
  if (cache.warming) return cache.warming;
  if (cache.loginPath && Date.now() - cache.loginPathAt < 600000) return Promise.resolve(cache.loginPath);
  const { username, shell } = user();
  const sh = shell && fs.existsSync(shell) ? shell : "/bin/zsh";
  const env = { HOME: os.homedir(), USER: username, LOGNAME: username, SHELL: sh, TERM: "dumb", LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const once = (flags) =>
    new Promise((resolve) => {
      execFile(sh, [flags, 'printf "__CHATHAND_PATH__%s__CHATHAND_PATH__" "$PATH"'], { env, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8" }, (_, stdout) =>
        resolve(/__CHATHAND_PATH__([^\n]*?)__CHATHAND_PATH__/.exec(stdout || "")?.[1] || null),
      ).stdin?.end();
    });
  cache.warming = (async () => {
    const value = (await once("-ilc")) || (await once("-lc"));
    if (value) {
      cache.loginPath = value;
      cache.loginPathAt = Date.now();
    }
    return cache.loginPath;
  })().finally(() => {
    cache.warming = null;
  });
  return cache.warming;
}
export function mergePath(...lists) {
  const seen = new Set();
  return lists
    .flatMap((l) => String(l || "").split(":"))
    .filter((d) => d && path.isAbsolute(d) && !/[\0\r\n]/.test(d) && !seen.has(d) && seen.add(d))
    .join(":");
}
export function fullEnvironment({ pty = false } = {}) {
  const base = safeEnvironment();
  const { username, shell } = user();
  if (!cache.loginPath || Date.now() - cache.loginPathAt > 600000) void warmFullEnvironment();
  const env = {
    ...base,
    USER: username,
    LOGNAME: username,
    SHELL: shell || "/bin/zsh",
    PATH: mergePath(cache.loginPath, base.PATH),
    TMPDIR: userTemp(),
    TERM: pty ? "xterm-256color" : "dumb",
    ...proxyEnv(),
  };
  delete env.GIT_CONFIG_NOSYSTEM; // 苹果自带 git 的系统配置里有钥匙串凭据助手
  const sock = sshAuthSock();
  if (sock) env.SSH_AUTH_SOCK = sock;
  return env;
}
export function fullLaunchSpec(job, { appRoot }) {
  const env = fullEnvironment({ pty: job.pty });
  let program = job.program,
    args = job.args;
  if (job.pty) {
    const python = ["/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3", "/usr/bin/python3"].find((p) =>
      fs.existsSync(p),
    );
    if (!python) fail("PTY_RUNTIME_MISSING", "交互终端需要系统 Python 3；普通命令仍可使用。");
    program = python;
    args = ["-I", path.join(appRoot, "app/v06/pty.py"), job.program, ...job.args];
  }
  job.sandbox = { backend: "none", scope: "full", pty: !!job.pty, note: "整台电脑：按当前账户权限运行，不套系统沙箱" };
  return { program, args, env };
}
