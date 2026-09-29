// Expressions (PT2.2, PS2.3, PS2.5, PS12).
//
// Every expression reads the pre-state and the data only; a primed field is
// write-only (PS2.3). Every operator is total on well-typed operands:
// integer division truncates toward zero and `%` takes the sign of the
// dividend (PS2.5, S12). A name is looked up in this order: local binding,
// parameter, field, constructor, `none`.
import type * as A from '@poly/core';
import type { RMachine } from './model.js';
import { equal, isUnion, isMap, keyOf, mapGet, type State, type Value } from './values.js';
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
}

export class EvalError extends Error {}

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
      if (e.object.kind === 'Name' && e.object.name === 'pre' && env.pre) return field(env.pre, e.prop);
      if (e.object.kind === 'Name' && e.object.name === 'post' && env.post) return field(env.post, e.prop);
      // S22: `Type.C`, a constructor named with its type.
      if (e.object.kind === 'Name' && env.M.unions.get(e.object.name)?.ctors.some((c) => c.name === e.prop)) return { ctor: e.prop, payload: {} };
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
      throw new EvalError(`poly-ref: no function ${e.callee} in this context`);
    }
    case 'Unary': {
      const v = evaluate(e.arg, env);
      return e.op === '!' ? !truth(v, '!') : -int(v, 'unary -');
    }
    case 'Binary': return binary(e, env);
    case 'Is': {
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
  throw new EvalError(`poly-ref: unknown name ${name}`);
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
      else eq = equal(evaluate(e.left, env), evaluate(e.right, env));
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
