import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CallTrace,traceFiles,safeResourceURI} from '../../app/call-trace.mjs';
const DAY=86400000;
function fixture(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ch-1060-trace-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=Date.UTC(2026,9,18,12);const trace=new CallTrace(root,[{name:'read_fixture',annotations:{readOnlyHint:true}}],{now:()=>now,...options});return {root,trace,advance(days){now+=days*DAY;}};}
const rpc=(method,params={})=>({jsonrpc:'2.0',id:'PRIVATE_REQUEST_ID',method,params});
test('resource calls record only safe URI/method/result/elapsed plus trace correlation fields',t=>{
 const {trace}=fixture(t);const mark=trace.startObservation();
 for(const method of ['resources/read','resources/list']){const id=trace.receiveRPC(rpc(method,{uri:'ui://chathand/task.html?token=SECRET_QUERY#SECRET_FRAGMENT',content:'SECRET_BODY'}),'SECRET_CALLER');trace.handled(id,{result:{contents:[{text:'SECRET_HTML',_meta:{nonce:'SECRET_NONCE'}}]}});}
 const rows=trace.endObservation(mark.id).events;assert.equal(rows.length,4);
 for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['format','instance_id','seq','at','event','call_id','method','uri',...(row.event==='rpc_received'?[]:['code','duration_ms'])].sort());
 assert.equal(rows[1].uri,'ui://chathand/task.html');assert.equal(rows[1].code,'OK');assert.equal(rows[3].uri,null);
 const raw=fs.readFileSync(trace.file,'utf8');for(const s of ['SECRET','PRIVATE_REQUEST_ID','response_bytes','caller_hash'])assert.equal(raw.includes(s),false);
 assert.equal(trace.snapshot().host_received_response,'not_observable');
});
test('unsafe URI paths/userinfo and untrusted errors are never logged; JSON-RPC error code retained',t=>{
 const {trace}=fixture(t);
 for(const uri of ['https://user:SECRET@private.invalid/SECRET?token=SECRET','file:///Users/SECRET/key','ui://chathand/SECRET.html','ui://chathand/task.html/SECRET','ui://chathand/%74ask.html'])assert.equal(safeResourceURI(uri),null);
 let id=trace.receiveRPC(rpc('resources/read',{uri:'file:///SECRET'}),'private');trace.handled(id,{error:{code:-32002,message:'SECRET'}});assert.equal(trace.entries.at(-1).code,-32002);
 id=trace.receiveRPC(rpc('resources/read',{uri:'ui://chathand/task.html'}),'private');trace.handlerException(id,{code:'SECRET_EXCEPTION',message:'SECRET'});assert.equal(trace.entries.at(-1).code,'UNCLASSIFIED');assert.equal(JSON.stringify(trace.entries).includes('SECRET'),false);assert.equal(trace.resourceCalls.size,0);
});
test('daily UTC files keep same-day evidence above the old 2MB limit and do not rotate',t=>{
 const {trace,advance}=fixture(t);const old=trace.file;const original=fs.readFileSync(old);fs.appendFileSync(old,' '.repeat(2*1024*1024));trace.record('fixture',null,{});assert.ok(fs.statSync(old).size>2*1024*1024);assert.equal(trace.rotations,0);assert.equal(trace.write_failures,0);
 advance(1);trace.record('fixture',null,{});assert.notEqual(trace.file,old);assert.equal(traceFiles(trace.dir).length,2);assert.ok(fs.readFileSync(old).subarray(0,original.length).equals(original));
 if(process.platform!=='win32')assert.equal(fs.statSync(trace.file).mode&0o777,0o600);
});
test('retention keeps 30 full days, then prunes oldest day; legacy files remain readable and untouched',t=>{
 const {trace,advance}=fixture(t,{retentionDays:1});const first=trace.file,legacy=path.join(trace.dir,'rpc.jsonl');fs.writeFileSync(legacy,'legacy fixture');
 advance(30);trace.record('fixture',null,{});assert.equal(fs.existsSync(first),true);advance(1);trace.record('fixture',null,{});assert.equal(fs.existsSync(first),false);assert.equal(fs.readFileSync(legacy,'utf8'),'legacy fixture');assert.equal(path.basename(traceFiles(trace.dir)[0]),'rpc.jsonl');assert.equal(trace.snapshot().storage.retention_days,30);
});
test('total cap evicts oldest complete days before newer evidence and discloses pressure',t=>{
 const {trace,advance}=fixture(t,{maxBytes:1600});const first=trace.file;fs.truncateSync(first,1400);advance(1);trace.record('fixture',null,{});const second=trace.file;advance(1);trace.record('fixture',null,{});
 assert.equal(fs.existsSync(first),false);assert.equal(fs.existsSync(second),true);assert.equal(trace.capacity_pruned_days,1);assert.ok(traceFiles(trace.dir).reduce((n,f)=>n+fs.statSync(f).size,0)<=1600);
});
test('current-day saturation preserves original bytes and discloses incomplete observations',t=>{
 const {trace}=fixture(t,{maxBytes:500});const m=trace.startObservation();for(let i=0;i<8;i++)trace.record('fixture',null,{});assert.ok(trace.write_failures>0);assert.ok(fs.statSync(trace.file).size<=500);assert.equal(trace.endObservation(m.id).conclusion,'TRACE_INCOMPLETE');
});
for(const kind of ['symlink','hardlink','directory'])test('daily writer rejects unsafe '+kind+' without changing target',t=>{
 const {trace,root}=fixture(t),outside=path.join(root,'untouched');fs.writeFileSync(outside,'safe');fs.unlinkSync(trace.file);
 if(kind==='symlink')fs.symlinkSync(outside,trace.file);if(kind==='hardlink')fs.linkSync(outside,trace.file);if(kind==='directory')fs.mkdirSync(trace.file);
 trace.record('fixture',null,{});assert.equal(fs.readFileSync(outside,'utf8'),'safe');assert.ok(trace.write_failures>0);
});
test('existing observation/query counters and bounded memory remain compatible',t=>{
 const {trace}=fixture(t,{capacity:4}),m=trace.startObservation();for(let i=0;i<30;i++){const id=trace.receiveRPC(rpc('tools/call',{name:'read_fixture',arguments:{path:'SECRET_PATH'}}),'caller');trace.handled(id,{result:{isError:false}});}
 assert.equal(trace.entries.length,4);const out=trace.endObservation(m.id);assert.equal(out.delta.read_calls,30);assert.equal(out.rows_complete,false);assert.equal(out.trace_complete,true);assert.equal(out.platform_root_cause,'NOT_DETERMINED');assert.equal(JSON.stringify(trace.entries).includes('SECRET_PATH'),false);
});
test('daily cap counts preserved legacy evidence; malformed date filenames are not managed',t=>{
 const {trace,advance}=fixture(t,{maxBytes:800}),first=trace.file,legacy=path.join(trace.dir,'rpc.jsonl.1'),unknown=path.join(trace.dir,'rpc-2026-99-99.jsonl');
 fs.writeFileSync(legacy,'x'.repeat(550));fs.writeFileSync(unknown,'untouched');advance(1);trace.record('fixture',null,{});
 assert.equal(fs.existsSync(first),false);assert.equal(fs.statSync(legacy).size,550);assert.equal(fs.readFileSync(unknown,'utf8'),'untouched');assert.equal(traceFiles(trace.dir).includes(unknown),false);
});
test('resource exception and abort paths release pending resource metadata',t=>{
 const {trace}=fixture(t),id=trace.receiveRPC(rpc('resources/read',{uri:'ui://chathand/task.html'}),'fixture');trace.httpDone(id,499,true);assert.equal(trace.resourceCalls.size,0);assert.equal(trace.inflight.size,0);
});
