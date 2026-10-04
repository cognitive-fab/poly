// Post hoc, not pre-registered: percentile bootstrap intervals for the mean per-task difference of each comparison
// PT13 makes (arms 3 and 4 against arms 1 and 2, arm 4 against arm 3), on the two co-primary measures. PT13 asks for
// intervals when the result is between the rules, and the frozen analyse.mjs computes none (owner, after cd09bcc).
// The per-task values are the frozen script's own (perTask); this file only resamples them. The ten tasks are
// resampled with replacement, 10,000 times, with a fixed seed, so the intervals reproduce exactly.
//
// Usage: node experiments/m3/posthoc/bootstrap.mjs [runs dir]
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPARISONS, loadRecords, perTask } from '../analysis/analyse.mjs';

export const RESAMPLES = 10_000;
export const SEED = 20261004;

/** mulberry32: a small seeded generator, so the resamples are the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The mean per-task difference (arm a minus arm b) and its 95% percentile bootstrap interval over the tasks. */
export function interval(diffs, { resamples = RESAMPLES, seed = SEED } = {}) {
  const next = rng(seed);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const means = [];
  for (let i = 0; i < resamples; i++) means.push(mean(diffs.map(() => diffs[Math.floor(next() * diffs.length)])));
  means.sort((x, y) => x - y);
  return { tasks: diffs.length, mean: mean(diffs), low: means[Math.floor(0.025 * resamples)], high: means[Math.ceil(0.975 * resamples) - 1] };
}

export function intervals(table) {
  const out = {};
  for (const measure of ['escapedPerDelivered', 'tokensPerDelivered']) {
    out[measure] = COMPARISONS.map(([a, b]) => {
      const tasks = Object.keys(table[a]).filter((t) => table[a][t][measure] != null && table[b]?.[t]?.[measure] != null).sort();
      return { arms: [a, b], ...interval(tasks.map((t) => table[a][t][measure] - table[b][t][measure])) };
    });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'runs');
  const r = intervals(perTask(loadRecords(dir)));
  console.log(JSON.stringify({ resamples: RESAMPLES, seed: SEED, ...r }, null, 2));
}
