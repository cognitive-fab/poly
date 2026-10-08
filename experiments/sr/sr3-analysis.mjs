// SR-AC3: the analysis of SR3, fixed before its runs (proposals/experiment-strict-rerun.md, SR3). It reads the scored
// SR3 records and M3's records of the same 20 cells (T3 and T7, arms 3 and 4, runs 1 to 5) and reports:
//
//   - the primary measure: runs with at least one escaped O1 defect, SR3 against M3, by a one-sided Fisher exact test
//     at 0.05 (H1: SR3 has fewer). Zero of 20 against 5 of 20 gives p = 0.024; one of 20 gives p = 0.09, reported as
//     not significant;
//   - beside it, per arm and task, escaped defects per delivered run, admitted runs and tokens per delivered run, with
//     M3's values for the same cells, by M3's own measures (experiments/m3/analysis/analyse.mjs).
//
// A run that is not scored (unscored, or no scores) is listed and left out of every count; nothing is imputed.
//
// Usage: node experiments/sr/sr3-analysis.mjs <SR3 runs dir> <M3 runs dir> [--json out.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { perTask, runMeasures } from '../m3/analysis/analyse.mjs';

export const CELLS = ['T3', 'T7'].flatMap((task) => [3, 4].flatMap((arm) => [1, 2, 3, 4, 5].map((run) => ({ task, arm, run }))));
const id = (c) => `${c.task}-arm${c.arm}-run${c.run}`;

const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

/**
 * One-sided Fisher exact test on a 2x2 table: `a` of `n1` in the first group and `b` of `n2` in the second have the
 * event. H1: the first group's proportion is lower. p = P(X <= a) under the hypergeometric law with the margins fixed.
 */
export function fisherLess(a, n1, b, n2) {
  const k = a + b;
  const n = n1 + n2;
  let p = 0;
  for (let x = Math.max(0, k - n2); x <= Math.min(a, k); x++) p += (choose(n1, x) * choose(n2, k - x)) / choose(n, k);
  return Math.min(1, p);
}

function records(dir) {
  const out = new Map();
  for (const c of CELLS) {
    const f = join(dir, id(c), 'run.json');
    out.set(id(c), existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
  }
  return out;
}

export function analyseSr3(srDir, m3Dir, alpha = 0.05) {
  const side = (dir) => {
    const recs = records(dir);
    const scored = [...recs.values()].filter((r) => r && !r.unscored && r.scores);
    const notScored = [...recs.entries()].filter(([, r]) => !r || r.unscored || !r.scores).map(([k, r]) => `${k}: ${!r ? 'no record' : r.unscored ? `unscored (${r.unscored})` : 'not scored'}`);
    const measures = scored.map((r) => ({ id: `${r.task}-arm${r.arm}-run${r.run}`, ...runMeasures(r) }));
    const withDefects = measures.filter((m) => (m.escaped ?? 0) > 0).map((m) => m.id);
    return { runs: scored.length, notScored, withDefects, admitted: measures.filter((m) => m.admitted).length, delivered: measures.filter((m) => m.delivered).length, table: perTask(scored) };
  };
  const sr3 = side(srDir);
  const m3 = side(m3Dir);
  const p = fisherLess(sr3.withDefects.length, sr3.runs, m3.withDefects.length, m3.runs);
  return { primary: { sr3: `${sr3.withDefects.length} of ${sr3.runs}`, m3: `${m3.withDefects.length} of ${m3.runs}`, p, significant: p < alpha, alpha }, sr3, m3 };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [srDir, m3Dir] = process.argv.slice(2);
  if (!srDir || !m3Dir) { console.error('usage: sr3-analysis.mjs <SR3 runs dir> <M3 runs dir> [--json out.json]'); process.exit(64); }
  const a = analyseSr3(srDir, m3Dir);
  const i = process.argv.indexOf('--json');
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(a, null, 2) + '\n');
  console.log(`runs with at least one escaped O1 defect: SR3 ${a.primary.sr3}, M3 ${a.primary.m3}; one-sided Fisher p = ${a.primary.p.toFixed(4)}${a.primary.significant ? ' (significant at 0.05)' : ' (not significant at 0.05)'}`);
  console.log(`  SR3: ${a.sr3.withDefects.join(', ') || 'none'}; M3: ${a.m3.withDefects.join(', ') || 'none'}`);
  for (const [name, s] of [['SR3', a.sr3], ['M3', a.m3]]) {
    console.log(`${name}: ${s.runs} scored, ${s.delivered} delivered, ${s.admitted} admitted${s.notScored.length ? `; not scored: ${s.notScored.join('; ')}` : ''}`);
    for (const arm of [3, 4]) for (const task of ['T3', 'T7']) {
      const c = s.table[arm]?.[task];
      if (c) console.log(`  arm ${arm} ${task}: escaped per delivered ${c.escapedPerDelivered?.toFixed(2) ?? 'n/a'}, O1-R per delivered ${c.o1rPerDelivered?.toFixed(2) ?? 'n/a'}, admitted ${c.admittedRate?.toFixed(2)}, tokens per delivered ${c.tokensPerDelivered === null ? 'n/a' : Math.round(c.tokensPerDelivered)}`);
    }
  }
}
