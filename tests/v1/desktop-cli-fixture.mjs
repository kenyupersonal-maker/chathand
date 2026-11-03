import path from 'node:path';
import {createDesktop,startDesktopFromNative} from '../../app/server.mjs';
import {runDesktopCLI} from '../../app/v1/desktop-cli.mjs';

// Synthetic errors and inert external services only. All paths are supplied by
// the test's fresh temporary home; this never starts the installed application.
const [mode,code]=process.argv.slice(2);
const startupError=()=>Object.assign(Error('PRIVATE_SYNTHETIC_MESSAGE /PRIVATE_SYNTHETIC_PATH credential=PRIVATE_SYNTHETIC_CREDENTIAL'),{
 ...(code==='none'?{}:{code}),details:{path:'/PRIVATE_SYNTHETIC_PATH',credential:'PRIVATE_SYNTHETIC_CREDENTIAL'},
});
const create=mode.startsWith('desktop')?options=>createDesktop({
 ...options,stateDir:process.env.CHATHAND_STATE_DIR,defaultRoot:path.join(process.env.HOME,'work'),
 adminAccess:{supported:()=>false,ready:()=>false},
 clientDeps:{
  currentAppPath:path.join(process.env.HOME,'Synthetic.app'),computerName:()=> 'Synthetic Startup Mac',
  credentials:{get:()=>null,set(){},remove(){},status:()=>({healthy:true,tunnel:false,relay:false})},
  tunnelFactory:()=>({child:null,doctorChild:null,log:[],status:'off',stop(){},snapshot:async()=>({ready:false,healthy:false,process_running:false})}),
  bSiteTransport:{setRpcDelivery(){},setRuntimeFactory(){},setHostFlow(){},close(){},stop(){},status:()=>({ready:false})},
  updaterFactory:()=>({snapshot:()=>({status:'unknown',install:{state:'idle'}}),forAI:()=>({status:'unknown'}),start(){},close(){},settingsChanged(){},cleanupLeftovers:async()=>({cleaned:0})}),
  ...(mode==='desktop-failure'?{matterStore:{recoverFinished:async()=>{throw startupError();}}}:{}),
 },
}):async()=>{
 // A failed create may already own handles. The executable must still exit.
 setInterval(()=>{},60000);
 if(mode==='blocked-stderr')process.stderr.write('x'.repeat(4*1024*1024));
 throw startupError();
};
await runDesktopCLI({start:()=>startDesktopFromNative({create}),version:'synthetic'});
