import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** Refresh only this installed bundle after its build changes, regardless of install method. */
export async function refreshStartupIcon({appPath, build, previousBuild, platform = process.platform,
  run = execute, remember = () => {}, record = () => {}}) {
  if (platform !== 'darwin' || !Number.isSafeInteger(build) || build < 1 || previousBuild === build)
    return {refreshed: false, reason: 'unchanged_or_unsupported'};
  if (typeof appPath !== 'string' || !path.isAbsolute(appPath) || path.basename(appPath) !== 'ChatHand.app')
    return {refreshed: false, reason: 'not_application'};
  try {
    const stat = fs.lstatSync(appPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return {refreshed: false, reason: 'not_application'};
  } catch { return {refreshed: false, reason: 'not_application'}; }
  for (const [program, args, code] of [
    ['/usr/bin/touch', [appPath], 'UPGRADE_ICON_TOUCH_FAILED'],
    [REGISTER, ['-f', appPath], 'UPGRADE_ICON_REGISTER_FAILED'],
  ]) {
    try {
      const result = await run(program, args, {timeout: 3000, maxBuffer: 4096});
      if (result?.status !== undefined && result.status !== 0) throw Error(code);
    } catch {
      record(code);
      return {refreshed: false, code};
    }
  }
  remember(build);
  return {refreshed: true, build};
}
