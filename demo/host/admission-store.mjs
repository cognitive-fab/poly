// DF27 items 5 and 11: where the demo's shared admissions are kept, and when they are removed. It imports nothing from
// @poly/*, so scripts/test-run.mjs can load it before anything is built.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** DF27 item 5: outside the repository, since the store holds the run's keys. */
export const storeRoot = () => join(tmpdir(), 'poly-demo-admissions');

/** DF27 item 5: one folder per run, one per key inside it. */
export const storeDir = (key, run = process.env.POLY_TEST_RUN, root = storeRoot()) => join(root, run, key);

/** DF27 item 5: a store folder is read only once ready.json, written last, says it is whole. */
export const storedAdmission = (key, run = process.env.POLY_TEST_RUN, root = storeRoot()) =>
  (existsSync(join(storeDir(key, run, root), 'ready.json')) ? storeDir(key, run, root) : null);

/**
 * DF27 item 5: moves a staged admission into place. On Windows a rename onto a folder that exists fails with EPERM
 * (measured 2026-10-31) instead of replacing it; the folder that won the race is used if it is whole.
 */
export function settle(staging, target) {
  try {
    renameSync(staging, target);
  } catch (e) {
    if (!existsSync(join(target, 'ready.json'))) throw e;
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

/** DF27 item 11: the number of whole admissions in one run's folder, which is then removed with its staging folders. */
export function endRun({ run, root = storeRoot() }) {
  const dir = join(root, run);
  if (!existsSync(dir)) return 0;
  const n = readdirSync(dir).filter((e) => !e.startsWith('.staging-') && existsSync(join(dir, e, 'ready.json'))).length;
  rmSync(dir, { recursive: true, force: true });
  return n;
}

/** DF27 item 11: every entry under the root last changed more than `maxAgeMs` before `now`; no run lasts seven days. */
export function sweepStores({ root = storeRoot(), now = Date.now(), maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
  if (!existsSync(root)) return [];
  const removed = [];
  for (const e of readdirSync(root)) {
    const p = join(root, e);
    const mtime = statSync(p, { throwIfNoEntry: false })?.mtimeMs;
    if (mtime === undefined || now - mtime <= maxAgeMs) continue;
    rmSync(p, { recursive: true, force: true });
    removed.push(e);
  }
  return removed;
}
