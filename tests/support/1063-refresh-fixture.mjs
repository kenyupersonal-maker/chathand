// Fully synthetic browser/service. No real sites, runtime state, or credentials.
import {ToolsRefresher,PLUGINS_URL} from '../../app/v1/tools-refresh.mjs';
import {storeTestDistribution,manifestStoreTestHelper} from './chrome-store-fixture.mjs';
export const ownURL=PLUGINS_URL+'/plugin_fixture_own',otherURL=PLUGINS_URL+'/plugin_fixture_other';
export function refreshFixture(options={}){
 const p={time:1000,url:PLUGINS_URL,calls:[],clicks:[],events:[],observed:[],finished:[],emitted:[]};
 p.identity=Object.hasOwn(options,'identity')?options.identity:{app_id:'plugin_fixture_own'};
 const expected={build:1063,instance_id:'fixture-install',connector_api:31,tool_count:83,schema_sha256:'a'.repeat(64),connection_tag:'fixture-connection',principal_tag:'fixture-principal',route:'relay'};
 const entries=options.entries||[{ref:'other',role:'link',name:'ChatHand',href:otherURL},{ref:'own',role:'link',name:'Renamed app',href:ownURL}];
 p.invoke=async(name,args)=>{
  p.calls.push([name,args]);
  if(options.throwAt===name)throw Object.assign(Error(options.errorMessage||'原始错误保留'),options.errorCode?{code:options.errorCode}:{});
  if(name==='browser_status')return {selected_backend:'extension',extension:{connected:true,helper:options.helper||manifestStoreTestHelper(),compatibility:{state:'compatible'}}};
  if(name==='begin_task')return {task_id:'fixture-task'};
  if(name==='finish_task'){p.finished.push(args);return {};}
  if(name==='browser_open'){p.url=args.url;return {page_id:'fixture-page',url:p.url};}
  if(name==='browser_find'){
   const all=p.url===PLUGINS_URL?entries:[{ref:'heading',role:'heading',name:'Renamed app'},{ref:'refresh',role:'button',name:options.button||'刷新工具'}];
   const elements=all.filter(x=>(!args.role||x.role===args.role)&&(!args.text||(args.exact?x.name===args.text:x.name.includes(args.text))));
   return {url:p.url,lang:options.lang||'zh',elements,total_elements:elements.length,...(options.incomplete&&p.url===PLUGINS_URL?{next_offset:0}:{})};
  }
  if(name==='browser_action'){
   p.clicks.push(args.ref);
   if(args.ref==='own')p.url=options.landURL||ownURL;
   else if(args.ref==='other')p.url=otherURL;
   else if(args.ref==='refresh'&&options.attest){p.events.push({kind:'tools_list',at:p.time,source:'trusted_server',authenticated:true,caller:'chatgpt',route:'relay',installation:{build:expected.build,instance_id:expected.instance_id},contract:{connector_api:31,tool_count:83,schema_sha256:expected.schema_sha256},connection_tag:expected.connection_tag,principal_tag:expected.principal_tag,host_binding:{attested_by:'trusted_host',page_id:'fixture-page',plugin_url:ownURL}});}
   return {url:p.url,status:'completed',changes:{url:p.url}};
  }
  if(name==='browser_snapshot')return options.confirm?{aria_yaml:'- alertdialog "New tools"\n  - button "Allow"'}:options.hostError?{aria_yaml:'- alert "Error: refresh failed"'}:{elements:[]};
  if(name==='browser_tabs')return {};
  throw Error('Unexpected mock call: '+name);
 };
 p.refresher=new ToolsRefresher({distribution:storeTestDistribution(),invoke:p.invoke,appName:options.appName||'ChatHand',targetIdentity:()=>p.identity,onIdentityObserved:o=>{p.observed.push(o);options.onObserved?.(p,o);},now:()=>p.time,sleep:async ms=>{p.time+=ms;},seen:()=>p.events,expected:()=>expected,emit:(kind,value)=>p.emitted.push([kind,value]),urls:[PLUGINS_URL],names:{load:()=>options.saved||{},save:()=>{}},pageWaitMs:1000,detailWaitMs:2500,observeMs:1500,toolsListWaitMs:500,helperManualWaitMs:500});
 return p;
}
