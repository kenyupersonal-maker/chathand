/** Route-scoped public management HTTP contracts, independent of MCP controls. */
export const MANAGEMENT_HTTP_ERRORS=Object.freeze({VALUE_RESET_FAILED:Object.freeze({route:'/api/value/reset',status:400,message:'清零失败，请稍后重试。'})});
export function managementHTTPError(route,error,cleanError) {
 if(route==='/api/setup/key'){
  const allowed=new Set('ARG_INVALID KEY_INVALID TUNNEL_ID_INVALID TUNNEL_RUNTIME_MISSING CREDENTIAL_BACKEND_UNSUPPORTED CREDENTIAL_STORE_UNSAFE CREDENTIAL_STORE_CORRUPT CREDENTIAL_STORE_VERSION CREDENTIAL_STORE_EXISTS CREDENTIAL_BUSY CREDENTIAL_CHANGED CREDENTIAL_CONFLICT CREDENTIAL_WRITE_VERIFY_FAILED CREDENTIAL_SAVE_FAILED'.split(' '));
  const code=allowed.has(error?.code)?error.code:'KEY_SAVE_FAILED';
  return {status:400,body:{saved:false,received:false,storage_verified:false,configured:false,connected:false,code,reason_code:code,error:{code,message:code}}};
 }
 const contract=MANAGEMENT_HTTP_ERRORS[error?.code];
 if(contract&&route===contract.route)return {status:contract.status,body:{error:{code:error.code,message:contract.message}}};
 return {status:error?.code==='BODY_TOO_LARGE'?413:400,body:{error:cleanError(error)}};
}
