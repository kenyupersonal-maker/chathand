import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {safeEnvironment} from '../../engine/src/commands.mjs';
import {fail} from '../../engine/src/core.mjs';
import {APP_ROOT} from './access.mjs';
const q=s=>JSON.stringify(s);
const real=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
const paths=xs=>[...new Set(xs.map(real))];
const rules=(op,list,kind='subpath')=>list.length?`(allow ${op} ${list.map(p=>`(${kind} ${q(p)})`).join(' ')})`:'';
export function sandboxAvailable(){return process.platform==='darwin'&&fs.existsSync('/usr/bin/sandbox-exec');}
export function buildProfile({root,mode='auto',scratch,cache,protectedPaths=[],runtimeRoot=APP_ROOT,extraRead=[]}){
  const read=paths(['/System','/usr','/bin','/sbin','/Library/Apple','/Library/Developer','/Library/Frameworks','/opt/homebrew','/private/etc',path.dirname(path.dirname(process.execPath)),runtimeRoot,root,scratch,cache,...extraRead]);
  const write=paths([root,scratch,cache]);
  const lines=['(version 1)','(deny default)','(allow process-exec process-fork)','(allow signal (target same-sandbox))','(allow process-info* (target same-sandbox))','(allow sysctl-read)','(allow mach-host*)','(allow file-read-metadata)','(allow file-read-data (literal "/"))','(allow ipc-posix-sem)',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.networkd") (global-name "com.apple.trustd.agent") (global-name "com.apple.dnssd.service"))',
    '(allow network-outbound (remote ip "*:*"))','(allow network-bind (local ip "localhost:*"))','(allow network-inbound (local ip "localhost:*"))',
    '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))','(allow file-read* file-write* (literal "/dev/null"))',
    '(allow pseudo-tty)','(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))','(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))','(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))'];
  if(mode==='full')lines.push('(allow file-read* file-write*)');
  else lines.push(rules('file-read*',read),rules('file-write*',write),rules('file-read*',[path.join(os.homedir(),'.gitconfig')],'literal'));
  for(const p of paths(protectedPaths)){
    lines.push(`(deny file-read* file-write* (subpath ${q(p)}))`);
    let parent=path.dirname(p);while(parent!=='/'&&parent!=='.'){lines.push(`(deny file-write-unlink (literal ${q(parent)}))`);parent=path.dirname(parent);}
  }
  lines.push(`(deny file-write* (subpath ${q(real(runtimeRoot))}))`);
  return lines.filter(Boolean).join('\n');
}
export function launchSpec(job,store){
  if(!sandboxAvailable())fail('SANDBOX_UNAVAILABLE','系统沙箱不可用，终端未执行。不会退回不受限制的执行方式。');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'kb06-job-'));
  const cache=path.join(os.homedir(),'Library/Caches/KenBridge/tools');fs.mkdirSync(cache,{recursive:true,mode:0o700});
  const profile=buildProfile({root:store.root,mode:store.accessMode,scratch,cache,protectedPaths:store.protectedPaths,runtimeRoot:store.runtimeRoot});
  let args=['-p',profile,job.program,...job.args];
  if(job.pty){
    const python=[
      '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3',
      '/usr/bin/python3'
    ].find(p=>fs.existsSync(p));
    if(!python)fail('PTY_RUNTIME_MISSING','交互终端需要系统 Python 3；普通命令仍可使用。');
    args=['-p',profile,python,'-I',path.join(APP_ROOT,'app/v06/pty.py'),job.program,...job.args];
  }
  const env={...safeEnvironment(),TMPDIR:scratch,TMP:scratch,TEMP:scratch,TERM:job.pty?'xterm-256color':'dumb',npm_config_cache:path.join(cache,'npm'),PIP_CACHE_DIR:path.join(cache,'pip'),XDG_CACHE_HOME:cache,PYTHONPYCACHEPREFIX:path.join(cache,'python'),CLANG_MODULE_CACHE_PATH:path.join(cache,'clang'),SWIFTPM_MODULECACHE_OVERRIDE:path.join(cache,'swift')};
  job.sandbox={backend:'macOS Seatbelt',scope:store.accessMode,isolated_temp:scratch,pty:!!job.pty};
  job.scratch=scratch;return {program:'/usr/bin/sandbox-exec',args,env};
}
export function probeSandbox(){
  if(!sandboxAvailable())return {available:false,reason:'MACOS_SEATBELT_REQUIRED'};
  const r=spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(deny default)(allow process-exec)(allow file-read*)','/usr/bin/true'],{timeout:3000,encoding:'utf8'});
  return {available:r.status===0,backend:'macOS Seatbelt',exit_code:r.status,error:r.status===0?null:(r.stderr||r.error?.code||'SANDBOX_FAILED').slice(0,300)};
}
