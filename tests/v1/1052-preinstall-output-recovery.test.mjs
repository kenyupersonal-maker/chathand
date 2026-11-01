import test from 'node:test';import assert from 'node:assert/strict';import {errorRecovery} from '../../app/v1/workflow.mjs';
export const spoolRecoveryCodes=['FULL_OUTPUT_UNAVAILABLE','OUTPUT_SPOOL_CURSOR','OUTPUT_SPOOL_CURSOR_EXPIRED','OUTPUT_SPOOL_CURSOR_BOUNDARY','OUTPUT_SPOOL_ENVELOPE_BUDGET','OUTPUT_SPOOL_WRITE_FAILED','OUTPUT_SPOOL_INTEGRITY','OUTPUT_SPOOL_CLOSED','OUTPUT_SPOOL_CLEANED','OUTPUT_SPOOL_SCOPE','OUTPUT_SPOOL_CONFIG','OUTPUT_SPOOL_CREATE_FAILED','OUTPUT_SPOOL_REDACTOR','OUTPUT_SPOOL_STATE','OUTPUT_SPOOL_UNSAFE'];
test('preinstall19 archive failures guide bounded reads or ordinary fallback without rerunning work',()=>{
 for(const code of spoolRecoveryCodes){const r=errorRecovery(code);assert.equal(r.create_new_task,false);assert.equal(r.automatic_retry,false);
  if(code==='FULL_OUTPUT_UNAVAILABLE'){assert.equal(r.next_action,'continue_with_ordinary_output');assert.equal(r.memory_complete_action,'use_integer_cursor_pages');}
  else if(['OUTPUT_SPOOL_CURSOR','OUTPUT_SPOOL_CURSOR_EXPIRED','OUTPUT_SPOOL_CURSOR_BOUNDARY','OUTPUT_SPOOL_ENVELOPE_BUDGET'].includes(code)){assert.equal(r.next_action,'reread_first_or_last_good_full_cursor_once_then_continue_with_ordinary_output');assert.equal(r.read_retry_limit,1);}
  else if(['OUTPUT_SPOOL_WRITE_FAILED','OUTPUT_SPOOL_INTEGRITY','OUTPUT_SPOOL_CLOSED','OUTPUT_SPOOL_CLEANED'].includes(code))assert.equal(r.next_action,'stop_full_reads_and_continue_with_ordinary_output');
  else assert.equal(r.next_action,'stop_and_report');
  if(r.next_action!=='stop_and_report')assert.equal(r.rerun_command,false);
 }
});
