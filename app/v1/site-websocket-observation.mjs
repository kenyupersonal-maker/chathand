/** Observations only: a disconnect event does not identify its root cause. */
export class SiteWebSocketObservation {
 constructor(clock=Date.now){this.clock=clock;this.value=null;}
 note(event,epoch){
  if(!Number.isSafeInteger(epoch)||epoch<0)return;
  if(this.value&&epoch<this.value.transport_epoch)return;
  const prior=this.value?.transport_epoch===epoch?this.value:{};
  const at=this.clock();
  if(!Number.isSafeInteger(at)||at<=0)return;
  if(event==='heartbeat'){
   if(prior.state==='connected')this.value={...prior,heartbeat_ack_at:at};
   return;
  }
  const states={connecting:['connecting','WS_CONNECTING'],connected:['connected','WS_CONNECTED'],disconnected:['reconnecting','WS_DISCONNECTED_UNCLASSIFIED'],failed:['disconnected','WS_CONNECT_FAILED'],stopped:['stopped','WS_STOPPED']};
  if(!states[event])return;
  const [state,reason_code]=states[event];
  this.value={...prior,state,reason_code,observed_at:at,transport_epoch:epoch};
  if(event==='connected')this.value.connected_at=at;
  if(event==='disconnected'||event==='failed')this.value.disconnected_at=at;
 }
 snapshot(){return this.value?{...this.value}:null;}
}
