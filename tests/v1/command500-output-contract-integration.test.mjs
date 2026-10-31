// Narrow description/prompt integration only. No processes, runtime state or core regression reruns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {TOOLS} from '../../app/tools.mjs';


const tool=name=>{const value=TOOLS.find(item=>item.name===name);assert.ok(value,name);return value;};
const frozen=JSON.parse(fs.readFileSync(new URL('../../contracts/tools-v31.json',import.meta.url),'utf8'));
for(const name of ['propose_command','command_result','list_commands'])assert.deepEqual(tool(name),frozen.find(t=>t.name===name),'API31 stays frozen: '+name);
const noLostFullPromise=text=>assert.doesNotMatch(text,/拿全文|for the complete output|for the full output/i);

test('command500 integration: command description retains platform/grant rules and distinguishes captured pages from UI retention',()=>{
 const text=tool('propose_command').description;
 for(const part of ['under an active task','Read bridge_info first','Windows requires full access',
  'packaged Job Object helper','pty=false','Preserve request_id','stop services before finishing',
  'command_result(full:true)','查询原job','不为找回输出重新执行'])assert.ok(text.includes(part),part);
 noLostFullPromise(text);
});

test('command500 integration: full remains boolean and pages captured originals without recovering legacy missing output',()=>{
 const full=tool('command_result').inputSchema.properties.full;
 assert.equal(full.type,'boolean');
 assert.deepEqual(Object.keys(full).sort(),['description','type']);
 for(const part of ['不摘要','稳定位置分页','不是一次给全','next_full_cursor'])assert.ok(full.description.includes(part),part);
 noLostFullPromise(full.description);
});

test('command500 integration: result describes sparse/partial cursor loss without changing wait or turn rules',()=>{
 const text=tool('command_result').description;
 for(const part of ['wait_ms up to 20s','Outputs do not automatically create a new ChatGPT turn',
  'output_reduced','output_retention','cursor_gap','cursor_gaps','partial_event_cursors',
  '上一next_cursor','保留原游标编号','不重新执行'])assert.ok(text.includes(part),part);
 noLostFullPromise(text);
});

test('command500 integration: desktop list explains retained finished records, no output and restart boundary',()=>{
 const value=tool('list_commands'),text=value.description;
 assert.equal(value.annotations.readOnlyHint,true);
 for(const part of ['含仍保留的已结束记录','不含输出',
  '重启后完整恢复','this connector','not a list of all system processes'])assert.ok(text.includes(part),part);
 assert.doesNotMatch(text,/List up to 50 newest jobs/);
});
