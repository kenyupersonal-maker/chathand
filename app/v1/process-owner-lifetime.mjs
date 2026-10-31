// Native stdin starts with the existing v2 key frame. The native parent retains
// its write end afterwards. Register before bootstrap reads; bind after create.
// No bytes, keys, PIDs or paths are logged or retained by this lifetime watcher.
export function watchNativeOwnerPipe(input, protocol) {
 if(protocol!=='stdin-v1')return null; // Caller retains the legacy PID fallback.
 let lost=false,closed=false,callback=null,notified=false;
 const notify=()=>{if(lost&&callback&&!notified&&!closed){notified=true;callback();}};
 const onLost=()=>{lost=true;notify();};
 const discard=()=>{};
 input.once('end',onLost);input.once('error',onLost);input.once('close',onLost);
 if(input.readableEnded||input.destroyed)lost=true;
 return {
  get lost(){return lost;},
  bind(onClose){
   if(closed||callback)throw Error('OWNER_PIPE_ALREADY_BOUND');
   callback=onClose;input.on('data',discard);input.resume();notify();
  },
  close(){if(closed)return;closed=true;callback=null;input.off('end',onLost);input.off('error',onLost);input.off('close',onLost);input.off('data',discard);input.pause();},
 };
}
