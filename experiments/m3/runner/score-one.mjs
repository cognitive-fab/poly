// Scores one delivered implementation of one task version with O3 and O2 (PT13), in its own process so that
// an implementation that hangs or crashes cannot take the scorer with it. Prints one JSON line.
//
// Usage: node score-one.mjs <task> <version> <implementation module>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, readO3, versions } from '../lib/task.mjs';
import { replay } from '../lib/o3.mjs';

const [task, n, impl] = process.argv.slice(2);
const v = versions(task)[Number(n)];
const spec = readJson(join(v.dir, 'explore.json'));
const o3 = readO3(v);
const o2 = (await import(pathToFileURL(join(v.dir, 'o2.mjs')).href)).default;
let createHost;
try {
  createHost = (await import(pathToFileURL(impl).href)).default;
} catch (e) {
  console.log(JSON.stringify({ loaded: false, error: String(e?.message ?? e) }));
  process.exit(0);
}
const r = await replay(createHost, o3, o2, spec);
const o3Failed = new Set(r.failures.filter((f) => f.kind === 'o3').map((f) => f.trace));
const o2Violated = [...new Set(r.failures.filter((f) => f.kind === 'o2').map((f) => f.property))].sort();
console.log(JSON.stringify({ loaded: true, o3: { traces: r.traces, failed: o3Failed.size }, o2: { properties: o2.length, violated: o2Violated } }));
