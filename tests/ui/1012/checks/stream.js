'use strict';
const fs=require('node:fs'),vm=require('node:vm'),{result}=require('./common');
const auth=fs.readFileSync('ui/auth.js','utf8'),code=fs.readFileSync('ui/stream.js','utf8'),checks=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,...(detail?{detail}:{})});
async function environment(mode='on'){
 let now=0,id=0,streams=[],calls=[],events=[],statuses=[],logs=[],tasks=new Map();
 const later=(fn,delay,repeat=0)=>{const key=++id;tasks.set(key,{at:now+delay,fn,repeat});return key;};
 const ctx={window:{},location:{hash:'#test.test-ui',href:'http://127.0.0.1:1234/#test.test-ui',origin:'http://127.0.0.1:1234',hostname:'127.0.0.1'},URL,performance:{now:()=>now},Math:{...Math,random:()=>.5,min:Math.min,max:Math.max},ReadableStream,Response,TextDecoder,TextEncoder,AbortController,console:{warn:x=>logs.push(x)},setTimeout:(fn,ms)=>later(fn,ms),clearTimeout:key=>tasks.delete(key),setInterval:(fn,ms)=>later(fn,ms,ms),clearInterval:key=>tasks.delete(key)};
 const fetch=async(route,opt)=>{calls.push({route,at:now,headers:opt.headers});if(route==='/api/state')return new Response(JSON.stringify({value:'fallback'}));if(mode==='off')return new Response('{}',{status:503});if(mode==='401'||mode==='403')return new Response('{}',{status:+mode});let controller;const body=new ReadableStream({start(c){controller=c;streams.push(c);c.enqueue(new TextEncoder().encode('event: state\ndata: {"value":"first"}\n\n'));},cancel(){streams=streams.filter(c=>c!==controller);}});opt.signal.addEventListener('abort',()=>{streams=streams.filter(c=>c!==controller);try{controller.close();}catch{}});return new Response(body);};
 ctx.fetch=fetch;vm.createContext(ctx);vm.runInContext(auth,ctx);vm.runInContext(code,ctx);ctx.window.ChatHandStream.start(state=>events.push(['state',state]),patch=>events.push(['patch',patch]),status=>statuses.push(status));
 const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};await flush();
 const tick=async(ms)=>{const end=now+ms;while(true){const next=[...tasks.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;tasks.delete(next[0]);if(next[1].repeat)tasks.set(next[0],{...next[1],at:now+next[1].repeat});next[1].fn();await flush();}now=end;await flush();};
 const push=async(raw)=>{for(const c of streams)c.enqueue(new TextEncoder().encode(raw));await flush();};
 return {stream:ctx.window.ChatHandStream,calls,events,statuses,logs,tick,push,mode:value=>{mode=value;},drop:async()=>{for(const c of streams)c.close();streams=[];await flush();},flush};
}
(async()=>{
 const live=await environment();check('B1 complete state and authorization headers',live.stream.status()==='live'&&live.events[0][1].value==='first'&&!!live.calls[0].headers.Authorization&&!!live.calls[0].headers['X-ChatHand-UI']);
 await live.push('event: patch\r');await live.push('\ndata: {\r\ndata: "value":"changed"}\r\n\r\n');check('CRLF fragmented frames and multiline data',live.events.at(-1)[0]==='patch'&&live.events.at(-1)[1].value==='changed');
 await live.drop();check('B4 live stream drop enters reconnecting',live.stream.status()==='reconnecting');await live.tick(500);check('B4 reconnect receives a new full state',live.stream.status()==='live'&&live.events.filter(e=>e[0]==='state').length===2);live.stream.stop();
 const failed=await environment('off');await failed.tick(1500);check('B4 three failures enter fallback',failed.stream.status()==='fallback'&&failed.calls.filter(c=>c.route==='/api/events').length===3);await failed.tick(30000);check('B4 fallback queries on 30 seconds',failed.calls.filter(c=>c.route==='/api/state').length===1);failed.mode('on');await failed.tick(16000);const gets=failed.calls.filter(c=>c.route==='/api/state').length;await failed.tick(31000);check('B4 recovered stream stops fallback',failed.stream.status()==='live'&&failed.calls.filter(c=>c.route==='/api/state').length===gets);failed.stream.stop();
 const quiet=await environment();await quiet.tick(59999);check('B5 watchdog holds before 60 seconds',quiet.calls.length===1);await quiet.tick(501);check('B5 no bytes for 60 seconds reconnects',quiet.calls.filter(c=>c.route==='/api/events').length===2);quiet.stream.stop();
 const ping=await environment();await ping.tick(50000);await ping.push('event: ping\ndata: {}\n\n');await ping.tick(20000);check('Ping bytes reset watchdog',ping.calls.length===1);ping.stream.stop();
 for(const code of ['401','403']){const auth=await environment(code);await auth.tick(120000);check('B6 '+code+' stops as blocked without retry or polling',auth.stream.status()==='blocked'&&auth.calls.filter(c=>c.route==='/api/events').length===1&&auth.calls.filter(c=>c.route==='/api/state').length===0&&auth.logs.length===1);auth.stream.stop();}
 result('B-stream',checks);
})().catch(error=>{console.error(error);process.exitCode=1;});
