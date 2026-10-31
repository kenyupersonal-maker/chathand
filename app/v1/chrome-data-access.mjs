/** Chrome access receipts contain categories, never paths, profile names or error text. */
const flows=new Set(['install','repair','uninstall']),operations=new Set(['mkdir','read','write','backup','remove','list']),kinds=new Set(['registration_directory','native_host','native_host_backup']);
export function chromeAccessFields(value){
 if(!value||!flows.has(value.flow)||!operations.has(value.operation)||!kinds.has(value.path_kind)||!['backend','native'].includes(value.accessor_role)||!Number.isSafeInteger(value.pid)||value.pid<=0||!['EACCES','EPERM','UNKNOWN'].includes(value.errno)||value.os_attribution!=='unknown'||value.code!=='CHROME_DATA_ACCESS_DENIED')return null;
 return {flow:value.flow,operation:value.operation,path_kind:value.path_kind,accessor_role:value.accessor_role,pid:value.pid,errno:value.errno,os_attribution:'unknown',code:'CHROME_DATA_ACCESS_DENIED'};
}
export function chromeAccessOperation({flow='install',operation,pathKind,diagnostic=()=>{}},work){
 try{return work();}catch(error){
  if(['EACCES','EPERM'].includes(error?.code)){
   const fields=chromeAccessFields({flow,operation,path_kind:pathKind,accessor_role:'backend',pid:process.pid,errno:error.code,os_attribution:'unknown',code:'CHROME_DATA_ACCESS_DENIED'});
   if(fields)try{diagnostic(fields);}catch{}
   const denied=Error('Chrome settings access denied.');denied.code='CHROME_DATA_ACCESS_DENIED';denied.errno_code=error.code;throw denied;
  }
  throw error;
 }
}
