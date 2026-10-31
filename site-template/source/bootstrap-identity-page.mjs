/** Browser presentation only. The authenticated bootstrap JSON contract is unchanged. */
export const BOOTSTRAP_PAGE_TEXT = Object.freeze({
 zh: {
  title:'Site 身份资料已准备',
  instructions:'复制身份资料，发回创建这个 Site 的 Work 对话，继续配置。',
  scope:'这一步只取得当前登录账号的身份。Site 还没配好，也还没连到这台 Mac。',
  copy:'复制身份资料',
  copied:'已复制。回到原来的 Work 对话粘贴发送。',
  copyFailed:'未能复制，请重试。',
  errorTitle:'未能取得 Site 身份资料',
  errorBody:'当前登录身份未通过检查。请回到原来的 Work 对话，提供下面的错误码。',
  disabled:'初始身份取得已关闭；这不是改连授权入口。请回到当前配置步骤，打开 /owner/rebind；缺少本次请求时重新配对并回答新问题。',
  invalidRequest:'身份请求不完整或已失效。请回到原来的 Work 对话重新打开链接。',
  parseTitle:'身份资料格式不正确',
  parseBody:'页面已打开，但返回的身份资料无法识别。请把错误码发回原来的 Work 对话。',
  code:'错误码',
  language:'语言',
  chinese:'中文',
  english:'English',
 },
 en: {
  title:'Site identity is ready',
  instructions:'Copy the identity details and send them in the Work chat that created this Site to continue setup.',
  scope:'This step only identifies the signed-in account. Site setup and the connection to this Mac are not complete yet.',
  copy:'Copy Identity Details',
  copied:'Copied. Paste and send in the original Work chat.',
  copyFailed:'Couldn’t copy. Try again.',
  errorTitle:'Couldn’t get the Site identity',
  errorBody:'The signed-in identity couldn’t be verified. Return to the original Work chat with the error code below.',
  disabled:'Initial identity setup is closed. This is not the replacement authorization page. Return to the current setup step and open /owner/rebind. If the request is missing, pair again and answer the new question.',
  invalidRequest:'The identity request is incomplete or no longer valid. Reopen the link from the original Work chat.',
  parseTitle:'Identity details couldn’t be read',
  parseBody:'The page opened, but the identity details have an unexpected format. Send the error code in the original Work chat.',
  code:'Error code',
  language:'Language',
  chinese:'中文',
  english:'English',
 },
});

const BOOTSTRAP_PRESENTATION_ERROR='B_BOOTSTRAP_PRESENTATION_INVALID';
const bootstrapEscape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bootstrapScriptJSON=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');

export function prefersBootstrapHTML(request){
 const raw=request.headers.get('accept')||'';
 if(raw.length>4096)return false;
 const quality=type=>Math.max(0,...raw.split(',').map(part=>{
  const [media,...parameters]=part.trim().toLowerCase().split(';').map(s=>s.trim());
  if(media!==type)return 0;
  const q=parameters.find(s=>s.startsWith('q='));
  if(!q)return 1;
  return /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)?Number(q.slice(2)):0;
 }));
 const html=Math.max(quality('text/html'),quality('application/xhtml+xml'));
 return html>0&&html>=quality('application/json');
}

function bootstrapPageLocale(request){
 for(const item of (request.headers.get('accept-language')||'').split(',')){
  const [tag,...params]=item.trim().toLowerCase().split(';');
  if(params.some(p=>/^\s*q=0(?:\.0*)?\s*$/.test(p)))continue;
  if(/^en(?:-|$)/.test(tag))return 'en';
  if(/^zh(?:-|$)/.test(tag))return 'zh';
 }
 return 'zh';
}

function validBootstrapPresentation(payload,request){
 const fields=['schema','protocol_version','site_id','site_origin','source_revision','nonce','server_time_ms','owner_subject'].sort();
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(Object.keys(payload).sort())!==JSON.stringify(fields))return false;
 const url=new URL(request.url);
 return payload.schema===1&&payload.protocol_version==='1'&&
  typeof payload.site_id==='string'&&/^[A-Za-z0-9_-]{4,128}$/.test(payload.site_id)&&
  payload.site_origin===url.origin&&typeof payload.source_revision==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(payload.source_revision)&&
  typeof payload.nonce==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce)&&payload.nonce===url.searchParams.get('nonce')&&
  Number.isSafeInteger(payload.server_time_ms)&&payload.server_time_ms>0&&
  typeof payload.owner_subject==='string'&&payload.owner_subject.length>0&&payload.owner_subject.length<=160&&
  ![...payload.owner_subject].some(ch=>ch.codePointAt(0)<=32||ch.codePointAt(0)===127);
}

function bootstrapPage(request,{payload=null,errorCode=null,status=200}={}){
 const locale=bootstrapPageLocale(request),text=BOOTSTRAP_PAGE_TEXT[locale];
 const parseError=errorCode===BOOTSTRAP_PRESENTATION_ERROR;
 const title=errorCode?(parseError?text.parseTitle:text.errorTitle):text.title;
 const body=errorCode?(parseError?text.parseBody:errorCode==='B_BOOTSTRAP_DISABLED'?text.disabled:/B_BOOTSTRAP_(?:PARAMS|NONCE|METHOD)_INVALID/.test(errorCode)?text.invalidRequest:text.errorBody):text.instructions;
 const safeCode=typeof errorCode==='string'&&/^B_[A-Z0-9_]{1,79}$/.test(errorCode)?errorCode:'B_BOOTSTRAP_UNCONFIRMED';
 const script=`(()=>{const tables=${bootstrapScriptJSON(BOOTSTRAP_PAGE_TEXT)};const identity=${bootstrapScriptJSON(payload)};const errorCode=${bootstrapScriptJSON(errorCode?safeCode:null)};let language=${bootstrapScriptJSON(locale)};
 const title=document.getElementById('title'),body=document.getElementById('instructions'),scope=document.getElementById('scope'),copy=document.getElementById('copy'),status=document.getElementById('status'),codeLabel=document.getElementById('code-label');
 function paint(){const t=tables[language];document.documentElement.lang=language==='en'?'en':'zh-CN';document.title=errorCode?(errorCode==='${BOOTSTRAP_PRESENTATION_ERROR}'?t.parseTitle:t.errorTitle):t.title;title.textContent=document.title;body.textContent=errorCode?(errorCode==='${BOOTSTRAP_PRESENTATION_ERROR}'?t.parseBody:errorCode==='B_BOOTSTRAP_DISABLED'?t.disabled:/B_BOOTSTRAP_(?:PARAMS|NONCE|METHOD)_INVALID/.test(errorCode)?t.invalidRequest:t.errorBody):t.instructions;if(scope)scope.textContent=t.scope;if(copy)copy.textContent=t.copy;if(codeLabel)codeLabel.textContent=t.code;status.textContent='';}
 for(const button of document.querySelectorAll('[data-language]'))button.addEventListener('click',()=>{language=button.getAttribute('data-language')==='en'?'en':'zh';document.querySelector('nav').setAttribute('aria-label',tables[language].language);paint();});
 if(copy)copy.addEventListener('click',async()=>{copy.disabled=true;try{if(!identity)throw Error('unavailable');await navigator.clipboard.writeText(JSON.stringify(identity));status.textContent=tables[language].copied;}catch{status.textContent=tables[language].copyFailed;}finally{copy.disabled=false;}});
 })();`;
 const html='<!doctype html><html lang="'+(locale==='en'?'en':'zh-CN')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>'+bootstrapEscape(title)+'</title>'+
 '<style>:root{color-scheme:light dark;--bg:#f5f7f5;--card:#fff;--ink:#171a18;--muted:#647067;--line:#dde3df;--button:#171a18;--button-ink:#fff}@media(prefers-color-scheme:dark){:root{--bg:#161a18;--card:#202622;--ink:#edf1ed;--muted:#a6b2a9;--line:#3b463f;--button:#edf1ed;--button-ink:#171a18}}*{box-sizing:border-box}body{margin:0;padding:24px;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(100%,560px);padding:32px;background:var(--card);border:1px solid var(--line);border-radius:20px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}h1{font-size:22px;line-height:1.4;margin:28px 0 12px;font-weight:600}p{margin:0 0 16px}small{color:var(--muted)}nav{display:flex;gap:12px}button{font:inherit;cursor:pointer}nav button{border:0;background:none;color:var(--muted);padding:4px}#copy{display:block;max-width:100%;border:0;border-radius:999px;padding:11px 20px;background:var(--button);color:var(--button-ink);margin-top:24px}button:focus-visible{outline:2px solid currentColor;outline-offset:4px}button:disabled{opacity:.6;cursor:default}#status{min-height:1.6em;color:var(--muted);font-size:13px;margin:12px 0 0}.code{overflow-wrap:anywhere;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:13px}#scope{font-size:13px;color:var(--muted)}</style></head><body><main><header><strong>ChatHand</strong><nav aria-label="'+bootstrapEscape(text.language)+'"><button type="button" data-language="zh">'+bootstrapEscape(text.chinese)+'</button><button type="button" data-language="en">'+bootstrapEscape(text.english)+'</button></nav></header><h1 id="title">'+bootstrapEscape(title)+'</h1><p id="instructions">'+bootstrapEscape(body)+'</p>'+
 (errorCode?'<p class="code"><span id="code-label">'+bootstrapEscape(text.code)+'</span>: <code>'+safeCode+'</code></p>':'<p id="scope">'+bootstrapEscape(text.scope)+'</p><button type="button" id="copy">'+bootstrapEscape(text.copy)+'</button>')+
 '<p id="status" role="status" aria-live="polite"></p></main><script>'+script+'</script></body></html>';
 return new Response(html,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','vary':'Accept, Accept-Language','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}

export async function bootstrapIdentityPresentation(request,response){
 let payload;
 try{payload=await response.json();}catch{return bootstrapPage(request,{errorCode:BOOTSTRAP_PRESENTATION_ERROR,status:502});}
 if(!validBootstrapPresentation(payload,request))return bootstrapPage(request,{errorCode:BOOTSTRAP_PRESENTATION_ERROR,status:502});
 return bootstrapPage(request,{payload});
}

export function bootstrapIdentityErrorPage(request,code,status=400){
 return bootstrapPage(request,{errorCode:typeof code==='string'&&/^B_BOOTSTRAP_[A-Z0-9_]{1,60}$/.test(code)?code:'B_BOOTSTRAP_UNCONFIRMED',status});
}
