// The machine tuple M = (F, init, A, H, G, term) of PS1.1, read from the AST.
//
// poly-ref reads the AST through `import type` only (PS9.3): it resolves
// types, builds domains and finds handlers itself, from the definitions in
// 04-semantics, sharing nothing with the compiler's checker.
import type * as A from '@poly/core';
import type { MapValue, UnionValue, Value } from './values.js';
import { keyOf, isUnion, isMap } from './values.js';

/** Types as PS1.4 lists them. */
export type RType =
  | { k: 'bool' }
  | { k: 'int'; lo: number; hi: number } // unbounded int: ±Infinity
  | { k: 'string' }
  | { k: 'union'; name: string }
  | { k: 'map'; key: RType; value: RType }
  | { k: 'ref' };

export interface RUnion {
  name: string;
  ctors: { name: string; fields: { name: string; type: RType }[] }[];
}

export interface RField {
  name: string;
  type: RType;
  /** D(f): the check domain, or null when it is the whole (finite) type. */
  check: Value[] | null;
  init: A.Expr;
}

export interface RParam {
  name: string;
  type: RType;
  check: Value[] | null;
  strict: boolean;
}

export interface RAction {
  name: string;
  params: RParam[];
}

/** An effect declaration (PT6.1): the kind its intents carry, its class, and its payload's parameters. */
export interface REffect {
  name: string;
  kind: string;
  cls: string;
  params: { name: string; type: RType }[];
}

/**
 * A path property (PS5.4) as a conjunction of bounds `count(kind) <= max`. The compiler accepts no other
 * form yet (S37); poly-ref reads the form from the AST itself and refuses anything else.
 */
export interface RPathProperty {
  name: string;
  id: string;
  bounds: { kind: string; max: number }[];
}

export interface RMachine {
  name: string;
  service: boolean;
  effects: Map<string, REffect>;
  pathProperties: RPathProperty[];
  unions: Map<string, RUnion>;
  /** Constructor name to its union. */
  ctors: Map<string, string>;
  fields: RField[];
  fieldNames: string[];
  actions: RAction[];
  handlers: Map<string, A.Handler>;
  guards: A.Guard[];
  terminal: A.Expr | null;
  invariants: A.Property[];
  stepProperties: A.Property[];
  rejectProperties: A.Property[];
}

export function buildMachine(module: A.Module, machineName: string): RMachine {
  const unions = new Map<string, RUnion>();
  const ctors = new Map<string, string>();
  const decls = module.decls;
  // Types first: a union's payload types may name other unions.
  const typeOf = (t: A.TypeExpr): RType => {
    switch (t.kind) {
      case 'TBool': return { k: 'bool' };
      case 'TInt': return { k: 'int', lo: -Infinity, hi: Infinity };
      case 'TString': return { k: 'string' };
      case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
      case 'TName': return { k: 'union', name: t.name };
      case 'TMap': return { k: 'map', key: typeOf(t.key), value: typeOf(t.value) };
      case 'TRef': return { k: 'ref' };
    }
  };
  for (const d of decls) {
    if (d.kind === 'EnumDecl') unions.set(d.name, { name: d.name, ctors: d.members.map((m) => ({ name: m, fields: [] })) });
    if (d.kind === 'TypeDecl') unions.set(d.name, { name: d.name, ctors: d.ctors.map((c) => ({ name: c.name, fields: c.fields.map((f) => ({ name: f.name, type: typeOf(f.type) })) })) });
  }
  for (const u of unions.values()) for (const c of u.ctors) if (!ctors.has(c.name)) ctors.set(c.name, u.name);

  const m = decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machineName);
  if (!m) throw new Error(`poly-ref: no machine ${machineName} in module ${module.name}`);

  const checkValues = (c: A.CheckClause | null): Value[] | null => {
    if (!c) return null;
    if (c.domain.kind === 'DomainRange') return Array.from({ length: c.domain.hi - c.domain.lo + 1 }, (_, k) => (c.domain as A.DomainRange).lo + k);
    return c.domain.values.map((v) => (v.kind === 'Name' ? v.name : v.value));
  };

  const fields: RField[] = m.fields.map((f) => ({ name: f.name, type: typeOf(f.type), check: checkValues(f.check), init: f.init }));
  const actions: RAction[] = [];
  const handlers = new Map<string, A.Handler>();
  const guards: A.Guard[] = [];
  let terminal: A.Expr | null = null;
  const invariants: A.Property[] = [];
  const stepProperties: A.Property[] = [];
  const rejectProperties: A.Property[] = [];
  const pathProperties: RPathProperty[] = [];
  const effects = new Map<string, REffect>();
  for (const it of m.items) {
    if (it.kind !== 'EffectDecl') continue;
    const kind = it.items.find((x) => x.kind === 'EffKind');
    const cls = it.items.find((x) => x.kind === 'EffClass');
    effects.set(it.name, {
      name: it.name,
      // PT6.1: the manifest is keyed by kind; S41 (provisional) makes the name the kind when none is given.
      kind: kind && kind.kind === 'EffKind' ? kind.value : it.name,
      cls: cls && cls.kind === 'EffClass' ? cls.value : 'none',
      params: it.params.map((p) => ({ name: p.name, type: typeOf(p.type) })),
    });
  }
  const guardedInputs = strictInputs(m, effects);
  for (const it of m.items) {
    if (it.kind === 'Action') {
      actions.push({
        name: it.name,
        // PT3.4a: a check domain is strict when declared so, or when the parameter can flow into the payload of
        // an irreversible or compensable effect; `disclosed` written out keeps it disclosed.
        params: it.params.map((p) => ({
          name: p.name, type: typeOf(p.type), check: checkValues(p.check),
          strict: p.check?.mode === 'strict' || (p.check !== null && p.check.mode === null && guardedInputs.has(`${it.name}.${p.name}`)),
        })),
      });
    }
    if (it.kind === 'Property' && it.form === 'path') pathProperties.push({ name: it.name, id: it.id, bounds: pathBounds(it.expr) });
    if (it.kind === 'Handler') handlers.set(it.action, it);
    if (it.kind === 'Guard') guards.push(it);
    if (it.kind === 'Terminal') terminal = it.expr;
    if (it.kind === 'Property' && it.form === 'invariant') invariants.push(it);
    if (it.kind === 'Property' && it.form === 'step') stepProperties.push(it);
    if (it.kind === 'Property' && it.form === 'reject') rejectProperties.push(it);
  }
  return {
    name: m.name, service: m.service, effects, pathProperties, unions, ctors, fields, fieldNames: fields.map((f) => f.name),
    actions, handlers, guards, terminal, invariants, stepProperties, rejectProperties,
  };
}

/** PS5.4: a conjunction of `count("k") <= n` and `count("k") < n`, as bounds; anything else is refused. */
function pathBounds(e: A.Expr): { kind: string; max: number }[] {
  if (e.kind === 'Binary' && e.op === '&&') return [...pathBounds(e.left), ...pathBounds(e.right)];
  if (e.kind === 'Binary') {
    const count = (x: A.Expr) => (x.kind === 'Call' && x.callee === 'count' && x.args.length === 1 && x.args[0].kind === 'String' ? x.args[0].value : null);
    const n = (x: A.Expr) => (x.kind === 'Int' ? x.value : null);
    const flip: Record<string, string> = { '>=': '<=', '>': '<' };
    const [k, lim, op] = count(e.left) !== null ? [count(e.left), n(e.right), e.op] : [count(e.right), n(e.left), flip[e.op]];
    if (k !== null && lim !== null && (op === '<=' || op === '<')) return [{ kind: k, max: op === '<=' ? lim : lim - 1 }];
  }
  throw new Error('poly-ref: a path property is a conjunction of count("kind") <= n (PS5.4, S37)');
}

/**
 * PT3.4a, read from the handlers: `Action.param` for each parameter an argument of an irreversible or
 * compensable emit reads, directly or through a `let`.
 */
function strictInputs(m: A.Machine, effects: Map<string, REffect>): Set<string> {
  const out = new Set<string>();
  for (const h of m.items) {
    if (h.kind !== 'Handler') continue;
    const lets = new Map<string, Set<string>>();
    const names = (x: unknown, acc = new Set<string>()): Set<string> => {
      if (!x || typeof x !== 'object') return acc;
      if (Array.isArray(x)) { for (const y of x) names(y, acc); return acc; }
      const node = x as { kind?: string; name?: string };
      if (node.kind === 'Name' && node.name) for (const n of lets.get(node.name) ?? [node.name]) acc.add(n);
      for (const [k, v] of Object.entries(x)) if (k !== 'span') names(v, acc);
      return acc;
    };
    const visit = (body: A.Stmt[]): void => {
      for (const st of body) {
        if (st.kind === 'Let') lets.set(st.name, names(st.expr));
        else if (st.kind === 'If') { visit(st.then); visit(st.else ?? []); }
        else if (st.kind === 'Match') for (const a of st.arms) visit(a.body);
        else if (st.kind === 'Intent' && st.op === 'emit') {
          const cls = effects.get(st.target)?.cls;
          if (cls !== 'irreversible' && cls !== 'compensable') continue;
          for (const a of st.args) for (const n of names(a.value)) out.add(`${h.action}.${n}`);
        }
      }
    };
    visit(h.body);
  }
  return out;
}

// ── domains (PS1.1, PS4.2) ─────────────────────────────────────────────────

/** Every value of a finite type, in declaration order. */
export function valuesOf(t: RType, M: RMachine): Value[] {
  switch (t.k) {
    case 'bool': return [false, true];
    case 'int':
      if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi)) throw new Error('poly-ref: an unbounded int has no enumeration; it needs a check domain (PT3.2)');
      return Array.from({ length: t.hi - t.lo + 1 }, (_, k) => t.lo + k);
    case 'string': throw new Error('poly-ref: a string has no enumeration; it needs a check domain (PT3.2)');
    case 'ref': return [null]; // `none` only: a single machine holds no other address (PS1.6)
    case 'union': {
      const u = M.unions.get(t.name)!;
      const out: Value[] = [];
      for (const c of u.ctors) {
        let recs: Record<string, Value>[] = [{}];
        for (const f of c.fields) {
          const vs = valuesOf(f.type, M);
          recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [f.name]: v })));
        }
        for (const r of recs) out.push({ ctor: c.name, payload: r } satisfies UnionValue);
      }
      return out;
    }
    case 'map': {
      const keys = valuesOf(t.key, M);
      const vals = valuesOf(t.value, M);
      let maps: [Value, Value][][] = [[]];
      for (const k of keys) maps = maps.flatMap((es) => vals.map((v) => [...es, [k, v] as [Value, Value]]));
      return maps.map((entries) => ({ entries }) satisfies MapValue);
    }
  }
}

/** D(a): every data record of an action, the product of its parameters' check domains (PS1.1). */
export function dataDomain(a: RAction, M: RMachine): Record<string, Value>[] {
  let recs: Record<string, Value>[] = [{}];
  for (const p of a.params) {
    const vs = p.check ?? valuesOf(p.type, M);
    recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [p.name]: v })));
  }
  return recs;
}

// The canonical keys of a map type, computed once per type object: inType runs on every successor
// of every state, and the key domain does not change (review finding 10).
const KEYS = new WeakMap<RType, string[]>();
function keyList(t: Extract<RType, { k: 'map' }>, M: RMachine): string[] {
  let keys = KEYS.get(t);
  if (!keys) {
    keys = valuesOf(t.key, M).map(keyOf);
    KEYS.set(t, keys);
  }
  return keys;
}

/** `v ∈ T`: membership of the declared type (PS1.2). */
export function inType(v: Value, t: RType, M: RMachine): boolean {
  switch (t.k) {
    case 'bool': return typeof v === 'boolean';
    case 'int': return typeof v === 'number' && Number.isInteger(v) && v >= t.lo && v <= t.hi;
    case 'string': return typeof v === 'string';
    case 'ref': return v === null;
    case 'union': {
      if (!isUnion(v)) return false;
      const c = M.unions.get(t.name)!.ctors.find((x) => x.name === v.ctor);
      if (!c) return false;
      const names = Object.keys(v.payload);
      if (names.length !== c.fields.length) return false;
      return c.fields.every((f) => f.name in v.payload && inType(v.payload[f.name], f.type, M));
    }
    case 'map': {
      if (!isMap(v)) return false;
      const keys = keyList(t, M);
      return v.entries.length === keys.length && v.entries.every(([k, x], i) => keyOf(k) === keys[i] && inType(x, t.value, M));
    }
  }
}

/** `v ∈ D(f)`: membership of the check domain; the type itself when there is no check clause (PS4.2). */
export function inCheckDomain(v: Value, f: { type: RType; check: Value[] | null }, M: RMachine): boolean {
  if (f.check) return f.check.some((x) => keyOf(x) === keyOf(v));
  return inType(v, f.type, M);
}
