// Internal presentation metadata only. Never translate raw fallback/AI text.
const KEY=/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9_]*){1,7}$/;
const CJK=/[\p{Script=Han}]/u;
export function displayParam(value,fallback='refresh.reason.unknown'){
 return typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&!CJK.test(value)?value:{key:fallback};
}
function paramsOnly(params,depth=0){
 if(!params||typeof params!=='object'||Array.isArray(params)||depth>2)return {};
 const out={};for(const [name,value] of Object.entries(params)){
  if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))continue;
  if(typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&!CJK.test(value))out[name]=value;
  else if(depth<2&&value&&KEY.test(value.key||''))out[name]={key:value.key,...(value.params?{params:paramsOnly(value.params,depth+1)}:{})};
 }return out;
}
export function messageMetadata(field,key=null,params={}){
 return {[field+'_key']:KEY.test(key||'')?key:null,[field+'_params']:paramsOnly(params)};
}
export function taskTitleMetadata(task){return messageMetadata('title',task.title_key,task.title_params);}
export function taskSummaryMetadata(task){return messageMetadata('summary',task.summary_key,task.summary_params);}
