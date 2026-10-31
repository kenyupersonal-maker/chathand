/** Isolated packaged-runtime QA. Never reads installed state or connects a Site. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function packagedRuntimeManifest(runtime,root){
 const {createDesktop}=await import(pathToFileURL(path.join(runtime,'app/server.mjs')));
 const work=path.join(root,'work');fs.mkdirSync(work,{recursive:true});
 const transport={setRpcDelivery(){},setRuntimeFactory(fn){this.runtime=fn;},setHostFlow(){},close(){},stop(){},status:()=>({ready:false})};
 const credentials={get:()=>null,publicStatus:()=>({}),status:()=>({}),set(){},remove(){}};
 const app=await createDesktop({stateDir:path.join(root,'state'),defaultRoot:work,uiKey:'ac'.repeat(32),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{credentials,bSiteTransport:transport,currentAppPath:path.join(root,'Fake.app'),computerName:()=> 'Synthetic Manifest Mac',maintenanceClock:{now:Date.now,setInterval:()=>({unref(){}}),clearInterval(){}},tunnelFactory:()=>({stop(){},snapshot:async()=>({healthy:false,ready:false,process_running:false})}),updaterFactory:()=>({currentBuild:0,snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown',request:null}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})})}});
 try{return {manifest:await transport.runtime(),settings:(await import(pathToFileURL(path.join(runtime,'app/v1/b-site-ws-transport.mjs')))).V412_SETTINGS};}
 finally{await app.close();}
}
