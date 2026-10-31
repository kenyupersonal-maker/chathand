/** Strict resource-server primitives. Passwords and token issuance stay with the IdP. */
import crypto from 'node:crypto';
export class Fault extends Error { constructor(code, message=code, status=400){super(message);this.code=code;this.status=status;} }
export const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export const random=()=>crypto.randomBytes(32).toString('base64url');
export function secureURL(raw,{development=false,originOnly=false}={}){
 let u;try{u=new URL(raw);}catch{throw new Fault('URL_INVALID');}
 const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
 if(u.username||u.password||u.hash||u.search||!(u.protocol==='https:'||(development&&local&&u.protocol==='http:')))throw new Fault('HTTPS_REQUIRED');
 if(originOnly&&u.pathname!=='/')throw new Fault('ORIGIN_REQUIRED');
 return u;
}
export async function fetchJSON(url,options={},limit=512*1024){
 const r=await fetch(url,{...options,redirect:'error',signal:options.signal||AbortSignal.timeout(15000)});
 const reader=r.body?.getReader();let n=0,chunks=[];if(reader)for(;;){const {value,done}=await reader.read();if(done)break;n+=value.length;if(n>limit){await reader.cancel();throw new Fault('RESPONSE_TOO_LARGE');}chunks.push(value);}
 let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Fault('REMOTE_JSON_INVALID','远端没有返回有效 JSON。',502);}
 return {ok:r.ok,status:r.status,data};
}
/** Only a configured HTTPS issuer/JWKS is trusted; never follow token jku/x5u. */
export class JWTVerifier{
 constructor({issuer,audience,jwksURL,nativeClientId,development=false,clock=()=>Date.now()}){
  this.issuer=secureURL(issuer,{development}).href;this.audience=audience;this.jwksURL=secureURL(jwksURL,{development}).href;this.nativeClientId=nativeClientId;this.clock=clock;this.keys=[];this.loadedAt=0;this.loading=null;
 }
 async load(force=false){
  if(this.keys.length&&!force&&this.clock()-this.loadedAt<300000)return;
  if(this.loading)return this.loading;
  this.loading=(async()=>{const r=await fetchJSON(this.jwksURL);if(!r.ok||!Array.isArray(r.data.keys)||r.data.keys.length>30)throw new Fault('JWKS_INVALID','认证签名公钥不可用。',503);if(r.data.keys.some(k=>!k||typeof k!=='object'))throw new Fault('JWKS_INVALID','认证公钥格式错误。',503);this.keys=r.data.keys;this.loadedAt=this.clock();})().finally(()=>this.loading=null);return this.loading;
 }
 async verify(token,scope){
  if(typeof token!=='string'||token.length>20000)throw new Fault('TOKEN_INVALID','登录凭据无效。',401);
  const parts=token.split('.');if(parts.length!==3||parts.some(x=>!x||!/^[\w-]+$/.test(x)))throw new Fault('TOKEN_INVALID','登录凭据无效。',401);
  let h,c;try{h=JSON.parse(Buffer.from(parts[0],'base64url'));c=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw new Fault('TOKEN_INVALID','登录凭据无效。',401);}
  if(!c||typeof c!=='object'||Array.isArray(c))throw new Fault('TOKEN_CLAIMS','凭据声明无效。',401);
  if(!h||h.alg!=='RS256'||typeof h.kid!=='string'||h.kid.length>200||h.crit||h.jku||h.x5u)throw new Fault('TOKEN_ALGORITHM','不支持该签名。',401);
  await this.load();let k=this.keys.find(k=>k.kid===h.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));
  if(!k&&this.clock()-this.loadedAt>5000){await this.load(true);k=this.keys.find(k=>k.kid===h.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));}
  if(!k)throw new Fault('TOKEN_SIGNATURE','签名公钥不匹配。',401);
  let key;try{key=crypto.createPublicKey({key:k,format:'jwk'});}catch{throw new Fault('TOKEN_SIGNATURE','签名无效。',401);}
  if(key.asymmetricKeyDetails?.modulusLength<2048||!crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))throw new Fault('TOKEN_SIGNATURE','签名无效。',401);
  const now=Math.floor(this.clock()/1000),aud=Array.isArray(c.aud)?c.aud:[c.aud];
  if(typeof c.azp!=='string'||!c.azp||c.azp.length>256||c.iss!==this.issuer||!aud.includes(this.audience)||typeof c.sub!=='string'||!c.sub||c.sub.length>256||!Number.isFinite(c.exp)||c.exp<=now||c.nbf!==undefined&&(!Number.isFinite(c.nbf)||c.nbf>now+30)||c.iat!==undefined&&(!Number.isFinite(c.iat)||c.iat>now+30))throw new Fault('TOKEN_CLAIMS','凭据已过期或不属于此服务。',401);
  if(typeof c.scope!=='string'||!c.scope.split(' ').includes(scope))throw new Fault('SCOPE_DENIED','这份凭据没有所需权限。',403);
  if(scope==='device:connect'&&c.azp!==this.nativeClientId)throw new Fault('CLIENT_DENIED','不是本机客户端的登录凭据。',403);
  return {sub:c.sub,client:c.azp||'oauth-client',expiresAt:c.exp*1000};
 }
}
