// plan-e3.md E3.9 preparation, PS18.3, HF3.6: what a live run can cost, from the vendor's prices, and what each way of fitting it
// under the month's cap costs in what the paired test can detect. Nothing here calls a model or reads a clock.
//
// The worst case is not an estimate. A run's budget gate admits a call only when what the run has spent plus that call's
// reservation stays inside the run's cap, and a call within its limits costs no more than its reservation (PS18.3, K15), so
// a run spends at most its cap. N runs cost at most N times the cap, and the tool refuses a plan whose worst case is over the
// month's cap. The reservation is also what limits a run in practice: a run stops when spent + reservation would pass the cap,
// so the spendable part of a cap is the cap less the largest reservation.
//
// The expected cost is an estimate from stated assumptions about a trial (the preamble, the tokens a step adds, the steps),
// not a measurement. The live run replaces the assumptions by measured figures (a two-trial pilot comes first).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectableGap, minDiscordant } from './paired.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const table = (f) => JSON.parse(readFileSync(join(HERE, '..', 'prices-live', f), 'utf8'));
const usd = (micro) => micro / 1e6;

/** PS18.3: ceil((I x P_in + N x P_out) / 10^6) micro-units, with N at the highest price of any class but input. */
export function reservation(t, maxInput, maxOutput) {
  const p = t.perMillionTokens;
  const hi = Math.max(p.output, p.cache_write, p.cache_read);
  return Math.ceil((maxInput * p.input + maxOutput * hi) / 1e6);
}

/**
 * The cost in micro-USD of one trial of `steps` agent calls. Request i carries the preamble P and the transcript so far; the
 * previous request's whole input is read from the cache; the tokens added since (the model's output O and the tool's T) are
 * written to it; the model writes O. Request 1 writes the preamble.
 */
export function trialCost(t, { preamble, output, tool, steps }) {
  const p = t.perMillionTokens;
  let micro = (preamble * p.cache_write) / 1e6 + (output * p.output) / 1e6;
  let prev = preamble;
  for (let i = 2; i <= steps; i += 1) {
    micro += (prev * p.cache_read) / 1e6 + ((output + tool) * p.cache_write) / 1e6 + (output * p.output) / 1e6;
    prev += output + tool;
  }
  return Math.ceil(micro);
}

/** The largest number of steps a trial can take before the run's cap stops it: spent + reservation would pass the cap. */
export function stepsBeforeCap(t, a, capMicro, reservationMicro) {
  const room = capMicro - reservationMicro;
  let s = 0;
  while (trialCost(t, { ...a, steps: s + 1 }) <= room) s += 1;
  return s;
}

/** One plan: trials = tasks x configs x reruns (or the stated count), a per-run cap and the month's cap. */
export function plan({ name, tasks, configs = 2, reruns, trials, capUsd, monthUsd = 25, pilotTrials = 0, assume, maxInput = 100000, maxOutput = 8000, tables = { main: table('main.json'), cheap: table('cheap.json') } }) {
  const n = trials ?? tasks * configs * reruns;
  const capMicro = Math.round(capUsd * 1e6);
  const res = reservation(tables.main, maxInput, maxOutput);
  const worst = (n + pilotTrials) * capMicro;
  const spendable = capMicro - res;
  const expected = Object.fromEntries(assume.steps.map((s) => {
    const full = trialCost(tables.main, { ...assume, steps: s });
    return [s, { trialUsd: usd(full), runUsd: usd(Math.min(full, Math.max(spendable, 0))), capped: full > spendable }];
  }));
  return {
    name, tasks, trials: n, pilotTrials, capUsd, reservationUsd: usd(res), spendableUsd: usd(Math.max(spendable, 0)),
    worstUsd: usd(worst), fits: worst <= monthUsd * 1e6, monthUsd,
    stepsBeforeCap: spendable > 0 ? stepsBeforeCap(tables.main, assume, capMicro, res) : 0,
    // a request is refused above the input limit: request i carries the preamble and i - 1 steps of transcript
    stepsBeforeInputLimit: maxInput >= assume.preamble ? Math.floor((maxInput - assume.preamble) / (assume.output + assume.tool)) + 1 : 0,
    maxInput, maxOutput,
    expected,
    pairs: tasks, detectableGap: detectableGap(tasks), discordantNeeded: minDiscordant(),
  };
}

/** The assumptions about a trial that the expected cost rests on. They are guesses to be replaced by the pilot's figures. */
export const ASSUMED = Object.freeze({ preamble: 5000, output: 300, tool: 1200, steps: [10, 16, 30, 60] });

/**
 * The options put to the owner for E3.9 (docs/e3/e3-9-plan.md), at the limits proposed for the agent decision (50,000 input
 * tokens, 4,000 output): the module's own 100,000 and 8,000 make the reservation 0.56 USD at Opus 5.5 prices, which leaves no
 * step under a 0.60 USD cap. Each is within 25 USD at worst.
 */
const LIMITS = { maxInput: 50000, maxOutput: 4000 };
export const OPTIONS = [
  { name: 'staged', tasks: 12, trials: 40, capUsd: 0.6, ...LIMITS },
  { name: 'staged-on-4', tasks: 12, trials: 32, capUsd: 0.78, ...LIMITS },
  { name: 'full', tasks: 12, reruns: 2, capUsd: 0.5, ...LIMITS },
  { name: 'eight-tasks', tasks: 8, reruns: 2, capUsd: 0.75, ...LIMITS },
  { name: 'single-run', tasks: 12, reruns: 1, capUsd: 1, ...LIMITS },
];
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const o of OPTIONS) console.log(JSON.stringify(plan({ ...o, assume: ASSUMED })));
}
