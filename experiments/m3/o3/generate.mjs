// Generates O3 for every version of the given tasks (all when none is given) from each version's reference
// (PT13, S92): o3/traces.json, deterministic, so its digest is stable. A bounded exploration is written with
// `bounded: true` and reported, never passed off as complete.
//
// Usage: node experiments/m3/o3/generate.mjs [T1 T2 ...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { explore, pack } from '../lib/o3.mjs';
import { adapterOf, readJson, taskIds, versions } from '../lib/task.mjs';

export async function generateO3(version) {
  const spec = readJson(join(version.dir, 'explore.json'));
  const createHost = await adapterOf(version, 'reference');
  const r = await explore(createHost, spec);
  mkdirSync(join(version.dir, 'o3'), { recursive: true });
  writeFileSync(join(version.dir, 'o3', 'traces.json'), JSON.stringify({ task: version.task, version: version.n, states: r.states, bounded: r.bounded, ...pack(r.traces) }) + '\n');
  return r;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : taskIds();
  let bounded = false;
  for (const id of ids) {
    for (const v of versions(id)) {
      const r = await generateO3(v);
      bounded ||= r.bounded;
      console.log(`${id} v${v.n}: ${r.states} observed states, ${r.traces.length} traces${r.bounded ? ', BOUNDED' : ''}`);
    }
  }
  if (bounded) process.exitCode = 3;
}
