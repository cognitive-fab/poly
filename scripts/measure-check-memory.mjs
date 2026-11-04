// M6 step 1: memory per file checked, in one long process (the M5 finding: one process grew to 2.9 GB while checking
// 1,438 files in a row). Checks every .poly source the standing test walked before S163, M3 runs included, in the same
// order and in one process, and records after each file the heap after a full collection and the resident set. A heap
// that still grows after collection, file after file, is a leak; a resident set that grows while the collected heap
// does not is memory the runtime keeps but does not hold live.
//
// Usage: node --expose-gc scripts/measure-check-memory.mjs <out.ndjson> [limit]
import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile } from '@poly/check';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const NOT_SOURCES = new Set(['node_modules', '.poly', '.git']);
const sources = (dir) => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  if (NOT_SOURCES.has(e)) return [];
  return statSync(p).isDirectory() ? sources(p) : p.endsWith('.poly') ? [p] : [];
}).sort();
const ALL = ['examples', 'conformance', join('test', 'fixtures'), 'experiments', join('packages', 'poly-runtime', 'model')].flatMap((d) => sources(join(ROOT, d)));

const out = process.argv[2];
const limit = Number(process.argv[3] ?? ALL.length);
// A limit that is not a positive integer would measure nothing and exit 0 (polywatch): it is a usage error.
if (!out || typeof globalThis.gc !== 'function' || !Number.isInteger(limit) || limit < 1) { console.error('usage: node --expose-gc scripts/measure-check-memory.mjs <out.ndjson> [limit]'); process.exit(64); }
writeFileSync(out, '');
const mb = (n) => Math.round(n / 1048576);
gc();
appendFileSync(out, JSON.stringify({ n: 0, heapMB: mb(process.memoryUsage().heapUsed), rssMB: mb(process.memoryUsage().rss) }) + '\n');
for (let i = 0; i < Math.min(limit, ALL.length); i++) {
  const f = ALL[i];
  const t0 = performance.now();
  let verdict;
  try { verdict = (await checkFile(f, { root: join(ROOT, '.poly', 'test-build', 'memory') })).verdict; } catch (e) { verdict = `threw: ${e.message}`; }
  const ms = Math.round(performance.now() - t0);
  gc();
  const m = process.memoryUsage();
  appendFileSync(out, JSON.stringify({ n: i + 1, file: relative(ROOT, f).split('\\').join('/'), ms, verdict, heapMB: mb(m.heapUsed), externalMB: mb(m.external), rssMB: mb(m.rss) }) + '\n');
}
