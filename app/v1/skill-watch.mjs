import fs from 'node:fs';import path from 'node:path';
/** Never watch the user's HOME to discover .codex. Missing roots use a slow stat. */
export function createSkillWatch({codexHome,onChange=()=>{},io=fs,clock={setTimeout,clearTimeout}}){
 const file=path.join(codexHome,'skills/chathand-setup/SKILL.md');let active=false,watchers=[],timer=null;
 const clear=()=>{if(timer!==null)clock.clearTimeout(timer);timer=null;for(const w of watchers)w.close();watchers=[];};
 function rebuild(){
  clear();if(!active)return;
  let exists=false;try{exists=io.statSync(codexHome).isDirectory();}catch{}
  if(!exists){timer=clock.setTimeout(()=>{timer=null;if(!active)return;onChange(file);rebuild();},60000);timer?.unref?.();return;}
  const changed=()=>{if(!active||timer!==null)return;timer=clock.setTimeout(()=>{timer=null;if(!active)return;onChange(file);rebuild();},100);timer?.unref?.();};
  for(const [dir,names] of [[codexHome,['skills']],[path.join(codexHome,'skills'),['chathand-setup']],[path.dirname(file),['SKILL.md']]]){
   try{const w=io.watch(dir,(_kind,name)=>{if(!name||names.includes(String(name))||_kind==='rename'&&String(name)===path.basename(dir))changed();});w.on?.('error',changed);w.unref?.();watchers.push(w);}catch{}
  }
 }
 return {start(){if(!active){active=true;rebuild();}},stop(){active=false;clear();},refresh(){if(active){onChange(file);rebuild();}},status:()=>({active,watchers:watchers.length,timers:Number(timer!==null)})};
}
