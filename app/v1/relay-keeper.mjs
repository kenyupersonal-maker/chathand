import {PACING} from './pacing.mjs';
import {takeInterruptionWitness} from './h8-cards.mjs';
// Isolated 1049 candidate. Does not send messages or infer host turn completion.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const RELAY = Object.freeze({
  countdown_ms: PACING.auto.countdown_ms, conflict_countdown_ms: 30_000, retry_ms: 10_000,
  retries: 3, resume_timeout_ms: 60_000, permit_ms: 5_000, max_auto_rounds: PACING.auto.per_task,
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const uuid = () => crypto.randomUUID();
const fail = code => { throw Object.assign(new Error(code), {code}); };
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const nonceOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const DENIED = new Set(['cancelled', 'resumed', 'limit']);
const PENDING = new Set(['armed', 'permit', 'retry_wait', 'manual_ready']);
const AWAITING = new Set(['dispatching', 'awaiting', 'unknown']);
const REASONS = new Set(['cancelled', 'new_tool', 'paused', 'stopped', 'waiting_user',
  'task_ended', 'authority_changed', 'unattributed_tool', 'disabled', 'new_checkpoint']);
const cleanReason = reason => REASONS.has(reason) ? reason : 'cancelled';

function context(input) {
  if (!input || typeof input.caller !== 'string' || !input.caller || input.caller.length > 4096) fail('RELAY_CONTEXT_INVALID');
  const session = input.session_hash ?? null;
  if (session !== null && !nonceOK(session)) fail('RELAY_CONTEXT_INVALID');
  const transport = input.transport ?? 'legacy';
  if (!['legacy', 'mcp_app'].includes(transport)) fail('RELAY_CONTEXT_INVALID');
  return {caller_hash: hash(input.caller), session_hash: session, transport};
}

function newState() {
  return {schema: 1, instance: null, countdown_ms: RELAY.countdown_ms,
    tasks: {}, attempts: {}, active_calls: {}, trials: [], live_cases: []};
}

/**
 * The sole writer is the app server. All state transitions use BEGIN IMMEDIATE.
 * readTask is a synchronous, trusted adapter to TaskPolicy + ResumeKeeper. It must
 * check caller ownership and return explicit live flags, epoch/revision and seq.
 * installationEligible is a trusted install-scope decision, never a widget arg.
 */
export class RelayKeeper {
  constructor({file, readTask, now = Date.now, installationEligible = false, events = null, taskState=()=>null, jobState=()=>null, notify=()=>{}} = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || typeof readTask !== 'function') fail('RELAY_CONFIG_INVALID');
    this.events = events;this.taskState=taskState;this.jobState=jobState;this.notify=notify;
    this.now = now;
    this.readTask = readTask;
    this.installationEligible = installationEligible === true;
    this.instance = uuid();
    this.closed = false;this.maintenanceTasks=new Set();this.lastMaintenance=-Infinity;
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    // The path is supplied by the server and must be inside its private state dir.
    this.db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS relay_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      this.db.prepare('INSERT OR IGNORE INTO relay_state (id,value) VALUES (1,?)').run(JSON.stringify(newState()));
      this._tx(state => {
      state.instance = this.instance;
      state.active_calls = {};
      const now = this.now();
      for (const task of Object.values(state.tasks)) {
        const card = task.card;
        if (!card) continue;
        // A permit was not yet consumed, so no send was authorized. A recovered
        // candidate must wait a full interval and pass live authority again.
        if (card.state === 'permit') {
          card.state = card.permit.from;
          card.permit = null;
        }
        if (card.state === 'armed'&&!card.wait) card.ready_at = now + state.countdown_ms;
        if (card.state === 'retry_wait') card.ready_at = now + RELAY.retry_ms;

      const attempt = state.attempts[card.attempt_id];
        if (attempt?.outcome === 'dispatching') {
          attempt.outcome = 'unknown';
          if (card.state === 'dispatching') card.state = 'unknown';
        }
      }
      }, true);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  _tx(fn, boot = false) {
    if (this.closed) fail('RELAY_CLOSED');
    this.db.exec('BEGIN IMMEDIATE');
    const notices=[],events=[];this.pendingNotices=notices;this.pendingEvents=events;
    try {
      const before=this.db.prepare('SELECT value FROM relay_state WHERE id=1').get().value;
      const state = JSON.parse(before);
      if (state.schema !== 1) fail('RELAY_STATE_VERSION');
      // Starting another service instance fences every old instance, including
      // an old card whose response is still in flight during app restart.
      if (!boot && state.instance !== this.instance) fail('RELAY_INSTANCE_REPLACED');
      this._sweep(state);
      const result = fn(state);
      if (result?.then) fail('RELAY_ASYNC_TRANSACTION');
      const after=JSON.stringify(state);if(after!==before)this.db.prepare('UPDATE relay_state SET value=? WHERE id=1').run(after);
      this.db.exec('COMMIT');
      this.indexMaintenance(state);this.lastMaintenance=this.now();
      this.pendingNotices=null;this.pendingEvents=null;
      for(const notice of notices)try{this.notify(notice);}catch{}
      for(const event of events)try{this.events?.record(event.kind,event.fields);}catch{}
      return result;
    } catch (error) {
      this.pendingNotices=null;this.pendingEvents=null;
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  _notice(task,kind){let live=null;try{live=this.readTask(task.id,{session_hash:task.session_hash});}catch{}if(!live)return;this.pendingNotices?.push({task_id:task.id,kind,auto_enabled:this.installationEligible&&!this.circuitOpen&&task.card?.auto===true&&['armed','retry_wait'].includes(task.card?.state)&&task.cancelled_seq!==task.card?.seq&&task.auto_rounds<PACING.auto.per_task&&task.block_rounds?.n<PACING.auto.per_block&&live?.auto_allowed!==false&&live?.external_wait!==true});}
  _refreshWait(task,state){
    const card=task.card;if(!card?.wait)return;
    let job=null;try{job=this.jobState(card.wait.job_id,task.id);}catch{}
    const now=this.now(),done=!!job&&!['running','pending_approval'].includes(job.status),over=now>=card.wait.until;
    if(done){card.wait.state='done';card.wait.finished_at=job.finished_at||card.wait.finished_at||now;card.prompt_kind='wait_done';card.ready_at=Math.max(card.at+(state?.countdown_ms??RELAY.countdown_ms),card.wait.finished_at+PACING.wait.ready_after_end_ms);}
    else if(over){card.wait.state='over';card.prompt_kind='wait_over';card.ready_at=Math.max(card.at+(state?.countdown_ms??RELAY.countdown_ms),card.wait.until);}
    else{card.wait.state='running';card.ready_at=null;}
    if(done&&!['new_tool','unattributed_tool','stopped'].includes(card.reason)&&!card.attempt_id&&!card.wait_notified&&now-card.wait.finished_at>=60000){card.wait_notified=true;this._notice(task,'wait_done');}
  }
  indexMaintenance(state){
    this.maintenanceTasks=new Set(Object.values(state.tasks).filter(task=>{
      const card=task.card;
      return card&&(['armed','permit','retry_wait',...AWAITING].includes(card.state)||card.wait?.state==='running');
    }).map(task=>task.id));
    this.onMaintenanceChange?.();
  }
  maintenanceDue(){
    if(this.closed)return false;
    for(const id of this.maintenanceTasks){let status=null;try{status=this.taskState(id);}catch{}
      if(['completed','failed','expired','superseded','revoked','rejected','cancelled','paused','permission_changed','workspace_changed','connection_lost'].includes(status))this.maintenanceTasks.delete(id);
    }
    return this.maintenanceTasks.size>0&&this.now()-this.lastMaintenance>=15000;
  }
  nextMaintenanceAt(){this.maintenanceDue();return !this.closed&&this.maintenanceTasks.size?this.lastMaintenance+15000:Infinity;}
  maintain(){return this.maintenanceDue()?this._tx(()=>({ok:true})):{ok:true,skipped:true};}

  _sweep(state) {
    const now = this.now();
    const cutoff=now-6*3600000;
    for(const [id,task] of Object.entries(state.tasks)){
      const related=Object.values(state.attempts).filter(a=>a.task_id===id);
      let settled=false;try{settled=['completed','failed','expired','superseded','revoked','rejected','cancelled','paused','permission_changed','workspace_changed','connection_lost'].includes(this.taskState(id));}catch{}
      if(settled&&task.card?.at<cutoff&&!related.some(a=>['dispatching','accepted','unknown'].includes(a.outcome)&&!a.resumed_at)){
        delete state.tasks[id];for(const a of related)delete state.attempts[a.id];
      }
    }
    for(const [id,a] of Object.entries(state.attempts))if(a.dispatched_at<cutoff&&!state.tasks[a.task_id]&&!['dispatching','accepted','unknown'].includes(a.outcome))delete state.attempts[id];
    for (const task of Object.values(state.tasks)) {
      const card = task.card;
      if (!card) continue;
      if(['armed','manual_ready','limit','cancelled'].includes(card.state))this._refreshWait(task,state);
      if(card.state==='armed'&&card.ready_at!==null&&!card.unclaimed_noted&&now-card.ready_at>=60000){card.unclaimed_noted=true;this.events?.record('relay.unclaimed',{task:task.id,ms:now-card.ready_at});}
      if (card.state === 'permit' && now >= card.permit.expires_at) {
        card.state = card.permit.from;
        card.permit = null;
      }
      const attempt = state.attempts[card.attempt_id];
      if (attempt && AWAITING.has(card.state) && now - attempt.dispatched_at >= RELAY.resume_timeout_ms) {
        if (attempt.outcome === 'dispatching') attempt.outcome = 'unknown';
        card.state = 'manual_ready';
        card.reason = 'resume_timeout';
        card.permit = null;
      }
    }
  }

  _owner(task, ctx) {
    const c = context(ctx);
    if (!task || ['caller_hash', 'session_hash', 'transport'].some(key => task[key] !== c[key])) fail('RELAY_CARD_INVALID');
    return c;
  }

  _mintCard(task){
    if(!task.card_secret)task.card_secret=crypto.randomBytes(32).toString('hex');
    const seq=(task.card_sequence||0)+1;if(seq>0xffffffff)fail('RELAY_CARD_SEQUENCE_LIMIT');
    task.card_sequence=seq;
    return seq.toString(16).padStart(8,'0')+crypto.createHmac('sha256',Buffer.from(task.card_secret,'hex')).update(task.id+':'+seq).digest('hex').slice(0,56);
  }
  _cardToken(task,raw){
    if(!task?.card||!nonceOK(raw))return null;
    if(hash(raw)===task.card.card_hash)return 'current';
    if(!nonceOK(task.card_secret)||!integer(task.card_sequence))return null;
    const seq=Number.parseInt(raw.slice(0,8),16);
    if(seq<1||seq>=task.card_sequence)return null;
    const expected=crypto.createHmac('sha256',Buffer.from(task.card_secret,'hex')).update(task.id+':'+seq).digest('hex').slice(0,56);
    return crypto.timingSafeEqual(Buffer.from(raw.slice(8),'hex'),Buffer.from(expected,'hex'))?'superseded':null;
  }

  _card(state, args, ctx) {
    if (!idOK(args.task_id) || !nonceOK(args.card_token)) fail('RELAY_CARD_INVALID');
    const task = state.tasks[args.task_id];
    this._owner(task, ctx);
    const proof=this._cardToken(task,args.card_token);if(!proof)fail('RELAY_CARD_INVALID');
    if(proof==='superseded')fail('RELAY_CARD_SUPERSEDED');
    return task;
  }

  _read(taskId, ctx) {
    try {
      const live = this.readTask(taskId, ctx);
      if (!live || live.then || !integer(live.epoch) || !integer(live.revision) || !integer(live.checkpoint_seq)) return {reason: 'task_unavailable'};
      if (live.status !== 'active') return {reason: 'task_ended'};
      if (live.enabled !== true || live.stopped !== false) return {reason: 'stopped'};
      if (live.paused !== false) return {reason: 'paused'};
      if ((live.session_hash ?? null) !== context(ctx).session_hash) return {reason: 'authority_changed'};
      return {live};
    } catch { return {reason: 'task_unavailable'}; }
  }

  _gate(state, task, ctx, {manual = false} = {}) {
    const checked = this._read(task.id, ctx);
    if (checked.reason) return checked.reason;
    const live = checked.live;
    if (live.epoch !== task.epoch || live.revision !== task.revision || live.checkpoint_seq !== task.card.seq) return 'authority_changed';
    if(!manual&&(live.external_wait===true||live.auto_allowed===false))return live.external_wait?'external_wait':'threshold_provisional';
    if (!manual && !this.installationEligible) return 'installation_not_eligible';
    if (Object.values(state.active_calls).some(call => this._matches(task, call, call.task_id) ||
      call.unattributed && task.caller_hash === call.caller_hash)) return 'tool_inflight';
    return null;
  }

  _matches(task, event, taskId) {
    if (task.caller_hash !== event.caller_hash) return false;
    if (task.session_hash && event.session_hash) return task.session_hash === event.session_hash;
    return Boolean(taskId && task.id === taskId);
  }

  _cancel(task, reason) {
    if (!task.card || task.card.state === 'resumed') return;
    task.card.state = 'cancelled';
    task.card.reason = cleanReason(reason);
    task.card.permit = null;
  }

  _view(state, task, ctx) {
    const card = task?.card;
    if (!card) return {available: false};
    const attempt = state.attempts[card.attempt_id];
    const reason = this._gate(state, task, ctx, {manual: true}),live=this._read(task.id,ctx).live,manualOnly=live?.external_wait===true||live?.auto_allowed===false;
    return {available: true, task_id: task.id, checkpoint_seq: card.seq,
      purpose: card.purpose, state:manualOnly&&card.state==='armed'?'manual_ready':card.state, reason: reason || card.reason || null,
      auto_enabled: this.installationEligible&&!manualOnly, auto:card.auto===true&&!manualOnly, auto_skipped:card.auto_skipped||null,prompt_kind:card.prompt_kind||'resume',block_n:task.block_rounds?.seq===card.seq?task.block_rounds.n:0,...(card.wait?{wait:{...card.wait}}:{}),auto_rounds: task.auto_rounds,
      max_auto_rounds: RELAY.max_auto_rounds, countdown_ms: state.countdown_ms,
      ready_at: ['armed', 'retry_wait'].includes(card.state) ? card.ready_at : null,
      retry_index: card.retry_index, cancelled: card.state === 'cancelled',
      manual_allowed: !reason && ['armed', 'retry_wait', 'manual_ready', 'limit'].includes(card.state),
      ...(attempt ? {attempt_id: attempt.id, dispatched_at: attempt.dispatched_at,
        outcome: attempt.outcome, error_code: attempt.error_code,
        resumed_at: attempt.resumed_at, resume_latency_ms: attempt.resume_latency_ms,
        resume_deadline: attempt.dispatched_at + RELAY.resume_timeout_ms} : {})};
  }

  /** Called only after a successful, explicitly continuing checkpoint is saved. */
  checkpoint({task_id, checkpoint_seq, continuing, waiting_user = false}, ctx) {
    if (!idOK(task_id) || !integer(checkpoint_seq) || checkpoint_seq < 1) fail('RELAY_ARGUMENT_INVALID');
    const owner = context(ctx);
    return this._tx(state => {
      const checked = this._read(task_id, ctx);
      if (checked.reason) return {armed: false, reason: checked.reason};
      const live = checked.live;
      if (live.checkpoint_seq !== checkpoint_seq) return {armed: false, reason: 'stale_checkpoint'};
      let task = state.tasks[task_id];
      if (task) this._owner(task, ctx);
      if (task?.card && checkpoint_seq <= task.card.seq) return {armed: false, reason: 'checkpoint_already_registered', relay: this._view(state, task, ctx)};
      if (!task) task = state.tasks[task_id] = {id: task_id, ...owner, auto_rounds: 0, card: null};
      const raw=this._mintCard(task);
      Object.assign(task,{epoch:live.epoch,revision:live.revision});
      task.card={seq:checkpoint_seq,purpose:'checkpoint',at:this.now(),ready_at:null,card_hash:hash(raw),consumed:false,state:'cancelled',retry_index:0,cycle_id:null,attempt_id:null,permit:null,reason:waiting_user?'waiting_user':continuing?'continuing':'cancelled'};
      return {armed:false,relay:this._view(state,task,ctx),_relay_meta:{card_token:raw}};
    });
  }

  // Pure observation: unresolved sends must never be replaced by a new card.
  canInterrupt(task_id,ctx,{ignoreInflight=false}={}){
    try{const checked=this._read(task_id,ctx);if(checked.reason)return false;
      const state=JSON.parse(this.db.prepare('SELECT value FROM relay_state WHERE id=1').get().value),task=state.tasks[task_id];
      if(!ignoreInflight&&Object.values(state.active_calls).some(c=>this._matches({caller_hash:context(ctx).caller_hash,session_hash:ctx.session_hash,id:task_id},c,c.task_id)||c.unattributed&&c.caller_hash===context(ctx).caller_hash))return false;
      if(!task)return true;this._owner(task,ctx);const card=task.card,attempt=state.attempts[card?.attempt_id];
      if(attempt&&!attempt.resumed_at&&['dispatching','accepted','unknown'].includes(attempt.outcome))return false;
      return !card||DENIED.has(card.state);
    }catch{return false;}
  }

  /** Existing stall detector may expose a manual button, never arm auto here. */
  interruption({task_id}, ctx, witness = null) {
    if (!idOK(task_id)) fail('RELAY_ARGUMENT_INVALID');
    const owner = context(ctx);
    return this._tx(state => {
      const checked = this._read(task_id, ctx);
      if (checked.reason) return {available: false, reason: checked.reason};
      const witnessed=takeInterruptionWitness(witness,task_id,ctx,checked.live,this.now());
      if (!witnessed && checked.live.manual_resume_allowed !== true) return {available: false, reason: 'not_interrupted'};
      if(!this.canInterrupt(task_id,ctx))return {available:false,reason:'send_unconfirmed'};
      let task = state.tasks[task_id];
      if (task) {
        this._owner(task, ctx);
        if (task.card && !DENIED.has(task.card.state)) return {relay: this._view(state, task, ctx)};
      } else task = state.tasks[task_id] = {id: task_id, ...owner, auto_rounds: 0};
      const raw = this._mintCard(task), live = checked.live;
      if(task.block_rounds?.seq!==live.checkpoint_seq)task.block_rounds={seq:live.checkpoint_seq,n:0};
      const blockLimit=task.block_rounds.n>=PACING.auto.per_block,taskLimit=task.auto_rounds>=PACING.auto.per_task,cancelled=task.cancelled_seq===live.checkpoint_seq;
      const auto=this.installationEligible&&!this.circuitOpen&&!blockLimit&&!taskLimit&&!cancelled&&live.auto_allowed!==false&&live.external_wait!==true;
      Object.assign(task, {epoch: live.epoch, revision: live.revision});
      task.card = {seq: live.checkpoint_seq, purpose: 'interruption',auto,auto_skipped:taskLimit?'task_limit':blockLimit?'block_limit':cancelled?'cancelled':live.external_wait?'external_wait':live.auto_allowed===false?'threshold_provisional':auto?null:'disabled',prompt_kind:task.block_rounds.n===1?'split_smaller':'resume',at: this.now(),
        ready_at: auto?this.now()+state.countdown_ms:null, card_hash: hash(raw), consumed: false, state:taskLimit?'limit':auto?'armed':'manual_ready',
        retry_index: 0, cycle_id: null, attempt_id: null, permit: null, reason: 'interrupted'};
      if(live.waiting_job){const w=live.waiting_job;task.card.wait={job_id:w.job_id,until:Number.isFinite(w.timeout_at)?w.timeout_at+60000:this.now()+3600000+60000,state:'running'};this._refreshWait(task,state);}
      if(blockLimit&&task.block_notified_seq!==live.checkpoint_seq){task.block_notified_seq=live.checkpoint_seq;this._notice(task,'block_limit');}
      return {relay: this._view(state, task, ctx), _relay_meta: {card_token: raw}};
    });
  }

  /** Surround every model-origin tool, including failures, with start/end. */
  noteToolStart({task_id = null, call_id}, ctx) {
    if (task_id !== null && !idOK(task_id) || typeof call_id !== 'string' || !call_id || call_id.length > 4096) fail('RELAY_ARGUMENT_INVALID');
    const c = context(ctx), key = hash(JSON.stringify([c, call_id]));
    return this._tx(state => {
      const exact = task_id && state.tasks[task_id];
      let cancelled = 0, resumed = 0;
      for (const task of Object.values(state.tasks)) {
        // If both identities are absent, conservatively revoke every pending
        // candidate for this caller; never guess that a task resumed.
        const unattributed = !c.session_hash && !task_id && task.caller_hash === c.caller_hash;
        if (!unattributed && !this._matches(task, c, task_id)) continue;
        const card = task.card;
        if (!card) continue;
        const attempt = state.attempts[card.attempt_id];
        const awaitingResume = AWAITING.has(card.state) || card.state === 'manual_ready' && card.reason === 'resume_timeout';
        if (exact === task && attempt && awaitingResume && ['dispatching', 'accepted', 'unknown'].includes(attempt.outcome)) {
          attempt.resumed_at = this.now();
          attempt.resume_latency_ms = Math.max(0, this.now() - attempt.dispatched_at);
          card.state = 'resumed'; card.reason = null; card.permit = null;
          resumed++;
        } else if (PENDING.has(card.state) || AWAITING.has(card.state)) {
          this._cancel(task, unattributed ? 'unattributed_tool' : 'new_tool'); cancelled++;
        }
      }
      state.active_calls[key] = {...c, task_id, unattributed: !c.session_hash && !task_id};
      return {call_key: key, cancelled, resumed};
    });
  }

  noteToolEnd({call_key}) {
    if (!nonceOK(call_key)) fail('RELAY_ARGUMENT_INVALID');
    return this._tx(state => { delete state.active_calls[call_key]; return {ok: true}; });
  }

  // Proof is read-only and never consumes a token. It is used ONLY to decide
  // whether a call may bypass the model-origin cancellation wrapper. The
  // actual tool method still validates and consumes its capability atomically.
  provePrivateCapability(args,ctx){
    if(this.closed||!args||typeof args!=='object'||!idOK(args.task_id))return false;
    try{
      const owner=context(ctx),row=this.db.prepare('SELECT value FROM relay_state WHERE id=1').get();
      const state=JSON.parse(row?.value||'null');
      if(state?.instance!==this.instance)return false;
      const task=state.tasks?.[args.task_id];
      this._owner(task,ctx);
      if(!owner.session_hash||task?.session_hash!==owner.session_hash)return false;
      const card=task?.card;
      const matches=(raw,expected)=>nonceOK(raw)&&typeof expected==='string'&&hash(raw)===expected;
      if(['view','claim','cancel'].includes(args.action))
        return this._cardToken(task,args.card_token)!==null;
      if(args.action==='begin_dispatch'){
        if(card?.state==='permit'&&matches(args.permit_token,card.permit?.hash))return true;
        // One-use replay is still an authenticated card attempt: the handler
        // returns send:false, it never dispatches twice.
        return Boolean(Object.values(state.attempts||{}).some(a=>a.task_id===task.id&&matches(args.permit_token,a.report_hash)));
      }
      if(args.action==='report'){
        const attempt=state.attempts?.[args.attempt_id];
        return Boolean(attempt&&attempt.task_id===task.id&&matches(args.report_token,attempt.report_hash));
      }
      return false;
    }catch{return false;}
  }

  view(args, ctx) { return this._tx(state => this._view(state, this._card(state, args, ctx), ctx)); }

  claim(args, ctx) {
    const mode = args.mode ?? 'auto';
    if (!['auto', 'manual'].includes(mode)) fail('RELAY_ARGUMENT_INVALID');
    if (mode === 'manual' && !idOK(args.request_id)) fail('RELAY_ARGUMENT_INVALID');
    return this._tx(state => {
      const task = this._card(state, args, ctx), card = task.card;
      const retry = mode === 'auto' && card.state === 'retry_wait';
      const retryMode = retry ? state.attempts[card.attempt_id]?.mode : null;
      const reason = this._gate(state, task, ctx, {manual: mode === 'manual' || retryMode === 'manual'});
      if (reason) {
        if (!['tool_inflight','installation_not_eligible','external_wait','threshold_provisional'].includes(reason)) this._cancel(task, reason);
        return {granted: false, reason};
      }
      if (mode === 'auto') {
        if (!['armed', 'retry_wait'].includes(card.state)) return {granted: false, reason: 'not_armed'};
        if (card.purpose !== 'interruption'||card.auto!==true) return {granted: false, reason: 'manual_only'};
        if (card.ready_at===null||this.now() < card.ready_at) return {granted: false, reason: 'too_early', ready_at: card.ready_at};
        if (card.state === 'armed' && (card.consumed || task.auto_rounds >= RELAY.max_auto_rounds)) return {granted: false, reason: 'auto_limit_or_consumed'};
        if (card.state === 'retry_wait' && state.attempts[card.attempt_id]?.outcome !== 'rejected') return {granted: false, reason: 'retry_not_proven_safe'};
      } else {
        if (!['armed', 'retry_wait', 'manual_ready', 'limit'].includes(card.state)) return {granted: false, reason: 'manual_unavailable'};
        const request = hash(args.request_id);
        if ((card.manual_requests || []).includes(request)) return {granted: false, reason: 'manual_request_replayed'};
        (card.manual_requests ||= []).push(request);
      }
      const raw = token(), from = card.state;
      card.permit = {hash: hash(raw), mode: retryMode || mode, retry, from, expires_at: this.now() + RELAY.permit_ms};
      card.state = 'permit';
      return {granted: true, permit_token: raw, expires_at: card.permit.expires_at};
    });
  }

  /** Commit consumption before returning send:true. Widget sends immediately. */
  beginDispatch({task_id, permit_token}, ctx) {
    if (!idOK(task_id) || !nonceOK(permit_token)) fail('RELAY_CARD_INVALID');
    return this._tx(state => {
      const task = state.tasks[task_id]; this._owner(task, ctx);
      const card = task.card, permit = card?.permit;
      if (card?.state !== 'permit' || !permit || permit.hash !== hash(permit_token) || this.now() >= permit.expires_at) return {send: false, reason: 'permit_invalid'};
      const reason = this._gate(state, task, ctx, {manual: permit.mode === 'manual'});
      if (reason) {if(!['external_wait','threshold_provisional'].includes(reason))this._cancel(task, reason);return {send:false,reason};}
      const retry = permit.from === 'retry_wait' && permit.retry === true;
      if (permit.mode === 'auto' && !retry && (card.consumed || task.auto_rounds >= RELAY.max_auto_rounds)) {
        this._cancel(task, 'cancelled'); return {send: false, reason: 'auto_limit_or_consumed'};
      }
      if (retry && (state.attempts[card.attempt_id]?.outcome !== 'rejected' || card.retry_index > RELAY.retries)) {
        this._cancel(task, 'cancelled'); return {send: false, reason: 'retry_not_proven_safe'};
      }
      if (!retry) { card.cycle_id = uuid(); card.retry_index = 0; }
      if (permit.mode === 'auto' && !retry){
        if(task.block_rounds?.seq!==card.seq)task.block_rounds={seq:card.seq,n:0};
        if(task.block_rounds.n>=PACING.auto.per_block||task.cancelled_seq===card.seq)return {send:false,reason:'block_limit_or_cancelled'};
        task.auto_rounds++;task.block_rounds.n++;this.pendingEvents?.push({kind:'relay.auto',fields:{task:task.id,prompt_kind:card.prompt_kind||'resume',block_n:task.block_rounds.n,task_n:task.auto_rounds}});
      }
      card.consumed = true;
      const attempt = {id: uuid(), task_id, checkpoint_seq: card.seq, cycle_id: card.cycle_id,
        mode: permit.mode, auto_round: task.auto_rounds, retry_index: card.retry_index,
        dispatched_at: this.now(), outcome: 'dispatching', error_code: null,
        report_hash: permit.hash, reported_at: null, resumed_at: null, resume_latency_ms: null,
        output_conflict: null, input_conflict: null};
      state.attempts[attempt.id] = attempt;
      card.attempt_id = attempt.id; card.state = 'dispatching'; card.permit = null; card.reason = null;
      return {send: true, attempt_id: attempt.id, mode: attempt.mode, retry_index: attempt.retry_index,
        auto_round: task.auto_rounds, dispatched_at: attempt.dispatched_at};
    });
  }

  /** Rejected is valid only for a definite structured host refusal, not timeout. */
  report({attempt_id, report_token, outcome, error_code = null, definitely_not_sent = false,
    output_conflict = null, input_conflict = null}, ctx) {
    if (!idOK(attempt_id) || !nonceOK(report_token) || !['accepted', 'rejected', 'unknown'].includes(outcome) ||
      error_code !== null && !Number.isSafeInteger(error_code) ||
      ![null, true, false].includes(output_conflict) || ![null, true, false].includes(input_conflict)) fail('RELAY_ARGUMENT_INVALID');
    if (outcome === 'rejected' && (definitely_not_sent !== true || error_code === null)) fail('RELAY_REJECTION_UNPROVEN');
    return this._tx(state => {
      const attempt = state.attempts[attempt_id];
      if (!attempt || attempt.report_hash !== hash(report_token)) fail('RELAY_CARD_INVALID');
      const task = state.tasks[attempt.task_id]; this._owner(task, ctx);
      if (!['dispatching', 'unknown'].includes(attempt.outcome)) {
        if (attempt.outcome !== outcome) fail('RELAY_REPORT_CONFLICT');
        return {ok: true, replayed: true, relay: this._view(state, task, ctx)};
      }
      // A recovered/timeout unknown cannot become a new retry. A late accepted
      // receipt may refine the record, but never schedules another message.
      const wasUnknown = attempt.outcome === 'unknown';
      Object.assign(attempt, {outcome, error_code, reported_at: this.now(), output_conflict, input_conflict});
      if (output_conflict === true) this._extendCountdown(state);
      const card = task.card;
      if (card?.attempt_id === attempt.id && AWAITING.has(card.state)) {
        if (outcome === 'rejected' && card.auto===true && !wasUnknown && attempt.retry_index < RELAY.retries && !this._gate(state, task, ctx, {manual: attempt.mode === 'manual'})) {
          card.state = 'retry_wait'; card.retry_index = attempt.retry_index + 1; card.ready_at = this.now() + RELAY.retry_ms;
        } else if (outcome === 'rejected') {
          card.state = 'manual_ready'; card.reason = 'retries_exhausted_or_unavailable';
        } else card.state = outcome === 'accepted' ? 'awaiting' : 'unknown';
      }
      return {ok: true, relay: this._view(state, task, ctx)};
    });
  }

  cancel(args, ctx) {
    return this._tx(state => { const task = this._card(state, args, ctx);task.cancelled_seq=task.card.seq;this._cancel(task, 'cancelled'); return {cancelled: true}; });
  }

  // Server/native hooks only, not directly exposed as unscoped widget tools.
  cancelTask(task_id, reason = 'stopped') {
    if (!idOK(task_id)) fail('RELAY_ARGUMENT_INVALID');
    return this._tx(state => { const task = state.tasks[task_id]; if (task) this._cancel(task, reason); return {cancelled: Boolean(task)}; });
  }
  cancelContext(ctx,reason='disabled'){
    const owner=context(ctx);return this._tx(state=>{for(const task of Object.values(state.tasks))if(task.caller_hash===owner.caller_hash&&task.session_hash===owner.session_hash)this._cancel(task,reason);});
  }
  cancelAll(reason = 'stopped') {
    return this._tx(state => { for (const task of Object.values(state.tasks)) this._cancel(task, reason); return {cancelled: true}; });
  }

  _extendCountdown(state) {
    state.countdown_ms = RELAY.conflict_countdown_ms;
    for (const task of Object.values(state.tasks)) {
      const card = task.card;
      if (card?.state === 'armed') card.ready_at = Math.max(card.ready_at, card.at + state.countdown_ms);
      if (card?.state === 'permit' && card.permit.from === 'armed' && card.permit.mode === 'auto') {
        card.permit = null; card.state = 'armed'; card.ready_at = Math.max(card.ready_at, card.at + state.countdown_ms);
      }
    }
  }

  /** Separate real-host evidence. Caller owns provenance; fixtures never count. */
  recordLiveCase({case_id, kind, sent, resumed, error_code = null, output_conflict, input_conflict, verified_real_host}) {
    if (!idOK(case_id) || !['ai_output', 'unsent_input', 'chatgpt_stopped', 'ordinary'].includes(kind) ||
      typeof sent !== 'boolean' || typeof resumed !== 'boolean' || typeof output_conflict !== 'boolean' ||
      typeof input_conflict !== 'boolean' || verified_real_host !== true ||
      error_code !== null && !Number.isSafeInteger(error_code)) fail('RELAY_LIVE_EVIDENCE_INVALID');
    return this._tx(state => {
      const id_hash = hash(case_id);
      if (state.live_cases.some(item => item.id_hash === id_hash)) return {recorded: false, replayed: true};
      const item = {id_hash, at: this.now(), kind, sent, resumed, error_code, output_conflict, input_conflict};
      state.live_cases.push(item);
      if (kind === 'ordinary' && state.trials.length < 30) state.trials.push(item);
      if (output_conflict) this._extendCountdown(state);
      return {recorded: true, ...this._graduation(state)};
    });
  }

  _graduation(state) {
    const completed = state.trials.length, successes = state.trials.filter(item => item.sent && item.resumed).length;
    return {real_trials: completed, real_successes: successes, eligible_for_release: completed === 30 && successes >= 27};
  }

  stats() {
    return this._tx(state => ({countdown_ms: state.countdown_ms, ...this._graduation(state),
      attempts: Object.values(state.attempts).map(({report_hash, ...safe}) => safe),
      live_cases: state.live_cases.map(({id_hash, ...safe}) => safe)}));
  }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
