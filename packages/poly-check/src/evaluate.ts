// `poly journal eval` and `poly journal fit` (PD3.3, PD1.6, PD2.4b, S132). Evaluation replays recorded questions
// to a candidate provider, off the step path, and compares its answers with the adjudicated outcomes; fitting
// learns a decision's calibration map from them. Both read `decision` events joined with their `outcome` links,
// and neither writes to any chain. Tests use recorded providers only: no test calls a model.
import { digest as polyDigest } from '@poly/core';
import type { JournalReader, Provider, CalibrationMap } from '@poly/runtime';

export interface Sample {
  run: string;
  decisionEvent: string;
  question: unknown;
  answer: unknown;
  /** The raw probability of the recorded answer, before calibration. */
  raw: number;
  model: { id: string; reported: string | null };
  outcome: 'Correct' | 'Wrong' | null;
}

/** Every recorded decision of `decision` with the outcome linked to it, if one was adjudicated. */
export async function samples(reader: JournalReader, decision: string): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const run of await reader.runs()) {
    const events = await reader.chain(run.run);
    const outcomes = new Map(events.filter((e) => e.kind === 'outcome').map((e) => [(e.body as { decisionEvent: string }).decisionEvent, (e.body as { outcome: 'Correct' | 'Wrong' }).outcome]));
    for (const e of events) {
      const b = e.body as Record<string, any>;
      if (e.kind !== 'decision' || b.decision !== decision) continue;
      out.push({ run: run.run, decisionEvent: e.hash, question: await reader.body(b.request), answer: b.answer, raw: b.raw, model: b.model, outcome: outcomes.get(e.hash) ?? null });
    }
  }
  return out;
}

export interface Evaluation {
  decision: string;
  /** Questions with an adjudicated outcome, which are the ones that can be scored. */
  scored: number;
  unscored: number;
  /** The candidate agrees with an outcome when it repeats a Correct answer or departs from a Wrong one. */
  agreement: number;
  brier: number;
  /** Ten reliability bins over the candidate's calibrated confidence: count, mean confidence, observed accuracy. */
  bins: { from: number; to: number; n: number; confidence: number | null; accuracy: number | null }[];
}

export async function evaluate(reader: JournalReader, decision: string, candidate: Provider): Promise<Evaluation> {
  const all = await samples(reader, decision);
  const scored = all.filter((s) => s.outcome);
  let agree = 0;
  let brier = 0;
  const bins = Array.from({ length: 10 }, (_, k) => ({ from: k / 10, to: (k + 1) / 10, n: 0, sum: 0, hits: 0 }));
  for (const s of scored) {
    const q = s.question as { decision: string; payload: unknown; intent: string };
    const a = await candidate(q);
    // Review B3: the candidate's confidence is the probability it gives the answer it returns.
    const conf = a.distribution.find(([x]) => polyDigest(x) === polyDigest(a.answer))?.[1] ?? 0;
    const same = polyDigest(a.answer) === polyDigest(s.answer);
    const right = s.outcome === 'Correct' ? same : !same;
    if (right) agree++;
    brier += (conf - (right ? 1 : 0)) ** 2;
    const bin = bins[Math.min(9, Math.floor(conf * 10))];
    bin.n++; bin.sum += conf; if (right) bin.hits++;
  }
  const n = scored.length;
  return {
    decision, scored: n, unscored: all.length - n,
    agreement: n ? agree / n : 0,
    brier: n ? brier / n : 0,
    bins: bins.map((b) => ({ from: b.from, to: b.to, n: b.n, confidence: b.n ? b.sum / b.n : null, accuracy: b.n ? b.hits / b.n : null })),
  };
}

/** PD1.6a: the steps of the monotone map by pool-adjacent-violators over (raw in thousandths, 1 if right else 0), sorted by raw. */
export function isotonicPoints(input: { x: number; y: number }[]): [number, number][] {
  const pts = [...input].sort((a, b) => a.x - b.x);
  const blocks: { x: number; sum: number; n: number }[] = [];
  for (const p of pts) {
    // Review B4: samples at one raw value are one block before any violator is pooled, so order cannot matter.
    const last = blocks[blocks.length - 1];
    if (last && last.x === p.x) { last.sum += p.y; last.n += 1; } else blocks.push({ x: p.x, sum: p.y, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      const a = blocks[blocks.length - 1];
      a.sum += b.sum; a.n += b.n;
    }
  }
  return blocks.map((b) => [b.x, Math.round((b.sum / b.n) * 1000)] as [number, number]);
}

/**
 * PD1.6a: a monotone map from raw to calibrated confidence, by isotonic regression (pool adjacent violators) of
 * whether each recorded answer was Correct on its raw probability, for the decisions of one model.
 */
export async function fit(reader: JournalReader, decision: string, model: string, version: number): Promise<CalibrationMap> {
  const pts = (await samples(reader, decision)).filter((s) => s.outcome && (s.model.reported ?? s.model.id) === model)
    .map((s) => ({ x: Math.round(s.raw * 1000), y: s.outcome === 'Correct' ? 1 : 0 })).sort((a, b) => a.x - b.x);
  if (!pts.length) throw new Error(`no adjudicated ${decision} decision of ${model} to fit a map on`);
  const points = isotonicPoints(pts);
  const body = { decision, version, fittedFor: model, points };
  // The runtime is loaded only by the commands that use it, so `poly check` runs without it.
  const { mapDigest } = await import('@poly/runtime');
  return { ...body, digest: mapDigest(body) };
}
