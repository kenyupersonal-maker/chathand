/** Shared failure recognition and budgets, extracted from app/v1/output-digest.mjs.
 * Pure text selection only: no files, commands, persistence or permissions.
 */
export const MAX_BLOCKS=12,MAX_BLOCK_LINES=25,MAX_FAILURE_CHARS=4000;
const indent=line=>(String(line).match(/^\s*/)?.[0].length||0);

export function failureRanges(lines){
 const ranges=[];
 for(let i=0;i<lines.length&&ranges.length<MAX_BLOCKS;i++){
  const line=lines[i],base=indent(line);
  if(/^\s*✖/.test(line)){
   let end=i;
   for(let j=i+1;j<lines.length&&j<i+MAX_BLOCK_LINES;j++){if(!lines[j].trim()||indent(lines[j])>base)end=j;else break;}
   ranges.push([i,end]);i=end;continue;
  }
  if(/^\s*Failed tests:\s*$/.test(line)){
   ranges.push([i,Math.min(lines.length-1,i+MAX_BLOCK_LINES-1)]);i=ranges.at(-1)[1];continue;
  }
 }
 if(ranges.length)return ranges;
 for(let i=0;i<lines.length&&ranges.length<MAX_BLOCKS;i++){
  const line=lines[i],base=indent(line);
  if(/^\s*not ok\s+\d+\s+-/i.test(line)){
   let end=i;
   for(let j=i+1;j<lines.length&&j<i+MAX_BLOCK_LINES;j++){const t=lines[j].trim();if(t==='...'){end=j;break;}if(!t||indent(lines[j])>base)end=j;else break;}
   ranges.push([i,end]);i=end;
  }
 }
 if(ranges.length)return ranges;
 const err=/Error|ERR_|AssertionError|FAIL|failed|error:/i;
 for(let i=0;i<lines.length&&ranges.length<MAX_BLOCKS;i++)if(err.test(lines[i])){ranges.push([i,Math.min(lines.length-1,i+2)]);i+=2;}
 return ranges;
}

/** The shared budget matches the original digest's 12 blocks / 25 lines /
 * 4,000 JavaScript characters. Retention byte accounting is separately UTF-8.
 * Callers supply one shared budget across whichever streams they inspect.
 */
export function selectFailureLines(lines,budget={blocks:0,chars:0}){
 const indices=new Set();let blocks=0;
 for(const [a,b] of failureRanges(lines)){
  if(budget.blocks>=MAX_BLOCKS||budget.chars>=MAX_FAILURE_CHARS)break;
  let used=0,added=false;
  for(let i=a;i<=b&&used<MAX_BLOCK_LINES;i++,used++){
   const chars=lines[i].length+1;if(budget.chars+chars>MAX_FAILURE_CHARS)break;
   indices.add(i);budget.chars+=chars;added=true;
  }
  if(added){blocks++;budget.blocks++;}
 }
 return {indices,blocks};
}
