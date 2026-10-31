import {legacyChromeDistribution} from '../app/v1/chrome-distribution.mjs';
class ExtensionBrowser extends ProductionExtensionBrowser {constructor(state,store,policy){super(state,store,policy,{distribution:legacyChromeDistribution()});}}
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {ExtensionBrowser as ProductionExtensionBrowser} from '../app/v09/extension-browser.mjs';

const current={version:'1.0.0.1070',build:1070,features:['self_reload']};
const old={version:'1.0.0.1069',build:1069,features:['self_reload']};
function fixture(t){
 const state={data:{browser_enabled:true},save(){}},policy={epoch:1,check(){},require(){},tasks:new Map()};
 const ext=new ExtensionBrowser(state,{},policy);
 ext.expected={version:current.version,build:current.build,folder:'/synthetic/expected-helper'};
 t.after(()=>ext.closeAll());return ext;
}

test('manual current handshake replaces an idle legacy copy immediately and the old session cannot take it back',t=>{
 const ext=fixture(t),legacy=crypto.randomUUID(),fresh=crypto.randomUUID();
 ext.next(legacy,{...old,features:[]});assert.equal(ext.helperStatus().state,'stale');
 ext.next(fresh,current);assert.equal(ext.session,fresh);assert.equal(ext.helperStatus().state,'current');
 assert.equal(ext.status().connected,true);
 assert.throws(()=>ext.next(legacy,old),{code:'EXTENSION_PROFILE_BUSY'});
 assert.equal(ext.helperStatus().state,'current');
 assert.equal(ext.helperStatus().loaded_folder_verified,false);
 assert.equal(ext.helperStatus().loaded_folder_status,'unknown');
});

test('a current helper clears the reload exception so repeated old copies cannot churn the connection',t=>{
 const ext=fixture(t),a=crypto.randomUUID(),b=crypto.randomUUID(),fresh=crypto.randomUUID();
 ext.next(a,old);assert.equal(ext.next(a,old).control,'reload');
 ext.next(b,old);assert.equal(ext.helperStatus().state,'wrong_folder');
 ext.next(fresh,current);assert.equal(ext.reloadAsked.size,0);
 for(const session of [a,b])assert.throws(()=>ext.next(session,old),{code:'EXTENSION_PROFILE_BUSY'});
 assert.equal(ext.session,fresh);assert.equal(ext.helperStatus().build,1070);
});

test('replacement waits for pending browser work even when a reload was already requested',async t=>{
 const ext=fixture(t),oldSession=crypto.randomUUID(),fresh=crypto.randomUUID();
 ext.next(oldSession,old);ext.next(oldSession,old);
 const pending=ext.request('tabs',{},'caller','task');const rejected=assert.rejects(pending,{code:'TASK_REVOKED'});
 assert.throws(()=>ext.next(fresh,current),{code:'EXTENSION_PROFILE_BUSY'});
 assert.equal(ext.pending.size,1);assert.equal(ext.session,oldSession);
 ext.cancelAll();await rejected;ext.next(fresh,current);
 assert.equal(ext.helperStatus().state,'current');
});

test('a matching helper reload receipt survives backend restart as a troubleshooting hint without directory proof',t=>{
 const ext=fixture(t),session=crypto.randomUUID();
 const report={...old,last_reload:{at:Date.now()-1000,from:old.version,to:current.version}};
 ext.next(session,report);assert.notEqual(ext.next(session,report).control,'reload');
 const status=ext.helperStatus();assert.equal(status.state,'wrong_folder');assert.equal(status.reason,'reload_kept_old_helper');
 assert.equal(status.loaded_folder_verified,false);assert.equal(status.actual_folder,undefined);
 ext.next(crypto.randomUUID(),current);assert.equal(ext.helperStatus().state,'current');
});

test('a reload receipt for another version, a future receipt or another old-version request is not wrong-folder evidence',t=>{
 const ext=fixture(t),session=crypto.randomUUID();
 for(const patch of [{to:'1.0.0.1068'},{from:'1.0.0.1068'},{at:Date.now()+60000},{at:-1}]){
  ext.noteHelper(session,{...old,last_reload:{at:Date.now()-1000,from:old.version,to:current.version,...patch}});
  assert.equal(ext.helperStatus().state,'stale');
 }
 ext.noteHelper(session,old);ext.reloadControl();
 ext.noteHelper(crypto.randomUUID(),{version:'1.0.0.1068',build:1068,features:[]});
 assert.equal(ext.helperStatus().state,'stale');
});

test('recheck-only mode preserves the session, pending request and install lease and sends no reconnect control',async t=>{
 const ext=fixture(t),session=crypto.randomUUID();ext.next(session,current);
 const pending=ext.request('tabs',{},'caller','task'),rejected=assert.rejects(pending,{code:'TASK_REVOKED'});
 let stopped=0;ext.installProbe={stop(){stopped++;},publicStatus:()=>({active:false}),next:()=>null};
 const before={session:ext.session,epoch:ext.epoch,timer:ext.connectionTimer,pending:ext.pending.size};
 const status=ext.reconnect({recheckOnly:true});
 assert.equal(status.rechecked,true);assert.equal(status.reconnecting,false);assert.equal(status.helper.state,'current');
 assert.deepEqual({session:ext.session,epoch:ext.epoch,timer:ext.connectionTimer,pending:ext.pending.size},before);
 assert.equal(stopped,0);assert.equal(ext.reconnectRequested,false);
 assert.equal(ext.next(session,current).kind,'request');ext.cancelAll();await rejected;
});
