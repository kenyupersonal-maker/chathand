/** One retry deadline, shared by every entrance to one Site reconnect loop. */
export function createReconnectBackoff({now=Date.now,random=Math.random}={}){
 let failures=0,nextAttemptAt=0;
 return {due:()=>now()>=nextAttemptAt,remaining:()=>Math.max(0,nextAttemptAt-now()),reset(){failures=0;nextAttemptAt=0;},fail({rateLimited=false}={}){
  failures++;const base=rateLimited?30000:Math.min(60000,1000*2**Math.min(failures-1,6));
  const delay=rateLimited?base:Math.min(60000,Math.round(base*(.8+Math.max(0,Math.min(1,random()))*.4)));
  nextAttemptAt=now()+delay;return delay;
 }};
}
