// Retains existing task authority during a temporary transport outage. No identity
// is persisted or logged; a selected-route/identity change ends the old grace.
export const CONNECTION_GRACE_MS=600000;
export class ConnectionGrace {
 constructor({now=Date.now,events=null}={}){Object.assign(this,{now,events});this.current=null;}
 reset(outcome='user_stop'){
  const c=this.current;if(c?.since!==null&&c?.since!==undefined)this.events?.record('conn.grace',{route:c.route,outcome,ms:Math.max(0,this.now()-c.since)});
  this.current=null;
 }
 update(route,{identity,healthy=false,auth=false,fatal=false}={}){
  let c=this.current;
  if(c&&(c.route!==route||c.identity!==identity)){this.reset('config_changed');c=null;}
  if(!c)this.current=c={route,identity,worked:false,since:null,expired:false};
  if(auth||fatal){this.reset(auth?'auth':'unrecoverable');return 'revoke';}
  if(healthy){if(c.since!==null)this.events?.record('conn.grace',{route,outcome:'reconnected',ms:Math.max(0,this.now()-c.since)});c.worked=true;c.since=null;c.expired=false;return 'ready';}
  if(!c.worked||!identity||c.expired)return 'revoke';
  if(c.since===null){c.since=this.now();this.events?.record('conn.grace',{route,outcome:'started',ms:0});}
  if(this.now()-c.since<CONNECTION_GRACE_MS)return 'retain';
  c.expired=true;this.events?.record('conn.grace',{route,outcome:'connection_lost',ms:this.now()-c.since});return 'revoke';
 }
}
