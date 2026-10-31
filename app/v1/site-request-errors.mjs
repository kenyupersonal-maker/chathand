// HTTP and runtime preparation share codes; never preserve numeric DOM codes.
export const safeSiteErrorCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]*$/.test(value)?value:null;
export function siteRequestErrorCode(error,{aborted=false}={}){
 const code=safeSiteErrorCode(error?.code);
 if(code?.startsWith('B_'))return code;
 return aborted||error?.name==='AbortError'||error?.name==='TimeoutError'||error?.code===20?'B_SITE_REQUEST_TIMEOUT':'B_SITE_NETWORK_FAILED';
}
