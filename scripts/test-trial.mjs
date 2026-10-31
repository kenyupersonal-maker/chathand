/** Preserve the historical trial suite and its top-level v1 modules. */
import {runNodeTests} from './test-node.mjs';
try { process.exitCode = runNodeTests(['--entry-point=trial', '--test-reporter=tap', '--test-timeout=120000', ...process.argv.slice(2)]); }
catch (error) { console.error(error.message); process.exitCode = 1; }
