import {fail} from '../../engine/src/core.mjs';

export const RUN_CAPABILITY_TOOL={name:'run_capability',description:'Run one locally registered extra ChatHand capability. The available names and exact parameter schemas are returned once by begin_task and in bridge_info.extra_capabilities. Existing tools keep their names and parameters. Unknown names or invalid parameters do not execute. This entry preserves the current task, permission and access scope.',inputSchema:{type:'object',properties:{capability:{type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'},parameters:{type:'object'}},required:['capability','parameters'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true,idempotentHint:false}};

// This is a local code registry, never a model-supplied tool/JavaScript loader.
function validate(schema,value,at='parameters',depth=0){
 if(depth>12)fail('CAPABILITY_ARGUMENT_INVALID',at+' 嵌套太深');
 const bad=()=>fail('CAPABILITY_ARGUMENT_INVALID',at+' 不符合本机能力参数定义');
 if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))bad();
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)bad();
  if(Object.keys(value).some(k=>['__proto__','prototype','constructor'].includes(k)))bad();
  for(const k of schema.required||[])if(!Object.hasOwn(value,k))bad();
  for(const [k,v] of Object.entries(value)){if(!Object.hasOwn(schema.properties||{},k)){if(schema.additionalProperties===true)continue;bad();}validate(schema.properties[k],v,at+'.'+k,depth+1);}
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length>(schema.maxItems??100)||value.length<(schema.minItems??0))bad();
  for(const v of value)validate(schema.items,v,at+'[]',depth+1);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length>(schema.maxLength??10000)||value.length<(schema.minLength??0)||schema.pattern&&!new RegExp(schema.pattern).test(value))bad();
 }else if(schema.type==='boolean'){if(typeof value!=='boolean')bad();}
 else if(schema.type==='integer'||schema.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))bad();}
 else bad();
}
export class CapabilityRegistry{
 constructor({existingNames=[],guard=()=>{}}={}){this.entries=new Map();this.existing=new Set(existingNames);this.guard=guard;}
 register({name,description,inputSchema,readOnly=false,permissions=[],handlesTaskPreparation=false,run}){
  if(!/^[a-z][a-z0-9_]{0,63}$/.test(name)||this.existing.has(name)||this.entries.has(name)||typeof description!=='string'||!description||inputSchema?.type!=='object'||typeof run!=='function'||!Array.isArray(permissions))throw Error('CAPABILITY_REGISTRATION_INVALID');
  if(!readOnly&&(!inputSchema.properties?.task_id||!inputSchema.required?.includes('task_id')||!permissions.length&&!handlesTaskPreparation))throw Error('CAPABILITY_TASK_AND_PERMISSION_REQUIRED');
  this.entries.set(name,{name,description,inputSchema:structuredClone(inputSchema),readOnly,permissions:[...permissions],handlesTaskPreparation,run});
 }
 list(){return [...this.entries.values()].map(({name,description,inputSchema,readOnly})=>({name,description,inputSchema:structuredClone(inputSchema),readOnly}));}
 async call(name,parameters,context){const entry=this.entries.get(name);if(!entry)fail('CAPABILITY_UNKNOWN','本机没有登记这个本事，请看 begin_task 或 bridge_info 的额外本事清单');validate(entry.inputSchema,parameters);await this.guard(entry,parameters,context);return entry.run(parameters,context);}
}
