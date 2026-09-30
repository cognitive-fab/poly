// Handlers denote functions (PS2) and the transition relation (PS3).
import type * as A from '@poly/core';
import type { RMachine, RType } from './model.js';
import { inCheckDomain } from './model.js';
import { evaluate, evaluateAt, EvalError, type Env, type Verdict } from './eval.js';
import { isMap, isUnion, keyOf, mapSet, type State, type Value } from './values.js';

/**
 * An intent of E (PS2.1), in statement order: an effect (its declared kind and payload), a timer set
 * (`after`, PT6.3) or a timer cancel (`cancel`). `kind` is what a path property counts: the effect's
 * kind, or `timer` and `cancelTimer`, which no effect may declare.
 */
export type Intent =
  | { type: 'effect'; kind: string; payload: Record<string, Value> }
  | { type: 'timer'; kind: 'timer'; key: string; action: string; ms: number; data: Record<string, Value> }
  | { type: 'cancel'; kind: 'cancelTimer'; key: string }
  | { type: 'spawn'; kind: 'spawnChild'; key: string; machineId: string; create: { action: string; data: Record<string, Value> } | null; onComplete: string | null; onParentTerminal: string | null }
  | { type: 'signal'; kind: 'signalChild'; key: string; action: string; data: Record<string, Value> };

/** A duration literal in milliseconds: 200ms, 5s, 2m, 1h (PT2). */
export function durationMs(text: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!m) throw new EvalError(`poly-ref: ${text} is not a duration`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
}

/** h_a(s, d) = accept(w, E) | reject(r) (PS2.1). */
export type HandlerResult = { kind: 'accept'; w: Map<string, Value>; E: Intent[] } | { kind: 'reject'; reason: string };

/** One labelled step of R_M (PS3.1, PS3.2). */
export interface Step {
  verdict: Verdict;
  next: State;
  /** E: the intents of an accepted step; empty for any other verdict (PS3.2, PT6.1). */
  effects: Intent[];
}

/** PS2.2: guards in declaration order, then the body; the first failure rejects. */
export function runHandler(M: RMachine, h: A.Handler, s: State, d: Record<string, Value>): HandlerResult {
  // Guards see the state and the action; parameters only where `action == A` narrows it (PS2.2, S19).
  const guardEnv: Env = { M, state: s, data: d, locals: new Map(), pre: s, action: h.action, params: false };
  for (const g of M.guards) {
    if (evaluate(g.cond, guardEnv) === true) return { kind: 'reject', reason: g.reason };
  }
  // In the handler a bare name is local, then parameter, then field; pre.f names the field (S19).
  const env: Env = { M, state: s, data: d, locals: new Map(), pre: s, action: h.action, params: true };
  const w = new Map<string, Value>();
  const E: Intent[] = [];
  const r = block(h.body, env, w, E, M, s);
  return r ?? { kind: 'accept', w, E };
}

/** Runs a block; returns a rejection, or null when the block completes. */
function block(body: A.Stmt[], outer: Env, w: Map<string, Value>, E: Intent[], M: RMachine, s: State): HandlerResult | null {
  const env: Env = { ...outer, locals: new Map(outer.locals) };
  for (const st of body) {
    switch (st.kind) {
      case 'Require':
        if (evaluate(st.cond, env) !== true) return { kind: 'reject', reason: st.reason };
        break;
      case 'Reject':
        return { kind: 'reject', reason: st.reason };
      case 'Let': {
        env.locals.set(st.name, evaluate(st.expr, env));
        const t = staticType(st.expr, env);
        if (t) (env.localTypes ??= new Map()).set(st.name, t);
        else env.localTypes?.delete(st.name);
        break;
      }
      case 'Assign': {
        const f = M.fields.find((x) => x.name === st.field);
        if (!f) throw new EvalError(`poly-ref: write to undeclared field ${st.field}`);
        write(w, st.field, evaluateAt(st.expr, env, f.type));
        break;
      }
      case 'MapUpdate': {
        // `f' = f with [k] = v` adds f ↦ s(f)[k := v] to w (PS2.2).
        const f = M.fields.find((x) => x.name === st.field)!;
        const m = s[st.field];
        if (!isMap(m) || f.type.k !== 'map') throw new EvalError(`poly-ref: ${st.field} is not a map`);
        write(w, st.field, mapSet(m, evaluate(st.key, env), evaluateAt(st.value, env, f.type.value)));
        break;
      }
      case 'If': {
        const r = block(evaluate(st.cond, env) === true ? st.then : st.else ?? [], env, w, E, M, s);
        if (r) return r;
        break;
      }
      case 'Match': {
        const v = evaluate(st.scrutinee, env);
        // S21, S22: pattern names are read against the scrutinee's own union, which a constructor
        // shared by two unions cannot tell; its static type can.
        const st0 = staticType(st.scrutinee, env);
        const union = st0?.k === 'union' ? st0.name : undefined;
        const arm = st.arms.find((a) => matches(M, a.pattern, v, union));
        // The compiler requires exhaustive arms (PL1501), so a match never falls through.
        if (!arm) throw new EvalError(`poly-ref: no arm of a match covers ${keyOf(v)}`);
        const armEnv: Env = { ...env, locals: new Map(env.locals), localTypes: new Map(env.localTypes ?? []) };
        if (arm.pattern.kind === 'PCtor' && isUnion(v)) {
          for (const f of arm.pattern.fields) {
            if (!f.bind || patternName(M, union, v.ctor, f.name, f.bind) !== 'bind') continue;
            armEnv.locals.set(f.bind, v.payload[f.name]);
            const pt = payloadType(M, union, v.ctor, f.name);
            if (pt) armEnv.localTypes!.set(f.bind, pt);
          }
        }
        const r = block(arm.body, armEnv, w, E, M, s);
        if (r) return r;
        break;
      }
      case 'Intent': {
        // emit, after and cancel append an intent to E (PS2.2); spawn, signal and send come later in M1.
        const args = (params: { name: string; type: RType }[], what: string): Record<string, Value> => {
          const out: Record<string, Value> = {};
          st.args.forEach((a, i) => {
            const p = a.name === null ? params[i] : params.find((x) => x.name === a.name);
            if (!p) throw new EvalError(`poly-ref: ${what} has no parameter ${a.name ?? i}`);
            out[p.name] = evaluateAt(a.value, env, p.type);
          });
          return out;
        };
        if (st.op === 'emit') {
          const eff = M.effects.get(st.target);
          if (!eff) throw new EvalError(`poly-ref: no effect ${st.target}`);
          E.push({ type: 'effect', kind: eff.kind, payload: args(eff.params, st.target) });
        } else if (st.op === 'after') {
          const act = M.actions.find((x) => x.name === st.target);
          if (!act || !st.as || !st.modifier) throw new EvalError(`poly-ref: after … -> ${st.target} is incomplete`);
          E.push({ type: 'timer', kind: 'timer', key: st.as, action: st.target, ms: durationMs(st.modifier), data: args(act.params, st.target) });
        } else if (st.op === 'cancel') {
          E.push({ type: 'cancel', kind: 'cancelTimer', key: st.target });
        } else if (st.op === 'spawn' && st.modifier !== 'detached') {
          const c = M.children.get(st.as ?? '');
          if (!c) throw new EvalError(`poly-ref: no child ${st.as}`);
          const params = c.create ? c.actions.find((a) => a.name === c.create)?.params ?? [] : [];
          E.push({ type: 'spawn', kind: 'spawnChild', key: c.key, machineId: c.machineId, create: c.create ? { action: c.create, data: args(params, c.create) } : null, onComplete: c.onComplete, onParentTerminal: c.onParentTerminal });
        } else if (st.op === 'signal') {
          const c = M.children.get(st.extra[0]);
          if (!c) throw new EvalError(`poly-ref: no child ${st.extra[0]}`);
          const params = c.actions.find((a) => a.name === st.target)?.params ?? [];
          E.push({ type: 'signal', kind: 'signalChild', key: c.key, action: st.target, data: args(params, st.target) });
        } else throw new EvalError(`poly-ref: \`${st.op}\` is not lowered yet`);
        break;
      }
    }
  }
  return null;
}

function write(w: Map<string, Value>, field: string, v: Value): void {
  if (w.has(field)) throw new EvalError(`poly-ref: ${field} written twice on one path (PS2.4)`);
  w.set(field, v);
}

/**
 * What a name in a payload pattern means (PT2.4, S21): a constructor of the payload's type is a
 * literal, `_` ignores the payload, and any other name binds it.
 */
function patternName(M: RMachine, union: string | undefined, ctor: string, payload: string, name: string): 'literal' | 'ignore' | 'bind' {
  if (name === '_') return 'ignore';
  const t = payloadType(M, union, ctor, payload);
  if (t && t.k === 'union' && M.unions.get(t.name)?.ctors.some((c) => c.name === name)) return 'literal';
  return 'bind';
}

/** The declared type of a constructor's payload, in the scrutinee's union when it is known. */
function payloadType(M: RMachine, union: string | undefined, ctor: string, payload: string): RType | undefined {
  const owner = union && M.unions.get(union)?.ctors.some((c) => c.name === ctor) ? union : M.ctors.get(ctor);
  return M.unions.get(owner ?? '')?.ctors.find((c) => c.name === ctor)?.fields.find((f) => f.name === payload)?.type;
}

/**
 * The declared type of an expression where the declarations say it: a field, a parameter, a typed
 * local, `pre.f`, a map entry, or a qualified constructor. Enough to know a match scrutinee's union.
 */
function staticType(e: A.Expr, env: Env): RType | undefined {
  const M = env.M;
  switch (e.kind) {
    case 'Name': {
      if (env.locals.has(e.name)) return env.localTypes?.get(e.name);
      const a = env.action ? M.actions.find((x) => x.name === env.action) : undefined;
      const p = env.params ? a?.params.find((x) => x.name === e.name) : undefined;
      if (p) return p.type;
      return M.fields.find((f) => f.name === e.name)?.type;
    }
    case 'Member': {
      if (e.object.kind === 'Name' && (e.object.name === 'pre' || e.object.name === 'post')) return M.fields.find((f) => f.name === e.prop)?.type;
      if (e.object.kind === 'Name' && M.unions.has(e.object.name)) return { k: 'union', name: e.object.name };
      return undefined;
    }
    case 'Index': {
      const t = staticType(e.object, env);
      return t?.k === 'map' ? t.value : undefined;
    }
    case 'CtorExpr': {
      const dot = e.ctor.indexOf('.');
      return dot >= 0 ? { k: 'union', name: e.ctor.slice(0, dot) } : undefined;
    }
    default:
      return undefined;
  }
}

function matches(M: RMachine, p: A.Pattern, v: Value, union?: string): boolean {
  if (p.kind === 'PWild') return true;
  // S22: a qualified pattern `Type.C` matches the constructor C.
  if (!isUnion(v) || v.ctor !== p.ctor.slice(p.ctor.indexOf('.') + 1)) return false;
  return p.fields.every((f) => {
    if (f.literal !== null) return keyOf(v.payload[f.name]) === keyOf(literal(f.literal));
    if (f.bind && patternName(M, union, v.ctor, f.name, f.bind) === 'literal') return keyOf(v.payload[f.name]) === keyOf({ ctor: f.bind, payload: {} });
    return true;
  });
}

function literal(l: A.Literal): Value {
  return l.kind === 'Name' ? { ctor: l.name, payload: {} } : l.value;
}

/** term(s) (PS1.1, PS1.3). */
export function isTerminal(M: RMachine, s: State): boolean {
  if (!M.terminal) return false;
  return evaluate(M.terminal, { M, state: s, data: {}, locals: new Map() }) === true;
}

/**
 * R_M (PS3.2): for a state s, an action a and data d, the verdict and the
 * next state. The rows apply in the table's order.
 */
export function transition(M: RMachine, s: State, action: string, d: Record<string, Value>): Step {
  if (isTerminal(M, s)) return { verdict: { kind: 'rejected', reason: 'terminal' }, next: s, effects: [] };
  const a = M.actions.find((x) => x.name === action);
  if (!a) throw new EvalError(`poly-ref: no action ${action}`);
  for (const p of a.params) {
    if (p.strict && !inCheckDomain(d[p.name], p, M)) return { verdict: { kind: 'rejected', reason: 'outside-check-domain' }, next: s, effects: [] };
  }
  const h = M.handlers.get(action);
  if (!h) return { verdict: { kind: 'unhandled' }, next: s, effects: [] };
  const r = runHandler(M, h, s, d);
  if (r.kind === 'reject') return { verdict: { kind: 'rejected', reason: r.reason }, next: s, effects: [] };
  // s ⊕ w: every field not written is unchanged (the frame).
  const next: State = {};
  for (const f of M.fieldNames) next[f] = r.w.has(f) ? r.w.get(f)! : s[f];
  return { verdict: { kind: 'accepted' }, next, effects: r.E };
}

/** The initial state: each field's initial value (PS1.1). */
export function initialState(M: RMachine): State {
  const s: State = {};
  const env: Env = { M, state: {}, data: {}, locals: new Map() };
  for (const f of M.fields) s[f.name] = evaluateAt(f.init, env, f.type);
  return s;
}
