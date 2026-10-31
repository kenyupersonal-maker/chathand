'use strict';
/* 本机状态流：双凭据只留在内存；重连的首包始终是一份完整快照。 */
window.ChatHandStream=(()=>{
 let generation=0,controller=null,reader=null,retryTimer=0,watchTimer=0,fallbackTimer=0,failures=0,current='reconnecting',callbacks=null,authBlocked=false,sequence=0,appliedSequence=0,fallbackEpoch=0,suspended=false;
 const visible=()=>window.__chathandWindowVisible!==false&&(typeof document==='undefined'||!document.hidden);
 const status=value=>{if(current===value)return;current=value;callbacks?.onStatus?.(value);};
 function clearFallback(){clearInterval(fallbackTimer);fallbackTimer=0;fallbackEpoch++;}
 function fallback(g){
  status('fallback');
  if(g!==generation||suspended||fallbackTimer)return;
  const epoch=++fallbackEpoch;
  fallbackTimer=setInterval(async()=>{
   const requestSequence=++sequence;
   try{
    const response=await window.ChatHandAuth.fetch('/api/state',{cache:'no-store'});
    if(g!==generation||epoch!==fallbackEpoch)return;
    if(response.status===401||response.status===403){authBlocked=true;clearFallback();status('blocked');return;}
    if(!response.ok)return;
    const state=await response.json();
    if(g!==generation||epoch!==fallbackEpoch||requestSequence<=appliedSequence)return;
    appliedSequence=requestSequence;
    callbacks?.onState(state);
   }catch{}
  },30000);
 }
 function disconnect(){clearTimeout(watchTimer);watchTimer=0;controller?.abort();void reader?.cancel().catch(()=>{});reader=null;controller=null;}
 async function connect(g){
  if(g!==generation||suspended||!callbacks||authBlocked)return;
  controller=new AbortController();let gotState=false,lastByte=performance.now();
  const watchdog=()=>{if(g!==generation)return;if(performance.now()-lastByte>=60000){controller?.abort();return;}watchTimer=setTimeout(watchdog,Math.max(1,60000-(performance.now()-lastByte)));};
  watchTimer=setTimeout(watchdog,60000);
  try{
   const response=await window.ChatHandAuth.fetch('/api/events',{cache:'no-store',signal:controller.signal});
   if(g!==generation)return;
   if(response.status===401||response.status===403){authBlocked=true;console.warn('ChatHand 状态流：'+(response.status===401?'OWNER_AUTH_REQUIRED':'UI_CONFIRM_REQUIRED'));clearFallback();status('blocked');return;}
   if(!response.ok||!response.body)throw Error('stream unavailable');
   reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
   const frame=raw=>{
    if(g!==generation)return;
    let event='message';const data=[];for(const line of raw.split('\n')){if(line.startsWith(':'))continue;const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);if(field==='event')event=value;else if(field==='data')data.push(value);}if(!data.length)return;
    let value;try{value=JSON.parse(data.join('\n'));}catch{return;}
    if(event==='state'){gotState=true;failures=0;appliedSequence=++sequence;clearFallback();status('live');if(g===generation)callbacks?.onState(value);}
    else if(event==='patch'&&gotState){appliedSequence=++sequence;callbacks?.onPatch(value);}
   };
   while(g===generation){const chunk=await reader.read();if(chunk.done)throw Error('stream ended');lastByte=performance.now();buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){frame(buffer.slice(0,end));buffer=buffer.slice(end+2);}}
  }catch{
   if(g!==generation||authBlocked)return;
   failures++;if(failures>=3)fallback(g);else status('reconnecting');
   const delay=Math.min(15000,500*2**Math.min(failures-1,5))*(.8+Math.random()*.4);
   retryTimer=setTimeout(()=>{retryTimer=0;void connect(g);},Math.min(15000,delay));
  }finally{if(g===generation)disconnect();}
 }
 function cancelConnection(){generation++;clearTimeout(retryTimer);retryTimer=0;clearFallback();disconnect();}
 function syncVisibility(){
  if(!callbacks)return;
  if(!visible()){
   if(!suspended){suspended=true;cancelConnection();status('paused');}
  }else if(suspended){
   suspended=false;failures=0;status('reconnecting');
   if(authBlocked)status('blocked');else void connect(generation);
  }
 }
 function stop(){cancelConnection();callbacks=null;suspended=false;}
 function start(onState,onPatch,onStatus){stop();callbacks={onState,onPatch,onStatus};failures=0;authBlocked=false;suspended=!visible();current=suspended?'paused':'reconnecting';onStatus?.(current);if(!suspended)void connect(generation);}
 if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('visibilitychange',syncVisibility);
 if(typeof window.addEventListener==='function')window.addEventListener('chathand:window-visibility',event=>{if(typeof event.detail?.visible!=='boolean')return;window.__chathandWindowVisible=event.detail.visible;syncVisibility();});
 return {start,stop,status:()=>current};
})();
