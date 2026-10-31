import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';import {desktop} from './1052-a-fixture.mjs';import {armUpgradeGuard} from '../app/v08/upgrade-guard.mjs';import {installationTask} from '../app/v1/update-install-task.mjs';import {createDesktop} from '../app/server.mjs';import {VERSION} from '../app/product.mjs';
const exec=promisify(execFile);
const currentBuild=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).kenBridge.build_number;
test('1059 full native WK page authenticates real SSE/fallback, updates after close/reopen/reload, and blocks real 401/403',{skip:process.platform!=='darwin',timeout:100000},async t=>{
 const f=await desktop(t);let a=f.app;const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1059-full-wk-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 a.state.data.auto_connect=false;a.state.data.connection_preference='none';a.state.data.setup_complete=true;a.state.data.tunnel={tunnel_id:'isolated-fixture'};a.state.save();await a.handle('/api/access',{enabled:false});const installing=installationTask({build:currentBuild,caller:'chatgpt'}).view;a.policy.tasks.set(installing.task_id,{...installing,id:installing.task_id,caller:'chatgpt'});
 armUpgradeGuard(path.join(f.root,'state'),VERSION,'isolated-page-guard',{build:currentBuild,transactionId:'2026-10-17T00-00-00-000Z-abcd1234'});
 let mode='live',stateReads=0;const requests=[],peers=new Set();
 const initial=()=>({status:'verifying',current_build:currentBuild,install:{state:'verifying'},just_updated:null});let update=initial();a.updater.snapshot=()=>structuredClone(update);
 const updated=tag=>{void a.handle('/api/upgrade/commit',{});update={status:'updated',current_build:currentBuild,install:{state:'idle'},just_updated:{from:VERSION,to:VERSION+'-'+tag,build_to:currentBuild,tool_schema_changed:false},refresh_tools:false};a.policy.emit('task_finished',{title:'isolated state transition'});};
 let backendRestarted=false;const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/__test/restart'){const oldPort=a.apiPort;await a.close();await assert.rejects(fetch('http://127.0.0.1:'+oldPort+'/api/state',{signal:AbortSignal.timeout(500)}));a=await createDesktop({stateDir:path.join(f.root,'state'),defaultRoot:f.work,uiKey:'bd'.repeat(32),adminAccess:{supported:()=>false,ready:()=>false},clientDeps:{computerName:()=> 'Isolated restarted backend',credentials:{get:()=>null,publicStatus:()=>({}),status:()=>({}),set(){},remove(){}},bSiteTransport:f.transport,currentAppPath:path.join(f.root,'ChatHand.app'),tunnelFactory:()=>f.tunnel,updaterFactory:()=>({snapshot:()=>structuredClone(update),start(){},close(){},settingsChanged(){}})}});t.after(()=>a.close());assert.notEqual(a.apiPort,oldPort);backendRestarted=true;mode='live';updated('live');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({owner:a.adminToken,ui:a.uiKey}));return;}
  if(url.pathname==='/__test/control'){mode=url.searchParams.get('mode');stateReads=0;if(mode==='fallback')update=initial();else updated(mode==='reopen'?'reopen':'live');res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');return;}
  const proof={mode,path:url.pathname,owner:req.headers.authorization==='Bearer '+a.adminToken,ui:req.headers['x-chathand-ui']===a.uiKey,status:null};if(url.pathname.startsWith('/api/'))requests.push(proof);
  if(mode==='fallback'&&url.pathname==='/api/events'){proof.status=503;res.writeHead(503);res.end();return;}
  if(mode==='fallback'&&url.pathname==='/api/state'&&++stateReads>=2)updated('fallback');
  const headers={...req.headers,host:'127.0.0.1:'+a.apiPort};if(headers.origin)headers.origin='http://127.0.0.1:'+a.apiPort;
  const upstream=http.request({hostname:'127.0.0.1',port:a.apiPort,path:req.url,method:req.method,headers},response=>{proof.status=response.statusCode;res.writeHead(response.statusCode,response.headers);response.pipe(res);if(mode==='live'&&url.pathname==='/api/events'&&response.statusCode===200)setTimeout(()=>updated('live'),3000);});
  peers.add(upstream);upstream.on('close',()=>peers.delete(upstream));upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const p of peers)p.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));});const origin='http://127.0.0.1:'+server.address().port;
 const swift=`import Cocoa
import WebKit
final class Harness:NSObject,WKNavigationDelegate {
 let web=WKWebView(frame:NSRect(x:0,y:0,width:1200,height:850),configuration:WKWebViewConfiguration())
 var stage=0;var phases:[String]=[];var origin="";var owner="";var ui="";var window:NSWindow!
 func begin(){let data=FileHandle.standardInput.readDataToEndOfFile();let values=try! JSONSerialization.jsonObject(with:data) as! [String:String];origin=values["origin"]!;owner=values["owner"]!;ui=values["ui"]!;web.navigationDelegate=self;window=NSWindow(contentRect:NSRect(x:20,y:20,width:2,height:2),styleMask:[.borderless],backing:.buffered,defer:false);window.contentView=web;window.orderFront(nil);load(owner,ui)}
 func load(_ token:String,_ key:String){guard let url=NativePageBootstrap.install(web:web,origin:origin,token:token,uiKey:key) else{finish("bootstrap");return};web.load(URLRequest(url:url))}
 func control(_ mode:String,_ done:@escaping()->Void){URLSession.shared.dataTask(with:URL(string:origin+"/__test/control?mode="+mode)!){_,_,_ in DispatchQueue.main.async{done()}}.resume()}
 func restart(_ done:@escaping()->Void){URLSession.shared.dataTask(with:URL(string:origin+"/__test/restart")!){data,_,_ in DispatchQueue.main.async{guard let data=data,let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:String],let owner=value["owner"],let ui=value["ui"] else{self.finish("backend restart");return};self.owner=owner;self.ui=ui;done()}}.resume()}
 func evaluate(_ script:String,_ done:@escaping()->Void){web.evaluateJavaScript(script){_,error in if error != nil{self.finish("script stage \\(self.stage)")}else{done()}}}
 func until(_ condition:String,_ done:@escaping()->Void,_ tries:Int=450){guard tries>0 else{web.evaluateJavaScript("JSON.stringify({hidden:document.hidden,inert:document.querySelector('#app')?.inert,enabled:S?.enabled,phase:S?.update?.status,updated:S?.update?.just_updated?.to,timer:!!durationTimer,clocks:[...document.querySelectorAll('[data-fmt=dur]')].map(x=>x.textContent),before:window.__clockBefore,tasks:S?.tasks?.map(x=>x.status)})"){value,_ in self.finish("timeout stage \\(self.stage): \\(value ?? "no safe diagnostic")")};return};web.evaluateJavaScript(condition){value,error in if (value as? Bool)==true{done()}else{DispatchQueue.main.asyncAfter(deadline:.now()+0.1){self.until(condition,done,tries-1)}}}}
 func safe()->String {return "!location.hash&&!location.search&&!Object.hasOwn(window,'__CHATHAND_AUTH__')&&typeof window.token==='undefined'&&typeof window.uiKey==='undefined'&&Object.keys(window.ChatHandAuth).join(',')==='fetch'"}
 func webView(_ view:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){let u=action.request.url;decisionHandler(u?.host=="127.0.0.1" && u?.port==URL(string:origin)?.port ? .allow:.cancel)}
 func webView(_ view:WKWebView,didFinish navigation:WKNavigation!){
  if stage==0{until("typeof S!=='undefined'&&S?.upgrade_pending===true&&document.body.textContent.includes('正在安装更新，即将重启')&&![...document.querySelectorAll('[data-action=resumeAI]')].some(x=>x.getClientRects().length)&&document.querySelector('[data-fmt=dur]')&&((window.__clockBefore=document.querySelector('[data-fmt=dur]').textContent),true)"){self.phases.append("upgrade_banner_no_resume");self.until("typeof S!=='undefined'&&S?.update?.just_updated?.to==='${VERSION}-live'&&window.ChatHandStream.status()==='live'&&document.body.textContent.includes('${currentBuild}')&&performance.now()<30000&&document.querySelector('[data-fmt=dur]')?.textContent!==window.__clockBefore&&("+self.safe()+")"){
   self.phases.append("full_page_sse_and_install_timer_advanced");self.window.orderOut(nil);self.evaluate("window.__chathandWindowVisible=false;window.dispatchEvent(new CustomEvent('chathand:window-visibility',{detail:{visible:false}}))"){
    self.control("reopen"){self.window.orderFront(nil);self.evaluate("window.__chathandWindowVisible=true;window.dispatchEvent(new CustomEvent('chathand:window-visibility',{detail:{visible:true}}))"){
     self.until("S?.update?.just_updated?.to==='${VERSION}-reopen'&&window.ChatHandStream.status()==='live'&&document.body.textContent.includes('reopen')"){
      self.phases.append("close_reopen_updates");self.control("fallback"){self.stage=1;self.web.reload()}
     }
    }}
   }
  }}}else if stage==1{until("typeof S!=='undefined'&&S?.update?.just_updated?.to==='${VERSION}-fallback'&&window.ChatHandStream.status()==='fallback'&&document.body.textContent.includes('fallback')&&("+self.safe()+")"){
   self.phases.append("full_page_real_fallback");self.control("invalid_owner"){self.stage=2;self.load("invalid-owner",self.ui)}
  }}else if stage==2{until("window.ChatHandStream?.status()==='blocked'&&S===null"){
   self.phases.append("real_401_blocked");self.evaluate("window.__chathandWindowVisible=false;window.dispatchEvent(new CustomEvent('chathand:window-visibility',{detail:{visible:false}}));window.__chathandWindowVisible=true;window.dispatchEvent(new CustomEvent('chathand:window-visibility',{detail:{visible:true}}))"){
    DispatchQueue.main.asyncAfter(deadline:.now()+0.5){self.until("window.ChatHandStream.status()==='blocked'"){self.control("invalid_key"){self.stage=3;self.load(self.owner,"invalid-key")}}}
   }
  }}else if stage==3{until("window.ChatHandStream?.status()==='blocked'"){
   self.phases.append("real_403_blocked");self.restart{self.stage=4;self.load(self.owner,self.ui)}
  }}else{until("typeof S!=='undefined'&&S?.update?.just_updated?.to==='${VERSION}-live'&&window.ChatHandStream.status()==='live'&&("+self.safe()+")"){
   self.phases.append("backend_close_recreate_same_WK_fresh_bootstrap_updates");self.finish(nil)
  }}
 }
 func finish(_ reason:String?){let value:[String:Any]=["passed":reason==nil,"reason":reason ?? "","phases":phases];let data=try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!);fflush(stdout);exit(reason==nil ? 0:1)}
}
let app=NSApplication.shared;app.setActivationPolicy(.accessory);let harness=Harness();harness.begin();DispatchQueue.main.asyncAfter(deadline:.now()+80){harness.finish("overall timeout")};app.run()
`;
 const main=path.join(root,'main.swift'),binary=path.join(root,'isolated-full-page');fs.writeFileSync(main,swift);
 await exec('/usr/bin/xcrun',['swiftc','-swift-version','5','-framework','Cocoa','-framework','WebKit',new URL('../native/NativePageBootstrap.swift',import.meta.url).pathname,main,'-o',binary],{timeout:45000,maxBuffer:1024*1024});
 const result=await new Promise((resolve,reject)=>{const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.once('error',reject);child.once('close',code=>code===0?resolve({stdout,stderr}):reject(Object.assign(Error('Isolated full-page WK failed'),{stdout,stderr,request_summary:requests.map(({mode,path,status,owner,ui})=>({mode,path,status,owner,ui}))})));child.stdin.end(JSON.stringify({origin,owner:a.adminToken,ui:a.uiKey}));});
 assert.equal(backendRestarted,true);const value=JSON.parse(result.stdout.trim().split('\n').find(s=>s.startsWith('{')));assert.equal(value.passed,true);assert.equal(value.phases.length,7);
 const good=requests.filter(r=>['live','reopen','fallback'].includes(r.mode)&&['/api/state','/api/events'].includes(r.path));assert.ok(good.length>=7);assert.ok(good.every(r=>r.owner&&r.ui));assert.ok(requests.some(r=>r.mode==='fallback'&&r.path==='/api/state'&&r.status===200));
 assert.ok(requests.some(r=>r.mode==='invalid_owner'&&r.status===401));assert.ok(requests.some(r=>r.mode==='invalid_key'&&r.path==='/api/events'&&r.status===403));assert.equal(requests.filter(r=>r.mode==='invalid_owner'&&r.path==='/api/events').length,1);
});
