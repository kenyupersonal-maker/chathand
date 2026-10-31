/** One timer for independent maintenance sources. Deadlines are monotonic;
 * callers explicitly convert persisted wall-clock deadlines with wallAt(). */
export class DeadlineScheduler {
 constructor({clock={},onError=()=>{}}={}){
  this.now=clock.monotonicNow||clock.now||(()=>performance.now());this.wallNow=clock.now||Date.now;
  this.setTimer=clock.setTimeout?.bind(clock)||(clock.setInterval?((fn,ms)=>{let id=clock.setInterval(()=>{clock.clearInterval(id);fn();},ms);return id;}):setTimeout);this.clearTimer=clock.clearTimeout?.bind(clock)||clock.clearInterval?.bind(clock)||clearTimeout;
  this.defer=clock.queueMicrotask?.bind(clock)||queueMicrotask;this.onError=onError;this.sources=new Map();this.dirty=new Set();this.timer=null;this.queued=false;this.closed=false;this.generation=0;
 }
 wallAt(at){return Number.isFinite(at)?this.now()+Math.max(0,at-this.wallNow()):Infinity;}
 add(name,{next,run}){if(this.sources.has(name))throw Error('DUPLICATE_MAINTENANCE_SOURCE');this.sources.set(name,{next,run,at:Infinity,busy:false});this.changed(name);}
 changed(...names){if(this.closed)return;for(const name of names.length?names:this.sources.keys())this.dirty.add(name);if(this.queued)return;this.queued=true;this.defer(()=>{this.queued=false;if(this.closed)return;this.recompute();});}
 recompute(){
  for(const name of this.dirty){const source=this.sources.get(name);if(!source)continue;try{const at=source.busy?Infinity:source.next();source.at=Number.isFinite(at)?at:Infinity;if(source.afterRun&&source.at<=this.now())source.at=this.now()+1000;source.afterRun=false;}catch(e){source.at=Infinity;this.onError(e,name);}}
  this.dirty.clear();this.arm();
 }
 arm(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;if(this.closed)return;const at=Math.min(...[...this.sources.values()].map(s=>s.at));if(!Number.isFinite(at))return;this.timer=this.setTimer(()=>this.fire(),Math.min(2147483647,Math.max(0,at-this.now())));this.timer?.unref?.();}
 fire(){
  this.timer=null;if(this.closed)return;const now=this.now(),generation=this.generation;
  for(const [name,source] of this.sources){if(source.busy||source.at>now)continue;source.at=Infinity;source.busy=true;
   const done=()=>{if(this.closed||generation!==this.generation)return;source.busy=false;source.afterRun=true;this.changed(name);};
   try{const result=source.run();if(result&&typeof result.then==='function')Promise.resolve(result).catch(e=>this.onError(e,name)).finally(done);else done();}catch(e){this.onError(e,name);done();}
  }
  this.arm();
 }
 close(){if(this.closed)return;this.closed=true;this.generation++;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.dirty.clear();this.sources.clear();}
}
