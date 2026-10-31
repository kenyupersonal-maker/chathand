import fs from 'node:fs';
import path from 'node:path';

function fail(code){throw Object.assign(new Error(code),{code});}
function occurrences(args,name){return args.reduce((n,arg)=>n+(arg===name?1:0),0);}
function valueArg(args,name){
 const indexes=args.flatMap((arg,i)=>arg===name?[i]:[]);
 if(indexes.length!==1)fail(indexes.length?'ISOLATED_BUILD_OPTION_DUPLICATE':'ISOLATED_BUILD_OPTION_REQUIRED');
 const value=args[indexes[0]+1];if(!value||value.startsWith('--'))fail('ISOLATED_BUILD_OPTION_VALUE_REQUIRED');
 return value;
}
function inside(parent,child){const rel=path.relative(parent,child);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);}

export function resolveIsolatedUnsignedOptions(args,{root,unsigned}){
 const enabled=occurrences(args,'--isolated-unsigned');
 const hasIsolatedInputs=args.includes('--isolation-root')||args.includes('--tunnel-cache');
 if(!enabled){if(hasIsolatedInputs)fail('ISOLATED_BUILD_FLAG_REQUIRED');return null;}
 if(enabled!==1)fail('ISOLATED_BUILD_FLAG_DUPLICATE');
 if(!unsigned)fail('ISOLATED_BUILD_UNSIGNED_REQUIRED');
 if(occurrences(args,'--unsigned')!==1)fail('ISOLATED_BUILD_UNSIGNED_REQUIRED');
 if(args.includes('--process-identity-baseline'))fail('ISOLATED_BUILD_BASELINE_FORBIDDEN');
 const allowed=new Set(['--unsigned','--isolated-unsigned','--isolation-root','--tunnel-cache','--output']);
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(!allowed.has(arg))fail('ISOLATED_BUILD_ARGUMENT_UNSUPPORTED');
  if(['--isolation-root','--tunnel-cache','--output'].includes(arg))i++;
 }
 const taskRoot=valueArg(args,'--isolation-root'),cache=valueArg(args,'--tunnel-cache'),output=valueArg(args,'--output');
 for(const value of [taskRoot,cache,output])if(!path.isAbsolute(value))fail('ISOLATED_BUILD_PATH_MUST_BE_ABSOLUTE');
 const isolationRoot=path.resolve(taskRoot),tunnelCache=path.resolve(cache),app=path.resolve(output),repo=path.resolve(root);
 if(isolationRoot===repo||inside(repo,isolationRoot)||inside(isolationRoot,repo))fail('ISOLATED_BUILD_ROOT_NOT_SEPARATE_FROM_SOURCE');
 if(path.dirname(app)!==isolationRoot||path.extname(app)!=='.app')fail('ISOLATED_BUILD_OUTPUT_OUTSIDE_TASK_ROOT');
 if(path.dirname(tunnelCache)!==isolationRoot)fail('ISOLATED_BUILD_TUNNEL_CACHE_OUTSIDE_TASK_ROOT');
 const reserved=['reports','bin','swiftpm-cache','swiftpm-config','swiftpm-security','swiftpm-scratch','swift-module-cache','clang-module-cache'];
 const targets=[app,tunnelCache,...reserved.map(name=>path.join(isolationRoot,name))];
 if(new Set(targets).size!==targets.length||reserved.includes(path.basename(app))||reserved.includes(path.basename(tunnelCache)))fail('ISOLATED_BUILD_PATH_COLLISION');
 return Object.freeze({
  root:isolationRoot,sourceRoot:repo,app,tunnelCache,
  reports:path.join(isolationRoot,'reports'),bin:path.join(isolationRoot,'bin'),
  swiftpmCache:path.join(isolationRoot,'swiftpm-cache'),
  swiftpmConfig:path.join(isolationRoot,'swiftpm-config'),
  swiftpmSecurity:path.join(isolationRoot,'swiftpm-security'),
  swiftpmScratch:path.join(isolationRoot,'swiftpm-scratch'),
  swiftModuleCache:path.join(isolationRoot,'swift-module-cache'),
  clangModuleCache:path.join(isolationRoot,'clang-module-cache'),
 });
}

export function assertFreshIsolatedTarget(config,{fsApi=fs}={}){
 const {root,app,tunnelCache}=config;
 const parent=path.dirname(root);
 if(!fsApi.existsSync(parent)||fsApi.realpathSync(parent)!==parent)fail('ISOLATED_BUILD_PARENT_MUST_BE_CANONICAL');
 const realSource=path.resolve(fsApi.realpathSync(config.sourceRoot));
 if(root===realSource||inside(realSource,root)||inside(root,realSource))fail('ISOLATED_BUILD_ROOT_REALPATH_OVERLAP');
 const present=target=>fsApi.existsSync(target)||(()=>{try{fsApi.lstatSync(target);return true;}catch{return false;}})();
 if(present(root)){
  const st=fsApi.lstatSync(root);
  if(!st.isDirectory()||st.isSymbolicLink()||fsApi.readdirSync(root).length)fail('ISOLATED_BUILD_ROOT_MUST_BE_EMPTY_DIRECTORY');
 }
 for(const target of [app,tunnelCache,...[config.reports,config.bin,config.swiftpmCache,config.swiftpmConfig,config.swiftpmSecurity,config.swiftpmScratch,config.swiftModuleCache,config.clangModuleCache]])if(present(target))fail('ISOLATED_BUILD_TARGET_ALREADY_EXISTS');
 return true;
}

export function swiftIsolationArguments(config){
 return ['--cache-path',config.swiftpmCache,'--config-path',config.swiftpmConfig,'--security-path',config.swiftpmSecurity,
  '--scratch-path',config.swiftpmScratch,'--disable-dependency-cache','--manifest-cache','none','--disable-netrc','--disable-keychain'];
}

export function swiftIsolationEnvironment(config,base=process.env){
 return {...base,CLANG_MODULE_CACHE_PATH:config.clangModuleCache};
}

export function swiftCompilerCacheArguments(config){
 return ['-module-cache-path',config.swiftModuleCache];
}
