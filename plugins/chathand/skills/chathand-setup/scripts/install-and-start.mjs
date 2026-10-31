import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {locateRuntime,callOwner,sanitized} from './setup.mjs';

const REQUIREMENT='=identifier "com.kenyu.chathand" and certificate leaf = H"13D3EF5EB9C743427123452CD966CBC8FD9ECF2D"';
const runtimeFor=app=>path.join(app,'Contents/Resources/runtime');
const failure=(code,details={})=>Object.assign(Error(code),{code,...details});
const errorCode=error=>/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code||'')?error.code:'INSTALL_FAILED';

// The user has already selected the package. Build numbers describe it; they
// do not grant or deny an upgrade/downgrade. Older bundles need no new ID.
export function selectedPackageAction(incoming,installed){
  if(!installed)return 'install';
  return incoming.path===installed.path ||
    (incoming.build_id && incoming.build_id===installed.build_id) ? 'preserve' : 'install';
}

// Keep the orchestration separate from OS effects so the few failure paths can
// be checked without installing, quitting or reading the user's real App.
export async function installSelectedApp({source,target},ops){
  const result={status:'incomplete',phase:'inspect',source_app:source,app_path:target,
    data_preserved:true,setup_complete:false,warnings:[]};
  let staged=null,backup=null,placed=false,stopped=false;
  try{
    const incoming=await ops.inspect(source),installed=await ops.inspect(target,{optional:true});
    result.build=incoming.build;result.build_id=incoming.build_id;
    result.action=selectedPackageAction(incoming,installed);
    if(result.action==='install'){
      result.phase='stage';staged=await ops.stage(source,target);
    }
    result.phase='quit';await ops.stop();stopped=true;
    if(staged){
      result.phase='replace';backup=await ops.backup(target);result.backup_path=backup;
      await ops.place(staged,target);staged=null;placed=true;
    }
    result.phase='verify';await ops.verify(target);
    result.phase='skill';
    try{await ops.installSkill(target);}catch(error){result.warnings.push({code:errorCode(error),step:'skill',next_action:'read_bundled_skill'});}
    result.phase='start';await ops.start(target);
    result.phase='doctor';result.doctor=await ops.doctor(target);
    result.status='ready';result.phase='continue_setup';
    result.skill_path=path.join(runtimeFor(target),'skills/chathand-setup/SKILL.md');
    result.next_action='continue_setup';
    // Ejecting the source is housekeeping, after the target is running.
    try{await ops.eject(source,target);}catch(error){result.warnings.push({code:errorCode(error),step:'eject',next_action:'eject_later'});}
    return result;
  }catch(error){
    result.code=errorCode(error);result.next_action='diagnose_and_resume';
    if(error.program)result.program=error.program;
    if(error.detail)result.detail=error.detail;
    if(placed&&backup){
      try{
        await ops.stop();
        result.failed_app_path=await ops.retainFailed(target);
        await ops.restore(backup,target);result.restored_previous=true;
        await ops.start(target);
      }catch(restoreError){result.restore_code=errorCode(restoreError);}
    }else if(backup){
      try{await ops.restore(backup,target);result.restored_previous=true;await ops.start(target);}
      catch(restoreError){result.restore_code=errorCode(restoreError);}
    }else if(stopped&&!placed&&result.phase==='replace'){
      try{await ops.start(target);}catch{}
    }
    throw failure(result.code,{install_result:result});
  }finally{
    if(staged)await ops.discardStage(staged).catch(()=>{});
  }
}

function command(program,args,{timeout=120000,input}={}){
  const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const r=spawnSync(program,args,{encoding:'utf8',timeout,maxBuffer:2*1024*1024,env,...(input===undefined?{}:{input})});
  if(r.error||r.status!==0){
    let value;try{value=JSON.parse(r.stdout);}catch{}
    // Never forward arbitrary subprocess output (including a setup response).
    const code=value?.error||value?.code;
    const systemDiagnostic=['/usr/bin/codesign','/usr/bin/ditto','/usr/bin/xattr','/usr/bin/hdiutil','/usr/libexec/PlistBuddy'].includes(program);
    throw failure(/^[A-Z][A-Z0-9_]{0,63}$/.test(code||'')?code:r.error?.code||'INSTALL_COMMAND_FAILED',{
      program:path.basename(program),...(systemDiagnostic?{detail:String(r.stderr||r.error?.message||'').trim().slice(0,1200)}:{})
    });
  }
  return String(r.stdout||'');
}
function jsonCommand(program,args,options){
  let result;const raw=command(program,args,options);
  try{result=JSON.parse(raw);}catch{throw failure('INSTALL_RESPONSE_INVALID');}
  if(result?.error)throw failure(errorCode({code:result.error}));
  return result;
}
function plainDirectory(dir,{create=false}={}){
  if(create)fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw failure('INSTALL_DIRECTORY_INVALID');
  return fs.realpathSync(dir);
}
function appPath(value,{missing=false}={}){
  if(typeof value!=='string'||!path.isAbsolute(value)||!value.endsWith('.app')||/[\0\r\n]/.test(value))throw failure('INSTALL_APP_PATH_INVALID');
  const parent=plainDirectory(path.dirname(value));
  const result=path.join(parent,path.basename(value));
  try{const st=fs.lstatSync(result);if(!st.isDirectory()||st.isSymbolicLink())throw failure('INSTALL_APP_PATH_INVALID');}
  catch(error){if(!missing||error.code!=='ENOENT')throw error;}
  return result;
}
function verifyApp(app){
  appPath(app);
  command('/usr/bin/codesign',['--verify','--deep','--strict','-R',REQUIREMENT,app]);
}
function buildIdentity(app){
  const file=path.join(runtimeFor(app),'build-provenance.json');
  try{
    const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>131072)return null;
    const value=JSON.parse(fs.readFileSync(file,'utf8')).build_id;
    return typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value)?value:null;
  }catch{return null;}
}

export function macInstallOperations({bootstrapApp,home=os.homedir(),now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  const runtime=runtimeFor(bootstrapApp),helper=path.join(runtime,'bin/ken-upgrade-control');
  const manual=path.join(home,'Library/Application Support/ChatHand/manual-install');
  const stageParents=new Set();
  const ensureManual=()=>{
    let dir=fs.realpathSync(home);
    for(const part of ['Library','Application Support','ChatHand','manual-install']){
      dir=path.join(dir,part);plainDirectory(dir,{create:true});
    }
    return dir;
  };
  const helperCall=(action,app)=>jsonCommand(helper,[action,app]);
  return {
    async inspect(app,{optional=false}={}){
      try{
        const resolved=appPath(app);verifyApp(resolved);
        const build=command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleVersion',path.join(resolved,'Contents/Info.plist')]).trim();
        if(!/^\d+$/.test(build))throw failure('INSTALL_BUILD_INVALID');
        return {path:resolved,build,build_id:buildIdentity(resolved)};
      }catch(error){
        // A damaged existing copy can be replaced from a verified package.
        // Its directory is backed up unchanged, never executed to identify it.
        if(optional)return null;
        throw error;
      }
    },
    async stage(source,target){
      const parent=fs.mkdtempSync(path.join(path.dirname(target),'.chathand-install-'));
      fs.chmodSync(parent,0o700);stageParents.add(parent);
      const app=path.join(parent,'ChatHand.app');
      try{
        command('/usr/bin/ditto',[source,app]);verifyApp(app);
        command('/usr/bin/xattr',['-dr','com.apple.quarantine',app]);
        if(command('/usr/bin/xattr',['-lr',app]).includes('com.apple.quarantine:'))throw failure('QUARANTINE_STILL_PRESENT');
        return app;
      }catch(error){fs.rmSync(parent,{recursive:true,force:true});stageParents.delete(parent);throw error;}
    },
    async discardStage(app){
      const parent=path.dirname(app);
      if(stageParents.has(parent)){fs.rmSync(parent,{recursive:true,force:true});stageParents.delete(parent);}
    },
    async stop(){
      // Uses the existing signature + PID/start-time lifecycle implementation.
      const result=helperCall('install-stop',bootstrapApp);
      if(result.stopped!==true)throw failure('INSTALL_QUIT_UNCONFIRMED');
    },
    async backup(target){
      if(!fs.existsSync(target))return null;
      appPath(target);const dir=ensureManual();let backup=path.join(dir,'previous.app');
      if(fs.existsSync(backup)||fs.lstatSync(backup,{throwIfNoEntry:false})){
        try{verifyApp(backup);fs.rmSync(backup,{recursive:true});}
        catch{backup=path.join(dir,'previous-'+crypto.randomUUID()+'.app');}
      }
      fs.renameSync(target,backup);return backup;
    },
    async place(staged,target){
      fs.renameSync(staged,target);
      const parent=path.dirname(staged);try{fs.rmdirSync(parent);}catch{}stageParents.delete(parent);
    },
    async verify(app){
      verifyApp(app);command('/usr/bin/xattr',['-dr','com.apple.quarantine',app]);
      if(command('/usr/bin/xattr',['-lr',app]).includes('com.apple.quarantine:'))throw failure('QUARANTINE_STILL_PRESENT');
    },
    async installSkill(app){
      const root=runtimeFor(app);
      command(path.join(root,'bin/node'),['--no-addons','--input-type=module','-e',
        'import('+JSON.stringify(path.join(root,'app/v09/local-setup.mjs'))+').then(m=>m.installSkill())']);
    },
    async start(app){
      verifyApp(app);
      const result=helperCall('install-start',app);
      if(result.started!==true)throw failure('INSTALL_START_UNCONFIRMED');
    },
    async doctor(app){
      const bin=path.join(runtimeFor(app),'bin');
      const expected=fs.realpathSync(path.join(bin,fs.existsSync(path.join(bin,'ChatHandNode'))?'ChatHandNode':'node'));
      const deadline=now()+30000;let last='APP_NOT_RUNNING';
      while(now()<deadline){
        try{
          const owner=locateRuntime({home}),state=await callOwner(owner,'/api/state');
          if(typeof state?.node!=='string'||fs.realpathSync(state.node)!==expected)throw failure('APP_PATH_MISMATCH');
          const native=helperCall('info',app);
          if(native.running!==true||native.pids?.length!==1)throw failure('INSTALL_START_UNCONFIRMED');
          // Disconnected is a valid first-install result, not an install error.
          return sanitized(state);
        }catch(error){last=errorCode(error);await wait(250);}
      }
      throw failure(last);
    },
    async retainFailed(target){
      const dir=ensureManual(),failed=path.join(dir,'failed-'+crypto.randomUUID()+'.app');
      fs.renameSync(target,failed);return failed;
    },
    async restore(backup,target){fs.renameSync(backup,target);},
    async eject(source,target){
      if(!source.startsWith('/Volumes/'))return;
      const plist=command('/usr/bin/hdiutil',['info','-plist'],{timeout:10000});
      const info=jsonCommand('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:plist});
      const mounts=(info.images||[]).flatMap(image=>(image['system-entities']||[]).map(item=>item['mount-point']))
        .filter(mount=>typeof mount==='string'&&source.startsWith(mount+'/')).sort((a,b)=>b.length-a.length);
      // A /Volumes path can be an external drive. Eject only a known disk image,
      // and never the volume containing the selected destination.
      if(mounts[0]&&!target.startsWith(mounts[0]+'/'))command('/usr/bin/hdiutil',['detach',mounts[0]],{timeout:10000});
    }
  };
}

function argumentsFor(args){
  const options={};
  for(let i=0;i<args.length;i+=2){
    if(!['--source','--target'].includes(args[i])||!args[i+1])throw failure('INSTALL_ARGUMENT_INVALID');
    options[args[i].slice(2)]=args[i+1];
  }
  return options;
}
function defaultTarget(home){
  const candidates=['/Applications',path.join(home,'Applications')];
  for(const dir of candidates){
    try{plainDirectory(dir,{create:dir!==candidates[0]});fs.accessSync(dir,fs.constants.W_OK);return path.join(dir,'ChatHand.app');}catch{}
  }
  throw failure('INSTALL_DESTINATION_UNAVAILABLE');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.platform!=='darwin')throw failure('MAC_REQUIRED');
    const options=argumentsFor(process.argv.slice(2)),home=os.homedir();
    const source=appPath(options.source),target=appPath(options.target||defaultTarget(home),{missing:true});
    const bootstrapApp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../../..');
    const result=await installSelectedApp({source,target},macInstallOperations({bootstrapApp,home}));
    console.log(JSON.stringify(result));
  }catch(error){
    console.error(JSON.stringify(error.install_result||{status:'incomplete',code:errorCode(error),next_action:'diagnose_and_resume'}));
    process.exitCode=1;
  }
}
