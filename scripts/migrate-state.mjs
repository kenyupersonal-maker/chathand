import {assertDesktopDataCompatibility} from '../app/v1/data-compatibility.mjs';
import {dataDirectory} from '../app/v07/paths.mjs';

try {
 const override=Object.hasOwn(process.env,'CHATHAND_STATE_DIR')?process.env.CHATHAND_STATE_DIR:Object.hasOwn(process.env,'KEN_BRIDGE_STATE_DIR')?process.env.KEN_BRIDGE_STATE_DIR:null;
 const stateDir=override===null?dataDirectory():override;
 assertDesktopDataCompatibility(stateDir);
 console.log(JSON.stringify({compatible:true}));
} catch (error) {
 if(error?.code==='DATA_FORMAT_NEWER'||error?.code==='DATA_FORMAT_UNSUPPORTED'){
  console.error(error.code);
  process.exitCode=error.code==='DATA_FORMAT_NEWER'?73:74;
 } else {
  console.error('STARTUP_CHECK_FAILED');
  process.exitCode=1;
 }
}
