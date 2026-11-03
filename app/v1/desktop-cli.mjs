// Exit statuses are a private, categorical protocol with NativeDiagnostics.
// Never forward arbitrary exception codes, messages, details or paths.
const STARTUP_FAILURES=new Map([
 ['NODE_VERSION',{code:'STARTUP_NODE_VERSION',status:71}],
 ['ALREADY_RUNNING',{code:'STARTUP_ALREADY_RUNNING',status:72}],
 ['DATA_FORMAT_NEWER',{code:'STARTUP_DATA_NEWER',status:73}],
 ['DATA_FORMAT_UNSUPPORTED',{code:'STARTUP_DATA_UNSUPPORTED',status:74}],
 ['EACCES',{code:'STARTUP_ACCESS_DENIED',status:75}],
 ['EPERM',{code:'STARTUP_ACCESS_DENIED',status:75}],
 ['ENOSPC',{code:'STARTUP_STORAGE_FULL',status:76}],
 ['EADDRINUSE',{code:'STARTUP_PORT_IN_USE',status:77}],
 ['NATIVE_OWNER_EXITED',{code:'STARTUP_OWNER_EXITED',status:78}],
 ['PILOT_IDENTITY_UNSAFE',{code:'PILOT_IDENTITY_UNSAFE',status:79}],
 ['PILOT_IDENTITY_CORRUPT',{code:'PILOT_IDENTITY_CORRUPT',status:80}],
 ['PILOT_IDENTITY_INVALID',{code:'PILOT_IDENTITY_INVALID',status:81}],
 ['RELAY_STATE_VERSION',{code:'RELAY_STATE_VERSION',status:82}],
 ['B_STORE_CONFIG',{code:'B_STORE_CONFIG',status:83}],
 ['B_STORE_UNSAFE',{code:'B_STORE_UNSAFE',status:84}],
 ['MATTER_UNSAFE_PATH',{code:'MATTER_UNSAFE_PATH',status:85}],
 ['MATTER_UNSAFE_FILE',{code:'MATTER_UNSAFE_FILE',status:86}],
 ['MATTER_SEQUENCE',{code:'MATTER_SEQUENCE',status:87}],
 ['MATTER_ID',{code:'MATTER_ID',status:88}],
 ['MATTER_JOURNAL_CONFLICT',{code:'MATTER_JOURNAL_CONFLICT',status:89}],
 ['STATE_UNSAFE',{code:'STATE_UNSAFE',status:90}],
]);
export function desktopStartupFailure(error){
 return STARTUP_FAILURES.get(error?.code)||{code:'STARTUP_FAILURE_UNKNOWN',status:70};
}

function exitCLI(status){
 process.exitCode=status;
 let finished=false;
 const finish=()=>{if(finished)return;finished=true;clearTimeout(deadline);process.exit(status);};
 // Flush ordinary output, but a blocked/broken log sink cannot keep a failed
 // service alive while its native owner retains stdin or partial startup handles.
 const deadline=setTimeout(finish,1000);
 process.stdout.once('error',finish);process.stderr.once('error',finish);
 try{process.stdout.write('',()=>process.stderr.write('',finish));}catch{finish();}
}

// Only the executable entry point opts into process termination. The embedded
// startDesktopFromNative API continues to reject without exiting its host.
export async function runDesktopCLI({start,version}){
 try{
  if(Number(process.versions.node.split('.')[0])<22)throw Object.assign(Error('NODE_VERSION'),{code:'NODE_VERSION'});
  const backend=await start();
  console.log(`ChatHand ${version} 本机执行服务已启动。`);
  backend.whenClosed.then(result=>{
   if(!result.ok){console.error(JSON.stringify(result.error));process.exitCode=process.exitCode||1;}
   exitCLI(process.exitCode||0);
  });
  let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
   if(stopping)return;stopping=true;void backend.close().catch(()=>{});
  });
 }catch(error){
  const {code,status}=desktopStartupFailure(error);
  console.error(JSON.stringify({code}));
  exitCLI(status);
 }
}
