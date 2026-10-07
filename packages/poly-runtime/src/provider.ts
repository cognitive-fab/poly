// Decision providers (PD1.6, PD1.7, PD2.2, PD3): the effect handler of a decision kind is a provider adapter,
// outside the checked core. It asks the typed question, applies the decision's calibration map to the engine's
// raw probabilities, and returns `{ answer, conf, margin }` in thousandths (PD1.3a) as the effect's result, which
// the manifest maps into the completion. The whole decision record goes to the ledger as a `decision` event, in
// the completion step's transaction (K1, K10); the adapter never writes to the ledger itself.
//
// The model is runtime configuration, never part of what the certificate binds (PD3.1): swapping it changes no
// file of the build.
import { digest } from '@cognitive-fab/polyflow-kernel/digest';

/** What an engine answers: the chosen answer, its distribution over answers, and what it reports about itself. */
export interface ProviderAnswer {
  answer: unknown;
  /** Each answer with its raw probability in [0, 1], the chosen one first. */
  distribution: [unknown, number][];
  /** The model version the provider reports, or null (PD2.2b). */
  reported?: string | null;
  latencyMs?: number;
  cost?: { units: number; unit: string };
  /** PS17.6: the ids of the items the answer cites, for a decision with `cites`. */
  cites?: string[];
  /** PS18.3, K15: a tier's provider reports the tokens it used, by class; the cost is computed from them. */
  usage?: Record<string, number>;
}

/**
 * PF13.3, PS17.2: what a decision reads, given to the provider and never recorded: each Content's body, and each Items'
 * items with their bodies, by parameter.
 */
export interface Materials { bodies: Record<string, string | null>; items: Record<string, { id: string; body: string | null }[]> }

/** The question a provider is asked; a route's tier is also given its name and its token limit (PS18.3, K15). */
export interface ProviderQuestion { decision: string; payload: unknown; intent: string; tier?: string; limits?: { maxTokens: number } }

export type Provider = (question: ProviderQuestion, materials?: Materials) => Promise<ProviderAnswer> | ProviderAnswer;

/** PS17.2: how the runtime gives a decision its materials, and keeps a Content answer as a body with the decision's taint. */
export interface DecisionMemory {
  materials(payload: Record<string, unknown>): Promise<Materials & { taint: unknown }>;
  /** Stores the answer's body with the taint, and gives its Content. */
  answer(body: string, taint: unknown): Promise<string>;
  /** PS17.6: the item set the answer cites, from the ids the provider gave, or a refusal, uncited. */
  cite(given: unknown, ids: unknown, run: string, intent: string): Promise<{ ref: string; count: number }>;
}

/**
 * S356: the one provider poly ships. It replays recorded answers and usage and calls no model: each call is answered by
 * the first recorded entry whose `match` holds every field of the question it names (a tier, a decision, or the
 * question's payload), or fails, as a provider with no answer does. An entry with `fail` fails with that message.
 * `asked` lists the questions, for a test to read.
 */
export interface Recorded { match?: Partial<ProviderQuestion>; answer?: unknown; distribution?: [unknown, number][]; usage?: Record<string, number>; reported?: string | null; fail?: string }
export function recordedProvider(calls: Recorded[]): Provider & { asked: ProviderQuestion[] } {
  const asked: ProviderQuestion[] = [];
  const same = (a: unknown, b: unknown) => digest(a ?? null) === digest(b ?? null);
  const fn = ((q: ProviderQuestion) => {
    asked.push(q);
    const hit = calls.find((c) => Object.entries(c.match ?? {}).every(([k, v]) => same((q as unknown as Record<string, unknown>)[k], v)));
    if (!hit) throw new Error(`no recorded answer for this question (${q.decision}${q.tier ? `, tier ${q.tier}` : ''})`);
    if (hit.fail) throw new Error(hit.fail);
    return { answer: hit.answer, distribution: hit.distribution ?? [[hit.answer, 1]], usage: hit.usage ?? {}, reported: hit.reported ?? null, latencyMs: 0 };
  }) as Provider & { asked: ProviderQuestion[] };
  fn.asked = asked;
  return fn;
}

/** PD1.6: a monotone map from raw to calibrated confidence, in thousandths, fitted for one model of one decision. */
export interface CalibrationMap {
  decision: string;
  version: number;
  /** The model id the map was fitted on (PD1.6b). */
  fittedFor: string;
  digest: string;
  /** Steps of a non-decreasing function: [raw, calibrated], raw ascending; a raw below the first maps to 0. */
  points: [number, number][];
}

export interface ProviderConfig {
  provider: Provider;
  /** The configured model id (PD2.2: model.id); runtime configuration, never certified. */
  model: string;
  calibration?: CalibrationMap | null;
}

/** The digest a map is identified by: its decision, version, model and points. */
export const mapDigest = (m: Omit<CalibrationMap, 'digest'>): string => digest({ decision: m.decision, version: m.version, fittedFor: m.fittedFor, points: m.points });

/** Applies a map (identity when uncalibrated, PD1.6c) to a probability, giving thousandths. */
export function calibrate(map: CalibrationMap | null | undefined, p: number): number {
  const raw = Math.max(0, Math.min(1000, Math.round(p * 1000)));
  if (!map) return raw;
  let out = 0;
  for (const [x, y] of map.points) { if (x <= raw) out = y; else break; }
  return Math.max(0, Math.min(1000, Math.round(out)));
}

export interface DecisionRecord {
  decision: string;
  intent: string;
  provider: string | null;
  model: { id: string; reported: string | null };
  calibration: { version: number; fittedFor: string; digest: string } | { uncalibrated: true };
  /** The question asked, kept in the content store; the event carries its digest as `request` (PD2.2a). */
  question: unknown;
  inputs: string[];
  answer: unknown;
  raw: number;
  conf: number;
  margin: number;
  distribution: [unknown, number][];
  /** PS17.6: the item set the answer cites, by reference, so a step's cites is checked against its record. */
  cites?: { ref: string; count: number };
  latencyMs: number | null;
  cost: { units: number; unit: string } | null;
}

const sameAnswer = (x: unknown, y: unknown): boolean => digest(x ?? null) === digest(y ?? null);

/** The raw probability the distribution gives an answer, 0 when it does not list it (review B3). */
export function answerProbability(distribution: [unknown, number][], answer: unknown): number {
  return distribution.find(([x]) => sameAnswer(x, answer))?.[1] ?? 0;
}

/** The adapter: the effect handler for `decision.<d>`, recording the full record for the ledger by intent id. */
export function decisionHandler(decision: string, providerKind: string | null, config: ProviderConfig, records: Map<string, DecisionRecord>, memory?: { content: boolean; cites: string | null; mem: DecisionMemory }) {
  return async (payload: unknown, _caps: unknown, ctx: { idempotencyKey: string; instanceId?: string }) => {
    const question = { decision, payload, intent: ctx.idempotencyKey };
    const t0 = Date.now();
    // PS17.2: a decision of a program with memory reads its materials; the question recorded holds digests only (S310).
    const m = memory ? await memory.mem.materials((payload ?? {}) as Record<string, unknown>) : null;
    const raw = await config.provider(question, m ? { bodies: m.bodies, items: m.items } : undefined);
    // PS17.2: an answer that is a body is kept in the content store with the decision's taint, and the decision gives
    // its Content; the record and the distribution hold digests, never the body (S310).
    const a = memory?.content ? await (async () => { if (typeof raw.answer !== 'string') throw Object.assign(new Error(`decision ${decision} answers a Content, and the provider gave no text`), { permanent: true }); const d = await memory.mem.answer(raw.answer, m!.taint); return { ...raw, answer: d, distribution: raw.distribution.map(([x, p]): [unknown, number] => [x === raw.answer ? d : digest(x ?? null), p]) }; })() : raw;
    const dist = [...a.distribution].sort((x, y) => y[1] - x[1]);
    // Review B3: conf is the calibrated probability of the answer returned, and margin that probability minus the
    // highest of any other answer, floored at 0; an answer the distribution does not list has probability 0.
    const first = answerProbability(dist, a.answer);
    const second = Math.max(0, ...dist.filter(([x]) => !sameAnswer(x, a.answer)).map(([, p]) => p));
    const conf = calibrate(config.calibration, first);
    const margin = Math.max(0, conf - calibrate(config.calibration, second));
    const map = config.calibration;
    const record: DecisionRecord = {
      decision, intent: ctx.idempotencyKey, provider: providerKind,
      model: { id: config.model, reported: a.reported ?? null },
      calibration: map ? { version: map.version, fittedFor: map.fittedFor, digest: map.digest } : { uncalibrated: true },
      question, inputs: [digest(payload ?? null)],
      answer: a.answer, raw: first, conf, margin, distribution: dist,
      latencyMs: a.latencyMs ?? Date.now() - t0, cost: a.cost ?? null,
    };
    // PS17.6: the citations are checked before the completion; an uncited answer is refused and its failed outcome runs.
    const cited = memory?.cites ? await memory.mem.cite((payload as Record<string, unknown>)?.[memory.cites], raw.cites, ctx.instanceId ?? '', ctx.idempotencyKey) : null;
    if (cited) record.cites = cited as { ref: string; count: number };
    records.set(ctx.idempotencyKey, record);
    return { answer: a.answer, conf, margin, ...(cited ? { cites: cited } : {}) };
  };
}
