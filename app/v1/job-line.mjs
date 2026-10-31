export function lastOutputLine(events){
 if(!Array.isArray(events))return '';
 const parts=[];let remaining=4096;
 for(let i=events.length-1;i>=0&&remaining>0;i--){
  if(!['stdout','stderr'].includes(events[i]?.stream)||typeof events[i]?.text!=='string')continue;
  const bytes=Buffer.from(events[i].text);const tail=bytes.subarray(Math.max(0,bytes.length-remaining));parts.unshift(tail);remaining-=tail.length;
 }
 const text=Buffer.concat(parts).toString('utf8')
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/\x1b[ -/]*[@-~]/g,'')
  .replace(/\r\n/g,'\n').replace(/\r/g,'\n')
  .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,'');
 const line=text.split('\n').map(s=>s.trim()).filter(Boolean).at(-1)||'';
 const chars=Array.from(line);return chars.length>120?chars.slice(0,119).join('')+'…':line;
}
