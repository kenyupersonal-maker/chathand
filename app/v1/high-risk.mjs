import {t} from "../i18n.mjs";
/** 高危命令：清单、文案、识别。
 * 一份文案，四处用：设置页、开启前的确认、拦下时回给 ChatGPT 的说明、首页「已拦下」卡。
 * 这是「防手滑、让用户知情」的闸门，不是防专门绕过的围墙：脚本里再调用、编码后执行都识别不了，识别不了就放行并记录。
 * 最后一道锁仍是 macOS 自己（管理员密码、钥匙串弹窗、改系统保护要进恢复模式）。 */
import path from "node:path";
import os from "node:os";
import {blockedReceipt} from "./blocked.mjs";

export const HIGH_RISK = [
  { id: "admin", name: t("permissions.risk.admin.name"), cmd: "sudo", level: "极高", what: t("permissions.risk.admin.what"), harm: t("permissions.risk.admin.harm"), enable_note: t("permissions.risk.admin.enable_note") },
  { id: "erase", name: t("permissions.risk.erase.name"), cmd: "diskutil erase… · dd · mkfs", level: "极高", what: t("permissions.risk.erase.what"), harm: t("permissions.risk.erase.harm") },
  { id: "bulk_delete", name: t("permissions.risk.bulk_delete.name"), cmd: "rm -rf · find -delete · rsync --delete", level: "高", what: t("permissions.risk.bulk_delete.what"), harm: t("permissions.risk.bulk_delete.harm") },
  { id: "keychain", name: t("permissions.risk.keychain.name"), cmd: "security …", level: "高", what: t("permissions.risk.keychain.what"), harm: t("permissions.risk.keychain.harm") },
  { id: "pipe_run", name: t("permissions.risk.pipe_run.name"), cmd: "curl … | sh", level: "高", what: t("permissions.risk.pipe_run.what"), harm: t("permissions.risk.pipe_run.harm") },
  { id: "gatekeeper", name: t("permissions.risk.gatekeeper.name"), cmd: "xattr -d com.apple.quarantine · spctl · csrutil", level: "高", what: t("permissions.risk.gatekeeper.what"), harm: t("permissions.risk.gatekeeper.harm") },
  { id: "bulk_perm", name: t("permissions.risk.bulk_perm.name"), cmd: "chmod -R · chown -R", level: "中", what: t("permissions.risk.bulk_perm.what"), harm: t("permissions.risk.bulk_perm.harm") },
  { id: "autostart", name: t("permissions.risk.autostart.name"), cmd: "launchctl load · crontab · at", level: "中", what: t("permissions.risk.autostart.what"), harm: t("permissions.risk.autostart.harm") },
  { id: "power", name: t("permissions.risk.power.name"), cmd: "shutdown · reboot · pmset sleepnow · networksetup", level: "中", what: t("permissions.risk.power.what"), harm: t("permissions.risk.power.harm") },
  { id: "chatgpt_self", name: t("permissions.risk.chatgpt_self.name"), cmd: t("permissions.risk.chatgpt_self.commandLabel"), level: "高", what: t("permissions.risk.chatgpt_self.what"), harm: t("permissions.risk.chatgpt_self.harm") },
].filter(r => r.id !== "erase").map(r => ({ ...r, level_text: t(r.level === "极高" ? "permissions.level.extreme" : r.level === "高" ? "permissions.level.high" : "permissions.level.medium"), group: ["admin", "autostart"].includes(r.id) ? "common" : "danger" }));
// Keep the legacy setting readable for upgrades; no disk erase gate consumes it.
export const HIGH_RISK_IDS = [...HIGH_RISK.map((r) => r.id), "erase"];
export const NEVER = [
  { id: "erase", name: t("permissions.never.erase.name"), why: t("permissions.never.erase.why") },
  { id: "password", name: t("permissions.never.password.name"), why: t("permissions.never.password.why") },
  { id: "self", name: t("permissions.never.self.name"), why: t("permissions.never.self.why") },
  { id: "switch_user", name: t("permissions.never.switch_user.name"), why: t("permissions.never.switch_user.why") },
];
export const riskById = (id) => HIGH_RISK.find((r) => r.id === id);
export const whereToEnable = (id) => t(riskById(id)?.group === "common" ? "permissions.enable.commonPath" : "permissions.enable.dangerPath", {name:riskById(id)?.name || id});
export function commonPermissionDetails(id) {
  return {
    requires_local_user: true,
    requires_computer_password: id === "admin",
    local_action: id === "admin" ? t("permissions.localAction.admin", {path:whereToEnable(id)}) : t("permissions.localAction.other", {path:whereToEnable(id)}),
    retry: false,
    notification: { page: "settings", section: "commands", item: id },
  };
}
export const INSTRUCTIONS_FOR_AI = [
  t("permissions.ai.noBypass"),
  t("permissions.ai.alternative"),
  t("permissions.ai.switchOff"),
  t("permissions.ai.switchOn"),
  t("permissions.ai.computerPassword"),
];
export function defaultSwitches() {
  return Object.fromEntries(HIGH_RISK_IDS.map((id) => [id, false]));
}
export function normalizeSwitches(value) {
  const out = defaultSwitches();
  if (value && typeof value === "object") for (const id of HIGH_RISK_IDS) out[id] = value[id] === true;
  return out;
}

/* ---------- 把 shell 文本拆成一段一段的命令 ---------- */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "tcsh", "csh"]);
const STDIN_RUNNERS = new Set([...SHELLS, "python", "python3", "perl", "ruby", "node", "ChatHandNode", "osascript", "php"]);
const FETCHERS = new Set(["curl", "wget", "fetch", "http", "aria2c"]);
const WRAPPERS = new Set(["env", "nice", "nohup", "time", "command", "exec", "builtin", "caffeinate", "timeout", "gtimeout", "stdbuf", "arch", "xcrun", "ionice", "chrt"]);

/** 很小的 shell 词法：认单双引号、反斜杠、$(...)、`...`、<(...)、>(...)、( ) { } 分组、; && || | & 和换行，
 * 输出重定向（> >> &> 2>），输入重定向和 2>&1 这类只跳过，here-doc（<<EOF … EOF）的正文单独收起来。
 * 返回 { segments:[{words:[...], redirects:[...], pipeTo:boolean, heredoc?:string}], subs:[脚本文本], procSubs:[脚本文本] } */
export function splitShell(script) {
  const segments = [];
  const subs = [],
    procSubs = [];
  let words = [],
    redirects = [],
    word = "",
    hasWord = false,
    pendingRedirect = false,
    pendingSkip = false,
    pendingHeredoc = false,
    heredocs = [], // 这一行里等着读正文的 here-doc：{ delim, strip, segment }
    current = null; // 当前这段命令（还没 push 时先占位，here-doc 正文要挂上去）
  const segmentRef = () => (current ??= { words, redirects, pipeTo: false });
  const pushWord = () => {
    if (!hasWord) return;
    if (pendingHeredoc) {
      heredocs.push({ delim: word, strip: pendingHeredoc === "-", segment: segmentRef() });
      pendingHeredoc = false;
    } else if (pendingSkip) pendingSkip = false;
    else if (pendingRedirect) {
      redirects.push(word);
      pendingRedirect = false;
    } else if (/^\d*[<>]&(\d+|-)$/.test(word)) {
      // 2>&1、>&-：复制或关闭文件描述符，不是文件
    } else if (/^\d*>{1,2}\S+/.test(word) && !/^\d*>&\d/.test(word)) redirects.push(word.replace(/^\d*>{1,2}/, ""));
    else if (/^\d*>{1,2}$/.test(word) || word === "&>" || word === "&>>") pendingRedirect = true;
    else if (/^\d*<<-?$/.test(word)) pendingHeredoc = word.endsWith("-") ? "-" : true;
    else if (/^\d*<<-?\S+/.test(word) && !/^\d*<<</.test(word)) heredocs.push({ delim: word.replace(/^\d*<<-?/, ""), strip: /^\d*<<-/.test(word), segment: segmentRef() });
    else if (/^\d*<{1,3}$/.test(word)) pendingSkip = true; // 输入重定向：后面那个词是读的文件
    else if (/^\d*<{1,3}\S/.test(word) && !/^<\(/.test(word)) {
      // <file、<<<"text"：只读，不是参数
    } else words.push(word);
    word = "";
    hasWord = false;
  };
  const endSegment = (pipeTo = false) => {
    pushWord();
    if (words.length || redirects.length) {
      const seg = segmentRef();
      seg.pipeTo = pipeTo;
      segments.push(seg);
    } else if (pipeTo && segments.length) segments[segments.length - 1].pipeTo = true;
    words = [];
    redirects = [];
    current = null;
    pendingRedirect = false;
    pendingSkip = false;
    pendingHeredoc = false;
  };
  const readHeredocs = (i) => {
    // i 指向换行；把后面的正文按顺序读给这一行的 here-doc，返回正文结束后的位置（指向最后一个换行）
    let at = i;
    for (const h of heredocs) {
      const body = [];
      for (;;) {
        if (at >= script.length) break;
        const nl = script.indexOf("\n", at + 1);
        const line = script.slice(at + 1, nl < 0 ? script.length : nl);
        at = nl < 0 ? script.length : nl;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        body.push(line);
      }
      h.segment.heredoc = (h.segment.heredoc ? h.segment.heredoc + "\n" : "") + body.join("\n");
    }
    heredocs = [];
    return at;
  };
  const readBalanced = (i, open, close) => {
    // i 指向 open 之后的第一个字符；返回 [内容, 结束位置]
    let depth = 1,
      j = i,
      quote = null;
    for (; j < script.length; j++) {
      const c = script[j];
      if (quote) {
        if (c === "\\" && quote === '"') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return [script.slice(i, j), j];
    }
    return [script.slice(i), script.length - 1];
  };
  let quote = null;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < script.length && '"\\$`\n'.includes(script[i + 1])) word += script[++i];
      else if (c === "$" && script[i + 1] === "(") {
        const [inner, end] = readBalanced(i + 2, "(", ")");
        subs.push(inner);
        word += "$(" + inner + ")";
        i = end;
      } else if (c === "`") {
        const end = script.indexOf("`", i + 1);
        const inner = script.slice(i + 1, end < 0 ? script.length : end);
        subs.push(inner);
        word += "`" + inner + "`";
        i = end < 0 ? script.length : end;
      } else word += c;
      continue;
    }
    if (c === "\\") {
      if (script[i + 1] === "\n") i++;
      else if (i + 1 < script.length) {
        word += script[++i];
        hasWord = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
      continue;
    }
    if (c === "$" && script[i + 1] === "(") {
      const [inner, end] = readBalanced(i + 2, "(", ")");
      subs.push(inner);
      word += "$(" + inner + ")";
      hasWord = true;
      i = end;
      continue;
    }
    if (c === "`") {
      const end = script.indexOf("`", i + 1);
      const inner = script.slice(i + 1, end < 0 ? script.length : end);
      subs.push(inner);
      word += "`" + inner + "`";
      hasWord = true;
      i = end < 0 ? script.length : end;
      continue;
    }
    if ((c === "<" || c === ">") && script[i + 1] === "(") {
      const [inner, end] = readBalanced(i + 2, "(", ")");
      procSubs.push(inner);
      pushWord();
      words.push(c + "(" + inner + ")");
      i = end;
      continue;
    }
    if (c === "#" && !hasWord) {
      const nl = script.indexOf("\n", i);
      i = nl < 0 ? script.length : nl - 1;
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment();
      if (c === "\n" && heredocs.length) i = readHeredocs(i);
      continue;
    }
    if (c === "&") {
      if (script[i + 1] === "&") {
        i++;
        endSegment();
        continue;
      }
      if (script[i + 1] === ">") {
        pushWord();
        word = "&>";
        hasWord = true;
        i++;
        if (script[i + 1] === ">") {
          word += ">";
          i++;
        }
        pushWord();
        continue;
      }
      if (word.endsWith(">")) {
        word += c;
        continue;
      }
      endSegment();
      continue;
    }
    if (c === "|") {
      if (script[i + 1] === "|") {
        i++;
        endSegment();
        continue;
      }
      if (script[i + 1] === "&") i++;
      endSegment(true);
      continue;
    }
    if ((c === "(" || c === ")" || c === "{" || c === "}") && !hasWord) {
      endSegment();
      continue;
    }
    if (c === ")" && hasWord) {
      endSegment();
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      continue;
    }
    word += c;
    hasWord = true;
  }
  endSegment();
  if (heredocs.length) readHeredocs(script.length);
  return { segments, subs, procSubs };
}

/* ---------- 路径：什么算「大文件夹」 ---------- */
function bigFolders(home) {
  const h = (p) => path.join(home, p);
  return new Set(
    [
      "/",
      "/Users",
      "/Applications",
      "/Library",
      "/System",
      "/private",
      "/usr",
      "/bin",
      "/sbin",
      "/etc",
      "/var",
      "/opt",
      "/Volumes",
      home,
      ...["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music", "Library", "Public", "Applications", "Library/Mobile Documents"].map(h),
    ].map((p) => p.replace(/\/+$/, "") || "/"),
  );
}
function expandHome(p, home) {
  return String(p)
    .replace(/^~(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^\$HOME(?=\/|$)/, home);
}
/** 返回规范化后的绝对路径；带 * 通配的只认「某个目录下的全部」这种写法 */
export function targetPath(raw, { cwd, home }) {
  let p = expandHome(raw, home);
  if (/^\$|`|\$\(/.test(p)) return null; // 变量没法知道指向哪里
  let all = false;
  if (/(^|\/)\*+$/.test(p) || /(^|\/)\.\*$/.test(p)) {
    all = true;
    p = p.replace(/\/?\.?\*+$/, "") || ".";
  }
  if (/[*?[\]]/.test(p)) return null;
  const abs = path.resolve(cwd || home, p);
  const norm = abs.replace(/\/+$/, "") || "/";
  const volumeRoot = /^\/Volumes\/[^/]+$/.test(norm);
  return { path: norm, all, volumeRoot };
}
export function isBigFolder(raw, ctx) {
  const t = targetPath(raw, ctx);
  if (!t) return false;
  return bigFolders(ctx.home).has(t.path) || t.volumeRoot;
}
const LAUNCH_DIRS = (home) => [path.join(home, "Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"];
function inLaunchDir(raw, ctx) {
  const t = targetPath(raw, ctx);
  if (!t) return /LaunchAgents|LaunchDaemons/.test(String(raw));
  return LAUNCH_DIRS(ctx.home).some((d) => t.path === d || t.path.startsWith(d + "/"));
}

/* ---------- 识别一条命令（已经拆好的 argv） ---------- */
const optionArgs = (args) => args.filter((a) => a.startsWith("-"));
const plainArgs = (args) => args.filter((a) => !a.startsWith("-"));
const hasFlag = (args, re) => args.some((a) => (/^-[A-Za-z]+$/.test(a) && re.test(a.slice(1))) || false);

function unwrap(argv) {
  // 去掉 env、nohup、nice 这类外壳，返回真正的程序和参数
  let a = [...argv];
  for (let guard = 0; guard < 8 && a.length; guard++) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
    const prog = path.basename(a[0] || "");
    if (!WRAPPERS.has(prog)) break;
    a.shift();
    if (prog === "env") {
      while (a.length && (a[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]))) {
        if (["-u", "--unset", "-C", "--chdir", "-S"].includes(a[0])) a.shift();
        a.shift();
      }
    } else if (prog === "nice" || prog === "ionice" || prog === "chrt") {
      while (a.length && a[0].startsWith("-")) {
        if (["-n", "-c", "-p"].includes(a[0])) a.shift();
        a.shift();
      }
    } else if (prog === "timeout" || prog === "gtimeout") {
      while (a.length && a[0].startsWith("-")) {
        if (["-s", "-k", "--signal", "--kill-after"].includes(a[0])) a.shift();
        a.shift();
      }
      a.shift(); // 时长
    } else if (prog === "caffeinate") {
      while (a.length && a[0].startsWith("-")) {
        if (["-t", "-w"].includes(a[0])) a.shift();
        a.shift();
      }
    } else if (prog === "arch") {
      while (a.length && a[0].startsWith("-")) a.shift();
    } else if (prog === "xcrun") {
      while (a.length && a[0].startsWith("-")) {
        if (["--sdk", "--toolchain"].includes(a[0])) a.shift();
        a.shift();
      }
    } else if (prog === "stdbuf") {
      while (a.length && a[0].startsWith("-")) a.shift();
    } else while (a.length && a[0].startsWith("-") && a[0] !== "--") a.shift();
    if (a[0] === "--") a.shift();
  }
  return a;
}

/** sudo 的写法：只接受 sudo [-u 用户] [-g 组] [-E] [-H] [-n] [-P] 命令…；-S、-A、-i、-s 这类一律不收 */
export function parseSudo(args) {
  const a = [...args];
  const opts = [];
  while (a.length && a[0].startsWith("-")) {
    const o = a.shift();
    if (o === "--") break;
    if (["-u", "-g", "--user", "--group"].includes(o)) {
      if (!a.length) return { ok: false, reason: "sudo 的 -u/-g 后面缺少名字。" };
      opts.push(o, a.shift());
      continue;
    }
    if (/^--(user|group)=/.test(o)) {
      opts.push(o);
      continue;
    }
    if (/^-[EHnP]+$/.test(o) || ["--preserve-env", "--set-home", "--non-interactive", "--preserve-groups"].includes(o)) {
      opts.push(o);
      continue;
    }
    return {
      ok: false,
      reason: `不支持 sudo ${o}。只支持「sudo 命令…」（可带 -u、-E），不读输入流，也不进入交互 shell。`,
    };
  }
  if (!a.length) return { ok: false, reason: "sudo 后面缺少要运行的命令。" };
  if (path.basename(a[0]) === "sudo") return parseSudo(a.slice(1));
  return { ok: true, options: opts, argv: a };
}

function osascriptText(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "-e" && i + 1 < args.length) out.push(args[++i]);
  return out.join("\n");
}
function appleScriptStrings(text) {
  // do shell script "..." 里的命令（AppleScript 字符串转义只有 \" 和 \\）
  return [...String(text).matchAll(/do\s+shell\s+script\s+"((?:[^"\\]|\\.)*)"/gi)].map((m) => m[1].replace(/\\(["\\])/g, "$1"));
}

const add = (hits, id, evidence) => {
  if (!hits.some((h) => h.id === id)) hits.push({ id, evidence });
};

function classifyArgv(argv, ctx, out, depth) {
  const a = unwrap(argv);
  if (!a.length) return;
  const prog = path.basename(a[0]);
  const args = a.slice(1);
  const cmdText = [prog, ...args].join(" ").slice(0, 200);
  // 换新版只能走 request_update + 用户在 ChatHand 窗口点「安装」：不让 AI 直接跑升级事务、本机安装脚本或升级助手。
  const runsFile = (name, runners) => prog === name || (runners.test(prog) && args.some((x) => path.basename(String(x)) === name));
  if (["ken-upgrade-control", "ChatHandUpgradeControl"].includes(prog) || runsFile("install-local-build.sh", /^(bash|sh|zsh|dash|ksh)$/) || runsFile("upgrade.mjs", /^(node|nodejs|ChatHandNode|bun|deno)$/)) {
    out.never ??= { id: "self", evidence: cmdText };
    return;
  }
  // 永远不开放
  if (prog === "su" || prog === "doas") {
    out.never ??= { id: "switch_user", evidence: cmdText };
    return;
  }
  if (prog === "sudoedit" || prog === "visudo") {
    out.never ??= { id: "password", evidence: cmdText };
    return;
  }
  if (prog === "sudo") {
    add(out.hits, "admin", cmdText);
    const s = parseSudo(args);
    out.admin = s;
    if (s.ok) classifyArgv(s.argv, ctx, out, depth + 1);
    return;
  }
  if (["kill", "killall", "pkill"].includes(prog)) {
    if (killsSelf(prog, args, ctx)) out.never ??= { id: "self", evidence: cmdText };
    return;
  }
  // 套了一层 shell：sh -c "…"
  if (SHELLS.has(prog)) {
    for (let i = 0; i < args.length; i++) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[i]) && i + 1 < args.length) {
        try {
          if (splitShell(args[i + 1]).subs.some((x) => mentionsFetcher(x, ctx))) add(out.hits, "pipe_run", cmdText);
        } catch {}
        classifyScript(args[i + 1], ctx, out, depth + 1);
        break;
      }
      if (/^[<>]\(/.test(args[i])) {
        // bash <(curl …)
        const inner = args[i].slice(2, -1);
        if (mentionsFetcher(inner, ctx)) add(out.hits, "pipe_run", cmdText);
        classifyScript(inner, ctx, out, depth + 1);
      }
    }
    return;
  }
  if (prog === "eval") {
    classifyScript(args.join(" "), ctx, out, depth + 1);
    if (args.some((x) => mentionsFetcher(x, ctx))) add(out.hits, "pipe_run", cmdText);
    return;
  }
  if (prog === "source" || prog === ".") {
    if (args.some((x) => /^<\(/.test(x) && mentionsFetcher(x, ctx))) add(out.hits, "pipe_run", cmdText);
    return;
  }
  if (prog === "osascript") {
    const text = osascriptText(args);
    // 1029：只能由用户本人确认；辅助功能脚本不许点 ChatHand 自己或通知中心。
    if (/System\s+Events/i.test(text) && /ChatHand|Notification\s*Center|通知中心/i.test(text)) {
      out.never ??= { id: "self", evidence: "用脚本点 ChatHand 自己或通知中心，等于 AI 替自己批准" };
      return;
    }
    if (/with\s+administrator\s+privileges/i.test(text)) add(out.hits, "admin", cmdText);
    if (/\b(restart|shut\s*down|sleep|log\s*out)\b/i.test(text) && /(system events|finder|loginwindow)/i.test(text)) add(out.hits, "power", cmdText);
    if (/make\s+(new\s+)?login\s+item/i.test(text)) add(out.hits, "autostart", cmdText);
    if (/\bquit\b/i.test(text) && /chathand/i.test(text)) out.never ??= { id: "self", evidence: cmdText };
    for (const inner of appleScriptStrings(text)) classifyScript(inner, ctx, out, depth + 1);
    return;
  }
  if (prog === "xargs") {
    // xargs 的目标来自输入，看不到；只认危险程序本身
    const rest = args.filter((x) => !x.startsWith("-"));
    if (rest.length && ["shutdown", "reboot", "halt"].includes(path.basename(rest[0]))) add(out.hits, "power", cmdText);
    return;
  }
  // 1 清空或格式化磁盘
  if (prog === "diskutil") {
    const verb = plainArgs(args)[0] || "";
    const second = plainArgs(args)[1] || "";
    if (/^(erase\w*|zeroDisk|randomDisk|secureErase|reformat|partitionDisk|eraseVolume|eraseDisk)$/i.test(verb)) add(out.hits, "erase", cmdText);
    if (/^(apfs|cs|appleRAID|ar)$/i.test(verb) && /^(delete\w*|erase\w*)$/i.test(second)) add(out.hits, "erase", cmdText);
  }
  if (prog === "dd" && args.some((x) => /^of=\/dev\//.test(x))) add(out.hits, "erase", cmdText);
  if (/^(mkfs|newfs)(\.|_|$)/.test(prog) || prog === "newfs_apfs" || prog === "newfs_hfs" || prog === "newfs_msdos" || prog === "newfs_exfat")
    add(out.hits, "erase", cmdText);
  if (prog === "gpt" && /^(destroy|create)$/.test(plainArgs(args)[0] || "")) add(out.hits, "erase", cmdText);
  if (prog === "asr" && /^(restore|imagescan)$/.test(plainArgs(args)[0] || "") && args.includes("--erase")) add(out.hits, "erase", cmdText);
  // 2 一次性删除整个大文件夹
  if (prog === "rm" || prog === "srm") {
    const recursive = args.some((x) => x === "--recursive" || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(x));
    const targets = args.filter((x) => !x.startsWith("-") || x === "-");
    if (recursive && targets.some((t) => isBigFolder(t, ctx))) add(out.hits, "bulk_delete", cmdText);
    if (targets.some((t) => touchesSelf(t, ctx))) out.never ??= { id: "self", evidence: cmdText };
  }
  if (prog === "find") {
    const roots = [];
    for (const x of args) {
      if (x.startsWith("-") || x === "(" || x === "!") break;
      roots.push(x);
    }
    const deletes = args.includes("-delete") || args.some((x, i) => ["-exec", "-execdir", "-ok"].includes(x) && /^(rm|srm|unlink)$/.test(path.basename(args[i + 1] || "")));
    // 带了 -name 这类筛选，只删挑出来的文件，不算「整个删掉」
    const narrowed = args.some((x) => /^-(i?name|i?path|i?regex|i?wholename|newer\w*|[amc](time|min)|size|empty|user|perm|links)$/.test(x));
    if (deletes && !narrowed && roots.some((r) => isBigFolder(r, ctx))) add(out.hits, "bulk_delete", cmdText);
  }
  if (prog === "rsync" && args.some((x) => /^--delete/.test(x))) {
    const rest = plainArgs(args);
    const dest = rest[rest.length - 1];
    if (dest && !dest.includes(":") && isBigFolder(dest, ctx)) add(out.hits, "bulk_delete", cmdText);
  }
  if (prog === "mv" && plainArgs(args).some((t) => touchesSelf(t, ctx))) out.never ??= { id: "self", evidence: cmdText };
  // 3 读取钥匙串里的密码
  if (prog === "security") {
    const verb = plainArgs(args)[0] || "";
    if (/^find-(generic|internet)-password$/.test(verb) && args.some((x) => /^-[A-Za-z]*[wg][A-Za-z]*$/.test(x))) add(out.hits, "keychain", cmdText);
    if (verb === "dump-keychain" && args.some((x) => /^-[A-Za-z]*d[A-Za-z]*$/.test(x))) add(out.hits, "keychain", cmdText);
    if (/^(export|export-identity)$/.test(verb)) add(out.hits, "keychain", cmdText);
  }
  // 5 绕过系统的安全检查
  if (prog === "xattr") {
    const flags = optionArgs(args).join("");
    if ((/[dc]/.test(flags) && args.includes("com.apple.quarantine")) || /c/.test(flags)) add(out.hits, "gatekeeper", cmdText);
  }
  if (prog === "spctl" && args.some((x) => /^--(master-disable|global-disable|disable|add|remove)$/.test(x))) add(out.hits, "gatekeeper", cmdText);
  if (prog === "csrutil" && !(plainArgs(args)[0] === "status" || !args.length)) add(out.hits, "gatekeeper", cmdText);
  if (prog === "defaults" && /^write$/.test(args[0] || "") && /LaunchServices/.test(args[1] || "") && /LSQuarantine/.test(args.join(" ")))
    add(out.hits, "gatekeeper", cmdText);
  // 6 批量改整个大文件夹的权限
  if (["chmod", "chown", "chgrp", "chflags"].includes(prog)) {
    const recursive = args.some((x) => /^-[A-Za-z]*R[A-Za-z]*$/.test(x));
    if (recursive && plainArgs(args).slice(1).some((t) => isBigFolder(t, ctx))) add(out.hits, "bulk_perm", cmdText);
  }
  // 7 开机自启或定时运行
  if (prog === "launchctl") {
    const verb = plainArgs(args)[0] || "";
    if (/^(load|bootstrap|enable|submit)$/.test(verb)) add(out.hits, "autostart", cmdText);
    if (/^(reboot)$/.test(verb)) add(out.hits, "power", cmdText);
    if (/^(bootout|remove|kill|kickstart|disable|unload|stop)$/.test(verb) && /chathand|ken[ -_]?bridge/i.test(args.join(" "))) out.never ??= { id: "self", evidence: cmdText };
  }
  if (prog === "crontab") {
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-u") {
        i++;
        continue;
      }
      rest.push(args[i]);
    }
    if (!(rest.length && rest.every((x) => x === "-l"))) add(out.hits, "autostart", cmdText); // 只有 crontab -l（看）放行；改、删、从输入装都算
  }
  if (prog === "at" || prog === "batch") add(out.hits, "autostart", cmdText);
  if (["cp", "mv", "ln", "install", "ditto", "rsync", "tee", "touch", "curl", "wget", "plutil"].includes(prog) && args.some((t) => !t.startsWith("-") && inLaunchDir(t, ctx)))
    add(out.hits, "autostart", cmdText);
  if (prog === "defaults" && /^write$/.test(args[0] || "") && /(loginwindow|loginitems)/i.test(args[1] || "") && /(LoginHook|AutoLaunched|SessionItems)/i.test(args.join(" ")))
    add(out.hits, "autostart", cmdText);
  // 8 关机、重启、睡眠或断网
  if (["shutdown", "reboot", "halt", "poweroff"].includes(prog)) add(out.hits, "power", cmdText);
  if (prog === "pmset" && args.some((x) => /^(sleepnow|restoredefaults)$/.test(x))) add(out.hits, "power", cmdText);
  if (prog === "networksetup" && args.some((x) => /^-(set|switch|remove|create|delete|add)/i.test(x))) add(out.hits, "power", cmdText);
  if (prog === "ifconfig" && args.includes("down")) add(out.hits, "power", cmdText);
  if (prog === "airport" && args.some((x) => /^(-z|--disassociate)$/.test(x))) add(out.hits, "power", cmdText);
}
/** kill / killall / pkill 会不会打到 ChatHand 自己（本机服务是 node 进程，通道是 tunnel-client） */
function safeRegExp(text, flags = "") {
  try {
    return new RegExp(text, flags);
  } catch {
    return null;
  }
}
function killsSelf(prog, args, ctx) {
  if (/chathand|tunnel-client|ken[ -_]?bridge/i.test(args.join(" "))) return true;
  if (prog === "kill") {
    const targets = args.filter((x, i) => !(i === 0 && /^-/.test(x) && x !== "-1") && x !== "-s" && args[i - 1] !== "-s");
    return targets.some((x) => x === "-1" || ctx.selfPids.has(Number(x)));
  }
  const withValue = new Set(["-u", "-U", "-g", "-G", "-t", "-P", "-s", "-F", "-c", "--signal", "-SIGNAL"]);
  const patterns = [];
  for (let i = 0; i < args.length; i++) {
    if (withValue.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) patterns.push(args[i]);
  }
  if (prog === "killall") {
    const regex = args.includes("-m");
    return patterns.some((n) => (regex ? ctx.selfNames.some((name) => safeRegExp(n)?.test(name)) : ctx.selfNames.includes(n)));
  }
  const full = args.some((x) => /^-[A-Za-z]*f[A-Za-z]*$/.test(x));
  const insensitive = args.some((x) => /^-[A-Za-z]*i[A-Za-z]*$/.test(x));
  const pool = full ? ctx.selfCmdlines : ctx.selfNames;
  return patterns.some((p) => pool.some((name) => safeRegExp(p, insensitive ? "i" : "")?.test(name)));
}
function touchesSelf(raw, ctx) {
  const t = targetPath(raw, ctx);
  if (!t) return false;
  return ctx.selfPaths.some((p) => t.path === p || t.path.startsWith(p + "/"));
}
function mentionsFetcher(text, ctx) {
  try {
    const { segments, subs } = splitShell(String(text).replace(/^[<>]\(|\)$/g, ""));
    if (segments.some((s) => FETCHERS.has(path.basename(unwrap(s.words)[0] || "")))) return true;
    return subs.some((x) => mentionsFetcher(x, ctx));
  } catch {
    return /\b(curl|wget)\b/.test(String(text));
  }
}
/** 这条命令会不会把标准输入当脚本跑：sh、bash（不带脚本文件、不带 -c），也认 sudo sh */
function readsScriptFromStdin(words) {
  let argv = unwrap(words);
  if (path.basename(argv[0] || "") === "sudo") {
    const s = parseSudo(argv.slice(1));
    if (!s.ok) return false;
    argv = unwrap(s.argv);
  }
  const prog = path.basename(argv[0] || "");
  if (!SHELLS.has(prog)) return false;
  const rest = argv.slice(1);
  if (rest.some((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x))) return false;
  return !rest.some((x) => !x.startsWith("-"));
}
function classifyScript(script, ctx, out, depth) {
  if (depth > 4) {
    out.unparsed.push("嵌套太深");
    return;
  }
  let parsed;
  try {
    parsed = splitShell(String(script));
  } catch {
    out.unparsed.push("无法解析 shell 文本");
    return;
  }
  const { segments, subs, procSubs } = parsed;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const argv = unwrap(seg.words);
    const prog = path.basename(argv[0] || "");
    // 下载后直接交给解释器：curl … | sh
    if (seg.pipeTo && FETCHERS.has(prog)) {
      const next = segments[i + 1];
      const nargv = next ? unwrap(next.words) : [];
      let nprog = path.basename(nargv[0] || "");
      let nargs = nargv.slice(1);
      if (nprog === "sudo") {
        const s = parseSudo(nargs);
        if (s.ok) {
          nprog = path.basename(s.argv[0] || "");
          nargs = s.argv.slice(1);
        }
      }
      if (STDIN_RUNNERS.has(nprog) && !nargs.some((x) => !x.startsWith("-") && x !== "-")) add(out.hits, "pipe_run", [prog, "…", "|", nprog].join(" "));
    }
    // 命令替换里有下载，再交给 shell / eval 执行：sh -c "$(curl …)"、eval "$(curl …)"
    if ((SHELLS.has(prog) || prog === "eval") && seg.words.some((w) => /\$\(|`/.test(w) && mentionsFetcher(w.replace(/^.*?\$\(|\)\s*$/g, ""), ctx)))
      add(out.hits, "pipe_run", prog + " …$(curl …)");
    for (const r of seg.redirects) if (inLaunchDir(r, ctx)) add(out.hits, "autostart", "> " + r);
    // here-doc 正文交给 shell 跑的（bash <<EOF、sudo sh <<EOF、cat <<EOF | sh），正文也要看
    if (seg.heredoc && (readsScriptFromStdin(seg.words) || (seg.pipeTo && segments[i + 1] && readsScriptFromStdin(segments[i + 1].words))))
      classifyScript(seg.heredoc, ctx, out, depth + 1);
    classifyArgv(seg.words, ctx, out, depth);
  }
  for (const s of [...subs, ...procSubs]) classifyScript(s, ctx, out, depth + 1);
}

const SELF_PROCESS_NAMES = ["node", "tunnel-client", "KenBridge", "ChatHand", "ChatHandNode", "ChatHandUpgradeControl", "ChatHandDocumentReader", "ChatHandBrowserHost", "ChatHandArtifactIO", "ChatHandTunnel", "ChatHandCloudflared", "ChatHandInstaller"];

/** 对一次 propose_command 做识别。program/args 是 ChatGPT 给的原样参数。 */
export function classifyCommand({ program, args = [], cwd, home = os.homedir(), selfPids = [], selfPaths = [], selfNames = SELF_PROCESS_NAMES, selfCmdlines = [] }) {
  const ctx = {
    cwd: cwd || home,
    home,
    selfPids: new Set(selfPids.filter(Boolean).map(Number)),
    selfPaths: selfPaths.filter(Boolean).map((p) => p.replace(/\/+$/, "")),
    selfNames: [...new Set([...SELF_PROCESS_NAMES, ...selfNames.filter(Boolean)])],
    selfCmdlines: selfCmdlines.filter(Boolean),
  };
  const out = { hits: [], never: null, admin: null, unparsed: [] };
  classifyArgv([String(program), ...args.map(String)], ctx, out, 0);
  out.hits = out.hits.filter((h, i, all) => all.findIndex((x) => x.id === h.id) === i);
  return out;
}

/** 拦下时回给 ChatGPT 的错误：带作用、危害、在哪里打开、给 AI 的指示和可直接改写的话 */
export function highRiskError(id, { command = "", times = 1 } = {}) {
  if(id === "erase") return neverError("erase", command);
  const r = riskById(id);
  const common = r.group === "common";
  const e = new Error(t(common ? "permissions.block.common" : "permissions.block.danger",{name:r.name}));
  e.code = "HIGH_RISK_DISABLED";
  e.details = {
    risk_id: id,
    risk_name: r.name,
    group: r.group,
    what_it_does: r.what,
    harm: r.harm,
    where_to_enable: whereToEnable(id),
    enabled_now: false,
    blocked_times: times,
    instructions_for_ai: [...INSTRUCTIONS_FOR_AI, ...(times >= 3 ? ["已多次被拦，停止重试，先和用户说明。"] : [])],
    say_to_user_template: t("permissions.block.sayToUser",{name:r.name,path:whereToEnable(id)}),
  };
  e.details.blocked = blockedReceipt({kind:"can_enable",gate:common ? "common" : "high_risk",id,name:r.name,cause:`${command || r.cmd}：${e.message}`,can_do:r.what,risk:r.harm,path:whereToEnable(id),link:`chathand://settings/commands/${id}`,alternative:id === "pipe_run" ? t("permissions.explanation.pipeAlternative") : t("permissions.explanation.disabledAlternative")});
  // Keep the old receipt shape for older clients, but new blocked calls only
  // explain the user's switch. They never ask for a card or a polling loop.
  Object.assign(e.details.blocked, {
    answer_in_chat: false,
    say_to_user: [e.details.say_to_user_template],
    next: t("permissions.ai.switchOff"),
  });
  if (common) {
    Object.assign(e.details, commonPermissionDetails(id));
    e.details.instructions_for_ai = [...INSTRUCTIONS_FOR_AI,e.details.local_action];
    e.details.say_to_user_template = t("permissions.block.commonSay",{name:r.name,action:e.details.local_action});
  }
  if (id === "pipe_run") e.details.instructions_for_ai.push("先下载到文件、看过内容再运行。");
  return e;
}
export function neverError(id, evidence = "") {
  const n = NEVER.find((x) => x.id === id) || NEVER.find((x) => x.id === "self");
  const e = new Error(t("permissions.block.never",{name:n.name,why:n.why}));
  e.code = id === "switch_user" ? "PROGRAM_BLOCKED" : "NEVER_ALLOWED";
  e.details = { never_id: n.id, never_name: n.name, why: n.why, evidence: String(evidence).slice(0, 200), instructions_for_ai: ["不要重试，也不要换写法绕过。", "跟用户说清楚这一步做不了，换别的办法，或请用户自己动手。", ...(n.id === "self" ? ["要把 ChatHand 换成你做好的新版，用 request_update 申请，由用户在 ChatHand 窗口点「安装」。"] : [])] };
  e.details.blocked = blockedReceipt({kind:"never",gate:"never",id:n.id,name:n.name,cause:`${evidence || "propose_command"}：${e.message}`,can_do:t("permissions.explanation.neverUnavailable"),risk:n.why,alternative:n.id === "self" ? t("permissions.explanation.selfUpdate") : t("permissions.explanation.neverAlternative")});
  return e;
}
export function adminFormError(reason) {
  const e = new Error(reason);
  e.code = "ADMIN_FORM_UNSUPPORTED";
  e.details = { supported_form: "sudo 命令…（可带 -u 用户、-E）", why: "ChatHand 只认直接写的 sudo 命令，这样用户在任务记录里看得到以管理员身份运行了什么。", instructions_for_ai: ["改成「sudo 命令…」的直接写法再提议一次。", t("permissions.ai.sudoPassword")] };
  return e;
}
