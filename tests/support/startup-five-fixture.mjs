import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DesktopState} from '../../app/state.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
export async function startupFixture(t,{prepare,existingRoot,expectFailure=false}={}){
 const root=existingRoot||fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'chathand-startup-five-')));
 const home=path.join(root,'home'),stateDir=path.join(root,'state'),work=path.join(home,'work');
 for(const dir of [home,stateDir])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const f={root,home,stateDir,work,uiKey:'a'.repeat(64)};
 if(!existingRoot){const seed=new DesktopState(stateDir,{defaultRoot:work});Object.assign(seed.data,{setup_complete:true,onboarding:true,auto_connect:false,access_enabled:false});seed.save();}
 prepare?.(f);
 const child=spawn(process.execPath,['tests/v1/desktop-cli-fixture.mjs','desktop'],{cwd:repo,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:home,CFFIXED_USER_HOME:home,TMPDIR:root,NODE_TEST_CONTEXT:'child-v8',CHATHAND_STATE_DIR:stateDir,KEN_BRIDGE_STATE_DIR:stateDir,CHATHAND_UI_KEY_STDIN:'1',CHATHAND_OWNER_PIPE:'stdin-v1'}});
 f.child=child;let stdout='',stderr='',ended=false;
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.stdin.on('error',()=>{});
 const exit=new Promise(resolve=>child.once('close',(status,signal)=>{ended=true;resolve({status,signal});}));
 child.stdin.write(JSON.stringify({v:2,ui_key:f.uiKey,owner_key:'b'.repeat(64)})+'\n');
 f.exit=exit;f.logs=()=>stdout+stderr;
 f.close=async()=>{if(ended)return;child.stdin.end();const deadline=setTimeout(()=>{if(!ended)child.kill('SIGKILL');},3000);await exit;clearTimeout(deadline);};
 t.after(async()=>{await f.close();if(!existingRoot)fs.rmSync(root,{recursive:true,force:true});});
 const until=Date.now()+5000;
 while(!stdout.includes('本机执行服务已启动。')&&!ended&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));
 if(expectFailure){if(!ended)throw Error('Expected isolated startup failure');return f;}
 if(ended||Date.now()>=until)throw Error('Isolated startup did not open: '+stderr);
 const runtime=JSON.parse(fs.readFileSync(path.join(stateDir,'runtime.json'),'utf8'));
 f.origin=runtime.ui_origin;f.adminToken=runtime.admin_token;
 f.request=async(route,body)=>{
  const response=await fetch(f.origin+route,{...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)}),headers:{Authorization:'Bearer '+f.adminToken,'X-ChatHand-UI':f.uiKey,'Content-Type':'application/json'}});
  return {status:response.status,body:await response.json()};
 };
 return f;
}
