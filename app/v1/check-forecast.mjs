// 1022 预报：这一次调用会不会让 OpenAI 多查一下（帮助文档 20001326：网络安全、生物相关会额外检查）。
// 只用来提前提醒用户「停住了发继续，别点重试」，不改、不拆、不藏任何内容。
export const FORECAST_RANK=Object.freeze({none:0,maybe:1,likely:2});

// 会直接被多查的话题：一个就到「可能」，两个就「很可能」。
const STRONG=['exploit','payload','shellcode','privilege escalation','sandbox escape','bypass','malware','ransomware','keylogger','rootkit','backdoor','reverse shell','credential dump','phishing','zero-day','0day','pathogen','toxin','提权','越狱','绕过','恶意软件','勒索','键盘记录','后门','反弹 shell','凭据窃取','钓鱼','武器化','病原体','毒素'];
// 系统安全相关的普通词：单个不算，凑够几个才算。
const MEDIUM=['sandbox','seatbelt','sandbox-exec','codesign','notarize','keychain','sudo','administrator','setuid','sigkill','pkill','killall','kill','launchd','launchagent','launchdaemon','persistence','tcc','entitlement','entitlements','permission','permissions','firewall','intercept','inject','injection','ptrace','dtrace','debugger','certificate','decrypt','encrypt','password','passwords','credential','credentials','xattr','quarantine','gatekeeper','spctl','csrutil','mitm','vulnerability','pentest','nmap','virus','high-risk','full-access',
 '沙箱','签名','公证','钥匙串','管理员','开机自启','权限','防火墙','拦截','注入','证书','解密','加密','密码','凭据','隔离属性','抓包','漏洞','渗透','扫描端口','病毒','高危','完全访问'];
// ChatHand 自己仓库里内容本身就容易被多查的文件（开发流程里「交给 Claude 改」的那几个）。
const FILES=['app/v1/high-risk.mjs','app/v06/sandbox.mjs','app/v1/full-access.mjs','app/v1/update.mjs','scripts/upgrade.mjs','scripts/install-local-build.sh','scripts/build-v09.mjs'];

const ascii=/^[\x20-\x7e]+$/;
function hits(text,words){const found=new Set();for(const w of words){if(ascii.test(w)){const re=new RegExp('(^|[^a-z0-9_])'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[^a-z0-9_])','i');if(re.test(text))found.add(w);}else if(text.includes(w))found.add(w);}return found;}
function textOf(name,args={},result=null){
 const parts=[args.title,args.path,args.destination,args.query,args.url,args.note,args.done,args.next];
 if(args.program)parts.push([args.program,...(Array.isArray(args.args)?args.args:[])].join(' '));
 if(typeof args.content==='string')parts.push(args.content.slice(0,4000));
 if(result&&typeof result==='object'){for(const k of ['content','text','lines'])if(typeof result[k]==='string')parts.push(result[k].slice(0,4000));}
 return parts.filter(x=>typeof x==='string').join('\n').toLowerCase();
}

export function forecastText(text){
 const t=String(text||'').toLowerCase(),strong=hits(t,STRONG).size,medium=hits(t,MEDIUM).size,files=FILES.filter(f=>t.includes(f)).length;
 const score=3*strong+3*files+medium;
 return score>=6?'likely':score>=3?'maybe':'none';
}
export function forecastCall(name,args={},result=null){return forecastText(textOf(name,args,result));}
// 1027：停住记录里写上这次命中了哪些词（最多 8 个），好看出停住和内容有没有关系。
export function forecastHits(name,args={},result=null){
 const t=textOf(name,args,result);
 return [...FILES.filter(f=>t.includes(f)),...hits(t,STRONG),...hits(t,MEDIUM)].slice(0,8);
}
