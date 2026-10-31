import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteConnectionTelemetry} from '../app/connection.mjs';
import {DiagnosticEvents,readConnectionTimeline} from '../app/diagnostic-events.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


function site(){
 let now=1000;const rows=[];
 const observer=new SiteConnectionTelemetry({clock:()=>now,events:{record:(kind,value)=>rows.push({kind,...value})}});
 const route={configured:1,state:'healthy'},transport={running:true,ready:false,authenticated:false,transport_epoch:2,runtime_manifest:{state:'accepted',transport_epoch:2}};
 const observe=extra=>observer.observe({route,transport,fresh:true,...extra});
 return {observer,rows,route,transport,observe,at:value=>now=value};
}
test('1070 Site separates local transport, verified cloud and first call; manifest/REST health alone never mean connected',()=>{
 const f=site();f.observe();assert.equal(f.rows.find(r=>r.kind==='conn.cloud').to,'checking');
 assert.deepEqual(f.rows.filter(r=>r.kind==='conn.startup').map(r=>[r.stage,r.outcome,r.source]),[['transport','begin','site'],['transport','ok','site']]);
 assert.equal(f.observer.authenticatedCallSucceeded(2),false);
 f.transport.ready=true;f.transport.authenticated=true;f.transport.runtime_manifest.transport_epoch=1;f.at(1800);f.observe();
 assert.equal(f.observer.authenticatedCallSucceeded(2),false);
 f.transport.runtime_manifest.transport_epoch=2;f.observe({fresh:false});assert.equal(f.observer.authenticatedCallSucceeded(2),false);
 f.observe();assert.equal(f.rows.find(r=>r.stage==='healthy').ms,800);
 f.at(2200);assert.equal(f.observer.authenticatedCallSucceeded(1),false);assert.equal(f.observer.authenticatedCallSucceeded(2),true);
 assert.equal(f.rows.at(-1).reason,'call_ok');assert.equal(f.rows.at(-1).ms,1200);assert.equal(f.rows.at(-1).source,'site');
 assert.equal(f.observer.authenticatedCallSucceeded(2),false);
});
test('1070 Site reconnect observations are categorical and deduplicated; stopped and old epochs cannot revive success',()=>{
 const f=site();f.transport.ready=true;f.transport.authenticated=true;f.observe();
 f.at(3000);f.transport.ready=false;f.transport.websocket={transport_epoch:2,disconnected_at:3000};f.transport.last_error_code='https://PRIVATE_VALUE';
 f.observe();f.observe();assert.equal(f.rows.filter(r=>r.kind==='conn.restart').length,1);assert.equal(f.rows.at(-1).to,'checking');
 assert.equal(JSON.stringify(f.rows).includes('PRIVATE_VALUE'),false);
 f.at(4000);f.transport.running=false;f.observe();assert.equal(f.rows.at(-1).to,'unknown');assert.equal(f.observer.authenticatedCallSucceeded(2),false);
 f.transport.running=true;f.transport.transport_epoch=3;f.observe();assert.equal(f.rows.filter(r=>r.kind==='conn.restart').length,2);
 const before=f.rows.length;f.observe({epoch:2});assert.equal(f.rows.length,before);
 assert.equal(f.observer.authenticatedCallSucceeded(2),false);
 f.transport.ready=true;f.transport.runtime_manifest.transport_epoch=3;f.observe();assert.equal(f.observer.authenticatedCallSucceeded(3),true);
});
test('1070 integrated Site categorical startup/restart metadata survives diagnostic persistence and projection',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'1070-site-events-')),events=new DiagnosticEvents(root,{salt:Buffer.alloc(32)});
 events.record('conn.startup',{source:'site',stage:'transport',outcome:'begin',code:'OK',ms:0});
 if(events.startupSnapshot()[0]?.source!=='site'){t.skip('Chrome-owned diagnostic Site source dictionary is not integrated');return;}
 const observer=new SiteConnectionTelemetry({events});const route={configured:1,state:'healthy'},transport={running:true,transport_epoch:1};
 observer.observe({route,transport,fresh:true});observer.observe({route,transport:{...transport,transport_epoch:2},fresh:true});
 const rows=readConnectionTimeline(root).events;assert.ok(rows.some(row=>row.kind==='conn.startup'&&row.source==='site'));assert.ok(rows.some(row=>row.kind==='conn.restart'&&row.source==='site'));
});
