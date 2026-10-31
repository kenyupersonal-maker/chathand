import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {D1} from './relay-d1.mjs';
import {createRelayWorker} from './fixtures/relay-worker-v412.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(here,'bootstrap.json'),'utf8'));
const envFor=db=>({DB:db,RELAY_ACTIVE:'true',RELAY_PAIRING_KEY:'synthetic-only',RELAY_OWNER_EMAIL:'fixture@example.invalid'});
function request(pathname,{method='GET',body,paired=true,headers={}}={}){
 const values={'oai-authenticated-user-email':'fixture@example.invalid',...headers};
 if(paired)values.authorization='Bearer synthetic-only';
 return new Request(`https://candidate.invalid${pathname}`,{method,headers:values,body:body===undefined?undefined:JSON.stringify(body)});
}

test('candidate hides experiment probes while retaining pairing, ordinary MCP and the formal WS endpoint',async()=>{
 const db=new D1();
 const env=envFor(db),worker=createRelayWorker(manifest);
 try{
  const probes=['/relay/ok','/relay/d1-probe','/relay/do-probe','/relay/ws-probe','/relay/diagnostic-rpc'];
  for(const pathname of probes){
   const get=await worker.fetch(request(pathname),env);assert.equal(get.status,404,`${pathname} GET`);assert.equal((await get.json()).error,'NOT_FOUND');
   const post=await worker.fetch(request(pathname,{method:'POST',body:{jsonrpc:'2.0',id:'rc-probe',method:'ping',params:{_meta:{'chathand/experiment':'chathand-relay-v4'}}}}),env);assert.equal(post.status,404,`${pathname} POST`);assert.equal((await post.json()).error,'NOT_FOUND');
  }

  const noPair=await worker.fetch(request('/relay/manifest',{paired:false}),env);assert.equal(noPair.status,401);assert.equal((await noPair.json()).error,'PAIRING_UNAUTHORIZED');
  const paired=await worker.fetch(request('/relay/manifest'),env);assert.equal(paired.status,200);assert.equal((await paired.json()).version,'route-compare-20261003');

  const initialized=await worker.fetch(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:'initialize',method:'initialize',params:{protocolVersion:manifest.initialize.protocolVersion,capabilities:{},clientInfo:{name:'candidate-entry-test',version:'1'}}},paired:false}),env);
  assert.equal(initialized.status,200);assert.equal((await initialized.json()).result.protocolVersion,manifest.initialize.protocolVersion);

  const missingWsMarker=await worker.fetch(request('/relay/ws',{headers:{upgrade:'websocket'}}),env);
  assert.equal(missingWsMarker.status,403);assert.equal((await missingWsMarker.json()).error,'EXPERIMENT_REQUEST_REQUIRED');
  const formalWs=await worker.fetch(request('/relay/ws',{headers:{upgrade:'websocket','x-rc-ws-probe':'route-compare-20261003'}}),env);
  assert.equal(formalWs.status,501,'Node fixture has no WebSocketPair runtime; request passed the formal route, pairing gate and compatibility marker');
  assert.equal((await formalWs.json()).error,'WEBSOCKET_RUNTIME_UNAVAILABLE');
 }finally{db.sqlite.close();}
});
