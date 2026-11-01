import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';

const serverSource=fs.readFileSync(new URL('../../app/server.mjs',import.meta.url),'utf8');
test('fresh isolated App is empty; normal tool writes survive App restart',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-matter-app-')));
 const work=path.join(root,'work'),stateDir=path.join(root,'state');fs.mkdirSync(work);
 let current;
 t.after(async()=>{await current?.close();fs.rmSync(root,{recursive:true,force:true});});
 const open=()=>createDesktop({stateDir,defaultRoot:work,uiKey:'bd'.repeat(32),clientDeps:{
  currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic notes fixture',
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),
  updaterFactory:()=>({currentBuild:1084,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null,just_updated:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})
 }});
 current=await open();assert.equal(current.tools.matterStore.items.size,0);
 await current.handle('/api/access',{enabled:true});await current.handle('/api/mode',{mode:'full',confirm:true});
 const context={setupPrincipal:'test:notes-user',session:'notes-fixture-session'};
 const result=await current.tools.invoke('matter_write',{request_id:'notes-write-0001',entries:[{
  operation_id:'notes-operation-0001',action:'create',title:'User note',
  raw:{speaker:'User',text:'Synthetic note created through the normal tool'},state:'deferred'
 }]},'chatgpt',context);
 assert.equal(result.items[0].saved,true);const id=result.items[0].id,file=current.tools.matterStore.file(id),before=fs.readFileSync(file);
 await current.close();current=null;current=await open();
 const query=await current.tools.invoke('matter_query',{ids:[id],view:'summary'},'chatgpt',context);
 assert.equal(query.items[0].title,'User note');assert.equal(current.tools.matterStore.items.size,1);
 assert.deepEqual(fs.readFileSync(file),before);
});

test('runtime and App build have no dependency on historical personal import files',()=>{
 const build=fs.readFileSync(new URL('../../scripts/build-v09.mjs',import.meta.url),'utf8');
 const privateImport=/legacy-matters-1051|matter-source-1051|matter-import\.mjs|importInitialMatters|importBundledInitialMatters/;
 assert.doesNotMatch(serverSource,privateImport);assert.doesNotMatch(build,privateImport);
});
