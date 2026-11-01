// Fake-only differential reference: the 1049 redactor before the linear scanner.
export function redact1049(text) {
 return String(text).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[REDACTED_KEY]').replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+\b/g,'[REDACTED_KEY]').replace(/(Bearer\s+)[^\s"']+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|token|password|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,;"']+/gi,'$1[REDACTED]');
}
const names=['DB_PASSWORD','PGPASSWORD','HF_TOKEN','GITHUB_TOKEN','access_token','refresh_token','accessToken','csrftoken'];
export const redactionCorpus=[];
function add(kind,input,value,hidden=true){redactionCorpus.push({id:redactionCorpus.length+1,kind,input,value,hidden});}
for(const name of names)for(const key of [name,name.toLowerCase(),name.toUpperCase()])for(const form of ['shell','json','colon']){
 const value='FAKE-SECRET-'+String(redactionCorpus.length+1).padStart(4,'0');
 add(form,form==='shell'?`${key}=${value}\n`:form==='json'?`{"${key}": "${value}"}\n`:`${key}: '${value}'\n`,value);
}
add('long-line','GITHUB_TOKEN'+' '.repeat(100000)+'=FAKE-SECRET-0073\n','FAKE-SECRET-0073');
add('split-secret','accessToken: FAKE-SECRET-0074\n','FAKE-SECRET-0074');
add('negative','tokenized=FAKE-SECRET-0075\n','FAKE-SECRET-0075',false);
add('negative','ordinary=FAKE-SECRET-0076\n','FAKE-SECRET-0076',false);
for(const [kind,input,value] of [['bearer','Bearer FAKE-SECRET-0077','FAKE-SECRET-0077'],['openai','sk-FAKE_SECRET_0078','sk-FAKE_SECRET_0078'],['github','ghp_FAKE_SECRET_0079','ghp_FAKE_SECRET_0079'],['assignment','service_api-key=FAKE-SECRET-0080','FAKE-SECRET-0080']])add(kind,input,value);
export function differential(redact){
 const rows=redactionCorpus.map(({id,kind,input,value,hidden})=>({id,kind,expected_hidden:hidden,old_hidden:!redact1049(input).includes(value),new_hidden:!redact(input).includes(value)}));
 return {count:rows.length,old_hidden:rows.filter(r=>r.old_hidden).length,regressions:rows.filter(r=>r.old_hidden&&!r.new_hidden),newly_hidden:rows.filter(r=>!r.old_hidden&&r.new_hidden),rows};
}
