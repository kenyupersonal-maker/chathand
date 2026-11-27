import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {SearchManager} from '../../app/v06/search.mjs';

const caller='fixture';
const session='a'.repeat(64);
const root=path.resolve('synthetic-search-directory');
const entry=name=>({name,isDirectory:()=>false,isFile:()=>false});

function fixture(t,entries){
  const visits=[];
  const state={opened:0,closed:0};
  const store={
    root,paused:false,checkActive(){},
    resolve(input){
      const file=path.resolve(root,input);
      if(file!==root)visits.push(path.basename(file));
      return file;
    }
  };
  const policy={state:{data:{active:'fixture'}},epoch:1,permissionRevision:1};
  t.mock.method(fs.promises,'opendir',async directory=>{
    assert.equal(directory,root);
    state.opened++;
    return {
      close(){state.closed++;},
      async *[Symbol.asyncIterator](){
        try{yield* entries();}
        finally{this.close();}
      }
    };
  });
  const search=new SearchManager(store,policy);
  return {search,visits,state,policy};
}

function start(search,type='files'){
  return search.start({path:root,query:'target.txt',type,max_results:30},caller,session).search_id;
}

function* manyEntries(){
  for(let i=1;i<=50_000;i++)yield entry('file-'+i+'.txt');
  yield entry('target.txt');
  yield entry('last.txt');
}

test('filename searches automatically carry the same directory cursor across 50,000 entries',async t=>{
  const {search,visits,state}=fixture(t,manyEntries);
  const id=start(search);
  const result=await search.results(id,caller,session,0,30,null,5000);
  assert.equal(result.search_id,id);
  assert.equal(result.status,'completed');
  assert.equal(result.visited,50_002);
  assert.equal(result.scan_batches,2);
  assert.deepEqual(result.reasons,[]);
  assert.equal(result.incomplete,false);
  assert.deepEqual(result.results,[{path:path.join(root,'target.txt'),type:'file'}]);
  assert.equal(new Set(visits).size,50_002);
  assert.equal(visits.length,50_002);
  assert.deepEqual(visits.slice(49_999),['file-50000.txt','target.txt','last.txt']);
  assert.deepEqual(state,{opened:1,closed:1});
});

test('a filename search can enter a new batch after 30 seconds with fewer than 50,000 entries',async t=>{
  let clock=0;
  t.mock.method(performance,'now',()=>clock);
  const {search,visits,state}=fixture(t,function*(){
    yield entry('first.txt');
    clock=30_000;
    yield entry('target.txt');
  });
  const id=start(search);
  const result=await search.results(id,caller,session,0,30,null,5000);
  assert.equal(result.status,'completed');
  assert.equal(result.scan_batches,2);
  assert.equal(result.visited,2);
  assert.equal(result.incomplete,false);
  assert.equal(result.results[0].path,path.join(root,'target.txt'));
  assert.deepEqual(visits,['first.txt','target.txt']);
  assert.deepEqual(state,{opened:1,closed:1});
});

test('content searches still stop at the original scan cap',async t=>{
  const {search,visits,state}=fixture(t,manyEntries);
  const result=await search.results(start(search,'content'),caller,session,0,30,null,5000);
  assert.equal(result.status,'completed');
  assert.equal(result.visited,50_000);
  assert.equal(result.scan_batches,undefined);
  assert.equal(result.incomplete,true);
  assert.deepEqual(result.reasons,['SCAN_BUDGET']);
  assert.equal(visits.at(-1),'file-50000.txt');
  assert.deepEqual(state,{opened:1,closed:1});
});

for(const boundary of ['cancel','revoke'])test('a filename batch respects '+boundary+' before processing the next entry',async t=>{
  let clock=0,id,interrupt;
  t.mock.method(performance,'now',()=>clock);
  const {search,visits,policy,state}=fixture(t,function*(){
    yield entry('first.txt');
    clock=30_000;
    interrupt=tick().then(()=>{
      if(boundary==='cancel')search.stop(id,caller,session);
      else policy.permissionRevision++;
    });
    yield entry('target.txt');
  });
  id=start(search);
  const job=search.jobs.get(id);
  for(let i=0;i<20&&(job.status==='running'||state.closed===0);i++)await tick();
  assert.notEqual(job.status,'running');
  await interrupt;
  assert.equal(job.visited,1);
  assert.deepEqual(job.results,[]);
  assert.deepEqual(visits,['first.txt']);
  assert.deepEqual(state,{opened:1,closed:1});
  if(boundary==='cancel')assert.equal(search.results(id,caller,session).status,'cancelled');
  else assert.throws(()=>search.results(id,caller,session),{code:'SEARCH_REVOKED'});
});
