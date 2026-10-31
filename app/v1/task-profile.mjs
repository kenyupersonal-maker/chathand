import {fail} from '../../engine/src/core.mjs';
export function taskProfile({model,trial='medium'}={}){
 if(model!==undefined&&typeof model!=='string')fail('ARG_INVALID','model 需要字符串。');
 if(!['fine','medium','coarse'].includes(trial))fail('ARG_INVALID','trial 请选择 fine、medium、coarse。');
 const text=typeof model==='string'?model.toLowerCase():null;
 return {model:text===null?'unknown':[...text].length>40?'other':text.includes('pro')?'pro':text.includes('thinking')?'thinking':text.includes('instant')?'instant':'other',trial};
}
