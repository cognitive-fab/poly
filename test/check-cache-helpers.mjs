// PT14a: shared by the cache, goals and defects tests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

/** A report as JSON with what may differ between a cached and an uncached check removed: timings, roots, cache notes. */
export function comparable(report) {
  return JSON.parse(JSON.stringify(report, (k, v) => {
    if (k === 'ms' || k === 'cache' || k === 'buildDir') return undefined;
    if (k === 'note' && typeof v === 'string') return v.replace(/;? ?from the cache, key sha256:[0-9a-f]+/, '') || undefined;
    return v;
  }));
}

/**
 * Checks a file with no cache, then cold (filling a fresh cache), then warm (reading it), and requires the three
 * reports to agree; on the warm run a program stage 0 accepts reads every unit it caches back. Each report is reduced
 * to its comparable JSON at once, so a large example holds one report in memory at a time.
 */
export async function sweep(file) {
  const name = relative(ROOT, file);
  const dir = mkdtempSync(join(tmpdir(), 'poly-cache-sweep-'));
  try {
    const none = comparable(await checkFile(file, { root: join(dir, 'none') }));
    const cold = comparable(await checkFile(file, { root: join(dir, 'cold'), cache: join(dir, 'cache') }));
    assert.deepEqual(cold, none, `${name}: cold and no cache differ`);
    const warm = await checkFile(file, { root: join(dir, 'warm'), cache: join(dir, 'cache') });
    if (none.verdict !== 'REFUSED' && none.verdict !== 'ERROR') {
      const units = [...warm.machines, ...warm.configurations];
      for (const u of units) if (u.cache) assert.equal(u.cache.hit, true, `${name}: ${u.machine ?? u.configuration} was not read from the cache`);
      assert.ok(units.some((u) => u.cache?.hit), `${name}: nothing was read from the cache`);
    }
    assert.deepEqual(comparable(warm), none, `${name}: warm and no cache differ`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
