import fs from 'node:fs';
import {scopeReceipt} from '../v1/blocked.mjs';
import {DesktopCommandQueue} from '../commands.mjs';
import {fail} from '../../engine/src/core.mjs';
import {launchSpec,sandboxAvailable} from './sandbox.mjs';
import {APP_ROOT} from './access.mjs';
import {fullLaunchSpec,fullEnvironment} from '../v1/full-access.mjs';
import {resolveProgram,adminArgs,settleAdminJob,createDefaultAdminAccess,adminSetupError} from '../v1/admin-command.mjs';
// 「只在这个文件夹里」被系统沙箱挡住时的典型报错：给 ChatGPT 和首页说清楚要「整台电脑」
const SANDBOX_DENIED=/Operation not permitted|Connection invalid|not allowed to send Apple ?events|\(-1743\)|LSOpenURLsWithRole|kLSNoExecutableErr|\(-10810\)|\(-10661\)|sandbox-exec: |deny\(\d+\)/i;
export class SandboxQueue extends DesktopCommandQueue {
  get adminAccess(){return this._adminAccess??=createDefaultAdminAccess({stateDir:this.store.stateDir});}
  set adminAccess(v){this._adminAccess=v;}
  full(){return this.store.accessMode==='full';}
  status(){
    if(this.full())return {enabled:this.enabled,available:true,node_path:process.execPath,stdin:'pipe',pty:true,backend:'none',scope:'computer',approval:'task_grant_or_per_action',not_os_sandbox:true,note:'整台电脑：命令按当前账户权限运行，不套系统沙箱；管理员（sudo）命令在用户打开「以管理员身份运行」后直接运行，不用输密码。'};
    return {enabled:this.enabled&&sandboxAvailable(),available:sandboxAvailable(),node_path:process.execPath,stdin:'pipe',pty:true,backend:'macOS Seatbelt',scope:'folder',approval:'task_grant_or_per_action',not_os_sandbox:false,sandbox_acceptance:'LOCAL_PASS'};
  }
  propose(spec){
    const {pty=false,admin=null,...base}=spec;
    if(typeof pty!=='boolean')fail('ARG_INVALID','pty 必须是布尔值。');
    for(const j of this.jobs.values())if(j.request_id===spec.request_id&&!!j.pty!==pty)fail('OP_CONFLICT','同一请求编号的终端类型不同。');
    if(!this.full()&&!sandboxAvailable())fail('SANDBOX_UNAVAILABLE','系统沙箱不可用，未执行命令。');
    if(admin){
      // 管理员命令（10/2 定）：用户打开「以管理员身份运行」时装好了小助手和 sudoers 规则，这里直接经小助手运行，不再弹框（app/v1/admin-command.mjs）
      if(process.platform!=='darwin'||!this.full())fail('NEEDS_FULL_ACCESS','管理员命令只在 Mac 上、文件范围是「整台电脑」时可用。');
      if(!this.adminAccess.ready())throw adminSetupError();
      const cwd=this.store.resolve(base.cwd??'.',{directory:true});
      const program=resolveProgram(admin.argv[0],fullEnvironment().PATH);
      const result=super.propose({...base,stdin_mode:'closed',program:'/usr/bin/sudo',args:adminArgs({program,argv:admin.argv,options:admin.options,cwd})});
      const job=this.get(result.job_id);job.pty=false;job.admin??={display:[...admin.display],result:null};
      return {...this.publicJob(job),...(result.replayed?{replayed:true}:{})};
    }
    const result=super.propose({...base,...(pty?{stdin_mode:'pipe'}:{})});
    const job=this.get(result.job_id);job.pty=pty;return {...this.publicJob(job),...(result.replayed?{replayed:true}:{})};
  }
  prepareSpawn(job){
    if(job.admin){job.sandbox={backend:'管理员（sudo）',scope:'computer',pty:false};return {program:'/usr/bin/sudo',args:job.args,env:fullEnvironment()};}
    if(this.full())return fullLaunchSpec(job,{appRoot:APP_ROOT});
    return launchSpec(job,this.store);
  }
  approve(id){
    let result;
    try{result=super.approve(id);}catch(e){
      const job=this.jobs.get(id);
      if(job&&job.status==='running'&&!job.child){job.status='failed';job.finished_at=Date.now();job.launch_error=e.code||'LAUNCH_FAILED';this.recordLater(job);}
      throw e;
    }
    const job=this.jobs.get(id);
    if(job?.child){
      const scope=job.sandbox?.scope;
      job.child.once('close',()=>{
        try{
          if(job.admin){settleAdminJob(job);this.recordLater(job);return;}
          if(scope==='auto'&&job.status==='failed'){const err=job.events.filter(e=>e.stream==='stderr').map(e=>e.text).join('').slice(-4000);const m=SANDBOX_DENIED.exec(err);if(m){job.needsFullAccess=m[0];this.onSandboxDenied?.(job);}}
        }catch{}
      });
    }
    return result;
  }
  inspectChunk(job,chunk){
    job.promptTail=((job.promptTail||'')+chunk.toString('utf8')).slice(-256);
    const t=job.promptTail;
    job.inputHint=/password|passphrase|verification code/i.test(t)&&/[:?]\s*$/.test(t)?'sensitive_input_likely':/(?:>>>|\$|> |\? |\[y\/n\]|\(y\/n\)|:\s*)$/i.test(t)?'waiting_for_input_likely':null;
  }
  approveInput(id){const p=this.inputs.get(id);const result=super.approveInput(id);if(p){const j=this.jobs.get(p.job_id);if(j){j.promptTail='';j.inputHint=null;}}return result;}
  publicJob(job,options){
    const pub={...super.publicJob(job,options),pty:!!job.pty,sandbox:job.sandbox||null,input_hint:job.status==='running'?job.inputHint||null:null,input_hint_evidence:job.inputHint?'prompt_pattern_not_process_proof':null,warning:job.sandbox?.scope==='full'||job.admin?'命令按当前账户权限运行，没有系统沙箱。':'命令受 macOS 系统沙箱约束；当前访问范围以 sandbox.scope 为准。'};
    if(job.admin){
      // 显示给用户和 ChatGPT 的就是它提议的那条 sudo 命令；实际由 macOS 授权框以管理员身份执行同一条
      Object.assign(pub,{program:job.admin.display[0],args:job.admin.display.slice(1),admin:true,admin_result:job.admin.result||null,admin_message:job.admin.message||null,
        user_action:job.status==='pending_approval'?'等用户在 ChatHand 里确认。不要重复提议，不要在聊天里要密码。':null,
        rejected_reason:job.status==='rejected'?'用户在 ChatHand 里拒绝了这条管理员命令。':null});
    }
    if(job.needsFullAccess)pub.needs_full_access={code:'NEEDS_FULL_ACCESS',evidence:job.needsFullAccess,blocked:job.blocked||scopeReceipt({command:[job.program,...(job.args||[])].join(' '),reason:job.needsFullAccess}),message:'这一步多半被「只在这个文件夹里」的系统沙箱挡住了。需要用户把文件范围改成「整台电脑」：ChatHand 首页右边「权限与能力」→ 文件范围 → 选「整台电脑」。不要反复重试。'};
    return pub;
  }
  async close(){await super.close();for(const job of this.jobs.values())if(job.scratch&&!job.child&&!job.cleanupPending)try{fs.rmSync(job.scratch,{recursive:true,force:true});}catch{}}
}
