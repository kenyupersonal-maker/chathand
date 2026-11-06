// Source-checkout fallback for the same read-only Darwin calls in UpgradeControl.
// This script does not send Apple Events or interact with other applications.
ObjC.import('Foundation');
ObjC.bindFunction('__error',['int*',[]]);
ObjC.bindFunction('proc_pidinfo',['int',['int','int','uint64','void*','int']]);
ObjC.bindFunction('malloc',['uint64*',['uint64']]);
ObjC.bindFunction('free',['void',['void*']]);
ObjC.bindFunction('sysctlbyname',['int',['char *','void*','void*','void*','uint64']]);
ObjC.bindFunction('renamex_np',['int',['char *','char *','uint32']]);
function run(argv){
 const ep=$.__error();
 if(argv[0]==='archive'){
  ep[0]=0;const status=$.renamex_np(argv[1],argv[2],4);return JSON.stringify({ok:status===0,errno:ep[0]});
 }
 const pid=Number(argv[1]),d=$.NSMutableData.dataWithLength(136);ep[0]=0;
 const count=$.proc_pidinfo(pid,3,1,d.mutableBytes,136),error=ep[0];
 const size=$.malloc(8),boot=$.NSMutableData.dataWithLength(16);size[0]=16;
 const bootStatus=$.sysctlbyname('kern.boottime',boot.mutableBytes,size,null,0),bootSize=Number(size[0]);$.free(size);
 return JSON.stringify({count,error,process:count===136?ObjC.unwrap(d.base64EncodedStringWithOptions(0)):null,boot:bootStatus===0&&bootSize===16?ObjC.unwrap(boot.base64EncodedStringWithOptions(0)):null});
}
