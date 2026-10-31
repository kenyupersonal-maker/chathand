import {consolidatedTaskCard} from './card-task-view.mjs';
import {t} from '../i18n.mjs';
import {fail} from '../../engine/src/core.mjs';

// Transport-only card data must leave the model-visible object before any observer runs.
export function splitCardResult(result){
 if(!result||typeof result!=='object'||!Object.hasOwn(result,'_card_meta'))return {value:result,meta:undefined};
 const {_card_meta:meta,...value}=result;
 if(!meta||typeof meta!=='object'||Array.isArray(meta)||![Object.prototype,null].includes(Object.getPrototypeOf(meta)))fail('CARD_META_INVALID',t('card.meta.invalid'));
 return {value,meta};
}

// The logging/statistics path must never receive transport-only metadata.
export function observableToolResult(result){
 if(!result||typeof result!=='object')return result;
 const {_meta,_card_meta,...visible}=result;
 return visible;
}

// Preserve every existing capability in transport-only metadata. The model and
// all observers continue receiving only the original compact result.
export function withTaskCard(result,full,records={}){
 const {value,meta}=splitCardResult(result),card=consolidatedTaskCard(full,records);
 if(!card)return result;
 const controls=meta?.['chathand/task_controls'];
 if(controls?.task_id===card.task_id&&controls.checkpoint_seq===card.progress.checkpoint_seq&&typeof meta?.['chathand/task_control_nonce']==='string'&&!card.terminal&&card.status!=='unknown'){
  for(const action of ['continue','stop'])if(controls.actions?.includes(action))card.controls[action]={enabled:true,tool:'card_answer',choice:action,nonce_key:'chathand/task_control_nonce'};
 }
 return {...value,_card_meta:{...meta,'chathand/task_card':card}};
}
