import crypto from 'node:crypto';import {fail} from '../../engine/src/core.mjs';
const fingerprint=p=>crypto.createHash('sha256').update(JSON.stringify([p.job_id,p.text??'',p.close??false])).digest('hex');
// Keep lightweight replay receipts when finished inputs stop occupying the live
// queue. Retrying the same request must never type a second time.
export function inputReplay(queue,spec){
 const receipts=queue.inputReceipts||(queue.inputReceipts=new Map());
 for(const [id,p] of queue.inputs)if(!['pending_approval','running'].includes(p.status)){
  receipts.set(p.request_id,{fingerprint:fingerprint(p),input_id:id,job_id:p.job_id,status:p.status});queue.inputs.delete(id);
 }
 const previous=receipts.get(spec.request_id);if(!previous)return null;
 if(previous.fingerprint!==fingerprint(spec))fail('OP_CONFLICT','输入 request_id 冲突。');
 const {fingerprint:ignored,...safe}=previous;return {...safe,replayed:true};
}
