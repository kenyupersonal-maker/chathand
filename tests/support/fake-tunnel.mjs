/** Offline test transport. No OpenAI requests. Runs as an owned child process. */
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
const command=process.argv[2],config=process.argv[process.argv.indexOf('--config')+1];
const dir=path.dirname(config),mode=()=>{try{return fs.readFileSync(path.join(dir,'test-tunnel-mode'),'utf8').trim();}catch{return 'ok';}};
fs.appendFileSync(path.join(dir,'test-tunnel-calls.jsonl'),JSON.stringify({command,pid:process.pid,time:Date.now()})+'\n',{mode:0o600});
if(command==='doctor'){
 if(mode()==='auth-fail'){console.error('401 invalid_api_key');process.exit(1);}
 if(mode()==='network-fail'){console.error('network timeout');process.exit(1);}
 console.log('OFFLINE_TEST_DOCTOR_OK');process.exit(0);
}
if(command!=='run')process.exit(2);
// A rejected credential fails the actual transport as well as its diagnostic.
if(mode()==='auth-fail'){console.error('401 invalid_api_key');process.exit(1);}
if(mode()==='network-fail'){console.error('network timeout');process.exit(1);}
const text=fs.readFileSync(config,'utf8'),health=JSON.parse(text.match(/url_file: (.+)/)[1]);
const start=Date.now(),server=http.createServer((req,res)=>{const ready=mode()!=='unready'&&Date.now()-start>80;res.writeHead(req.url==='/readyz'&&!ready?503:200);res.end('offline-test');});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(health,`http://127.0.0.1:${server.address().port}`,{mode:0o600}));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
