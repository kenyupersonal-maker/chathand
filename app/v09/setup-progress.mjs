import crypto from 'node:crypto';

const STATES=new Set(['pending','running','done','needs_user']);

export class SetupProgress {
  constructor(){this.steps=new Map();}
  ensure(id,title){
    if(!this.steps.has(id)) this.steps.set(id,{id,title,status:'pending',started_at:null,finished_at:null,result:null,owner:null});
    return this.steps.get(id);
  }
  claim(id,owner){
    const step=this.ensure(id,id);
    if(step.status==='done') return {claimed:false,reason:'already_done',step};
    if(step.status==='running'&&step.owner!==owner) return {claimed:false,reason:'claimed_by_other',step};
    step.status='running';step.owner=owner;step.started_at??=Date.now();
    return {claimed:true,step};
  }
  done(id,result){
    const step=this.ensure(id,id);step.status='done';step.finished_at=Date.now();step.result=String(result||'').slice(0,500);return step;
  }
  needsUser(id,result){
    const step=this.ensure(id,id);step.status='needs_user';step.result=String(result||'').slice(0,500);return step;
  }
  snapshot(){return [...this.steps.values()].map(({owner,...step})=>step);}
}

export function createSetupProgress(){return new SetupProgress();}
