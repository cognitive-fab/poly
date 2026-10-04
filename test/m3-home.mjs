// A stand-in home for a test file that loads the M3 runner. The runner reads its arms' folder from the home directory
// when it is imported (isolation.mjs, ARM_CONFIG_DIR), so a test file imports this module first: the home is then a
// folder the test creates, and no test reads the owner's ~/.poly-m3/claude, whatever it holds. Spawned processes
// inherit it. The folder is removed when the process exits.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const STAND_IN_HOME = mkdtempSync(join(tmpdir(), 'poly-m3-home-'));
process.env.HOME = STAND_IN_HOME;
process.env.USERPROFILE = STAND_IN_HOME;
process.on('exit', () => rmSync(STAND_IN_HOME, { recursive: true, force: true }));
