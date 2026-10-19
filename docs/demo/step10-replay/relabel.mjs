// Recomputes the labels of the replay from the recorded logs (docs/demo/step10-replay.md, DB6 item 9): it calls the corrected classify() on the control and the
// fault run that the driver recorded, and prints the label the driver printed beside the recomputed one. It runs nothing against a build and starts no container.
// Usage: node docs/demo/step10-replay/relabel.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../../../demo/driver/replay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rows = [];
for (const [pass, dir] of [['first pass', HERE], ['second pass', join(HERE, 'second-pass')]]) {
  for (const run of ['ts-kept', 'poly-kept', 'ts-pilot-2', 'poly-pilot-3']) {
    const log = JSON.parse(readFileSync(join(dir, `${run}.json`), 'utf8'));
    const now = classify(log.control, log.run);
    rows.push({ pass, run, printed: log.outcome, recomputed: now.outcome, reason: now.reason, amount: now.amount ?? null });
  }
}
console.log(JSON.stringify(rows, null, 2));
