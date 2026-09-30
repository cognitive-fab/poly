// Expressions (PT2.2, PS2.3, PS2.5, PS12).
//
// Every expression reads the pre-state and the data only; a primed field is
// write-only (PS2.3). Every operator is total on well-typed operands:
// integer division truncates toward zero and `%` takes the sign of the
// dividend (PS2.5, S12). A name is looked up in this order: local binding,
// parameter, field, constructor, `none`.
import type * as A from '@poly/core';
import type { RMachine } from './model.js';
import { equal, isUnion, isMap, isRecord, keyOf, mapGet, type State, type Value } from './values.js';
import { valuesOf } from './model.js';

/** A step's verdict kind as a reject property sees it (PS5.3). */
export interface Verdict {
  kind: 'accepted' | 'rejected' | 'unhandled';
  reason?: string;
}

export interface Env {
  M: RMachine;
  /** The state bare field names read: the pre-state (PS2.3). */
  state: State;
  data: Record<string, Value>;
  locals: Map<string, Value>;
  /** Step and reject properties (PS5.2, PS5.3). */
  pre?: State;
  post?: State;
  action?: string;
  verdict?: Verdict;
  /**
   * Whether the action's parameters are visible (PS2.2, S19): always in a handler; in a guard, step or
   * reject property only on the right of a conjunct `action == A` that holds.
   */
  params?: boolean;
  /** The instance's own address, `self` (PS2.2): its name in a configuration, "self" for a machine checked alone. */
  self?: string;
  /** Inside an aggregate, the family index `[*]` stands for (S49). */
  star?: number;
  /** A compose invariant's joint state (PS7.1, PT7): the parent's state and each spawned child's. */
  joint?: { parent: State; children: Map<string, State> };
  /** A configuration property's global state σ (PS13.6). */
  global?: GlobalView;
  /** Declared types of local names, where known: pattern binders and lets (for match scrutinees, S21, S22). */
  localTypes?: Map<string, import('./model.js').RType>;
}

/** σ as a configuration property reads it (PS13.6): each instance by name (`inv`, `order[0]`), and the groups. */
export interface GlobalView {
  instance(name: string): { M: RMachine; state: State } | undefined;
  /** Each group's size: `order[2]` is `order` with 2. */
  groups: Map<string, number>;
  /** The initial global state, which `init(e)` reads. */
  initial: GlobalView | null;
}

export class EvalError extends Error {}

/** The instance a configuration expression names: `x`, `g[i]`, or `g[*]` inside an aggregate (S32). */
function instanceOf(e: A.Expr, env: Env): { M: RMachine; state: State } | undefined {
  const g = env.global;
  if (!g) return undefined;
  if (e.kind === 'Name' && !env.locals.has(e.name)) return g.instance(e.name);
  if (e.kind === 'Index' && e.object.kind === 'Name' && g.groups.has(e.object.name)) {
    const k = e.index.kind === 'Star' ? env.star : int(evaluate(e.index, env), 'an index');
    if (k === undefined) throw new EvalError('poly-ref: g[*] outside an aggregate (PS13.6)');
    return g.instance(`${e.object.name}[${k}]`);
  }
  return undefined;
}

/** The group an aggregate reads with `g[*]` (PS13.6). */
function starGroup(e: A.Expr, g: GlobalView): string | null {
  let found: string | null = null;
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object' || found) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as A.Expr;
    if (n.kind === 'Index' && n.index.kind === 'Star' && n.object.kind === 'Name' && g.groups.has(n.object.name)) { found = n.object.name; return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'span') walk(v);
  };
  walk(e);
  return found;
}

/** The family an aggregate's expression reads with `[*]` (S49). */
function starFamily(e: A.Expr): string | null {
  let found: string | null = null;
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object' || found) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as A.Expr;
    if (n.kind === 'Index' && n.index.kind === 'Star' && n.object.kind === 'Member') { found = n.object.prop; return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'span') walk(v);
  };
  walk(e);
  return found;
}

const truth = (v: Value, what: string): boolean => {
  if (typeof v !== 'boolean') throw new EvalError(`poly-ref: ${what} is not a Bool`);
  return v;
};
const int = (v: Value, what: string): number => {
  if (typeof v !== 'number') throw new EvalError(`poly-ref: ${what} is not an int`);
  return v;
};

export function evaluate(e: A.Expr, env: Env): Value {
  switch (e.kind) {
    case 'Int': return e.value;
    case 'Bool': return e.value;
    case 'String': return e.value;
    case 'Primed': throw new EvalError(`poly-ref: ${e.name}' is write-only (PS2.3)`);
    case 'Name': return lookup(e.name, env);
    case 'Member': {
      // S32: x.f and g[i].f, a field of an instance in σ.
      const inst = instanceOf(e.object, env);
      if (inst) return field(inst.state, e.prop);
      if (e.object.kind === 'Name' && e.object.name === 'pre' && env.pre) return field(env.pre, e.prop);
      if (e.object.kind === 'Name' && e.object.name === 'post' && env.post) return field(env.post, e.prop);
      // PT7: parent.f and children.k.f name fields of the joint state; S48 guarantees k is spawned.
      if (env.joint && e.object.kind === 'Name' && e.object.name === 'parent') return field(env.joint.parent, e.prop);
      // S49: children.f[i].x, and children.f[*].x inside an aggregate.
      if (env.joint && e.object.kind === 'Index' && e.object.object.kind === 'Member' && e.object.object.object.kind === 'Name' && e.object.object.object.name === 'children') {
        const k = e.object.index.kind === 'Star' ? env.star : int(evaluate(e.object.index, env), 'an index');
        if (k === undefined) throw new EvalError('poly-ref: [*] outside an aggregate');
        const child = env.joint.children.get(`${e.object.object.prop}${k}`);
        if (!child) throw new EvalError(`poly-ref: child ${e.object.object.prop}${k} is read before it is spawned (S48)`);
        return field(child, e.prop);
      }
      if (env.joint && e.object.kind === 'Member' && e.object.object.kind === 'Name' && e.object.object.name === 'children') {
        const child = env.joint.children.get(e.object.prop);
        if (!child) throw new EvalError(`poly-ref: child ${e.object.prop} is read before it is spawned (S48)`);
        return field(child, e.prop);
      }
      // S22: `Type.C`, a constructor named with its type.
      if (e.object.kind === 'Name' && env.M.unions.get(e.object.name)?.ctors.some((c) => c.name === e.prop)) return { ctor: e.prop, payload: {} };
      // S25: `r.f`, a field of a record value.
      const r = evaluate(e.object, env);
      if (isRecord(r)) {
        if (!(e.prop in r.fields)) throw new EvalError(`poly-ref: no field ${e.prop}`);
        return r.fields[e.prop];
      }
      throw new EvalError(`poly-ref: .${e.prop} outside a step or reject property`);
    }
    case 'Index': {
      const m = evaluate(e.object, env);
      if (!isMap(m)) throw new EvalError('poly-ref: indexing a value that is not a map');
      return mapGet(m, evaluate(e.index, env));
    }
    case 'Call': {
      if (e.callee === 'rejected' && env.verdict && e.args.length === 1 && e.args[0].kind === 'String') {
        // PS5.3: `rejected(r)` is true iff the step's verdict is rejected(r).
        return env.verdict.kind === 'rejected' && env.verdict.reason === e.args[0].value;
      }
      // PS13.6: count, sum, all and any over the members of one group; init(e) in the initial global state.
      if (env.global && ['count', 'sum', 'all', 'any'].includes(e.callee)) {
        const grp = starGroup(e.args[0], env.global);
        if (!grp) throw new EvalError(`poly-ref: ${e.callee} over no group`);
        const vals: Value[] = [];
        for (let k = 0; k < env.global.groups.get(grp)!; k++) vals.push(evaluate(e.args[0], { ...env, star: k }));
        if (e.callee === 'count') return vals.filter((v) => truth(v, 'count')).length;
        if (e.callee === 'sum') return vals.reduce<number>((a, v) => a + int(v, 'sum'), 0);
        if (e.callee === 'all') return vals.every((v) => truth(v, 'all'));
        return vals.some((v) => truth(v, 'any'));
      }
      if (env.global && e.callee === 'init') return evaluate(e.args[0], { ...env, global: env.global.initial ?? env.global });
      // S49: count, sum, all and any over the spawned members of one family.
      if (env.joint && ['count', 'sum', 'all', 'any'].includes(e.callee)) {
        const fam = starFamily(e.args[0]);
        const r = fam ? env.M.families.get(fam) : undefined;
        if (!fam || !r) throw new EvalError(`poly-ref: ${e.callee} over no family`);
        const vals: Value[] = [];
        for (let k = r.lo; k <= r.hi; k++) if (env.joint.children.has(`${fam}${k}`)) vals.push(evaluate(e.args[0], { ...env, star: k }));
        if (e.callee === 'count') return vals.filter((v) => truth(v, 'count')).length;
        if (e.callee === 'sum') return vals.reduce<number>((a, v) => a + int(v, 'sum'), 0);
        if (e.callee === 'all') return vals.every((v) => truth(v, 'all'));
        return vals.some((v) => truth(v, 'any'));
      }
      throw new EvalError(`poly-ref: no function ${e.callee} in this context`);
    }
    case 'Spawned': {
      if (!env.joint) throw new EvalError(`poly-ref: ${e.key} spawned outside a compose invariant`);
      return env.joint.children.has(e.index ? `${e.key}${int(evaluate(e.index, env), 'an index')}` : e.key);
    }
    case 'Quant': {
      // PS13.6: forall and exists over the members of a group of a configuration.
      if (env.global?.groups.has(e.group)) {
        for (let k = 0; k < env.global.groups.get(e.group)!; k++) {
          const inner: Env = { ...env, locals: new Map(env.locals) };
          inner.locals.set(e.var, k);
          const v = truth(evaluate(e.body, inner), e.q);
          if (e.q === 'forall' && !v) return false;
          if (e.q === 'exists' && v) return true;
        }
        return e.q === 'forall';
      }
      // S49: forall and exists over the indices of a family.
      const r = env.M.families.get(e.group);
      if (!r) throw new EvalError(`poly-ref: no family ${e.group}`);
      for (let k = r.lo; k <= r.hi; k++) {
        const inner: Env = { ...env, locals: new Map(env.locals) };
        inner.locals.set(e.var, k);
        const v = truth(evaluate(e.body, inner), e.q);
        if (e.q === 'forall' && !v) return false;
        if (e.q === 'exists' && v) return true;
      }
      return e.q === 'forall';
    }
    case 'Star':
      throw new EvalError('poly-ref: [*] outside an aggregate');
    case 'Unary': {
      const v = evaluate(e.arg, env);
      return e.op === '!' ? !truth(v, '!') : -int(v, 'unary -');
    }
    case 'Binary': return binary(e, env);
    case 'Is': {
      // S32: `g[i] is C` tests the one field of the instance's machine whose type has the constructor C.
      const inst = instanceOf(e.expr, env);
      if (inst) {
        const f = inst.M.fields.find((x) => x.type.k === 'union' && inst.M.unions.get(x.type.name)!.ctors.some((c) => c.name === e.ctors[0]));
        if (!f) throw new EvalError(`poly-ref: no field of ${inst.M.name} has the constructor ${e.ctors[0]}`);
        const fv = inst.state[f.name];
        return isUnion(fv) && e.ctors.includes(fv.ctor);
      }
      const v = evaluate(e.expr, env);
      if (!isUnion(v)) throw new EvalError('poly-ref: `is` on a value that is not a union');
      return e.ctors.includes(v.ctor);
    }
    case 'In': {
      const v = evaluate(e.expr, env);
      return e.set.some((x) => equal(v, evaluate(x, env)));
    }
    case 'CtorExpr': {
      const payload: Record<string, Value> = {};
      for (const f of e.fields) payload[f.name] = evaluate(f.value, env);
      return { ctor: e.ctor.slice(e.ctor.indexOf('.') + 1), payload };
    }
    case 'MapLit':
    case 'ArrayLit':
      throw new EvalError('poly-ref: a map literal needs its map type; it is evaluated with evaluateAt');
  }
}

/** Evaluate an expression whose map literals take their keys from a known type (initial values). */
export function evaluateAt(e: A.Expr, env: Env, type: import('./model.js').RType): Value {
  if (e.kind === 'MapLit' && type.k === 'map') {
    const keys = valuesOf(type.key, env.M);
    const given = new Map(e.entries.map((en) => [keyOf(evaluateAt(en.key, env, type.key)), en.value]));
    return { entries: keys.map((k) => [k, evaluateAt(given.get(keyOf(k))!, env, type.value)] as [Value, Value]) };
  }
  if (e.kind === 'MapLit' && type.k === 'record') {
    // S25: a record literal lists every field; the checker proved it.
    const fields: Record<string, Value> = {};
    for (const f of env.M.records.get(type.name)!.fields) {
      const en = e.entries.find((x) => x.key.kind === 'Name' && x.key.name === f.name)!;
      fields[f.name] = evaluateAt(en.value, env, f.type);
    }
    return { fields };
  }
  if (e.kind === 'ArrayLit' && type.k === 'map') {
    const keys = valuesOf(type.key, env.M);
    return { entries: keys.map((k, i) => [k, evaluateAt(e.items[i], env, type.value)] as [Value, Value]) };
  }
  if (e.kind === 'CtorExpr' && type.k === 'union') {
    const name = e.ctor.slice(e.ctor.indexOf('.') + 1);
    const c = env.M.unions.get(type.name)!.ctors.find((x) => x.name === name);
    if (c) {
      const payload: Record<string, Value> = {};
      for (const f of e.fields) payload[f.name] = evaluateAt(f.value, env, c.fields.find((x) => x.name === f.name)!.type);
      return { ctor: name, payload };
    }
  }
  return evaluate(e, env);
}

function field(s: State, name: string): Value {
  if (!(name in s)) throw new EvalError(`poly-ref: no field ${name}`);
  return s[name];
}

/**
 * The environment for the right of `L && R` or `L implies R`, where L has held. If L has a conjunct
 * `action == A`, the action is A there, so its parameters become visible (PS2.2, S19).
 */
function narrowed(left: A.Expr, env: Env): Env {
  if (env.params) return env;
  return establishes(left) ? { ...env, params: true } : env;
}

function establishes(e: A.Expr): boolean {
  if (e.kind === 'Binary' && e.op === '==') {
    const isAction = (x: A.Expr) => x.kind === 'Name' && x.name === 'action';
    return isAction(e.left) || isAction(e.right);
  }
  return e.kind === 'Binary' && e.op === '&&' && (establishes(e.left) || establishes(e.right));
}

function lookup(name: string, env: Env): Value {
  if (env.locals.has(name)) return env.locals.get(name)!;
  if (env.params && name in env.data) return env.data[name];
  if (name in env.state) return env.state[name];
  if (env.M.ctors.has(name)) return { ctor: name, payload: {} };
  if (name === 'none') return null;
  if (name === 'self') return env.self ?? 'self';
  throw new EvalError(`poly-ref: unknown name ${name}`);
}

/**
 * The two sides of an equality. A record or map literal takes its type from the other side (S25), as the
 * checker typed it: the other side is evaluated first, and the literal is read in its shape.
 */
function operands(l: A.Expr, r: A.Expr, env: Env): [Value, Value] {
  const lit = (x: A.Expr) => x.kind === 'MapLit' || x.kind === 'ArrayLit';
  if (lit(r) && !lit(l)) { const a = evaluate(l, env); return [a, literalLike(r, a, env)]; }
  if (lit(l) && !lit(r)) { const b = evaluate(r, env); return [literalLike(l, b, env), b]; }
  return [evaluate(l, env), evaluate(r, env)];
}

function literalLike(e: A.Expr, like: Value, env: Env): Value {
  if (e.kind === 'MapLit' && isRecord(like)) {
    return { fields: Object.fromEntries(e.entries.map((en) => [(en.key as A.NameRef).name, evaluate(en.value, env)])) };
  }
  if (e.kind === 'MapLit' && isMap(like)) {
    const byKey = new Map(e.entries.map((en) => [keyOf(evaluate(en.key, env)), en.value]));
    return { entries: like.entries.map(([k]) => [k, evaluate(byKey.get(keyOf(k))!, env)] as [Value, Value]) };
  }
  if (e.kind === 'ArrayLit' && isMap(like)) return { entries: like.entries.map(([k], i) => [k, evaluate(e.items[i], env)] as [Value, Value]) };
  throw new EvalError('poly-ref: a literal compared with a value of another shape');
}

function binary(e: A.Binary, env: Env): Value {
  switch (e.op) {
    case '&&': return truth(evaluate(e.left, env), '&&') && truth(evaluate(e.right, narrowed(e.left, env)), '&&');
    case '||': return truth(evaluate(e.left, env), '||') || truth(evaluate(e.right, env), '||');
    case 'implies': return !truth(evaluate(e.left, env), 'implies') || truth(evaluate(e.right, narrowed(e.left, env)), 'implies');
    case '==':
    case '!=': {
      // `action == A` in step and reject properties compares the step's action by name (PT5, S15).
      let eq: boolean;
      const actionSide = (x: A.Expr) => x.kind === 'Name' && x.name === 'action' && env.action !== undefined;
      if (actionSide(e.left) && e.right.kind === 'Name') eq = env.action === e.right.name;
      else if (actionSide(e.right) && e.left.kind === 'Name') eq = env.action === e.left.name;
      else eq = equal(...operands(e.left, e.right, env));
      return e.op === '==' ? eq : !eq;
    }
    default: {
      const a = int(evaluate(e.left, env), e.op);
      const b = int(evaluate(e.right, env), e.op);
      switch (e.op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
          if (b === 0) throw new EvalError('poly-ref: division by zero (the compiler refuses a divisor that may be 0, PL1204)');
          return Math.trunc(a / b);
        case '%':
          if (b === 0) throw new EvalError('poly-ref: division by zero (PL1204)');
          return a % b;
      }
    }
  }
  throw new EvalError(`poly-ref: unknown operator ${e.op}`);
}
