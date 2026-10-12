// plan-e3.md E3.8, HF2.8, HAC3, HAC8, S557, Q-E3-6: the paired acceptance of a harness change, and the statistics under it.
//
// Two configurations (the base and the candidate) run the same tasks with the model frozen. A task is completed when every
// stage of the plan passed ("reached the end of the plan", not "solved the task": the label of the recordings and of the
// live run). The pairs are per task. The rule, which follows the proposal's VERA reading:
//
//   1. A change outside the editable surface is refused first (HF3.11, host/change-gate.mjs).
//   2. Any stage that passed in the base and does not pass in the candidate is a regression, and any regression is REFUSE,
//      whatever else improved (HAC8: a change that improves one stage and regresses another is refused).
//   3. A candidate that completes fewer tasks than the base is REFUSE, however much cheaper it is (HAC3).
//   4. A significantly worse candidate (exact McNemar, one-sided, the other way) is REFUSE.
//   5. A significant gain (exact one-sided McNemar on the discordant pairs, alpha 0.05) with no regression is ACCEPT, unless a
//      measured noise floor is as large as the gain (then INCONCLUSIVE: the gain is within the rerun spread).
//   6. Anything else is INCONCLUSIVE, never "no difference": too few discordant pairs for any outcome to reach alpha, or a gain
//      that is not significant. The report says which, and the smallest gap the task set can detect.
//
// The noise floor is the share of tasks whose outcome differs between reruns of one configuration with the model frozen. On
// recordings a replay repeats exactly, so its floor is zero by construction. That is not a measurement, and `noiseFloor`
// says so (`measured: false`) instead of returning a number a reader could take for one. The real floor is measured at E3.9.
//
// Under a fixed cap a configuration that spends fewer tokens per step gets more steps, so "completed under the cap" partly measures
// cost and not only skill. A run the budget or a cap stopped (the scorer's ended.why is Budget or Cap) is reported, and completion is
// compared again on the tasks where no rerun of either configuration was stopped by a cap: `instance.underCap`. That second
// comparison is reported beside the verdict (and a line of `reasons` says so); it does not decide it, and it is smaller.
//
// No model is called here and nothing is random. Costs, when given, are reported beside the verdict and never decide it.
import { checkChange } from './change-gate.mjs';

const ALPHA = 0.05;
const POWER = 0.8;

// ---------------------------------------------------------------- the statistics

/** P(X >= k) for X ~ Binomial(m, 1/2), exact, to 17 digits. */
export function upperTail(m, k) {
  if (!Number.isInteger(m) || !Number.isInteger(k) || m < 0) throw new Error('the tail takes integers');
  if (k <= 0) return 1;
  if (k > m) return 0;
  let c = 1n; // C(m, 0)
  let sum = 0n;
  for (let i = 0; i <= m; i += 1) {
    if (i >= k) sum += c;
    c = (c * BigInt(m - i)) / BigInt(i + 1);
  }
  const scale = 10n ** 17n;
  return Number((sum * scale) / 2n ** BigInt(m)) / 1e17;
}

/**
 * Exact McNemar on the discordant pairs: b is the number of tasks the candidate completed and the base did not, c the reverse.
 * pGain is the one-sided p-value for "the candidate is better", pLoss for "the candidate is worse".
 */
export function mcnemarExact(b, c) {
  const n = b + c;
  return { b, c, discordant: n, pGain: upperTail(n, b), pLoss: upperTail(n, c) };
}

/** The fewest wins out of m discordant pairs that reach alpha, or null when even m of m does not. */
export function criticalWins(m, alpha = ALPHA) {
  for (let k = Math.ceil(m / 2); k <= m; k += 1) if (upperTail(m, k) <= alpha) return k;
  return null;
}

/** The fewest discordant pairs for which any outcome can reach alpha (5 at alpha 0.05). */
export function minDiscordant(alpha = ALPHA) {
  let m = 1;
  while (criticalWins(m, alpha) === null) m += 1;
  return m;
}

const logFact = (() => {
  const t = [0];
  return (n) => {
    while (t.length <= n) t.push(t[t.length - 1] + Math.log(t.length));
    return t[n];
  };
})();
const binomPmf = (n, k, p) => (k < 0 || k > n ? 0 : p <= 0 ? (k === 0 ? 1 : 0) : p >= 1 ? (k === n ? 1 : 0) : Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p)));

/**
 * The power of the one-sided exact test at n pairs when a share q of the pairs is discordant and the candidate wins a share
 * (q + gap) / (2q) of the discordant ones, so that the gap is the difference of the two completion rates.
 */
export function power(n, q, gap, alpha = ALPHA) {
  if (gap > q) throw new Error('the gap cannot exceed the share of discordant pairs');
  const p1 = (q + gap) / (2 * q);
  let total = 0;
  for (let m = 0; m <= n; m += 1) {
    const pm = binomPmf(n, m, q);
    if (pm < 1e-15) continue;
    const k = criticalWins(m, alpha);
    if (k === null) continue;
    let tail = 0;
    for (let w = k; w <= m; w += 1) tail += binomPmf(m, w, p1);
    total += pm * tail;
  }
  return total;
}

/**
 * The smallest gap (difference of completion rates, in steps of 1/100) the task set detects at 80% power, or null when none.
 * With q omitted, every discordant pair goes the candidate's way and the share of discordant pairs equals the gap (q = gap):
 * the favourable case, and the one that matters here, because a pair that goes the other way is a regressed stage and the
 * rule refuses it. With q given, a share q of the pairs is discordant and the candidate wins (q + gap) / (2q) of them.
 */
export function detectableGap(n, q = null, { alpha = ALPHA, target = POWER } = {}) {
  const top = q === null ? 100 : Math.round(q * 100);
  for (let g = 1; g <= top; g += 1) {
    const gap = g / 100;
    const reach = q === null ? upperBinomial(n, gap, minDiscordant(alpha)) : power(n, q, gap, alpha);
    if (reach >= target) return gap;
  }
  return null;
}

/** P(Bin(n, p) >= k). */
function upperBinomial(n, p, k) {
  let s = 0;
  for (let w = k; w <= n; w += 1) s += binomPmf(n, w, p);
  return s;
}
// ---------------------------------------------------------------- the runs

/** A run as the scorer gives it (host/score.mjs): { stages: [{ score }], total }. */
const completed = (run) => run.stages.every((s) => s.score === 1);

/** The outcome of one configuration on one task over its reruns: completed in every rerun; stage k passed in every rerun. */
function outcome(reruns, id, side) {
  if (!Array.isArray(reruns) || reruns.length === 0) throw new Error(`${side}: task ${id} has no run`);
  const total = reruns[0].total;
  if (!reruns.every((r) => r.total === total)) throw new Error(`${side}: task ${id} has runs of different plans`);
  return { total, completed: reruns.every(completed), stages: Array.from({ length: total }, (_, k) => (reruns.every((r) => r.stages[k].score === 1) ? 1 : 0)), reruns: reruns.length };
}

/**
 * The noise floor of one set of runs: { [taskId]: [run, run, ...] } for one configuration with the model frozen.
 * `source` is 'recording' (a replay) or 'live'. A replay must repeat exactly, and then its floor is zero by construction and
 * `measured` is false; a replay that does not repeat is a defect and throws. A live set needs at least two reruns of a task,
 * and the floor is the share of tasks whose completion differs between reruns (and of stages whose score does).
 */
export function noiseFloor(runs, { source }) {
  if (source !== 'recording' && source !== 'live') throw new Error("source must be 'recording' or 'live'");
  const ids = Object.keys(runs).sort();
  let disagreeTasks = 0;
  let stageCells = 0;
  let disagreeStages = 0;
  for (const id of ids) {
    const rr = runs[id];
    if (rr.length < 2) {
      if (source === 'live') throw new Error(`task ${id} has ${rr.length} run; a noise floor needs at least two reruns`);
      continue;
    }
    if (new Set(rr.map(completed)).size > 1) disagreeTasks += 1;
    for (let k = 0; k < rr[0].total; k += 1) {
      stageCells += 1;
      if (new Set(rr.map((r) => r.stages[k].score)).size > 1) disagreeStages += 1;
    }
  }
  if (source === 'recording') {
    if (disagreeTasks || disagreeStages) throw new Error('a replay of a recording differed between reruns, which is a defect of the replay and not noise');
    return { source, measured: false, tasks: ids.length, rate: 0, stageRate: 0, note: 'a replay repeats exactly, so its floor is zero by construction; this is not a measurement, and the floor is measured at the live run (E3.9)' };
  }
  return { source, measured: true, tasks: ids.length, disagreeing: disagreeTasks, rate: disagreeTasks / ids.length, stageRate: stageCells ? disagreeStages / stageCells : 0, note: 'the share of tasks whose completion differs between reruns of one configuration, model frozen' };
}

// ---------------------------------------------------------------- the decision

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

const STOPPED_BY_CAP = new Set(['Budget', 'Cap']);
const stoppedByCap = (reruns) => reruns.some((r) => r.ended && STOPPED_BY_CAP.has(r.ended.why));

/**
 * The tasks a cap stopped in either configuration, and completion compared on those where it stopped neither. The note says why
 * the second comparison exists. `line` is the sentence added to the verdict's reasons, or null when no cap stopped a run.
 */
function underCap(ids, base, candidate, tasks) {
  const baseCapped = ids.filter((id) => stoppedByCap(base[id]));
  const candidateCapped = ids.filter((id) => stoppedByCap(candidate[id]));
  const fit = tasks.filter((t) => !baseCapped.includes(t.id) && !candidateCapped.includes(t.id));
  const better = fit.filter((t) => t.b.completed && !t.a.completed).map((t) => t.id);
  const worse = fit.filter((t) => t.a.completed && !t.b.completed).map((t) => t.id);
  const test = mcnemarExact(better.length, worse.length);
  const note = 'under a fixed cap a configuration that spends fewer tokens per step gets more steps, so "completed under the cap" partly measures cost; the comparison on the tasks that fit inside the cap in both configurations does not';
  const anyCapped = baseCapped.length + candidateCapped.length > 0;
  return {
    baseCapped, candidateCapped, bothFit: fit.length, better, worse, ...test, note,
    line: anyCapped
      ? `a cap stopped ${baseCapped.length} task(s) of the base and ${candidateCapped.length} of the candidate, so completion under the cap partly measures cost; on the ${fit.length} task(s) that fit in both, ${better.length} favour the candidate and ${worse.length} the base (exact one-sided p ${test.pGain.toPrecision(3)}, reported beside the verdict and not deciding it)`
      : null,
  };
}

/**
 * @param {{ base: Record<string, object[]>, candidate: Record<string, object[]>, source: 'recording'|'live',
 *   changed?: string[], alpha?: number, costs?: { base: object, candidate: object } }} input
 *   base and candidate map a task id to its reruns (scorer results). `changed` is the files the change touches.
 * @returns {{ verdict: 'ACCEPT'|'REFUSE'|'INCONCLUSIVE', reasons: string[], instance: object }} the instance is the checked one
 *   (PT12.3a): the tasks, pairs, discordant counts, p-values, regressions, noise floor and detectable gap behind the verdict.
 */
export function decide({ base, candidate, source, changed, alpha = ALPHA, costs }) {
  const reasons = [];
  const verdict = (v) => {
    if (instance.underCap?.line) reasons.push(instance.underCap.line);
    return { verdict: v, reasons, instance };
  };
  const instance = { source, alpha, tasks: 0, pairs: null, regressions: [], noise: null, detectableGap: null, detectableGapNote: null, underCap: null, costs: costs ?? null };

  if (changed) {
    const gate = checkChange({ changed });
    if (!gate.accepted) {
      instance.refusedFiles = gate.refused;
      reasons.push(...gate.refused.map((r) => `${r.file}: ${r.reason}`));
      return verdict('REFUSE');
    }
  }

  const ids = Object.keys(base).sort();
  if (JSON.stringify(ids) !== JSON.stringify(Object.keys(candidate).sort())) throw new Error('the base and the candidate ran different tasks, so there are no pairs');
  if (ids.length === 0) throw new Error('no tasks');
  const tasks = ids.map((id) => ({ id, a: outcome(base[id], id, 'base'), b: outcome(candidate[id], id, 'candidate') }));
  for (const t of tasks) if (t.a.total !== t.b.total) throw new Error(`task ${t.id}: runs of different plans (${t.a.total} and ${t.b.total} stages)`);
  instance.tasks = tasks.length;

  const better = tasks.filter((t) => t.b.completed && !t.a.completed).map((t) => t.id);
  const worse = tasks.filter((t) => t.a.completed && !t.b.completed).map((t) => t.id);
  const test = mcnemarExact(better.length, worse.length);
  instance.pairs = { n: tasks.length, baseCompleted: sum(tasks, (t) => +t.a.completed), candidateCompleted: sum(tasks, (t) => +t.b.completed), better, worse, ...test };
  instance.underCap = underCap(ids, base, candidate, tasks);
  instance.detectableGap = detectableGap(tasks.length, null, { alpha });
  instance.detectableGapNote = `the smallest difference of completion rates detected at 80% power with ${tasks.length} pairs, if every discordant pair favours the candidate (a pair against it is a regressed stage and is refused); less if fewer pairs are discordant`;

  for (const t of tasks) {
    for (let k = 0; k < t.a.total; k += 1) if (t.a.stages[k] === 1 && t.b.stages[k] === 0) instance.regressions.push({ task: t.id, stage: k });
  }

  const noise = {
    base: noiseFloor(Object.fromEntries(ids.map((id) => [id, base[id]])), { source }),
    candidate: noiseFloor(Object.fromEntries(ids.map((id) => [id, candidate[id]])), { source }),
  };
  instance.noise = noise;
  const floor = Math.max(noise.base.rate, noise.candidate.rate);

  if (instance.regressions.length) {
    reasons.push(`${instance.regressions.length} stage(s) regressed: ${instance.regressions.map((r) => `${r.task}#${r.stage}`).join(', ')}; a change that regresses a stage is refused whatever else improved (HF2.8, HAC8)`);
    return verdict('REFUSE');
  }
  if (instance.pairs.candidateCompleted < instance.pairs.baseCompleted) {
    reasons.push(`the candidate completes ${instance.pairs.candidateCompleted} of ${tasks.length} tasks, the base ${instance.pairs.baseCompleted}; a cheaper run that completes fewer tasks fails (HAC3)`);
    return verdict('REFUSE');
  }
  if (test.pLoss <= alpha) {
    reasons.push(`the candidate is significantly worse: ${worse.length} of ${test.discordant} discordant pairs against it (exact one-sided p ${test.pLoss.toPrecision(3)})`);
    return verdict('REFUSE');
  }
  const need = minDiscordant(alpha);
  if (test.discordant < need) {
    reasons.push(`${test.discordant} discordant pair(s): fewer than ${need}, so no outcome could reach alpha ${alpha}; this is not "no difference"`);
    return verdict('INCONCLUSIVE');
  }
  if (test.pGain > alpha) {
    reasons.push(`${better.length} of ${test.discordant} discordant pairs favour the candidate (exact one-sided p ${test.pGain.toPrecision(3)}), not below ${alpha}; this is not "no difference"`);
    return verdict('INCONCLUSIVE');
  }
  if (noise.base.measured && floor >= (better.length - worse.length) / tasks.length) {
    reasons.push(`the gain (${better.length - worse.length} of ${tasks.length} tasks) is not above the rerun spread (${(floor * 100).toFixed(0)}% of tasks differ between reruns)`);
    return verdict('INCONCLUSIVE');
  }
  reasons.push(`${better.length} of ${test.discordant} discordant pairs favour the candidate (exact one-sided p ${test.pGain.toPrecision(3)}) and no stage regressed`);
  if (!noise.base.measured) reasons.push('the noise floor is not measured (recordings replay exactly); the verdict is recordings evidence');
  return verdict('ACCEPT');
}
