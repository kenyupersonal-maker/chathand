// Minimal in-memory D1-compatible fixture for relay-entry.test.mjs.
// Loads only the candidate's checked-in Drizzle migrations.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const siteRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'.');

export class D1 {
  constructor(){
    this.sqlite=new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    const migrationDir=path.join(siteRoot,'site/drizzle');
    for(const filename of fs.readdirSync(migrationDir).filter(name=>/^\d+_.+\.sql$/.test(name)).sort()){
      this.sqlite.exec(fs.readFileSync(path.join(migrationDir,filename),'utf8'));
    }
    this.batchId=0;
    this.currentBatch=null;
    if(this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rc_runtime'").get()){
      const manifest=JSON.parse(fs.readFileSync(path.join(siteRoot,'tests/fixtures/catalog.json'),'utf8'));
      const settings={hotMs:50,warmMs:100,coldMs:500,hotWindowMs:30000,warmWindowMs:300000,rotateMs:45000,maxOperations:200};
      this.sqlite.prepare("INSERT INTO rc_runtime(id,manifest_json,settings_json,revision,updated_at) VALUES('mac',?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER)) ON CONFLICT(id) DO NOTHING").run(JSON.stringify(manifest),JSON.stringify(settings),'fixture-v41');
    }
  }

  // Match D1: binding creates a new statement and leaves the source unchanged.
  prepare(sql,args=[]){
    const fixture=this;
    return {
      bind(...values){assert.ok(values.length<=100,'D1 max 100 bound parameters');return fixture.prepare(sql,values);},
      first(){return execute('first');},
      all(){return execute('all');},
      run(){return execute('run');},
    };
    function execute(kind){
      const statement=fixture.sqlite.prepare(sql);
      if(kind==='first')return statement.get(...args)??null;
      const before=fixture.sqlite.prepare('SELECT total_changes() AS n').get().n;
      const results=statement.columns().length?statement.all(...args):(statement.run(...args),[]);
      const changes=Number(fixture.sqlite.prepare('SELECT total_changes() AS n').get().n-before);
      return {success:true,results,meta:{changes,duration:0,served_by_region:'FIXTURE',served_by_primary:true}};
    }
  }

  batch(statements){
    this.sqlite.exec('BEGIN');
    this.currentBatch=++this.batchId;
    try{
      const results=statements.map(statement=>statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    }catch(error){
      this.sqlite.exec('ROLLBACK');
      throw error;
    }finally{
      this.currentBatch=null;
    }
  }
}
