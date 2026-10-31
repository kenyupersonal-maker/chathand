// The platform uses both IDs for the same object. Preserve observed IDs/URLs;
// normalization is only for identity comparison and scoped proof keys.
export const canonicalChatGPTAppId = value => typeof value === 'string' ? value.replace(/^plugin_(?=asdk_app_)/, '') : value;
export const sameChatGPTAppId = (a,b) => typeof a === 'string' && typeof b === 'string' && canonicalChatGPTAppId(a) === canonicalChatGPTAppId(b);
export function sameChatGPTAppDetailURL(a,b){
 try{const x=new URL(a),y=new URL(b),xi=x.pathname.split('/').pop(),yi=y.pathname.split('/').pop();
  return x.origin===y.origin&&x.pathname.slice(0,-xi.length)===y.pathname.slice(0,-yi.length)&&x.search===y.search&&x.hash===y.hash&&sameChatGPTAppId(xi,yi);
 }catch{return false;}
}
