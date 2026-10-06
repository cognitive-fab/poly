// Vacuous properties (PT12.3, S113, S128). A property whose antecedent is never true where it is judged holds
// for no reason the program gives, so it is INCONCLUSIVE with reason `vacuous`, never CLEAN.
//
// The antecedent of an implication is the conjunction of the left sides along its right spine (`a implies b
// implies c` has `a && b`). A conjunction is judged conjunct by conjunct. A quantifier at the top is judged per
// member: `forall` for every member, `exists` for some. An implication under any other operator is not judged.
import type { Expr, Binary, Stmt } from '@poly/core';
import { evaluate, type Env } from './eval.js';

export interface Antecedent {
  /** The left sides along the right spine, in order. */
  parts: Expr[];
  /** The quantifier the implication sits under, if any. */
  quant: { q: 'forall' | 'exists'; var: string; group: string } | null;
}

/** One vacuous property: its name, its AST node, the antecedent never true, and the member it was never true for. */
export interface Vacuous {
  property: string;
  id: string;
  /** The antecedent's parts, to be printed as one conjunction; empty when `text` says what was never seen. */
  parts: Expr[];
  /** For a path property clause, what was never seen, in words. */
  text?: string;
  member?: number;
}

/**
 * Deliberately broken checks, for one test each (ruled on M8 plan step 10): a channel's configuration that offers no
 * timer firing, one that fires a disarmed timer, and the vacuity of a never judged by the weak measure. Ruled on the
 * review of M8b (A-F2): a channel's configuration with the instance bound two, or the transit bound N, whatever the
 * application's channels.
 */
export const REF_FAULTS = ['no-timer-firing', 'fire-disarmed', 'weak-vacuity', 'instance-bound-two', 'transit-bound-n'] as const;
export type RefFault = (typeof REF_FAULTS)[number];

/** PS5.2a: a never's `while` (null without one) and its effect, read back from the step property it lowers to. */
export function neverParts(p: { expr: Expr }): { cond: Expr | null; effect: string } {
  const e = p.expr;
  if (e.kind === 'Binary' && e.op === 'implies') return { cond: e.left, effect: ((e.right as { arg: { effect: string } }).arg).effect };
  return { cond: null, effect: ((e as unknown as { arg: { effect: string } }).arg).effect };
}

/** PS5.2a: the actions whose handler can emit the effect: an `emit` of it on some path of the body. */
export function emittingActions(handlers: Map<string, { body: Stmt[] }>, effect: string): Set<string> {
  const has = (body: Stmt[]): boolean => body.some((s) =>
    (s.kind === 'Intent' && s.op === 'emit' && s.target === effect)
    || (s.kind === 'If' && (has(s.then) || has(s.else ?? [])))
    || (s.kind === 'Match' && s.arms.some((a) => has(a.body)))
    || (s.kind === 'For' && has(s.body)));
  return new Set([...handlers].filter(([, h]) => has(h.body)).map(([a]) => a));
}

export function antecedents(e: Expr): Antecedent[] {
  if (e.kind === 'Binary' && e.op === '&&') return [...antecedents(e.left), ...antecedents(e.right)];
  if (e.kind === 'Quant') return antecedents(e.body).filter((a) => !a.quant).map((a) => ({ ...a, quant: { q: e.q, var: e.var, group: e.group } }));
  if (e.kind === 'Binary' && e.op === 'implies') {
    const parts: Expr[] = [];
    let x: Expr = e;
    while (x.kind === 'Binary' && x.op === 'implies') { parts.push(x.left); x = x.right; }
    return [{ parts, quant: null }];
  }
  return [];
}

/** The parts as one left-nested conjunction, so evaluation short-circuits as the implication does (S19). */
export function conjunction(parts: Expr[]): Expr {
  return parts.slice(1).reduce<Expr>((l, r) => ({ kind: 'Binary', id: '', op: '&&', left: l, right: r } as Binary), parts[0]);
}

/** True when `e` holds in `env`; an expression that cannot be read there (an absent instance, S60) does not hold. */
function holds(e: Expr, env: Env): boolean {
  try { return evaluate(e, env) === true; } catch { return false; }
}

/**
 * The members an antecedent is judged for: the group's members (a configuration) or the family's indices
 * (a machine, S49), as `members(env)` gives them in one environment.
 */
export type Members = (env: Env, group: string) => number[];

/**
 * Judges one antecedent over the environments where its property is judged. Returns null when it is true
 * somewhere, or the vacuous record (with the first member never satisfied, for a `forall`).
 */
export function judge(a: Antecedent, envs: () => Iterable<Env>, members: Members): { member?: number } | null {
  const c = conjunction(a.parts);
  if (!a.quant) {
    for (const env of envs()) if (holds(c, env)) return null;
    return {};
  }
  const q = a.quant;
  const seen = new Set<number>();
  const all = new Set<number>();
  for (const env of envs()) {
    for (const k of members(env, q.group)) {
      all.add(k);
      if (seen.has(k)) continue;
      const inner: Env = { ...env, locals: new Map(env.locals) };
      inner.locals.set(q.var, k);
      if (holds(c, inner)) seen.add(k);
    }
  }
  if (q.q === 'exists') return seen.size ? null : {};
  // forall: every member that ever exists must see its antecedent; a member never created is no evidence (S60).
  const missing = [...all].sort((x, y) => x - y).find((k) => !seen.has(k));
  return missing === undefined ? (all.size ? null : {}) : { member: missing };
}

