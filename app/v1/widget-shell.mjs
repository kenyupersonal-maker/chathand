import {cardText} from '../i18n.mjs';
// Additive data protocol for the fixed offline shell. Rich task data stays in _meta.
export const widgetShellPresentation=(name,result,hostLocale)=>({protocol:1,task_card_meta_key:'chathand/task_card',i18n:cardText(hostLocale),density:name==='task_checkpoint'?'compact':'comfortable',sections:[],...(result?.status==='failed'?{accent:'#B4600B'}:{})});
