import {localText} from './i18n.mjs';
import {controlPlaneCategory} from '../engine/src/tunnel.mjs';
import {connectionStartupCode} from './diagnostic-events.mjs';
import {fail} from '../engine/src/core.mjs';

/** Owns connection intent and the three execution transitions. No model requests. */
export class ConnectionController {
 constructor({tunnel,state,onReset=()=>{},onConnecting=()=>{},onReady=()=>{},onUnavailable=()=>{},onCloudLost=()=>{},onCloudBack=()=>{},clock=()=>Date.now(),cloudRetryAllowed=()=>true,events=null}) {
  Object.assign(this,{events,tunnel,state,onReset,onConnecting,onReady,onUnavailable,onCloudLost,onCloudBack,clock,cloudRetryAllowed});
  this.lastCallSucceededAt=0;this.cloudEpisode=null;this.cloudLost=false;this.cloudState='unknown';this.cloudChangedAt=this.clock();
  this.desired=false;this.generation=0;this.busy=null;this.phase='idle';this.message='';
  this.errorCode=null;this.attempts=0;this.nextAttempt=0;this.blocked=false;this.startedAt=0;
 }
 set phase(value){const from=this._phase;this._phase=value;if(from!==value)this.events?.record('conn.state',{from,to:value,reason:this.transitionReason,n:this.attempts||0,code:this.errorCode||undefined});}
 get phase(){return this._phase;}
 snapshot(){return {timeline:this.events?.timelineSnapshot?.()||[],startup_timing:this.events?.startupSnapshot?.()||[],phase:this.phase,message:this.message,error_code:this.errorCode,desired:this.desired,attempts:this.attempts,next_attempt_at:this.nextAttempt||null,last_restart:this.lastRestart||null,cloud_lost:this.cloudLost,cloud_retry:this.cloudEpisode?{started_at:this.cloudEpisode.since,attempts:this.cloudEpisode.attempts,next_attempt_at:this.cloudEpisode.next}:null};}
 configureAndConnect(config) {
  if(this.busy||this.tunnel.child||this.tunnel.doctorChild){
   if(!this.desired)fail('CONNECTION_STOPPING',localText('connection.stopping'));
   if(config&&(config.tunnel_id!==this.tunnel.tunnelId||config.api_key!==this.tunnel.key||config.binary!==undefined&&config.binary!==this.tunnel.binary))fail('CONNECTION_BUSY',localText('connection.busy'));
   // Explicit reconnect after a temporary pause resumes execution on this live connection.
   if(this.phase==='ready')this.onReady();
   return {ok:true,...this.snapshot(),replayed:true};
  }
  if(config)this.tunnel.configure(config);
  if(!this.tunnel.key)fail('TUNNEL_UNCONFIGURED',localText('connection.unconfigured'));
  this.state.data.tunnel={tunnel_id:this.tunnel.tunnelId,binary:this.tunnel.binary};
  this.state.data.connection_preference='tunnel';this.state.data.auto_connect=true;this.state.save();
  this.cloudEpisode=null;this.cloudLost=false;this.desired=true;this.blocked=false;this.attempts=0;this.nextAttempt=0;this.errorCode=null;this.generation++;
  this.startAttempt();return {ok:true,...this.snapshot()};
 }
 startup(stage,outcome,at=this.clock(),code='OK',n=this.attemptNumber??this.attempts+1){this.events?.record('conn.startup',{stage,outcome,ms:Math.max(0,Math.floor(this.clock()-at)),code:connectionStartupCode(code),n,source:'controller'});}
 startAttempt() {
  if(this.busy||!this.desired||this.blocked)return;
  const generation=++this.generation,attemptNumber=this.attempts+1;this.attemptNumber=attemptNumber;this.attemptStartedAt=this.clock();this.startup('attempt','begin');this.transitionReason='started';this.phase='connecting';this.message=localText('connection.connecting');this.errorCode=null;
  this.onReset();this.onConnecting();
  // The transport owns readiness. Doctor is a concurrent diagnostic, never a startup gate.
  this.doctorResult=null;this.attempt=null;
  this.busy=(async()=>{
   if(generation!==this.generation||!this.desired)return;
   try {
    const transportAt=this.clock();this.startup('transport','begin');this.tunnel.start();this.startup('transport','ok',transportAt);this.startedAt=this.clock();this.phase='running';this.message=localText('connection.confirming');
    const attempt=this.attempt={generation,child:this.tunnel.child,transportGeneration:this.tunnel.generation,authenticated:false};
    const doctorAt=this.clock();this.startup('doctor','begin');
    this.doctorPending=(async()=>{
     if(generation!==this.generation||!this.desired)return {cancelled:true};
     return this.tunnel.doctor();
    })().then(check=>{
     const current=this.currentAttempt()===attempt&&this.desired;
     this.startup('doctor',!current||check.cancelled?'cancelled':check.timed_out?'timeout':check.ok?'ok':'failed',doctorAt,!current||check.cancelled?'CANCELLED':check.timed_out?'DOCTOR_TIMEOUT':check.auth_failed?'CONNECTION_AUTH_FAILED':check.ok?'OK':'DOCTOR_FAILED',attemptNumber);
     if(!current||check.cancelled)return;
     this.doctorResult=check;
     // A late self-check cannot tear down a healthy connection. Use its auth
     // finding only after this attempt has independently failed to connect.
     if(this.doctorAuthBlocks()&&this.phase!=='ready'&&this.errorCode==='CONNECTION_UNAVAILABLE')this.failed(true);
    }).catch(e=>{this.startup('doctor',generation===this.generation?'failed':'cancelled',doctorAt,e.code,attemptNumber);});
   }catch(e){
    if(generation===this.generation&&this.desired){this.startup('transport','failed',this.attemptStartedAt,e.code);this.tunnel.stop();this.failed(['KEY_INVALID','KEY_EXPIRED','AUTH_REQUIRED','TUNNEL_ID_INVALID','ENOENT'].includes(e.code));}
   }
  })().finally(()=>{this.busy=null;this.onDeadlineChange?.();});
 }
 // Retain the just-exited child's proof only to classify that same attempt's
 // failure. A new controller generation or different live child invalidates it.
 currentAttempt(){const a=this.attempt;return a?.generation===this.generation&&a.child&&(!this.tunnel.child||a.child===this.tunnel.child)?a:null;}
 doctorAuthBlocks(){const a=this.currentAttempt();return !!a&&!a.authenticated&&this.doctorResult?.auth_failed===true;}
 confirmAuthentication(proof){
  const a=this.currentAttempt();
  if(!a||!this.desired||!this.tunnel.child||proof.generation!==a.generation||proof.child!==a.child||a.child!==this.tunnel.child||a.transportGeneration!==this.tunnel.generation||this.tunnel.runAuthFailed===true||this.errorCode==='CONNECTION_AUTH_FAILED')return false;
  a.authenticated=true;return true;
 }
 transportFailed(){const auth=this.tunnel.runAuthFailed===true||this.doctorAuthBlocks();this.tunnel.stop();this.failed(auth);}

 failed(auth=false) {
  this.transitionReason=auth?'auth':'probe_unhealthy';this.onUnavailable({auth});this.attempts++;this.errorCode=auth?'CONNECTION_AUTH_FAILED':'CONNECTION_UNAVAILABLE';this.phase=auth?'needs_login':this.attempts>=3?'needs_retry':'reconnecting';
  this.blocked=auth||this.attempts>=3;this.errorCode=auth?'CONNECTION_AUTH_FAILED':'CONNECTION_UNAVAILABLE';
  this.message=auth?localText('connection.authFailed'):this.blocked?localText('connection.retryBlocked'):localText('connection.reconnecting');
  if(this.cloudEpisode&&!auth){this.blocked=true;this.nextAttempt=0;this.cloudFailure();return;}
  this.startup('attempt','failed',this.attemptStartedAt??this.clock(),this.errorCode);
  this.nextAttempt=this.blocked?0:this.clock()+[2000,5000,15000][Math.min(this.attempts-1,2)];
  if(this.nextAttempt)this.events?.record('conn.startup',{stage:'retry_wait',outcome:'begin',ms:this.nextAttempt-this.clock(),n:this.attempts,source:'controller'});
  // A connection that worked before and now cannot be restored: tell the user once (network or proxy, not the key).
  if(this.blocked&&!auth&&this.wasReady&&!this.cloudLost){this.cloudLost=true;try{this.onCloudLost({state:'down',proxy:this.tunnel.runningProxy?'proxy':'direct'});}catch{}}
 }
 tick() {
  this.retryCloud();
  if(!this.desired||this.busy||this.blocked)return;
  if(this.phase==='running'&&!this.tunnel.child){this.transportFailed();return;}
  if(this.tunnel.child||this.tunnel.doctorChild)return;
  if(this.clock()>=this.nextAttempt)this.startAttempt();
 }
 healthy(){
  if(!this.desired||!this.tunnel.child||this.phase==='ready'||this.blocked)return;
  if(this.tunnel.runAuthFailed===true){this.transportFailed();return;}
  // Save credentials and enable execution before publishing the ready state.
  const saveAt=this.clock();this.startup('credential_save','begin');
  try{this.onReady();this.startup('credential_save','ok',saveAt);}catch{this.startup('credential_save','failed',saveAt,'CREDENTIAL_SAVE_FAILED');this.onUnavailable();this.tunnel.stop();this.transitionReason='credential_save';this.phase='needs_retry';this.errorCode='CREDENTIAL_SAVE_FAILED';this.message=localText('connection.saveFailed');this.blocked=true;return;}
  this.startup('healthy','ok',this.attemptStartedAt??this.clock());this.attempts=0;this.nextAttempt=0;this.phase='ready';this.message=localText('connection.ready');this.errorCode=null;this.wasReady=true;
 }
 observe(health){
  if(!this.desired)return;
  this.recordCloud(health?.control_plane);
  if(this.tunnel.runAuthFailed===true&&!this.blocked){this.transportFailed();return;}
  // Only manager-created observations carry current run provenance; copied UI
  // JSON or local readiness alone cannot retire the startup doctor finding.
  if(this.tunnel.confirmsControlPlane?.(health?.control_plane))this.confirmAuthentication({generation:this.generation,child:this.tunnel.child});
  if(health?.healthy&&health?.ready&&this.tunnel.child){
   if(this.unhealthy){this.events?.record('conn.unhealthy',{n:this.unhealthy.n,ms:this.clock()-this.unhealthy.at});this.unhealthy=null;}this.healthy();this.watchCloud(health.control_plane);return;
  }
  if(this.phase==='ready'){
   const u=this.unhealthy||(this.unhealthy={at:this.clock(),n:0});u.n++;const ms=this.clock()-u.at;
   this.events?.record('conn.unhealthy',{n:u.n,ms});
   if(ms<10000||u.n<3)return;
   this.unhealthy=null;this.transportFailed();
  }else if(this.phase==='running'&&(!this.tunnel.child||this.clock()-this.startedAt>15000)){this.transportFailed();}
 }
 /** A real authenticated tool result is independent evidence that this route works. */
 authenticatedCallSucceeded(now=this.clock(),proof={generation:this.generation,child:this.tunnel.child}){
  if(proof.generation!==this.generation||proof.child!==this.tunnel.child||!this.desired||!this.tunnel.child||this.tunnel.runAuthFailed===true||this.errorCode==='CONNECTION_AUTH_FAILED')return false;
  if(this.attempt&&!this.confirmAuthentication(proof))return false;
  const firstCall=this.lastCallGeneration!==this.generation;this.lastCallGeneration=this.generation;
  this.lastCallSucceededAt=now;const lost=this.cloudLost,endedEpisode=!!this.cloudEpisode;this.cloudEpisode=null;this.cloudLost=false;
  this.recordCloud({state:'up',status:'ok'},'authenticated_call',{force:firstCall||endedEpisode||lost});if(lost)this.onCloudBack({state:'up'});return true;
 }
 recentlyAuthenticated(ms=45000){return this.lastCallSucceededAt>0&&this.clock()-this.lastCallSucceededAt<ms;}
 /** A cloud episode outlives local process/doctor resets; health or real calls clear it. */
 recordCloud(cp,source='health',{force=false}={}){
  const category=controlPlaneCategory(cp),signature=JSON.stringify([cp?.state,category.status,category.code]);
  const to=['up','checking','down'].includes(cp?.state)?cp.state:'unknown';
  if(!force&&to===this.cloudState&&signature===this.cloudSignature)return;const now=this.clock();
  this.events?.record('conn.cloud',{from:this.cloudState,to,reason:source==='authenticated_call'?'call_ok':({up:'health_ok',checking:'health_checking',down:'health_down',unknown:'health_unavailable'})[to],status:category.status,...(category.code?{code:category.code}:{}),source,ms:Math.max(0,now-this.cloudChangedAt)});
  this.cloudState=to;this.cloudSignature=signature;this.cloudChangedAt=now;
 }
 watchCloud(cp){
  this.recordCloud(cp);
  if(!this.desired||!cp)return;
  if(this.lastCallSucceededAt&&Number.isFinite(cp.checked_at)&&cp.checked_at<this.lastCallSucceededAt)return;
  if(cp.state==='up'){if(this.cloudLost)this.onCloudBack(cp);this.cloudEpisode=null;this.cloudLost=false;return;}
  if(!['down','checking'].includes(cp.state))return;
  const now=this.clock();if(this.recentlyAuthenticated()&&(!cp.down_since||cp.down_since<=this.lastCallSucceededAt))return;
  if(!this.cloudEpisode){const since=Math.max(this.lastCallSucceededAt,Number.isFinite(cp.down_since)&&cp.down_since<=now?cp.down_since:now);this.cloudEpisode={since,next:since+45000,attempts:0,cp};}
  else this.cloudEpisode.cp=cp;
  this.cloudFailure();this.retryCloud();
 }
 cloudFailure(){const e=this.cloudEpisode;if(e?.attempts>=2&&!this.cloudLost){this.cloudLost=true;this.onCloudLost(e.cp);}}
 retryCloud(){
  const e=this.cloudEpisode;
  if(!e||!this.desired||!this.cloudRetryAllowed()||['CONNECTION_AUTH_FAILED','CREDENTIAL_SAVE_FAILED'].includes(this.errorCode)||this.busy||this.clock()<e.next)return false;
  return this.restart('cloud_down',localText('connection.cloudDown'));
 }
 /** Restart the transport (proxy changed, cloud down, periodic retry). Keeps the user's intent; fresh attempt budget. */
 restart(reason='restart',message=localText('connection.networkChanged'),{attempts=0}={}){
  if(!this.desired||this.busy)return false;
  this.generation++;
  if(this.cloudEpisode){const e=this.cloudEpisode;e.attempts++;e.next=this.clock()+[60000,120000,300000][Math.min(e.attempts-1,2)];}
  this.events?.record('conn.restart',{reason,n:this.cloudEpisode?.attempts||this.attempts||0,ms:this.cloudEpisode?Math.max(0,this.clock()-this.cloudEpisode.since):0});this.transitionReason=reason;this.lastRestart={reason,at:this.clock()};this.attempts=attempts;this.blocked=false;this.errorCode=null;
  try{this.tunnel.stop();}catch{}
  try{this.onUnavailable();}catch{}
  this.phase='reconnecting';this.message=message;this.nextAttempt=this.clock()+1500;
  return true;
 }
 /** A blocked connection (network trouble, not a key problem) gets one more attempt. */
 retryOnce(reason='periodic'){
  if(this.cloudEpisode||!this.desired||!this.blocked||this.errorCode!=='CONNECTION_UNAVAILABLE')return false;
  return this.restart(reason,localText('connection.restarting'),{attempts:2});
 }
 nextDeadline(){
  if(!this.desired||this.busy)return Infinity;let at=Infinity;
  if(this.cloudEpisode&&this.cloudRetryAllowed()&&!['CONNECTION_AUTH_FAILED','CREDENTIAL_SAVE_FAILED'].includes(this.errorCode))at=this.cloudEpisode.next;
  if(!this.blocked&&this.phase!=='ready'&&!this.tunnel.child&&!this.tunnel.doctorChild)at=Math.min(at,this.nextAttempt||this.clock());
  return at;
 }
 monitor(){this.retryCloud();if(this.phase==='ready'&&!this.tunnel.child){this.observe({healthy:false});return;}this.tick();}
 stop({persist=true}={}) {
  this.transitionReason='user_stop';this.errorCode=null;this.unhealthy=null;this.wasReady=false;this.lastCallSucceededAt=0;this.cloudEpisode=null;this.cloudLost=false;this.desired=false;this.generation++;this.nextAttempt=0;this.blocked=false;this.phase='idle';this.message=localText('connection.disconnected');this.errorCode=null;
  let error=null;
  try{this.onReset();}catch(e){error??=e;}
  try{this.onUnavailable({userStop:true});}catch(e){error??=e;}
  try{this.tunnel.stop();}catch(e){error??=e;}
  if(persist){this.state.data.connection_preference='none';try{this.state.save();}catch(e){error??=e;}}
  if(error)throw error;
  return {ok:true,...this.snapshot()};
 }
}

/** Site timing observes transport evidence; it never grants or restores access. */
export class SiteConnectionTelemetry {
 constructor({events,clock=Date.now}){Object.assign(this,{events,clock});this.epoch=null;this.cloud='unknown';this.changedAt=clock();this.attemptAt=null;this.attempts=0;this.disconnectAt=null;this.callRecorded=false;}
 startup(stage,outcome,ms=0,code='OK'){
  this.events?.record('conn.startup',{source:'site',stage,outcome,ms:Math.max(0,Math.floor(ms)),code,n:this.attempts});
 }
 observe({route,transport={},fresh=false,epoch=transport.transport_epoch}={}){
  if(route?.configured!==1||!Number.isSafeInteger(epoch)||epoch<0)return;
  if(this.epoch!==null&&epoch<this.epoch)return;
  const now=this.clock(),running=transport.running===true;
  if(this.epoch!==epoch){
   if(!running)return;
   if(this.epoch!==null)this.events?.record('conn.restart',{source:'site',reason:'started',n:this.attempts,ms:Math.max(0,now-this.attemptAt)});
   this.epoch=epoch;this.attemptAt=now;this.attempts++;this.disconnectAt=null;this.callRecorded=false;this.cloud='unknown';this.changedAt=now;this.signature=null;
   this.startup('transport','begin');this.startup('transport','ok');
  }
  const manifest=transport.runtime_manifest;
  // REST health/pairing or an old manifest alone is not a live WebSocket.
  const ready=running&&fresh&&transport.ready===true&&transport.authenticated===true&&manifest?.state==='accepted'&&manifest.transport_epoch===epoch;
  const to=ready?'up':!running?'unknown':['failed','auth_required'].includes(route.state)?'down':'checking';
  const disconnected=transport.websocket?.transport_epoch===epoch?transport.websocket.disconnected_at:null;
  if(running&&Number.isSafeInteger(disconnected)&&disconnected>=this.attemptAt&&disconnected!==this.disconnectAt){
   this.disconnectAt=disconnected;
   this.events?.record('conn.restart',{source:'site',reason:'connection_lost',n:this.attempts,ms:Math.max(0,now-this.attemptAt)});
   this.startup('retry_wait','begin',0,route.state==='auth_required'?'CONNECTION_AUTH_FAILED':'CONNECTION_UNAVAILABLE');
  }
  const code=ready?null:route.state==='auth_required'?'CONNECTION_AUTH_FAILED':transport.last_error_code?'CONNECTION_UNAVAILABLE':null;
  const signature=JSON.stringify([to,code]);
  if(signature===this.signature)return;
  this.signature=signature;
  this.events?.record('conn.cloud',{source:'site',from:this.cloud,to,status:ready?'ok':to==='down'?'error':to==='checking'?'starting':'unknown',reason:({up:'health_ok',down:'health_down',checking:'health_checking',unknown:'health_unavailable'})[to],ms:Math.max(0,now-this.changedAt),...(code?{code}:{})});
  if(ready&&this.cloud!=='up')this.startup('healthy','ok',now-this.attemptAt);
  this.cloud=to;this.changedAt=now;
 }
 authenticatedCallSucceeded(epoch){
  if(epoch!==this.epoch||this.cloud!=='up'||this.callRecorded)return false;
  this.callRecorded=true;
  this.events?.record('conn.cloud',{source:'site',from:'up',to:'up',status:'ok',reason:'call_ok',ms:Math.max(0,this.clock()-this.attemptAt)});
  return true;
 }
}
