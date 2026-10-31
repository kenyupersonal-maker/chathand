import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {createDesktop} from '../../app/server.mjs';
export async function desktop(t,options={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ch1052-a-'))),work=path.join(root,'work');fs.mkdirSync(work);
 let time=Date.now(),maintenance;
 const tunnel={child:null,key:'synthetic-test-key',tunnelId:'synthetic-tunnel',stop(){this.child=null;},doctor:async()=>({ok:true}),start(){this.child={pid:0};},snapshot:async()=>({healthy:true,ready:true,process_running:true}),configure(){}};
 const transport={setRpcDelivery(fn){this.deliver=fn;},setRuntimeFactory(fn){this.runtime=fn;},setHostFlow(){},close(){},stop(){},status:()=>({ready:false})};
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'ac'.repeat(32),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{...(options.chromeDistribution?{chromeDistribution:options.chromeDistribution}:{}),...(options.siteNetworkFetch?{siteNetworkFetch:options.siteNetworkFetch}:{}),maintenanceClock:{now:()=>time,setInterval(fn){maintenance=fn;return {unref(){}};},clearInterval(){}},credentials:options.credentials||{get:()=>null,publicStatus:()=>({}),status:()=>({}),set(){},remove(){}},bSiteTransport:transport,currentAppPath:path.join(root,'ChatHand.app'),computerName:()=> 'Synthetic Mac',tunnelFactory:()=>tunnel,updaterFactory:()=>({currentBuild:1052,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 if(options.extensionHelper){const ext=app.tools.automation.browser.extension,next=ext.next.bind(ext);ext.noteHelper('fixture',options.extensionHelper);ext.next=(session,helper,...rest)=>next(session,helper??options.extensionHelper,...rest);}
 for(const o of [app.tools.resume,app.tools.h8Cards,app.tools.relayKeeper])o.now=()=>time;
 let seq=0;
 const rpc=async(name,args={},opt={})=>(await app.tools.rpc({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':opt.session||'a-session',...(opt.legacy?{}:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'})}}},'chatgpt',{transport:'local_http',setupPrincipal:'tunnel:chatgpt'})).result;
 const ok=r=>{if(r?.isError)throw Error(JSON.stringify(r.structuredContent));return r.structuredContent;};
 await app.handle('/api/access',{enabled:true});await app.handle('/api/mode',{mode:'full',confirm:true});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 return {app,root,work,tunnel,transport,rpc,ok,now:()=>time,advance:ms=>time+=ms,tick:()=>maintenance(),begin:async(args={})=>ok(await rpc('begin_task',{request_id:crypto.randomUUID(),title:'A isolated task',...args})).task_id};
}
