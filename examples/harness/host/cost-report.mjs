// plan-e3.md E3.6, HAC6: the cost of each model call as the terms that make it up, so that a change in cost can be traced to
// the term that moved it. A call's input is its preamble (the system prompt and the tool schemas, the first message of every
// request) and its transcript (everything else it is shown); its output is what the model wrote; its price follows from the
// usage and the price table (PS18.3). The terms are the host's, taken as the provider is asked (loop.mjs); the usage and the
// cost are the runtime's own, from the decision events of its ledger; the report is `consistent` only when the two agree on
// every call, so a term can never be one the runtime did not charge.
//
// A step is a plan step of the trial; a request is a call of the main model (an answer, or a reprompt after a cutoff).

/** PS18.3: the cost of a call in micro-units, ceil of the sum over token classes of tokens times price, per million. */
export function priceUnits(table, usage) {
  const p = table.perMillionTokens;
  return Math.ceil(((usage.input ?? 0) * p.input + (usage.output ?? 0) * p.output) / 1_000_000);
}

const TIER = { agent: 'main', summarise: 'cheap', read: 'cheap' };

/**
 * @param {{ calls: { kind: string, preamble: number, transcript: number, output: number }[], events: object[],
 *   prices: Record<string, object>, steps: number }} input `events` are the runtime's decision events in order; `prices`
 *   the price tables by tier (main, cheap)
 */
export function costReport({ calls, events, prices, steps }) {
  const byKind = {};
  for (const e of events) (byKind[e.decision] ??= []).push(e);
  const seen = {};
  const rows = [];
  const problems = [];
  for (const c of calls) {
    const i = (seen[c.kind] = (seen[c.kind] ?? -1) + 1);
    const e = byKind[c.kind]?.[i];
    if (!e) {
      problems.push(`${c.kind} call ${i}: no decision event`);
      continue;
    }
    if (e.usage.input !== c.preamble + c.transcript) problems.push(`${c.kind} call ${i}: input ${e.usage.input} is not preamble ${c.preamble} + transcript ${c.transcript}`);
    if (e.usage.output !== c.output) problems.push(`${c.kind} call ${i}: output ${e.usage.output} is not ${c.output}`);
    const want = priceUnits(prices[TIER[c.kind]], e.usage);
    if (e.cost.units !== want) problems.push(`${c.kind} call ${i}: cost ${e.cost.units} is not ${want} from the price table`);
    rows.push({ kind: c.kind, tier: TIER[c.kind], preamble: c.preamble, transcript: c.transcript, output: c.output, microUsd: e.cost.units });
  }
  for (const [k, list] of Object.entries(byKind)) if (list.length !== (seen[k] ?? -1) + 1) problems.push(`${k}: ${list.length} decision events for ${(seen[k] ?? -1) + 1} calls`);
  const tiers = {};
  for (const r of rows) {
    const t = (tiers[r.tier] ??= { calls: 0, preamble: 0, transcript: 0, output: 0, microUsd: 0 });
    t.calls += 1;
    t.preamble += r.preamble;
    t.transcript += r.transcript;
    t.output += r.output;
    t.microUsd += r.microUsd;
  }
  return { consistent: problems.length === 0, problems, steps, requests: rows.filter((r) => r.kind === 'agent').length, tiers, rows };
}

/** Which terms of the main tier differ between two reports, beyond a tolerance in tokens (0 by default): the term that moved a cost. */
export function movedTerms(a, b, tolerance = 0) {
  const A = a.tiers.main ?? { preamble: 0, transcript: 0, output: 0 };
  const B = b.tiers.main ?? { preamble: 0, transcript: 0, output: 0 };
  return ['preamble', 'transcript', 'output'].filter((t) => Math.abs(A[t] - B[t]) > tolerance);
}
