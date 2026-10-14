// PS23, PT33: the retry safety of irreversible effects, decided by poly-ref from the semantics, sharing no code with the compiler.
//   PL4003  an effect of class irreversible that may be attempted twice (bound 2 or more) has no guarantee: not keyed (G2), not idempotent by nature in
//           the standard library (G4). The witness is the path to the step that emits it (the prefix) and the path of the outbox model in which the
//           intent starts twice (the delivery, PS23.8). At most once (G1) is a bound of 1, and needs no finding.
//   PL4004  a keyed effect whose retry horizon is longer than its window (PS23.7).
//   PL4005  `idempotent by nature` declared outside the standard library (PS23.4, G4).
//   PL6304  an effect with an egress label and no class (PS23.6).
// Reads the effect declarations through the machine model (model.ts) and the explored graph for the prefix. The manifest entry the runtime reads is
// compared with the same declarations by the read-back of artefacts.ts, so a rule computed here is a rule about what runs (PT33.3).
import type { Diagnostic, Witness, WitnessStep } from '@poly/core';
import type { RMachine } from './model.js';

/** The longest a backoff waits, in milliseconds (the runtime's MAX_BACKOFF_MS, PT9.1). */
const MAX_BACKOFF_MS = 60 * 60_000;
/** The retry written out when an effect declares none (S137). */
export const DEFAULT_RETRY = Object.freeze({ attempts: 5, baseMs: 500, timeoutMs: 30_000 });

/** A duration literal in milliseconds: 500ms, 24h, 7d. */
export function millis(text: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(text);
  if (!m) throw new Error(`poly-ref: ${text} is not a duration`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
}

/** The retry horizon of PS23.7: the backoffs between attempts, then every attempt at its timeout. */
export function horizon(attempts: number, baseMs: number, timeoutMs: number): number {
  let h = attempts * timeoutMs;
  for (let n = 1; n <= attempts - 1; n++) h += Math.min(baseMs * 2 ** (n - 1), MAX_BACKOFF_MS);
  return h;
}

export type Guarantee =
  | { form: 'none' }
  | { form: 'at-most-once' }
  | { form: 'keyed'; header: string; windowMs: number }
  | { form: 'nature'; nature: string };

export interface RetrySafeEntry { kind: string; effect: string; class: string; attempts: number; guarantee: Guarantee }
export interface EffectClassEntry { kind: string; effect: string; class: string | null; labels: string[] }

/** The delivery part of a PL4003 witness (PS23.8, PT33.12). */
function delivery(attempts: number): NonNullable<Witness['delivery']> {
  const step = (action: string) => (action === 'Start' ? { action, target: 'may-execute' as const } : { action });
  const steps = ['Propose', 'GateAllow', 'Start', 'HandlerFailed', 'Start', 'HandlerOk', 'SettleOk'].map(step);
  const unsettled = ['Propose', 'GateAllow', 'Start', 'HandlerOk', 'SettleFailed', 'Start', 'HandlerOk', 'SettleOk'].map(step);
  return { model: `runtime${attempts}.OutboxIntent`, steps, targetExecutions: 2, key: 'unchanged', deduplication: 'none', alsoBy: [{ cause: 'unsettled', steps: unsettled }] };
}

export interface RetrySafety {
  entries: RetrySafeEntry[];
  classes: EffectClassEntry[];
  findings: Diagnostic[];
  /** The kernel assumptions the guarantees rest on: K17 for a keyed effect, K18 for one idempotent by nature. */
  assumptions: string[];
}

/**
 * `reachedBy(kind)` gives the witness steps of the shortest path to the first accepted step that emits an intent of this kind, or null when no reachable
 * step does (PS23.8). `make` builds a Diagnostic of poly-ref's own.
 */
export function retrySafety(
  M: RMachine,
  opts: { std: boolean; reachedBy: (kind: string) => WitnessStep[] | null; make: (code: 'PL4003' | 'PL4004' | 'PL4005' | 'PL6304', node: string | undefined, message: string, trace: WitnessStep[], property: string) => Diagnostic },
): RetrySafety {
  const entries: RetrySafeEntry[] = [], classes: EffectClassEntry[] = [], findings: Diagnostic[] = [], assumptions = new Set<string>();
  for (const e of M.effects.values()) {
    const retry = e.retry ? { attempts: e.retry.attempts, baseMs: millis(e.retry.base), timeoutMs: millis(e.retry.timeout) } : { attempts: DEFAULT_RETRY.attempts, baseMs: DEFAULT_RETRY.baseMs, timeoutMs: DEFAULT_RETRY.timeoutMs };
    const hasEgress = e.labels.some((l) => l === 'egress:external' || l === 'egress:public');
    if (hasEgress) {
      classes.push({ kind: e.kind, effect: e.name, class: e.declaredClass, labels: [...e.labels] });
      if (e.declaredClass === null) findings.push(opts.make('PL6304', e.id, `effect ${e.name} reaches outside the program (${e.labels.filter((l) => l.startsWith('egress:')).join(', ')}) and declares no class; state its class (PS23.6)`, [], e.name));
    }
    if (e.declaredClass !== 'irreversible') continue;
    // The guarantee the declaration gives (PS23.4). A nature declared outside the standard library is not one (PS23.4, G4).
    let guarantee: Guarantee;
    const idem = e.idempotent;
    if (idem?.form === 'header') guarantee = { form: 'keyed', header: idem.header, windowMs: millis(idem.window) };
    else if (idem?.form === 'nature' && opts.std) guarantee = { form: 'nature', nature: idem.reason };
    else guarantee = retry.attempts === 1 ? { form: 'at-most-once' } : { form: 'none' };
    if (idem?.form === 'nature' && !opts.std) findings.push(opts.make('PL4005', e.id, `effect ${e.name} declares itself idempotent by nature; only a module of the standard library may (PS23.4, G4)`, [], e.name));
    if (guarantee.form === 'keyed') {
      assumptions.add('K17');
      const h = horizon(retry.attempts, retry.baseMs, retry.timeoutMs);
      if (h > guarantee.windowMs) findings.push(opts.make('PL4004', e.id, `effect ${e.name} can be retried over ${h} ms (${retry.attempts} attempts, base ${retry.baseMs} ms, timeout ${retry.timeoutMs} ms) and its key window is ${guarantee.windowMs} ms (PS23.7)`, [], e.name));
    }
    if (guarantee.form === 'nature') assumptions.add('K18');
    // A nature declared outside the standard library still states K18 as an assumption the author made.
    if (idem?.form === 'nature' && !opts.std) assumptions.add('K18');
    entries.push({ kind: e.kind, effect: e.name, class: e.declaredClass, attempts: retry.attempts, guarantee });
    if (guarantee.form === 'none' && retry.attempts >= 2) {
      const prefix = opts.reachedBy(e.kind);
      const f = opts.make('PL4003', e.id, `effect ${e.name} is irreversible and may be attempted ${retry.attempts} times with no guarantee that the target executes it once: a lost answer is retried and the target may run it twice (PS23.5)`, prefix ?? [], e.name);
      f.reach = prefix ? 'reached' : 'not-reached-in-instance';
      f.witness!.delivery = delivery(retry.attempts);
      findings.push(f);
    }
  }
  return { entries, classes, findings, assumptions: [...assumptions] };
}
