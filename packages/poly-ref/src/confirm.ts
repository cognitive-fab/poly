// Confirming an engine's witness against the checked instance (PS4.2, PS4.2a).
//
// polygraph explores the lowered module without knowing the instance, so it
// can report a property violated in a state the instance does not contain:
// past a check-domain bound, for example. A finding counts only if every
// state its witness passes through is in Reach(I). If the witness leaves
// the instance first, it is a bound hit, not a finding. If poly-ref, which
// is authoritative inside Reach(I), disagrees about a state inside the
// instance, that is a lowering mismatch (PL2501).
import type { MachineReport } from './check.js';
import { alpha, flattenData } from './alpha.js';
import { evaluate } from './eval.js';
import { stateKey } from './values.js';

/** One step of an engine witness, in the lowered module's flat encoding. */
export interface FlatStep {
  action: string | null;
  data: unknown;
  state: unknown;
}

export interface WitnessToConfirm {
  /** 'state', 'transition' or 'rejection', as polygraph names its invariant kinds. */
  kind: string;
  /** The property's name in the lowered module (a declared name, or domain:/shape:/bound:). */
  property: string;
  path: FlatStep[];
}

export type Confirmation =
  | { status: 'confirmed' }
  | { status: 'outside'; step: number }
  | { status: 'disagrees'; reason: string };

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
};

export function confirmWitness(report: MachineReport, w: WitnessToConfirm): Confirmation {
  const { graph: g, model: M } = report;
  const indexOf = (flat: unknown): number | undefined => {
    try { return g.index.get(stateKey(alpha(flat as Record<string, unknown>, M), M.fieldNames)); } catch { return undefined; }
  };
  const automatic = /^(domain|shape|bound):/.test(w.property);
  // A state violation names the last state; a transition or rejection names the last step, whose
  // pre-state is the one before. An automatic invariant fails by leaving the type or the bound, so its
  // last state is outside the instance by definition; everything before it must be inside.
  const inside = w.kind === 'state' && !automatic ? w.path.length : w.path.length - 1;
  for (let i = 0; i < inside; i++) {
    if (indexOf(w.path[i].state) === undefined) return { status: 'outside', step: i };
  }
  if (w.kind === 'state' && !automatic) {
    const p = M.invariants.find((x) => x.name === w.property);
    if (!p) return { status: 'disagrees', reason: `poly-ref has no invariant ${w.property}` };
    const s = g.states[indexOf(w.path[w.path.length - 1].state)!];
    const holds = evaluate(p.expr, { M, state: s, data: {}, locals: new Map() }) === true;
    return holds ? { status: 'disagrees', reason: `invariant ${w.property} holds in that state by PS5.1` } : { status: 'confirmed' };
  }
  // The last step, from a state inside the instance: find poly-ref's edge for it.
  const from = indexOf(w.path[w.path.length - 2]?.state);
  const last = w.path[w.path.length - 1];
  if (from === undefined || last.action === null) return { status: 'disagrees', reason: 'the witness has no last step' };
  const edge = g.out[from].map((k) => g.edges[k]).find((e) => e.label.action === last.action && stable(flattenData(e.label.data, e.label.action, M)) === stable(last.data));
  if (!edge) return { status: 'disagrees', reason: `poly-ref has no step ${last.action} ${stable(last.data)} from that state` };
  if (automatic) {
    const kind = w.property.startsWith('bound:') ? 'bound' : 'escape';
    return edge.outcome.kind === kind ? { status: 'confirmed' } : { status: 'disagrees', reason: `poly-ref's step leads to a ${edge.outcome.kind}, not a ${kind}` };
  }
  const s = g.states[from];
  if (w.kind === 'transition') {
    const p = M.stepProperties.find((x) => x.name === w.property);
    if (!p) return { status: 'disagrees', reason: `poly-ref has no step property ${w.property}` };
    if (edge.label.verdict.kind !== 'accepted') return { status: 'disagrees', reason: 'the step is not accepted, and a step property sees accepted steps only (PS5.2)' };
    const holds = evaluate(p.expr, { M, state: s, data: edge.label.data, locals: new Map(), pre: s, post: edge.outcome.state, action: edge.label.action }) === true;
    return holds ? { status: 'disagrees', reason: `step property ${w.property} holds on that step by PS5.2` } : { status: 'confirmed' };
  }
  if (w.kind === 'rejection') {
    const p = M.rejectProperties.find((x) => x.name === w.property);
    if (!p) return { status: 'disagrees', reason: `poly-ref has no reject property ${w.property}` };
    const holds = evaluate(p.expr, { M, state: s, data: edge.label.data, locals: new Map(), pre: s, action: edge.label.action, verdict: edge.label.verdict }) === true;
    return holds ? { status: 'disagrees', reason: `reject property ${w.property} holds on that step by PS5.3` } : { status: 'confirmed' };
  }
  return { status: 'disagrees', reason: `unknown witness kind ${w.kind}` };
}
