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
}

export type Provider = (question: { decision: string; payload: unknown; intent: string }) => Promise<ProviderAnswer> | ProviderAnswer;

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
  latencyMs: number | null;
  cost: { units: number; unit: string } | null;
}

const sameAnswer = (x: unknown, y: unknown): boolean => digest(x ?? null) === digest(y ?? null);

/** The raw probability the distribution gives an answer, 0 when it does not list it (review B3). */
export function answerProbability(distribution: [unknown, number][], answer: unknown): number {
  return distribution.find(([x]) => sameAnswer(x, answer))?.[1] ?? 0;
}

/** The adapter: the effect handler for `decision.<d>`, recording the full record for the ledger by intent id. */
export function decisionHandler(decision: string, providerKind: string | null, config: ProviderConfig, records: Map<string, DecisionRecord>) {
  return async (payload: unknown, _caps: unknown, ctx: { idempotencyKey: string }) => {
    const question = { decision, payload, intent: ctx.idempotencyKey };
    const t0 = Date.now();
    const a = await config.provider(question);
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
    records.set(ctx.idempotencyKey, record);
    return { answer: a.answer, conf, margin };
  };
}
