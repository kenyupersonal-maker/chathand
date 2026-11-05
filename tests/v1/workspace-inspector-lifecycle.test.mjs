import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter,once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {copyBundleTree} from '../../scripts/build-privacy.mjs';
import {WorkspaceInspector,spawnWorkspaceProbe} from '../../app/v1/workspace-inspector.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'chathand-probe-lifecycle-')),work=path.join(root,'workspace'),state=path.join(root,'state');fs.mkdirSync(work);fs.mkdirSync(state);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,work,state};}
class FakeChild extends EventEmitter{
 constructor(pid=654321){super();Object.assign(this,{pid,exitCode:null,signalCode:null,killed:false,connected:true,kills:[],channel:{unref(){}}});}
 unref(){} send(_data,callback){callback?.();} disconnect(){this.connected=false;}
 kill(signal){this.kills.push(signal);this.killed=true;this.signalCode=signal;queueMicrotask(()=>this.emit('exit',null,signal));return true;}
}

test('a successful owned probe exits naturally even when its inspector closes immediately',async t=>{
 const {work,state}=fixture(t);let child,exit,kills=0;const inspector=new WorkspaceInspector({factory:()=>{child=spawnWorkspaceProbe();exit=once(child,'exit');const kill=child.kill.bind(child);child.kill=(...args)=>{kills++;return kill(...args);};return child;}});t.after(()=>inspector.close());
 const result=await inspector.inspect(work,state);assert.equal(result.available,true);inspector.close();await exit;assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);assert.equal(kills,0);assert.equal(inspector.children.size,0);assert.equal(inspector.retiring.size,0);
});

test('an exited child handle is never killed or retained when its numeric PID is reused',async()=>{
 const original=new FakeChild(),unrelated=new FakeChild(original.pid),inspector=new WorkspaceInspector({factory:()=>original,timeoutMs:1000});const pending=inspector.inspect('/synthetic/workspace','/synthetic/state');original.exitCode=0;original.emit('exit',0,null);assert.equal((await pending).code,'WORKSPACE_PROBE_FAILED');inspector.cancel();inspector.close();assert.deepEqual(original.kills,[]);assert.deepEqual(unrelated.kills,[]);assert.equal(inspector.children.size,0);assert.equal(inspector.retiring.size,0);
});

test('cancel kills only the owned live handle once, and failed spawn consumes no child slot',async()=>{
 const child=new FakeChild(),inspector=new WorkspaceInspector({factory:()=>child});const pending=inspector.inspect('/synthetic/workspace','/synthetic/state');inspector.cancel();inspector.close();assert.deepEqual(await pending,{cancelled:true});assert.deepEqual(child.kills,['SIGKILL']);await new Promise(r=>setImmediate(r));assert.equal(inspector.children.size,0);
 const failed=new FakeChild();failed.pid=undefined;const other=new WorkspaceInspector({factory:()=>failed});const failure=other.inspect('/synthetic/workspace','/synthetic/state');failed.emit('error',Error('Synthetic spawn failure'));assert.equal((await failure).code,'WORKSPACE_PROBE_FAILED');assert.equal(other.children.size,0);other.close();assert.deepEqual(failed.kills,[]);
});

test('a completed success that is still exiting is never reused by a later operation',async()=>{
 const children=[new FakeChild(654321),new FakeChild(654322)];let spawned=0;const inspector=new WorkspaceInspector({factory:()=>children[spawned++]});
 const first=inspector.inspect('/synthetic/workspace','/synthetic/state');children[0].emit('message',{available:true,real_path:'/synthetic/workspace',identity:{ino:1}});assert.equal((await first).identity.ino,1);
 const next=inspector.inspect('/synthetic/workspace','/synthetic/state');assert.equal(spawned,2);children[1].emit('message',{available:true,real_path:'/synthetic/workspace',identity:{ino:2}});assert.equal((await next).identity.ino,2);
 for(const child of children){child.exitCode=0;child.emit('exit',0,null);}inspector.close();assert.equal(inspector.children.size,0);
});

test('production runtime copy includes the isolated probe and runs it from the copied layout',async t=>{
 const {root,work,state}=fixture(t),source=fileURLToPath(new URL('../..',import.meta.url)),runtime=path.join(root,'runtime');
 // This uses the same production tree copier and directory layout as build-v09,
 // without compiling, signing, installing, or producing an application package.
 copyBundleTree(path.join(source,'app'),path.join(runtime,'app'),source);copyBundleTree(path.join(source,'engine/src'),path.join(runtime,'engine/src'),source);
 const build=fs.readFileSync(path.join(source,'scripts/build-v09.mjs'),'utf8');assert.match(build,/function copy\(a,b\)\{copyBundleTree\(a,b,root\);\}/);assert.match(build,/for\(const f of \['app',/);
 for(const name of ['workspace-inspector.mjs','workspace-probe-child.mjs','workspace-recovery.mjs'])assert.deepEqual(fs.readFileSync(path.join(runtime,'app/v1',name)),fs.readFileSync(path.join(source,'app/v1',name)));
 const {WorkspaceInspector:CopiedInspector}=await import(pathToFileURL(path.join(runtime,'app/v1/workspace-inspector.mjs')).href),inspector=new CopiedInspector();t.after(()=>inspector.close());const result=await inspector.inspect(work,state);assert.equal(result.available,true);assert.equal(result.real_path,fs.realpathSync(work));
});
