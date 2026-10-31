import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const error=code=>Object.assign(Error(code),{code});
export function compareBuilds(incoming,installed,{incomingId,installedId}={}){
 if(!/^\d+$/.test(String(incoming))||installed!==null&&!/^\d+$/.test(String(installed)))throw error('INSTALL_BUILD_INVALID');
 const same=installed!==null&&typeof incomingId==='string'&&incomingId.length>0&&incomingId===installedId;
 return {incoming_build:String(incoming),installed_build:installed===null?null:String(installed),action:same?'preserve':'install',reason:same?'same_package':'selected_package'};
}
export function readBuild(app,{run=spawnSync}={}){const file=path.join(app,'Contents/Info.plist'),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw error('INSTALL_PLIST_UNSAFE');const value=run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',file],{encoding:'utf8',timeout:3000,maxBuffer:1024});if(value.status!==0)throw error('INSTALL_BUILD_UNAVAILABLE');const build=value.stdout.trim();if(!/^\d+$/.test(build))throw error('INSTALL_BUILD_INVALID');return build;}
export function installationDecision(incoming,installed='/Applications/ChatHand.app',options={}){if(!path.isAbsolute(incoming)||!path.isAbsolute(installed))throw error('INSTALL_APP_PATH_INVALID');return compareBuilds(readBuild(incoming,options),fs.existsSync(installed)?readBuild(installed,options):null);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{const args=process.argv.slice(2),i=args.indexOf('--incoming'),j=args.indexOf('--installed');console.log(JSON.stringify(installationDecision(args[i+1],j>=0?args[j+1]:undefined)));}catch(e){console.error(JSON.stringify({status:'STOPPED',code:e.code||'INSTALL_BUILD_UNAVAILABLE'}));process.exitCode=1;}
