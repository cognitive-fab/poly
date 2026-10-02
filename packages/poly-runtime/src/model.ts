// The OutboxIntent model (PT9.7, S119, S120): its source, its instance for a retry bound, and the lowered builds
// the worker hosts. The source is the PT9.7 machine with maxAttempts 3. The instance for a bound m replaces the
// three ranges and the two tests that state the bound, and names its module `runtime<m>` (the spec's own module
// `runtime` for 3), so the instances can be registered side by side. The lowered builds are checked in under
// model/build; the runtime reads them only after their digests match model/build/MANIFEST.json, and the
// runtime's CI lowers them again from this text and requires the same bytes (the standing rule).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256OfBytes } from '@poly/core';

export const MODEL_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'model');
export const MODEL_SOURCE = join(MODEL_DIR, 'outbox-intent.poly');
export const MODEL_BUILD = join(MODEL_DIR, 'build');
/** S120, S137: admission refuses a maxAttempts above 10, so these are every bound a build can declare. */
export const BOUNDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const MODEL_FILES = ['contract.json', 'next.cjs', 'invariants.mjs', 'liveness.mjs'] as const;

export const moduleOfBound = (m: number): string => (m === 3 ? 'runtime' : `runtime${m}`);
export const machineOfBound = (m: number): string => `${moduleOfBound(m)}.OutboxIntent`;

/** The PT9.7 text with its bound replaced. */
export function modelSource(m: number, text = readFileSync(MODEL_SOURCE, 'utf8')): string {
  if (!Number.isInteger(m) || m < 1) throw new Error(`a retry bound is a positive integer, not ${m}`);
  // Each text that states the bound, and how many times the source states it (S147 added the rechecks, whose own
  // bound of 2 is not the retry bound and is not replaced).
  const swaps: [string, string, number][] = [
    ['module runtime\n', `module ${moduleOfBound(m)}\n`, 1],
    ['attempts: 0..2,', `attempts: 0..${m - 1},`, 3],
    ['attempt: 1..3,', `attempt: 1..${m},`, 2],
    ['if n < 3 {', `if n < ${m} {`, 2],
  ];
  let out = text;
  for (const [a, b, times] of swaps) {
    if (out.split(a).length !== times + 1) throw new Error(`the OutboxIntent source no longer states "${a.trim()}" ${times} time(s)`);
    out = out.split(a).join(b);
  }
  return out;
}

export interface ModelBuild { machineId: string; dir: string; module: string; contract: string }

/** The checked-in lowered builds, after their bytes match the manifest; a mismatch refuses the runtime. */
export function verifiedModels(bounds: readonly number[]): ModelBuild[] {
  const manifestPath = join(MODEL_BUILD, 'MANIFEST.json');
  if (!existsSync(manifestPath)) throw new Error('the OutboxIntent builds have no MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>;
  return [...new Set(bounds)].sort((x, y) => x - y).map((m) => {
    if (!BOUNDS.includes(m as 1)) throw new Error(`no OutboxIntent build for maxAttempts ${m}; at most 10 (S120, S137)`);
    const dir = join(MODEL_BUILD, machineOfBound(m));
    for (const f of MODEL_FILES) {
      const rel = `${machineOfBound(m)}/${f}`;
      const p = join(dir, f);
      if (!existsSync(p)) throw new Error(`the OutboxIntent build ${rel} is missing`);
      const have = sha256OfBytes(readFileSync(p));
      if (have !== manifest[rel]) throw new Error(`the OutboxIntent build ${rel} does not match its manifest (recorded ${manifest[rel]}, found ${have})`);
    }
    return { machineId: machineOfBound(m), dir, module: join(dir, 'next.cjs'), contract: join(dir, 'contract.json') };
  });
}
