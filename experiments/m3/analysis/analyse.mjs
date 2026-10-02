// The analysis of PT13, fixed before any run (plan-m3 section 7). It reads scored run records (runner/score.mjs)
// and computes, per arm and task, the measures PT13 names, then the fixed tests and rules:
//
//   - a run delivers its task when every version was delivered within the run's budget;
//   - escaped defects of a run: the failing O1 tests, summed over its four versions (PT13's primary measure);
//   - per task and arm: escaped defects per delivered run, and tokens per delivered run (all tokens of all runs,
//     delivered or not, over the delivered runs), the co-primary measures;
//   - the five comparisons (arm 3 and arm 4 against arms 1 and 2, arm 4 against arm 3) by the exact Wilcoxon
//     signed-rank test over the tasks, two-sided, Holm-corrected at 0.05; tokens are compared the same way, as a
//     second family;
//   - the win, surface and stop rules as PT13 writes them, a win needing both the 30% reduction and Holm-corrected
//     significance against arms 1 and 2 (S96);
//   - tokens kept as their four parts, input, output, cache read and cache write; the measure is their sum, all
//     tokens processed, and cost at list price is a secondary measure from a price table given with --prices (S99).
//
// Pre-registered with them (S115, S117): a sensitivity analysis over the tasks no arm's material models (MODELLED).
// Significance is decided once, over all ten tasks; on the unmodelled tasks a primary win must also show the 30%
// reduction against arms 1 and 2, or it is reported as a win only with the modelled tasks, never as a win. The
// subset's p-values are descriptive: five tasks cannot reach 0.05.
//
// A task whose value is missing for an arm (no delivered run) is left out of that comparison, and the report says
// so. Nothing is imputed.
//
// Usage: node experiments/m3/analysis/analyse.mjs <dir of run directories> [--json out.json]
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { holm, wilcoxonSignedRank } from './stats.mjs';

export const COMPARISONS = [[3, 1], [3, 2], [4, 1], [4, 2], [4, 3]];

/**
 * Every worked example in the material an arm receives (S115), with the tasks whose family it models: the manual
 * and examples of arms 3 and 4 (runner/workspace.mjs, as frozen) and arm 2's polygraph archive. Arm 1 receives
 * TypeScript only. An example models a task when it has the task's domain and lifecycle, or its central mechanism
 * (a payment effect and its completion, attempts up to a limit); fragments that show a format and no machine model
 * nothing. plan-m3.md section 10 records the same list.
 */
export const MODELLED = [
  { example: 'hello: the Gate', where: 'README; examples/hello', arms: [3, 4], tasks: [] },
  { example: 'orders: the Order with its payment.charge effect', where: 'README; spec PT2.5, PT4.5, PT6, PT11, PT12, PT15', arms: [3, 4], tasks: ['T1', 'T3'] },
  { example: 'checkout: Inventory, Order and two-buyers', where: 'README; spec PT7a, Appendix A', arms: [3, 4], tasks: ['T2', 'T4'] },
  { example: 'runtime: the OutboxIntent', where: 'spec PT9.7; examples/evidence', arms: [3, 4], tasks: ['T3', 'T6'] },
  { example: 'delivery: the Delivery protocol', where: 'spec PT9.8; examples/delivery', arms: [3, 4], tasks: [] },
  { example: 'repo-hygiene: a gate policy', where: 'spec PT8', arms: [3, 4], tasks: [] },
  { example: 'customer-brief: a workflow declaration', where: 'spec PT10', arms: [3, 4], tasks: [] },
  { example: 'turnstile: the embedded turnstile', where: 'examples/embedded/turnstile.ts', arms: [4], tasks: [] },
  { example: 'workshop: a Job with a charge effect, retries, a timer and a Drill child', where: 'examples/embedded/workshop.ts', arms: [4], tasks: ['T3', 'T6'] },
  { example: 'Rocket Launcher: a SAM v2 strict-profile reducer', where: 'polygraph scripts/prompt_template_v2.txt', arms: [2], tasks: [] },
  { example: 'push-locked-must-reject: a turnstile rejection invariant', where: 'polygraph README', arms: [2], tasks: [] },
  { example: 'withTracing: a trace projection of a payment workflow', where: 'polygraph README', arms: [2], tasks: [] },
];

/** The tasks some arm's material models, sorted by number. */
export const modelledTasks = (list = MODELLED) => [...new Set(list.flatMap((e) => e.tasks))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The four parts of a run's tokens, summed over its turns (S99). */
export function tokenParts(r) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const v of r.versions ?? []) {
    const u = v.usage ?? {};
    out.input += u.input_tokens ?? 0;
    out.output += u.output_tokens ?? 0;
    out.cacheRead += u.cache_read_input_tokens ?? 0;
    out.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  return out;
}

/** A run's cost at list price: `prices` gives dollars per million tokens of each part. */
export function costOf(parts, prices) {
  return (parts.input * prices.input + parts.output * prices.output + parts.cacheRead * prices.cacheRead + parts.cacheWrite * prices.cacheWrite) / 1e6;
}

/** The measures of one run. */
export function runMeasures(r, prices) {
  const scores = r.scores ?? [];
  const delivered = scores.length === 4 && scores.every((s) => s.delivered && s.withinBudget);
  const o1Ran = scores.length === 4 && scores.every((s) => s.o1?.ran);
  const o1rRan = scores.length === 4 && scores.every((s) => s.o1r?.ran);
  return {
    delivered,
    admitted: r.arm >= 3 ? delivered && scores.every((s) => s.admitted === true) : null,
    escaped: o1Ran ? scores.reduce((n, s) => n + s.o1.failed, 0) : null,
    // M3-10: O1-R failures, a secondary measure beside O1, never added into `escaped`.
    o1r: o1rRan ? scores.reduce((n, s) => n + s.o1r.failed, 0) : null,
    tokens: r.spent?.tokens ?? 0,
    tokenParts: tokenParts(r),
    cost: prices ? costOf(tokenParts(r), prices) : null,
    wallMs: r.spent?.wallMs ?? 0,
    o2: scores.reduce((n, s) => n + (s.o2?.violated?.length ?? 0), 0),
    o3: scores.reduce((n, s) => n + (s.o3?.failed ?? 0), 0),
    introduced: scores.reduce((n, s) => n + (s.regressions?.introduced ?? 0), 0),
    caught: scores.reduce((n, s) => n + (s.regressions?.caught ?? 0), 0),
  };
}

/** Per arm and task: the aggregated measures. */
export function perTask(records, prices) {
  const out = {};
  for (const r of records) {
    const m = runMeasures(r, prices);
    const cell = ((out[r.arm] ??= {})[r.task] ??= { runs: 0, deliveredRuns: 0, admittedRuns: 0, escapedDelivered: [], o1rDelivered: [], tokens: 0, parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, wallMs: [], o2: [], o3: [], introduced: [], caught: [] });
    cell.runs++;
    cell.tokens += m.tokens;
    for (const k of Object.keys(cell.parts)) cell.parts[k] += m.tokenParts[k];
    if (m.cost !== null) cell.cost += m.cost;
    cell.wallMs.push(m.wallMs);
    if (m.admitted) cell.admittedRuns++;
    if (m.delivered) {
      cell.deliveredRuns++;
      if (m.escaped !== null) cell.escapedDelivered.push(m.escaped);
      if (m.o1r !== null) cell.o1rDelivered.push(m.o1r);
      cell.o2.push(m.o2); cell.o3.push(m.o3); cell.introduced.push(m.introduced); cell.caught.push(m.caught);
    }
  }
  for (const arm of Object.keys(out)) {
    for (const task of Object.keys(out[arm])) {
      const c = out[arm][task];
      out[arm][task] = {
        runs: c.runs,
        deliveredRuns: c.deliveredRuns,
        deliveryRate: c.deliveredRuns / c.runs,
        admittedRate: Number(arm) >= 3 ? c.admittedRuns / c.runs : null,
        escapedPerDelivered: c.escapedDelivered.length ? mean(c.escapedDelivered) : null,
        o1rPerDelivered: c.o1rDelivered.length ? mean(c.o1rDelivered) : null,
        tokensPerDelivered: c.deliveredRuns ? c.tokens / c.deliveredRuns : null,
        tokenPartsPerDelivered: c.deliveredRuns ? Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, v / c.deliveredRuns])) : null,
        costPerDelivered: prices && c.deliveredRuns ? c.cost / c.deliveredRuns : null,
        wallMsMean: mean(c.wallMs),
        o2Mean: mean(c.o2), o3Mean: mean(c.o3), introducedMean: mean(c.introduced), caughtMean: mean(c.caught),
      };
    }
  }
  return out;
}

/** The paired comparisons of one measure over the tasks both arms have a value for, Holm-corrected. */
export function compare(table, measure, alpha = 0.05) {
  const tasks = [...new Set(Object.values(table).flatMap((t) => Object.keys(t)))].sort();
  const rows = COMPARISONS.map(([a, b]) => {
    const both = tasks.filter((t) => table[a]?.[t]?.[measure] != null && table[b]?.[t]?.[measure] != null);
    const x = both.map((t) => table[a][t][measure]);
    const y = both.map((t) => table[b][t][measure]);
    const w = wilcoxonSignedRank(x, y);
    return { arms: [a, b], tasks: both.length, leftOut: tasks.filter((t) => !both.includes(t)), meanA: mean(x), meanB: mean(y), wPlus: w.wPlus, n: w.n, p: w.p };
  });
  const h = holm(rows.map((r) => r.p), alpha);
  return rows.map((r, i) => ({ ...r, adjusted: h[i].adjusted, rejected: h[i].rejected }));
}

/** The mean over tasks of an arm's per-task value. */
const armMean = (table, arm, measure) => mean(Object.values(table[arm] ?? {}).map((c) => c[measure]).filter((v) => v != null));

/** PT13's rules. */
export function rules(table, defects) {
  const esc = (a) => armMean(table, a, 'escapedPerDelivered');
  const tok = (a) => armMean(table, a, 'tokensPerDelivered');
  const reduces = (p, o) => esc(o) != null && esc(p) != null && esc(o) > 0 && esc(p) <= 0.7 * esc(o);
  const win = {};
  for (const p of [3, 4]) {
    const effect = reduces(p, 1) && reduces(p, 2) && tok(p) != null && tok(1) != null && tok(p) <= 2 * tok(1);
    const sig = (o) => defects.find((c) => c.arms[0] === p && c.arms[1] === o);
    const significant = effect && sig(1).rejected && sig(2).rejected;
    win[p] = { effect, significant, win: significant };
  }
  const s3 = esc(3), s4 = esc(4);
  const notWorse = s3 != null && s4 != null && s4 - s3 <= 0.1 * s3;
  const surface = notWorse && tok(4) != null && tok(3) != null && tok(4) < tok(3) ? 'embedded' : 'standalone';
  const admitted = (a) => { const cells = Object.values(table[a] ?? {}); const runs = cells.reduce((n, c) => n + c.runs, 0); return runs ? cells.reduce((n, c) => n + c.admittedRate * c.runs, 0) / runs : 0; };
  const stop = admitted(3) < 0.7 && admitted(4) < 0.7;
  // S96: a win needs the 30% reduction and both Holm-corrected comparisons below 0.05.
  const verdict = stop ? 'stop' : win[3].win || win[4].win ? 'win' : 'between';
  return { escapedMean: { 1: esc(1), 2: esc(2), 3: s3, 4: s4 }, tokensMean: { 1: tok(1), 2: tok(2), 3: tok(3), 4: tok(4) }, win, surface, admittedRate: { 3: admitted(3), 4: admitted(4) }, stop, verdict };
}

/**
 * Per arm, how many runs a cap stopped and which (4c630d2): `tokens` (the runner's token cap), `wall` (its wall time)
 * and `usd` (the CLI's dollar cap). The caps are set not to bind; a run a cap stops is still counted, never rerun.
 */
export function capStops(records) {
  const out = Object.fromEntries([1, 2, 3, 4].map((a) => [a, { runs: 0, stopped: 0, tokens: 0, wall: 0, usd: 0 }]));
  const which = { budget: 'tokens', wall: 'wall', usd: 'usd' };
  for (const r of records) {
    const c = out[r.arm];
    if (!c) continue;
    c.runs++;
    const cap = (r.versions ?? []).map((v) => which[v.stopped]).find(Boolean);
    if (cap) { c.stopped++; c[cap]++; }
  }
  return out;
}

/** The comparisons and rules over a set of records. */
function primary(records, prices) {
  const table = perTask(records, prices);
  const defects = compare(table, 'escapedPerDelivered');
  const tokens = compare(table, 'tokensPerDelivered');
  return { table, comparisons: { escapedDefects: defects, tokens }, rules: rules(table, defects) };
}

/**
 * The primary analysis over all tasks, and the sensitivity analysis (S115) over the tasks no arm's material models.
 * Both are reported. Significance is decided once, by the primary comparison (S96, S117). On the unmodelled tasks
 * the check is an effect check: an arm's mean escaped defects per delivered task is at least 30% below that of
 * arms 1 and 2 (`holds`). The subset's comparisons and p-values are reported as descriptive, never as a gate: over
 * five tasks the smallest exact two-sided p is 2/32, which cannot reach 0.05. `reported` is what the experiment may
 * claim: a primary win counts only when the effect holds on the unmodelled tasks; otherwise it is reported as a
 * win only with the modelled tasks, never as a win.
 */
export function analyse(records, prices, { modelled = modelledTasks() } = {}) {
  const all = primary(records, prices);
  const left = records.filter((r) => !modelled.includes(r.task));
  const sub = primary(left, prices);
  const tasks = [...new Set(left.map((r) => r.task))].sort();
  const minP = 2 / 2 ** tasks.length;
  const esc = sub.rules.escapedMean;
  // At least 30% below, as 10 x arm <= 7 x comparator: 0.7 x 100 is not 70 in floating point.
  const below = (p, o) => esc[p] != null && esc[o] != null && esc[o] > 0 && 10 * esc[p] <= 7 * esc[o];
  const holds = { 3: below(3, 1) && below(3, 2), 4: below(4, 1) && below(4, 2) };
  const note = `descriptive only (S117): over ${tasks.length} tasks the smallest exact two-sided p is ${minP.toFixed(4)}` + (minP >= 0.05 ? ', so it cannot reach 0.05' : '');
  const sensitivity = { ...sub, modelled: [...modelled], tasks, holds, descriptive: true, note };
  const win = {};
  for (const p of [3, 4]) win[p] = !all.rules.win[p].win ? 'no win' : holds[p] ? 'win' : 'only with the modelled tasks';
  const values = Object.values(win);
  const verdict = all.rules.verdict !== 'win' ? all.rules.verdict : values.includes('win') ? 'win' : 'win only with the modelled tasks';
  // M3-10: O1-R compared the same way, reported apart as a secondary measure, in no rule and no verdict.
  return { ...all, sensitivity, reported: { verdict, win }, secondary: { o1r: compare(all.table, 'o1rPerDelivered') }, capStops: capStops(records) };
}

/** Every scored run record under a directory. */
export function loadRecords(dir) {
  return readdirSync(dir).map((d) => join(dir, d, 'run.json')).filter((f) => existsSync(f)).map((f) => JSON.parse(readFileSync(f, 'utf8'))).filter((r) => r.scores);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: analyse.mjs <runs dir> [--json out.json] [--prices prices.json]'); process.exit(64); }
  const p = process.argv.indexOf('--prices');
  const a = analyse(loadRecords(dir), p > 0 ? JSON.parse(readFileSync(process.argv[p + 1], 'utf8')) : undefined);
  const i = process.argv.indexOf('--json');
  if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify(a, null, 2) + '\n');
  console.log('all tasks:');
  for (const c of a.comparisons.escapedDefects) console.log(`  escaped defects, arm ${c.arms[0]} vs ${c.arms[1]}: ${c.meanA?.toFixed(2)} vs ${c.meanB?.toFixed(2)} over ${c.tasks} tasks, p ${c.p.toFixed(4)}, Holm ${c.adjusted.toFixed(4)}${c.rejected ? ' (significant)' : ''}`);
  console.log(`  verdict: ${a.rules.verdict}; surface: ${a.rules.surface}; win: arm 3 ${JSON.stringify(a.rules.win[3])}, arm 4 ${JSON.stringify(a.rules.win[4])}; stop: ${a.rules.stop}`);
  const s = a.sensitivity;
  console.log(`without the modelled tasks ${s.modelled.join(', ')} (${s.tasks.join(', ')}):`);
  for (const c of s.comparisons.escapedDefects) console.log(`  escaped defects, arm ${c.arms[0]} vs ${c.arms[1]}: ${c.meanA?.toFixed(2)} vs ${c.meanB?.toFixed(2)} over ${c.tasks} tasks, p ${c.p.toFixed(4)} (descriptive)`);
  console.log(`  ${s.note}`);
  console.log(`  at least 30% below arms 1 and 2 (S117): arm 3 ${s.holds[3]}, arm 4 ${s.holds[4]}`);
  for (const c of a.secondary.o1r) console.log(`secondary (M3-10), O1-R failures, arm ${c.arms[0]} vs ${c.arms[1]}: ${c.meanA?.toFixed(2)} vs ${c.meanB?.toFixed(2)} over ${c.tasks} tasks, p ${c.p.toFixed(4)}`);
  for (const [arm, c] of Object.entries(a.capStops)) console.log(`caps (4c630d2), arm ${arm}: ${c.stopped} of ${c.runs} runs stopped by a cap (tokens ${c.tokens}, wall ${c.wall}, dollars ${c.usd})`);
  console.log(`reported (S115, S117): ${a.reported.verdict}; arm 3 ${a.reported.win[3]}, arm 4 ${a.reported.win[4]}`);
}
