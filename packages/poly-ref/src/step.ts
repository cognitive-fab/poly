// Handlers denote functions (PS2) and the transition relation (PS3).
import type * as A from '@poly/core';
import type { RMachine } from './model.js';
import { inCheckDomain } from './model.js';
import { evaluate, evaluateAt, EvalError, type Env, type Verdict } from './eval.js';
import { isMap, isUnion, keyOf, mapSet, type State, type Value } from './values.js';

/** h_a(s, d) = accept(w, E) | reject(r) (PS2.1). E is empty in M0: no intents are lowered yet. */
export type HandlerResult = { kind: 'accept'; w: Map<string, Value> } | { kind: 'reject'; reason: string };

/** One labelled step of R_M (PS3.1, PS3.2). */
export interface Step {
  verdict: Verdict;
  next: State;
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
  const r = block(h.body, env, w, M, s);
  return r ?? { kind: 'accept', w };
}

/** Runs a block; returns a rejection, or null when the block completes. */
function block(body: A.Stmt[], outer: Env, w: Map<string, Value>, M: RMachine, s: State): HandlerResult | null {
  const env: Env = { ...outer, locals: new Map(outer.locals) };
  for (const st of body) {
    switch (st.kind) {
      case 'Require':
        if (evaluate(st.cond, env) !== true) return { kind: 'reject', reason: st.reason };
        break;
      case 'Reject':
        return { kind: 'reject', reason: st.reason };
      case 'Let':
        env.locals.set(st.name, evaluate(st.expr, env));
        break;
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
        const r = block(evaluate(st.cond, env) === true ? st.then : st.else ?? [], env, w, M, s);
        if (r) return r;
        break;
      }
      case 'Match': {
        const v = evaluate(st.scrutinee, env);
        const arm = st.arms.find((a) => matches(M, a.pattern, v));
        // The compiler requires exhaustive arms (PL1501), so a match never falls through.
        if (!arm) throw new EvalError(`poly-ref: no arm of a match covers ${keyOf(v)}`);
        const armEnv: Env = { ...env, locals: new Map(env.locals) };
        if (arm.pattern.kind === 'PCtor' && isUnion(v)) {
          for (const f of arm.pattern.fields) if (f.bind && patternName(M, v.ctor, f.name, f.bind) === 'bind') armEnv.locals.set(f.bind, v.payload[f.name]);
        }
        const r = block(arm.body, armEnv, w, M, s);
        if (r) return r;
        break;
      }
      case 'Intent':
        throw new EvalError(`poly-ref: \`${st.op}\` is not in milestone M0`);
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
function patternName(M: RMachine, ctor: string, payload: string, name: string): 'literal' | 'ignore' | 'bind' {
  if (name === '_') return 'ignore';
  const t = M.unions.get(M.ctors.get(ctor) ?? '')?.ctors.find((c) => c.name === ctor)?.fields.find((f) => f.name === payload)?.type;
  if (t && t.k === 'union' && M.unions.get(t.name)?.ctors.some((c) => c.name === name)) return 'literal';
  return 'bind';
}

function matches(M: RMachine, p: A.Pattern, v: Value): boolean {
  if (p.kind === 'PWild') return true;
  if (!isUnion(v) || v.ctor !== p.ctor) return false;
  return p.fields.every((f) => {
    if (f.literal !== null) return keyOf(v.payload[f.name]) === keyOf(literal(f.literal));
    if (f.bind && patternName(M, v.ctor, f.name, f.bind) === 'literal') return keyOf(v.payload[f.name]) === keyOf({ ctor: f.bind, payload: {} });
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
  if (isTerminal(M, s)) return { verdict: { kind: 'rejected', reason: 'terminal' }, next: s };
  const a = M.actions.find((x) => x.name === action);
  if (!a) throw new EvalError(`poly-ref: no action ${action}`);
  for (const p of a.params) {
    if (p.strict && !inCheckDomain(d[p.name], p, M)) return { verdict: { kind: 'rejected', reason: 'outside-check-domain' }, next: s };
  }
  const h = M.handlers.get(action);
  if (!h) return { verdict: { kind: 'unhandled' }, next: s };
  const r = runHandler(M, h, s, d);
  if (r.kind === 'reject') return { verdict: { kind: 'rejected', reason: r.reason }, next: s };
  // s ⊕ w: every field not written is unchanged (the frame).
  const next: State = {};
  for (const f of M.fieldNames) next[f] = r.w.has(f) ? r.w.get(f)! : s[f];
  return { verdict: { kind: 'accepted' }, next };
}

/** The initial state: each field's initial value (PS1.1). */
export function initialState(M: RMachine): State {
  const s: State = {};
  const env: Env = { M, state: {}, data: {}, locals: new Map() };
  for (const f of M.fields) s[f.name] = evaluateAt(f.init, env, f.type);
  return s;
}
