// DF27 items 3 and 11: runs one `node --test` command with one new POLY_TEST_RUN, so every test file it starts shares the
// demo's admissions. The runner of node --test does not load the suite's preload (measured on Node 24.12.0), so the id
// must be set before it starts. The id is always new: a command started inside a run must neither use nor remove that
// run's store. Before the command, stores older than seven days are removed; after it, this run's store, with its count.
//
//   node scripts/test-run.mjs node --import ./test/fixtures/home-guard.mjs --test ...
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { endRun, sweepStores } from '../demo/host/admission-store.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/test-run.mjs <command> [args...]');
  process.exit(2);
}
const run = randomUUID();
sweepStores();
const r = spawnSync(command === 'node' ? process.execPath : command, args, { stdio: 'inherit', env: { ...process.env, POLY_TEST_RUN: run } });
console.log(`poly-demo-admissions: run ${run}, ${endRun({ run })} admissions`);
if (r.error) console.error(r.error.message);
process.exit(typeof r.status === 'number' ? r.status : 1);
