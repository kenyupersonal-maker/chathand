import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktop} from '../../app/server.mjs';
import {DesktopState} from '../../app/state.mjs';
import {spawn} from 'node:child_process';
import {spawnWorkspaceProbe} from '../../app/v1/workspace-inspector.mjs';
import {Automation} from '../../app/v07/automation.mjs';
import {storeTestDistribution} from './chrome-store-fixture.mjs';

export async function workspaceFixture(t,{missing=true,pathValue,mode='auto',beforeBoot}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-workspace-recovery-'))),stateDir=path.join(root,'state'),work=path.join(root,'Portfolio'),preserved=path.join(root,'Portfolio-preserved'),other=path.join(root,'Other-project');
 const seed=new DesktopState(stateDir,{defaultRoot:work});fs.writeFileSync(path.join(work,'original.txt'),'ORIGINAL_PROJECT');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'other.txt'),'OTHER_PROJECT');
 const selected=seed.project();selected.name='Portfolio Workspace';if(pathValue!==undefined)selected.path=typeof pathValue==='function'?pathValue({root,work,stateDir,other}):pathValue;
 const second=seed.addProject({name:'Other Project',folder:other});
 Object.assign(seed.data,{setup_complete:true,onboarding:true,setup_workspace_confirmed:true,mode,full_access_confirmed:mode==='full',permission_tier_intent:mode==='full'?'full':'light',connection_preference:'none',auto_connect:false,browser_enabled:true,terminal_enabled:true,desktop_enabled:false,access_enabled:true});seed.save();
 if(missing)fs.renameSync(work,preserved);
 const uiKey='a1'.repeat(32),distribution=storeTestDistribution();let app;
 const f={root,stateDir,work,preserved,other,selectedId:selected.id,secondId:second.id,uiKey};
 f.boot=async()=>{
  app=await createDesktop({stateDir,defaultRoot:f.freshDefaultRoot,uiKey,lock:false,adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{workspaceProbeTimeoutMs:f.probeTimeoutMs,workspaceProbeFactory:data=>{if(f.probeFactory)return f.probeFactory(data);const result=f.probeOverride?.(data);if(result===undefined)return spawnWorkspaceProbe();return spawn(process.execPath,['-e','process.once("message",()=>process.send('+JSON.stringify(result)+',()=>process.exit(0)))'],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','ignore','ipc'],detached:true});},automationFactory:(state,store,policy)=>{const automation=new Automation(state,store,policy);automation.browser.personal.chromeInfo=()=>({installed:true,supported:true,major:144,minimum_major:144});automation.browser.managed.status=()=>({available:true,engine:'Synthetic managed browser',sessions:0});return automation;},chromeDistribution:distribution,computerName:()=> 'Synthetic Recovery Mac',tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({status:'off',ready:false,healthy:false,process_running:false})}),updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),reconcileStartup:async()=>({reconciled:false}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
  f.app=app;f.origin=`http://127.0.0.1:${app.apiPort}`;
  await f.post('/api/access',{enabled:true});return app;
 };
 f.post=async(route,body={},ui=true)=>{const r=await fetch(f.origin+route,{method:'POST',headers:{Authorization:'Bearer '+app.adminToken,'Content-Type':'application/json',...(ui?{'X-ChatHand-UI':uiKey}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 f.read=async route=>{const r=await fetch(f.origin+route,{headers:{Authorization:'Bearer '+app.adminToken,'X-ChatHand-UI':uiKey}});return {status:r.status,body:await r.json()};};
 f.close=async()=>{if(app){const old=app;app=null;await old.close();}};
 t.after(async()=>{await f.close();fs.rmSync(root,{recursive:true,force:true});});
 beforeBoot?.(f);await f.boot();return f;
}
