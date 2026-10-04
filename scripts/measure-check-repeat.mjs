// M6 step 1: whether one check leaves memory behind. Checks the same file n times in one process and records the heap
// after a full collection each time. A heap that grows with the number of checks of one unchanged file is memory each
// check keeps; a flat heap means the growth over many different files is what they leave, not what checking does.
//
// Usage: node --expose-gc scripts/measure-check-repeat.mjs <file.poly> <n> <out.ndjson>
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile } from '@poly/check';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const [file, nText, out] = process.argv.slice(2);
const n = Number(nText);
if (!file || !out || !Number.isInteger(n) || n < 1 || typeof globalThis.gc !== 'function') { console.error('usage: node --expose-gc scripts/measure-check-repeat.mjs <file.poly> <n> <out.ndjson>'); process.exit(64); }
writeFileSync(out, '');
const mb = (x) => Math.round((x / 1048576) * 10) / 10;
for (let i = 0; i <= n; i++) {
  if (i > 0) await checkFile(file, { root: join(ROOT, '.poly', 'test-build', 'repeat') });
  gc();
  const m = process.memoryUsage();
  appendFileSync(out, JSON.stringify({ i, heapMB: mb(m.heapUsed), rssMB: mb(m.rss) }) + '\n');
}
