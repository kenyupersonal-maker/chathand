import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createRelayWorker,createWsHooks,loadRuntime} from './fixtures/relay-worker-v412.mjs';
import {createRelaySession} from './fixtures/ws-relay-session.mjs';
import {runWsClient} from '../../app/v1/relay-v412/ws-relay-client.mjs';

export const BASE=path.resolve(path.dirname(new URL(import.meta.url).pathname));
export const manifest=JSON.parse(fs.readFileSync(path.join(BASE,'tests/fixtures/catalog.json'),'utf8'));
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const rpc=(id,name='read_file',arguments_={path:'/fixture'})=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:arguments_}});
export const request=body=>new Request('https://fixture.invalid/mcp',{method:'POST',headers:{'oai-authenticated-user-email':'fixture@example.invalid'},body:JSON.stringify(body)});
export class D1 {
 constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec('PRAGMA foreign_keys=ON');const dir=path.join(BASE,'site/drizzle');for(const name of fs.readdirSync(dir).filter(name=>/^\d+_.+\.sql$/.test(name)).sort())this.sqlite.exec(fs.readFileSync(path.join(dir,name),'utf8'));this.calls=[];this.roundtrips=[];this.batchId=0;this.currentBatch=null;this.beforeBatch=null;seedRuntime(this.sqlite);}
 migrate(file){this.sqlite.exec(fs.readFileSync(file,'utf8'));}
 // Match D1: binding creates a new statement and leaves the source unchanged.
 prepare(sql,args=[]){const db=this;return {_sql:sql,bind(...values){assert.ok(values.length<=100,'D1 max 100 bound parameters');return db.prepare(sql,values);},first(){return run('first');},all(){return run('all');},run(){return run('run');}};
  function run(kind){const call={sql,args:[...args],kind,batch:db.currentBatch};db.calls.push(call);if(db.currentBatch===null)db.roundtrips.push([call]);const query=db.sqlite.prepare(sql);const before=db.sqlite.prepare('SELECT total_changes() AS n').get().n;const results=query.columns().length?query.all(...args):(query.run(...args),[]);const changes=Number(db.sqlite.prepare('SELECT total_changes() AS n').get().n-before);if(kind==='first')return results[0]??null;return {success:true,results,meta:{changes,duration:0.1,served_by_region:'FIXTURE',served_by_primary:true}};}}
 batch(statements){const barrier=this.beforeBatch?.(statements);return barrier?.then?barrier.then(()=>this.executeBatch(statements)):this.executeBatch(statements);}
 executeBatch(statements){const before=this.calls.length;this.sqlite.exec('BEGIN');this.currentBatch=++this.batchId;try{const result=statements.map(q=>q.run());this.sqlite.exec('COMMIT');this.roundtrips.push(this.calls.slice(before));return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}finally{this.currentBatch=null;}}
}
export const defaultSettings={hotMs:50,warmMs:100,coldMs:500,hotWindowMs:30000,warmWindowMs:300000,rotateMs:45000,maxOperations:200};
function seedRuntime(sqlite){if(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rc_runtime'").get())sqlite.prepare("INSERT INTO rc_runtime(id,manifest_json,settings_json,revision,updated_at) VALUES('mac',?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER)) ON CONFLICT(id) DO NOTHING").run(JSON.stringify(manifest),JSON.stringify(defaultSettings),'fixture-v41');}
function serverFrame(text){const bytes=Buffer.from(text),n=bytes.length<126?2:bytes.length<=65535?4:10,header=Buffer.alloc(n);header[0]=129;header[1]=n===2?bytes.length:n===4?126:127;if(n===4)header.writeUInt16BE(bytes.length,2);if(n===10)header.writeBigUInt64BE(BigInt(bytes.length),2);return Buffer.concat([header,bytes]);}
function decodeClient(bytes){let length=bytes[1]&127,at=2;if(length===126){length=bytes.readUInt16BE(2);at=4;}else if(length===127){length=Number(bytes.readBigUInt64BE(2));at=10;}const mask=bytes.subarray(at,at+4),raw=Buffer.from(bytes.subarray(at+4,at+4+length));for(let i=0;i<raw.length;i++)raw[i]^=mask[i%4];return {opcode:bytes[0]&15,payload:raw};}
export function setup({dropAck=false,dropResultBeforeCommit=false,delayTaskEndMs=0,blockAfterTaskEndMs=0,sessionOptions={},beforeClientFrame,afterServerFrame,beforeConnect,configureHooks,onClientWrite,sessionFactory=createRelaySession}={}){
 const db=new D1(),env={DB:db,RELAY_ACTIVE:'true',RELAY_PAIRING_KEY:'synthetic-only',RELAY_OWNER_EMAIL:'fixture@example.invalid'},worker=createRelayWorker(manifest),sessions=[],clientFrames=[],serverFrames=[],background=new Set(),backgroundErrors=[];let drop=dropAck,dropResult=dropResultBeforeCommit,connections=0;
 const ctx={waitUntil:work=>{background.add(work);work.catch(error=>backgroundErrors.push(error)).finally(()=>background.delete(work));}};const fetch=worker.fetch.bind(worker);worker.fetch=(req,bindings=env,context=ctx)=>fetch(req,bindings,context);
 let attempts=0;
 const connect=async()=>{const attempt=++attempts;await beforeConnect?.(attempt,{db,env});const runtime=await loadRuntime(env,manifest);const connection=++connections;const socket=new EventEmitter(),server=new EventEmitter();let closed=false;
  const end=()=>{if(closed)return;closed=true;socket.emit('close');server.emit('close',{});};
  socket.setTimeout=()=>{};socket.destroy=end;socket.write=bytes=>{if(closed)return false;const frame=decodeClient(bytes);if(frame.opcode===8){end();return true;}if(frame.opcode===1){const value=JSON.parse(frame.payload.toString('utf8'));onClientWrite?.(value,{connection,socket,server});setImmediate(async()=>{if(closed)return;clientFrames.push(value);if(dropResult&&value.type==='result-end'){dropResult=false;end();return;}await beforeClientFrame?.(value,{db,env,worker,connection,socket,server});if(!closed)server.emit('message',{data:JSON.stringify(value)});});}return true;};
  server.accept=()=>{};server.addEventListener=(name,fn)=>server.on(name,fn);server.close=end;server.send=text=>{const frame=JSON.parse(text);serverFrames.push(frame);afterServerFrame?.(frame,{db,env,worker,connection,socket,server});if(frame.type==='ack'&&drop){drop=false;setImmediate(end);return;}const deliver=()=>{if(!closed){socket.emit('data',serverFrame(text));if(frame.type==='task-end'&&blockAfterTaskEndMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,blockAfterTaskEndMs);}};if(frame.type==='task-end'&&delayTaskEndMs)setTimeout(deliver,delayTaskEndMs);else setImmediate(deliver);};
  const hooks=createWsHooks(env,ctx);hooks.toolPolicy=name=>{const tool=runtime.manifest.tools.tools.find(t=>t.name===name);return {known:!!tool,readonly:tool?.annotations?.readOnlyHint===true,destructive:!tool||tool.annotations?.destructiveHint===true};};configureHooks?.(hooks,{connection,server,socket});const session=sessionFactory(server,hooks,{...runtime.settings,...sessionOptions});sessions.push(session);return {socket,head:Buffer.alloc(0)};};
 const flushBackground=async()=>{while(background.size)await Promise.allSettled([...background]);};
 return {db,env,worker,connect,sessions,clientFrames,serverFrames,ctx,background,backgroundErrors,flushBackground,get connections(){return connections;}};
}
export async function settle(predicate,ms=3000){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('TEST_TIMEOUT');}
export function online(h,age=0){h.db.sqlite.prepare("INSERT INTO rc_devices(id,last_seen,generation) VALUES('mac',?,'fixture') ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen").run(Date.now()-age);}
export async function start(h,{execute,durationMs=1100,clientFactory=runWsClient}={}){const runtime=await loadRuntime(h.env,manifest),root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-v4-offline-')),logs=[];let executions=0;const running=clientFactory({connect:h.connect,execute:async(...args)=>{executions++;return execute?execute(...args):{response:{jsonrpc:'2.0',id:args[0].id,result:{ok:true}},elapsed_ms:1};},toolManifest:Object.fromEntries(runtime.manifest.tools.tools.map(t=>[t.name,t])),cacheKey:crypto.randomBytes(32),root,durationMs,log:e=>logs.push(e)});return {root,logs,running,get executions(){return executions;}};}
export async function cleanup(h,s){for(const session of h.sessions)session.close();if(s){await s.running;fs.rmSync(s.root,{recursive:true,force:true});}await h.flushBackground();h.db.sqlite.close();}
export function assembly(rpc_){const bytes=Buffer.from(JSON.stringify(rpc_));return {parts:[{sequence:0,chunk_hash:sha(bytes),data_b64:bytes.toString('base64'),bytes}],total_bytes:bytes.length,total_chunks:1,sha256:sha(bytes)};}
