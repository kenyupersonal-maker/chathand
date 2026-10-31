const ROUTES=new Set(['site','openai']);
const COMMAND_ROUTES=new Map([
 ['site-start','site'],['site','site'],['site-pair','site'],['site-replace','site'],
 ['connect','openai'],['bind-app',null],['prepare-browser',null],['test-start',null]
]);
const validTime=value=>Number.isSafeInteger(value)&&value>=0;
const validProgress=(command,route)=>ROUTES.has(route)&&COMMAND_ROUTES.has(command)&&
 (COMMAND_ROUTES.get(command)===null||COMMAND_ROUTES.get(command)===route);

// Keep memory and persisted activity in agreement when the state writer fails.
function saveActivity(state,updates){
 const previous=Object.keys(updates).map(key=>[key,Object.hasOwn(state.data,key),state.data[key]]);
 Object.assign(state.data,updates);
 try{state.save();}catch(error){
  for(const [key,present,value]of previous){if(present)state.data[key]=value;else delete state.data[key];}
  throw error;
 }
}

export class SetupActivity {
 constructor({state,now=Date.now,timeoutMs=15*60*1000}){Object.assign(this,{state,now,timeoutMs});}

 // Call only after actual setup progress is accepted, never for reads or route
 // selection. Explicit attribution can target a standby route being configured.
 touch(command,route){
  if(!validProgress(command,route))return false;
  const at=this.now();if(!validTime(at))return false;
  saveActivity(this.state,{
   setup_activity_last_at:at,setup_activity_in_progress:true,
   setup_activity_last_command:command,setup_activity_route:route
  });
  return true;
 }

 // Cancellation ends progress without publishing a new successful test.
 cancel(route){
  const activity=this.snapshot();
  if(!ROUTES.has(route)||activity.route!==route||this.state.data.setup_activity_in_progress===false)return false;
  saveActivity(this.state,{setup_activity_in_progress:false});
  return true;
 }

 finish(route){
  const activity=this.snapshot();
  if(!activity.active||route!==undefined&&activity.route!==route)return false;
  const now=this.now(),previous=this.state.data.setup_activity_finished_at;
  if(!validTime(now))return false;
  const at=Math.max(now,validTime(previous)?previous+1:0);
  if(!validTime(at))return false;
  saveActivity(this.state,{setup_activity_finished_at:at,setup_activity_in_progress:false});
  return true;
 }

 snapshot(){
  const data=this.state.data,at=data.setup_activity_last_at,now=this.now();
  const attributed=validProgress(data.setup_activity_last_command,data.setup_activity_route);
  return {
   // Old timestamps may have come from doctor; only attributed progress is live.
   active:attributed&&data.setup_activity_in_progress!==false&&validTime(at)&&
    validTime(now)&&now>=at&&now-at<this.timeoutMs,
   last_at:validTime(at)?at:null,
   last_command:attributed?data.setup_activity_last_command:null,
   route:attributed?data.setup_activity_route:null,
   ...(validTime(data.setup_activity_finished_at)?{finished_at:data.setup_activity_finished_at}:{})
  };
 }
}
