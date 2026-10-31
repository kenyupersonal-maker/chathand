// 1052 A3: fixed engineering defaults. Model/trial behavior is wired by A4.
export const PACING = Object.freeze({
 block: Object.freeze({fine:Object.freeze({calls:10,ms:150000}),medium:Object.freeze({calls:20,ms:270000}),coarse:Object.freeze({calls:40,ms:540000})}),
 wait: Object.freeze({poll_ms:20000,note_ms:300000,ready_after_end_ms:5000}),
 return_limit_chars:12000,
 stall:Object.freeze({cap_ms:600000,floor_pro_ms:360000}),
 auto:Object.freeze({per_task:5,per_block:2,countdown_ms:20000}),
});
// This accepts only a classified model, never stores the original model string.
// A4 will pass the per-task classification; A3 callers retain the original floor.
export function stallBudget(ms,model='unknown'){
 return Math.min(PACING.stall.cap_ms,Math.max(ms,model==='pro'?PACING.stall.floor_pro_ms:0));
}
