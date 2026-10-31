import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile),read=rel=>fs.readFileSync(new URL('../'+rel,import.meta.url),'utf8');
test('1058 isolated WK real DOM resets shell tokens/sections and native bootstrap survives reload with a credential-free URL',{skip:process.platform!=='darwin',timeout:90000},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'1058-wk-shell-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const auth=read('ui/auth.js');
 const task=read('ui/task-widget.html'),image=read('ui/image-batch-widget.html');
 const extract=(html,name)=>html.slice(html.indexOf('function applyShellPresentation('),html.indexOf('\nfunction render(',html.indexOf('function applyShellPresentation('))).replace('function applyShellPresentation','function '+name);
 const prune=task.split('\n').find(line=>line.startsWith('function pruneTextBindings('));
 assert.ok(prune);assert.equal(image.split('\n').find(line=>line.startsWith('function pruneTextBindings(')),prune);
 const script=auth+'\nconst textBindings=new Map();\n'+prune+'\n'+`\nwindow.authVerified=!!window.ChatHandAuth&&Object.keys(window.ChatHandAuth).join(',')==='fetch';\n`+extract(task,'taskShell')+'\n'+extract(image,'imageShell')+`
 window.runShellChecks=()=>{const errors=[],check=(v,m)=>{if(!v)errors.push(m);};
  const root=document.documentElement,card=document.querySelector('.card');
  for(const [fn,variable] of [[taskShell,'--widget-ok'],[imageShell,'--ok']]){
   const detached=document.createElement('span'),connected=document.createElement('span');card.append(connected);textBindings.set(detached,()=>{});textBindings.set(connected,()=>{});
   fn({widget_shell:{protocol:1,accent:'#123456',density:'compact',sections:[{title:'Title',text:'<script>window.compromised=true</script>'}]}});
   check(!textBindings.has(detached)&&textBindings.has(connected),'text bindings prune only detached nodes');connected.remove();
   check(root.style.getPropertyValue(variable)==='#123456','accent');if(fn===imageShell)check(root.style.getPropertyValue('--bar')==='#123456','bar');
   const probe=document.createElement('span');probe.style.color='var('+variable+')';card.append(probe);check(getComputedStyle(probe).color==='rgb(18, 52, 86)','computed color');probe.remove();
   check(card.style.padding==='12px 16px','density');check(document.querySelector('#shell-sections').textContent.includes('<script>'),'text-only');check(!window.compromised,'no code');
   fn({});check(!root.style.getPropertyValue(variable),'accent reset');check(!card.style.padding,'density reset');check(!document.querySelector('#shell-sections'),'sections reset');
   fn({widget_shell:{protocol:1,accent:'url(https://example.invalid)',density:'arbitrary',sections:[]}});check(!root.style.getPropertyValue(variable),'invalid color');
  }
  check(window.authVerified,'bootstrap auth');check(!Object.hasOwn(window,'__CHATHAND_AUTH__'),'bootstrap removed');check(!location.hash,'credential-free URL');return errors;
 };
 `;
 const safeScript=script.replaceAll('</script>','<'+String.fromCharCode(92)+'/script>');
 assert.equal(safeScript.includes('</script>'),false);
 const html='<!doctype html><html><head><style>'+task.match(/<style>([\s\S]*?)<\/style>/)[1]+'</style></head><body><section class="card"></section><script>'+safeScript+'</script></body></html>';
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 const source=`import Cocoa
import WebKit
final class Harness:NSObject,WKNavigationDelegate {
 let web=WKWebView(frame:NSRect(x:0,y:0,width:600,height:400),configuration:WKWebViewConfiguration())
 var loads=0
 func start(){web.navigationDelegate=self;guard let u=NativePageBootstrap.install(web:web,origin:CommandLine.arguments[1],token:"synthetic-token",uiKey:"synthetic-ui-key") else{finish(["invalid origin"]);return};web.load(URLRequest(url:u))}
 func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){let u=action.request.url;decisionHandler(u?.host=="127.0.0.1" && u?.port==URL(string:CommandLine.arguments[1])?.port ? .allow:.cancel)}
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){loads+=1;web.evaluateJavaScript("window.runShellChecks()") { value,error in
  var failures=value as? [String] ?? ["JavaScript did not return assertions"];if error != nil {failures.append("JavaScript execution failed")};if webView.url?.fragment != nil || webView.url?.query != nil {failures.append("unsafe WK URL")};if !failures.isEmpty{self.finish(failures);return};if self.loads==1{self.web.reload()}else{self.finish([])}
 }}
 func finish(_ errors:[String]){let value:[String:Any] = ["passed":errors.isEmpty,"errors":errors,"loads":loads,"url_has_credentials":web.url?.fragment != nil];let data=try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!);fflush(stdout);exit(errors.isEmpty ? 0:1)}
}
let app=NSApplication.shared;app.setActivationPolicy(.prohibited);let harness=Harness();harness.start();DispatchQueue.main.asyncAfter(deadline:.now()+40){harness.finish(["timeout"])};app.run()
`;
 const main=path.join(root,'main.swift'),binary=path.join(root,'isolated-wk-check');fs.writeFileSync(main,source);
 await exec('/usr/bin/xcrun',['swiftc','-swift-version','5','-framework','Cocoa','-framework','WebKit',new URL('../native/NativePageBootstrap.swift',import.meta.url).pathname,main,'-o',binary],{timeout:45000,maxBuffer:1024*1024});
 let result;try{result=await exec(binary,[origin],{timeout:45000,maxBuffer:1024*1024});}catch(error){assert.fail('Isolated WK assertions: '+error.stdout+' '+error.stderr);}const line=result.stdout.trim().split('\n').find(x=>x.startsWith('{'));assert.ok(line,result.stdout);const evidence=JSON.parse(line);assert.equal(evidence.passed,true);assert.equal(evidence.loads,2);assert.equal(evidence.url_has_credentials,false);
});
