import os from 'node:os';import path from 'node:path';
/** Current storage is independent of the product version. */
export function dataDirectory(home=os.homedir()){return path.join(home,'Library','Application Support','ChatHand','data');}
export function upgradeHome(home=os.homedir()){return path.join(home,'Library','Application Support','ChatHand','upgrades');}
