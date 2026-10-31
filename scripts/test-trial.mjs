/** Compatibility entry point for the declared Node source suites. */
import {runNodeTests} from './test-node.mjs';
try { process.exitCode = runNodeTests(['--test-reporter=tap', '--test-timeout=120000', ...process.argv.slice(2)]); }
catch (error) { console.error(error.message); process.exitCode = 1; }
