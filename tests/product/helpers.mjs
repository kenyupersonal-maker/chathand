import http from 'node:http';import crypto from 'node:crypto';
import {RelayClient} from '../../app/relay.mjs';
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn,ms=4500){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(15);}throw Error('CONDITION_TIMEOUT');}
export async function fakeIdP(t,options={}){
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),kid='test-key';let issuer,audience;
 const stats={jwks:0,polls:0,refreshes:0,flow:'success'};
 const token=(sub='alice',scope='mcp:tools',azp='chat-client',extra={},header={})=>{const h=Buffer.from(JSON.stringify({alg:'RS256',kid,...header})).toString('base64url'),c=Buffer.from(JSON.stringify({iss:issuer,aud:audience,sub,scope,azp,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...extra})).toString('base64url');return h+'.'+c+'.'+crypto.sign('RSA-SHA256',Buffer.from(h+'.'+c),privateKey).toString('base64url');};
 const server=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const x=new URLSearchParams(text);let data,status=200;
  if(req.url==='/.well-known/jwks.json'){stats.jwks++;data={keys:[{...publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'}]};}
  else if(req.url==='/.well-known/ken-bridge')data={schema:1,issuer,audience,mcp_url:audience,native_client_id:'native-app',token_endpoint:issuer+'oauth/token',device_authorization_endpoint:issuer+'oauth/device/code'};
  else if(req.url==='/device/register'){if(options.deviceUnavailable){status=409;data={error:'DEVICE_NOT_AVAILABLE'};}else data={};}
  else if(req.url==='/device/next'){await sleep(50);data={};}
  else if(['/device/offline','/device/revoke','/device/result'].includes(req.url))data={};
  else if(req.url==='/oauth/device/code')data={device_code:'secret-test-code',user_code:'TEST-2026',verification_uri:issuer+'verify',verification_uri_complete:issuer+'verify?user_code=TEST-2026',expires_in:30,interval:1};
  else if(req.url==='/oauth/revoke')data={};
  else if(req.url==='/oauth/token'){
   if(x.get('grant_type')==='refresh_token'){stats.refreshes++;if(stats.flow==='revoked'){status=400;data={error:'invalid_grant'};}else data={access_token:token('alice','device:connect','native-app'),refresh_token:'rotated-refresh',expires_in:3600};}
   else{stats.polls++;if(stats.flow==='denied'){status=400;data={error:'access_denied'};}else if(stats.flow==='pending'){status=400;data={error:'authorization_pending'};}else data={access_token:token('alice','device:connect','native-app'),refresh_token:'test-refresh',expires_in:3600};}
  }else{status=404;data={error:'not_found'};}
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));issuer=`http://127.0.0.1:${server.address().port}/`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});return {issuer,stats,token,setAudience:v=>{audience=v;}};
}
export async function setup(t,options={}){const idp=await fakeIdP(t,options),base=new URL(idp.issuer).origin;idp.setAudience(base+'/mcp');
 const relay=(rpc)=>{const r=new RelayClient({rpc,development:true,name:'Test Mac'});t.after(()=>r.stop());return r;};
 const saved=(id='device00000000000001',sub='alice')=>({version:1,id,name:'Test Mac',config:{base,issuer:idp.issuer,client:'native-app',audience:base+'/mcp',token:idp.issuer+'oauth/token',device:idp.issuer+'oauth/device/code'},session:{access_token:idp.token(sub,'device:connect','native-app'),refresh_token:'test-refresh',expires_at:Date.now()+3600000}});
 return {idp,base,relay,saved};}
