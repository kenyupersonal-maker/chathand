import {AsyncLocalStorage} from 'node:async_hooks';
import {isControlDetailCode,controlErrorDetails,foregroundDeliveryDetails,backgroundDeliveryDetails,isLateAuthorizationCode} from './control-errors.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MAX_FILE_BYTES = 256 * 1024;
export const VERSION = '0.3.1';
export function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function privateDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('STATE_UNSAFE', '状态目录不是普通目录。');
  fs.chmodSync(dir, 0o700);
}
export function saveJSON(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {flag: 'wx', mode: 0o600});
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
// Conflict provenance is local to this process. It is evidence of a recorded
// earlier change, never a claim that another writer is currently active.
const fileTasks=new AsyncLocalStorage();
export function hashConflict(store,rel,current,expected){
 const previous=store.runtimeChanges?.get(path.resolve(store.root,rel)),task=fileTasks.getStore()?.store===store?fileTasks.getStore().task:null;
 const conflict={kind:previous?(task&&previous.task_id===task.id?'own_earlier_change':'other_task_change'):'external_change',current_sha256:current,expected_sha256:expected,task_status:task?.status||null,next:'先读一遍现在的内容，跟你要改的比一下，再决定怎么改。'};
 throw Object.assign(new Error('文件和你给的 SHA 对不上，没有改。'),{code:'HASH_CONFLICT',conflict});
}
export function withFileTask(store,task,run){return fileTasks.run({store,task},run);}
// Only these codes may carry structured guidance for the AI (what was blocked, where the user can enable it).
const DETAIL_CODES = new Set(['HIGH_RISK_DISABLED', 'CAPABILITY_OFF', 'NEEDS_FULL_ACCESS', 'ADMIN_FORM_UNSUPPORTED', 'ADMIN_SETUP_REQUIRED', 'NEVER_ALLOWED', 'PROGRAM_BLOCKED', 'PERSONAL_DOWNLOAD_LOCATION', 'SCOPE_REQUIRED', 'CONFIRMATION_PENDING']);
export function redactErrorText(value) {
  return String(value).replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:api[_-]?key|runtime[_-]?key|access[_-]?token|admin[_-]?token|mcp[_-]?token|password)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, '$1[REDACTED]');
}
function boundedDetails(value, depth = 0) {
  if (typeof value === 'string') return redactErrorText(value).slice(0, 1200);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth > 3) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => boundedDetails(v, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [String(k).slice(0, 60), /^(?:api_key|runtime_key|admin_token|mcp_token|password|authorization)$/i.test(k) ? '[REDACTED]' : boundedDetails(v, depth + 1)]));
  return null;
}
export function cleanError(e) {
  if (typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code) && !/^E[A-Z]+$/.test(e.code)) {
    if(e.code==='HASH_CONFLICT'&&e.conflict)return {code:e.code,message:'文件和你给的 SHA 对不上，没有改。',conflict:boundedDetails(e.conflict)};
    if(e.code==='SEARCH_LIMIT')return {code:e.code,message:redactErrorText(e.message),running:boundedDetails(e.running||[]),retry_after_ms:Number.isSafeInteger(e.retry_after_ms)?e.retry_after_ms:20000};
    const details = e.code === 'ADMIN_SETUP_REQUIRED' ? { ...e.details, requires_local_user: true, requires_computer_password: true, local_action: '要你回到电脑前打开一次（要输电脑密码）。密码只在 macOS 授权框里输入。', retry: false } : e.details;
    const controlDetails=controlErrorDetails(e.code,details,redactErrorText);
    const foreground=foregroundDeliveryDetails(details)||(isLateAuthorizationCode(e.code)?backgroundDeliveryDetails(details):null);
    if(foreground&&!isControlDetailCode(e.code))return {code:e.code,message:redactErrorText(e.message),details:foreground};
    if(isControlDetailCode(e.code)&&(!DETAIL_CODES.has(e.code)||e.code==='CAPABILITY_OFF'))return {code:e.code,message:redactErrorText(e.message),...(controlDetails?{details:controlDetails}:{})};
    return DETAIL_CODES.has(e.code) && details && typeof details === 'object' ? {code: e.code, message: redactErrorText(e.message), details: boundedDetails(details)} : {code: e.code, message: redactErrorText(e.message)};
  }
  const known = {ENOENT: '文件或目录不存在。', EACCES: '当前系统账户没有访问权限。', EPERM: '系统拒绝这项操作。', EEXIST: '目标已经存在。', ENOTDIR: '路径中的某一项不是目录。', EISDIR: '目标是目录。', ENOSPC: '磁盘空间不足。'};
  return {code: e.code || 'INTERNAL_ERROR', message: known[e.code] || '操作失败；在本机检查错误记录。'};
}
export class FileStore {
  constructor(root, stateDir) {
    this.stateDir = path.resolve(stateDir);
    privateDir(this.stateDir);
    // Keep the leaf-symlink rejection above; then match setRoot's canonical paths.
    // macOS /var and /private/var may refer to the same physical directory.
    this.stateDir = fs.realpathSync(this.stateDir);
    this.opsDir = path.join(this.stateDir, 'receipts'); privateDir(this.opsDir);
    this.auditFile = path.join(this.stateDir, 'audit.jsonl');
    this.writesEnabled = false; this.paused = false;
    this.setRoot(root);
  }
  setRoot(root) {
    const real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) fail('ROOT_INVALID', '请选择现有项目目录。');
    const home = fs.realpathSync(os.homedir());
    const broad = ['/', home, '/Users', '/System', '/Applications', '/Library', '/etc', '/private', '/var', '/usr', ...['Desktop','Documents','Downloads','Library'].map(x => path.join(home, x))];
    if (broad.includes(real)) fail('ROOT_TOO_BROAD', '不能把整个主目录、系统目录或通用文档目录交给工具。请选择专用项目文件夹。');
    if (this.stateDir === real || this.stateDir.startsWith(real + path.sep) || real.startsWith(this.stateDir + path.sep)) fail('ROOT_STATE_OVERLAP', '项目目录和工具状态目录必须分开。');
    this.root = real; this.writesEnabled = false;
  }
  checkActive(write = false) {
    if (this.paused) fail('PAUSED', '本机已暂停远程操作。');
    if (write && !this.writesEnabled) fail('WRITE_DISABLED', '请用户在本机面板开启本会话文件修改，再继续。');
  }
  audit(event) {
    if (fs.existsSync(this.auditFile) && fs.statSync(this.auditFile).size > 5 * 1024 * 1024) {
      fs.renameSync(this.auditFile, this.auditFile + '.previous');
    }
    fs.appendFileSync(this.auditFile, JSON.stringify({time: new Date().toISOString(), ...event}) + '\n', {mode: 0o600});
  }
  recentEvents() {
    if (!fs.existsSync(this.auditFile)) return [];
    return fs.readFileSync(this.auditFile, 'utf8').trim().split('\n').slice(-35).map(line => {try {return JSON.parse(line);} catch {return {event:'unreadable'};}});
  }
  resolve(rel, {missing = false, directory = false} = {}) {
    if (typeof rel !== 'string' || rel.length > 1024 || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel)) fail('PATH_INVALID', '只能使用项目内的相对路径。');
    if (directory && rel === '.') return this.root;
    const parts = rel.split('/');
    if (!parts.length || parts.some(p => !p || p === '.' || p === '..')) fail('PATH_INVALID', '路径不能包含空段、点或上级目录。');
    let current = this.root;
    // Check every existing component. No links are followed within the chosen root.
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let st;
      try { st = fs.lstatSync(current); } catch (e) {
        if (e.code === 'ENOENT' && missing && i === parts.length - 1) return current;
        throw e;
      }
      if (st.isSymbolicLink()) fail('LINK_BLOCKED', '不允许访问符号链接。');
      if (i < parts.length - 1 && !st.isDirectory()) fail('PATH_INVALID', '路径中包含非目录项。');
      if (st.isFile() && st.nlink > 1) fail('LINK_BLOCKED', '不允许访问有多个硬链接的文件。');
      if (!st.isDirectory() && !st.isFile()) fail('TYPE_BLOCKED', '只支持普通文件和目录。');
    }
    return current;
  }
  bytes(rel) {
    const file = this.resolve(rel);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink > 1) fail('TYPE_BLOCKED', '只能读取普通、非硬链接文件。');
      if (st.size > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', '单个文本文件上限为 256 KiB。');
      const buf = fs.readFileSync(fd);
      if (buf.length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', '文件在读取时超过大小限制。');
      if (buf.includes(0)) fail('BINARY_BLOCKED', '该文件不是受支持的文本文件。');
      let content;
      try { content = new TextDecoder('utf-8', {fatal: true}).decode(buf); }
      catch { fail('ENCODING_BLOCKED', '只支持 UTF-8 文本。'); }
      return {buf, content, sha256: digest(buf), mode: st.mode & 0o777};
    } finally { fs.closeSync(fd); }
  }
  info() {
    this.checkActive();
    return {name:'Ken Local Bridge',version:VERSION,workspace_name:path.basename(this.root),writes_enabled:this.writesEnabled,scope:'file tools: selected project; terminal: user-account privileges with local approval',max_file_bytes:MAX_FILE_BYTES,not_os_sandbox:true};
  }
  list(rel = '.') {
    this.checkActive();
    const dir = this.resolve(rel, {directory: true});
    if (!fs.statSync(dir).isDirectory()) fail('TYPE_BLOCKED', '目标不是目录。');
    const entries = fs.readdirSync(dir, {withFileTypes:true}).filter(e => {try {this.resolve(rel === '.' ? e.name : rel + '/' + e.name); return e.isDirectory() || e.isFile();} catch {return false;}}).map(e => ({name:e.name,type:e.isDirectory()?'directory':'file'}));
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    this.audit({event:'list_directory',path:rel});
    return {path:rel,entries:entries.slice(0,300),truncated:entries.length>300};
  }
  read(rel, startLine = 1, maxLines = 250) {
    this.checkActive();
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 1000) fail('ARG_INVALID','行数范围不正确。');
    const {content,sha256} = this.bytes(rel); const lines = content.split('\n');
    this.audit({event:'read_text',path:rel,sha256});
    return {path:rel,sha256,total_lines:lines.length,start_line:startLine,content:lines.slice(startLine-1,startLine-1+maxLines).join('\n'),truncated:startLine-1+maxLines<lines.length};
  }
  operationFile(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(id)) fail('OP_INVALID','operation_id 需为 8–96 个字母、数字、下划线或短横线。');
    return path.join(this.opsDir, id + '.json');
  }
  write(rel, content, expected, operationId) {
    this.checkActive(true);
    if (typeof content !== 'string' || Buffer.byteLength(content)>MAX_FILE_BYTES || content.includes('\0')) fail('CONTENT_INVALID','只允许不超过 256 KiB 的文本。');
    if (expected !== 'MISSING' && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected))) fail('HASH_REQUIRED','expected_sha256 必须是刚读取到的哈希；新文件使用 MISSING。');
    const receiptFile = this.operationFile(operationId);
    const fingerprint = digest(JSON.stringify([this.root,rel,content,expected]));
    if (fs.existsSync(receiptFile)) {
      const old=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
      if (old.fingerprint!==fingerprint) fail('OP_CONFLICT','同一 operation_id 不能用于不同内容。');
      if (old.status==='applied') return {...old.result,replayed:true,notice:'之前的结果；如需当前状态，请重新读取文件。'};
      fail('OP_INCOMPLETE','该操作留有未完成记录。请在本机检查文件与备份，禁止盲目重试。');
    }
    const target = this.resolve(rel,{missing:true});
    let before=null;
    try { before=this.bytes(rel); } catch(e) {if(e.code!=='ENOENT')throw e;}
    const actual=before?before.sha256:'MISSING';
    if(actual!==expected)hashConflict(this,rel,actual,expected);
    const afterHash=digest(content);
    const receipt={version:1,id:operationId,root:this.root,path:rel,fingerprint,status:'prepared',created_at:new Date().toISOString(),before:before?{content:before.content,sha256:before.sha256,mode:before.mode}:null,after_sha256:afterHash};
    this.audit({event:'write_prepared',path:rel,operation_id:operationId});
    saveJSON(receiptFile,receipt); // Recovery data is committed before modifying the project.
    const tmp=path.join(path.dirname(target),`.ken-write-${crypto.randomUUID()}`);
    try {
      const fd=fs.openSync(tmp,'wx',before?before.mode:0o600);
      try {fs.writeFileSync(fd,content,'utf8');fs.fsyncSync(fd);} finally{fs.closeSync(fd);}
      const targetAgain=this.resolve(rel,{missing:true});
      let latest='MISSING';try{latest=this.bytes(rel).sha256;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(latest!==expected)hashConflict(this,rel,latest,expected);
      if (expected==='MISSING') {
        // link creates the destination atomically without replacing a concurrently created file.
        fs.linkSync(tmp,targetAgain); fs.unlinkSync(tmp);
      } else fs.renameSync(tmp,targetAgain);
      receipt.status='applied';receipt.result={path:rel,sha256:afterHash,receipt_id:operationId,created:before===null};
      saveJSON(receiptFile,receipt);
      this.audit({event:'write_text',path:rel,operation_id:operationId,sha256:afterHash});
      return receipt.result;
    } finally {try{fs.unlinkSync(tmp);}catch{}}
  }
  restore(receiptId, operationId) {
    this.checkActive(true);
    const record=JSON.parse(fs.readFileSync(this.operationFile(receiptId),'utf8'));
    if(record.root!==this.root || record.status!=='applied') fail('RESTORE_INVALID','备份不属于当前项目或不是已完成操作。');
    if(!record.before)fail('RESTORE_CREATE_UNSUPPORTED','这条记录是新建文件；本版不提供远程删除，请在本机移除。');
    return this.write(record.path,record.before.content,record.after_sha256,operationId);
  }
}
