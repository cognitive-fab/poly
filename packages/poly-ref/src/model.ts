// The machine tuple M = (F, init, A, H, G, term) of PS1.1, read from the AST.
//
// poly-ref reads the AST through `import type` only (PS9.3): it resolves
// types, builds domains and finds handlers itself, from the definitions in
// 04-semantics, sharing nothing with the compiler's checker.
import type * as A from '@poly/core';
import type { MapValue, RecordValue, UnionValue, Value } from './values.js';
import { keyOf, isUnion, isMap, isRecord } from './values.js';

/** Types as PS1.4 lists them. */
export type RType =
  | { k: 'bool' }
  | { k: 'int'; lo: number; hi: number } // unbounded int: ±Infinity
  | { k: 'string' }
  | { k: 'union'; name: string }
  | { k: 'record'; name: string }
  | { k: 'map'; key: RType; value: RType }
  /** An address of an instance of machine `machine` (PS1.6); `none` is null. */
  | { k: 'ref'; machine: string };

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

/** One conjunct of a path property (PS5.4, S37): a bound on a kind's count, or an order of two kinds. */
export type PathClause = { k: 'count'; kind: string; max: number } | { k: 'before'; first: string; then: string };

/**
 * A path property (PS5.4) as a conjunction of clauses. These are the prefix-closed forms S37 admits; poly-ref
 * reads them from the AST itself and refuses anything else.
 */
export interface RPathProperty {
  name: string;
  id: string;
  clauses: PathClause[];
}

/**
 * The monitor of a path property: one number per clause, the count so far (saturated one above its bound)
 * or, for `before`, 1 once its first kind was emitted. A step's intents are read in order, so an intent
 * of `then` in the same step as, but before, the first kind still breaks the order.
 */
export function monitorStart(p: RPathProperty): number[] {
  return p.clauses.map(() => 0);
}

/** The monitor after one step's intents, and the first clause they break (-1 when none). */
export function monitorStep(p: RPathProperty, m: number[], kinds: string[]): { next: number[]; broken: number } {
  const next = [...m];
  let broken = -1;
  p.clauses.forEach((c, i) => {
    for (const k of kinds) {
      if (c.k === 'count') {
        if (k === c.kind) next[i] = Math.min(c.max + 1, next[i] + 1);
        if (next[i] > c.max && broken < 0) broken = i;
      } else {
        if (k === c.then && next[i] === 0 && broken < 0) broken = i;
        if (k === c.first) next[i] = 1;
      }
    }
  });
  return { next, broken };
}

/** How a broken clause reads in a finding. */
export function clauseText(c: PathClause): string {
  return c.k === 'count' ? `count("${c.kind}") reaches ${c.max + 1}, above ${c.max}` : `"${c.then}" is emitted before any "${c.first}"`;
}

/** An attached child, by key (PT6.4): its machine, creation action and wiring, and its actions' parameters. */
export interface RChild {
  key: string;
  /** `<module>.<Machine>` (S28). */
  machineId: string;
  machine: string;
  create: string | null;
  onComplete: string | null;
  onParentTerminal: string | null;
  actions: { name: string; params: { name: string; type: RType }[] }[];
}

/** A record type (S25): its fields, in declaration order. */
export interface RRecord {
  name: string;
  fields: { name: string; type: RType }[];
}

export interface RMachine {
  name: string;
  records: Map<string, RRecord>;
  /** `<module>.<Machine>` (S28). */
  id: string;
  service: boolean;
  children: Map<string, RChild>;
  /** S49: child families by name, with the indices their keys take. */
  families: Map<string, { lo: number; hi: number }>;
  effects: Map<string, REffect>;
  pathProperties: RPathProperty[];
  /** Every machine of the module by name, with its actions: what a send may name (PS2.2). */
  receivers: Map<string, { name: string; params: { name: string; type: RType }[] }[]>;
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
  /** Liveness properties (PS5.5), checked under their fairness (PS6). */
  liveness: A.Liveness[];
}

export function buildMachine(module: A.Module, machineName: string): RMachine {
  const unions = new Map<string, RUnion>();
  const ctors = new Map<string, string>();
  const decls = module.decls;
  const recordNames = new Set(decls.filter((d) => d.kind === 'RecordDecl').map((d) => d.name));
  const records = new Map<string, RRecord>();
  // Types first: a union's payload types may name other unions.
  const typeOf = (t: A.TypeExpr): RType => {
    switch (t.kind) {
      case 'TBool': return { k: 'bool' };
      case 'TInt': return { k: 'int', lo: -Infinity, hi: Infinity };
      case 'TString': return { k: 'string' };
      case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
      case 'TName': return recordNames.has(t.name) ? { k: 'record', name: t.name } : { k: 'union', name: t.name };
      case 'TMap': return { k: 'map', key: typeOf(t.key), value: typeOf(t.value) };
      case 'TRef': return { k: 'ref', machine: t.machine[t.machine.length - 1] };
    }
  };
  for (const d of decls) {
    if (d.kind === 'EnumDecl') unions.set(d.name, { name: d.name, ctors: d.members.map((m) => ({ name: m, fields: [] })) });
    if (d.kind === 'TypeDecl') unions.set(d.name, { name: d.name, ctors: d.ctors.map((c) => ({ name: c.name, fields: c.fields.map((f) => ({ name: f.name, type: typeOf(f.type) })) })) });
  }
  for (const d of decls) if (d.kind === 'RecordDecl') records.set(d.name, { name: d.name, fields: d.fields.map((f) => ({ name: f.name, type: typeOf(f.type) })) });
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
  const liveness: A.Liveness[] = [];
  const pathProperties: RPathProperty[] = [];
  const effects = new Map<string, REffect>();
  for (const it of m.items) {
    if (it.kind !== 'EffectDecl') continue;
    const kind = it.items.find((x) => x.kind === 'EffKind');
    const cls = it.items.find((x) => x.kind === 'EffClass');
    effects.set(it.name, {
      name: it.name,
      // PT6.1: the manifest is keyed by kind; S41 makes the name the kind when none is given.
      kind: kind && kind.kind === 'EffKind' ? kind.value : it.name,
      cls: cls && cls.kind === 'EffClass' ? cls.value : 'none',
      params: it.params.map((p) => ({ name: p.name, type: typeOf(p.type) })),
    });
  }
  const guardedInputs = strictInputs(m, effects);
  const receivers = new Map(decls.filter((d): d is A.Machine => d.kind === 'Machine').map((d) => [d.name, d.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => ({ name: a.name, params: a.params.map((p) => ({ name: p.name, type: typeOf(p.type) })) }))]));
  // PT6.4: attached children, by the key their spawn names (declared by use, like timer keys).
  const children = new Map<string, RChild>();
  const families = new Map<string, { lo: number; hi: number }>();
  // S49: a loop `for i in lo..n` runs i up to n, whose bound is n itself or the top of its range type.
  const loopTop = (f: A.For, action: string): number => {
    if (f.hi.kind === 'Int') return f.hi.value;
    const name = f.hi.kind === 'Name' ? f.hi.name : '';
    const decl = m.items.find((i): i is A.Action => i.kind === 'Action' && i.name === action)?.params.find((p) => p.name === name)?.type
      ?? m.fields.find((x) => x.name === name)?.type;
    const t = decl ? typeOf(decl) : null;
    if (!t || t.k !== 'int' || !Number.isFinite(t.hi)) throw new Error(`poly-ref: the loop over ${f.var} has no bound`);
    return t.hi;
  };
  const spawns = (body: A.Stmt[], action: string, loops: { v: string; lo: number; hi: number }[]): void => {
    for (const s of body) {
      if (s.kind === 'For') { spawns(s.body, action, [...loops, { v: s.var, lo: s.lo, hi: loopTop(s, action) }]); continue; }
      if (s.kind === 'Intent' && s.op === 'spawn' && s.modifier !== 'detached' && s.as) {
        const name = s.target.split('.').pop()!;
        const child = decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === name);
        if (!child) throw new Error(`poly-ref: no machine ${s.target}`);
        const pair = (tag: string) => { const i = s.extra.indexOf(tag); return i >= 0 ? s.extra[i + 1] : null; };
        // An indexed key k[i] is a family: one key per index the loop gives i (S49).
        let keys = [s.as];
        if (s.index) {
          const r = indexRange(s.index, loops);
          if (!r) throw new Error(`poly-ref: the index of ${s.as} is not the loop variable or a constant`);
          keys = Array.from({ length: r.hi - r.lo + 1 }, (_, k) => `${s.as}${r.lo + k}`);
          const prev = families.get(s.as);
          families.set(s.as, prev ? { lo: Math.min(prev.lo, r.lo), hi: Math.max(prev.hi, r.hi) } : r);
        }
        for (const key of keys) {
          if (children.has(key)) continue;
          children.set(key, {
            key, machineId: `${module.name}.${name}`, machine: name,
            create: pair('create'), onComplete: pair('complete'), onParentTerminal: pair('parent-terminal'),
            actions: child.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => ({ name: a.name, params: a.params.map((p) => ({ name: p.name, type: typeOf(p.type) })) })),
          });
        }
      }
      if (s.kind === 'If') { spawns(s.then, action, loops); spawns(s.else ?? [], action, loops); }
      if (s.kind === 'Match') for (const a of s.arms) spawns(a.body, action, loops);
    }
  };
  for (const it of m.items) if (it.kind === 'Handler') spawns(it.body, it.action, []);
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
    if (it.kind === 'Property' && it.form === 'path') pathProperties.push({ name: it.name, id: it.id, clauses: pathClauses(it.expr) });
    if (it.kind === 'Handler') handlers.set(it.action, it);
    if (it.kind === 'Guard') guards.push(it);
    if (it.kind === 'Terminal') terminal = it.expr;
    if (it.kind === 'Property' && it.form === 'invariant') invariants.push(it);
    if (it.kind === 'Property' && it.form === 'step') stepProperties.push(it);
    if (it.kind === 'Property' && it.form === 'reject') rejectProperties.push(it);
    if (it.kind === 'Liveness') liveness.push(it);
  }
  // S51: a completion's childKey ranges over the keys whose spawn names that action as its completion.
  for (const a of actions) {
    const keys = [...children.values()].filter((c) => c.onComplete === a.name).map((c) => c.key);
    for (const p of a.params) if (p.name === 'childKey' && p.type.k === 'string' && p.check === null && keys.length) p.check = keys;
  }
  return {
    name: m.name, records, id: `${module.name}.${m.name}`, service: m.service, children, families, effects, pathProperties, receivers, unions, ctors, fields, fieldNames: fields.map((f) => f.name),
    actions, handlers, guards, terminal, invariants, stepProperties, rejectProperties, liveness,
  };
}

/** The indices of a key's index: the loop variable, it plus or minus a constant, or a constant (S49). */
function indexRange(e: A.Expr, loops: { v: string; lo: number; hi: number }[]): { lo: number; hi: number } | null {
  if (e.kind === 'Int') return { lo: e.value, hi: e.value };
  if (e.kind === 'Name') { const l = loops.find((x) => x.v === e.name); return l ? { lo: l.lo, hi: l.hi } : null; }
  if (e.kind === 'Binary' && (e.op === '+' || e.op === '-') && e.right.kind === 'Int') {
    const r = indexRange(e.left, loops);
    const c = e.op === '+' ? e.right.value : -e.right.value;
    return r ? { lo: r.lo + c, hi: r.hi + c } : null;
  }
  return null;
}

/** PS5.4, S37: a conjunction of `count("k") <= n`, `count("k") < n` and `before("k1", "k2")`; anything else is refused. */
function pathClauses(e: A.Expr): PathClause[] {
  if (e.kind === 'Binary' && e.op === '&&') return [...pathClauses(e.left), ...pathClauses(e.right)];
  if (e.kind === 'Call' && e.callee === 'before' && e.args.length === 2 && e.args[0].kind === 'String' && e.args[1].kind === 'String') {
    return [{ k: 'before', first: e.args[0].value, then: e.args[1].value }];
  }
  if (e.kind === 'Binary') {
    const count = (x: A.Expr) => (x.kind === 'Call' && x.callee === 'count' && x.args.length === 1 && x.args[0].kind === 'String' ? x.args[0].value : null);
    const n = (x: A.Expr) => (x.kind === 'Int' ? x.value : null);
    const flip: Record<string, string> = { '>=': '<=', '>': '<' };
    const [k, lim, op] = count(e.left) !== null ? [count(e.left), n(e.right), e.op] : [count(e.right), n(e.left), flip[e.op]];
    if (k !== null && lim !== null && (op === '<=' || op === '<')) return [{ k: 'count', kind: k, max: op === '<=' ? lim : lim - 1 }];
  }
  throw new Error('poly-ref: a path property is a conjunction of count bounds and before (PS5.4, S37)');
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
        else if (st.kind === 'For') visit(st.body);
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
    case 'ref': {
      // S57, PS1.6: alone, none and one address per Ref<M> field plus the most Ref<M> parameters of one action, and
      // self when M is the machine's own type. Addresses are only compared and passed on, so these realise every
      // pattern of equalities a state and a step hold.
      const n = refCount(M, t.machine);
      return [null, ...Array.from({ length: n }, (_, i) => `${t.machine}#${i + 1}`)];
    }
    case 'record': {
      // S25: every combination of field values, in declaration order.
      let recs: Record<string, Value>[] = [{}];
      for (const f of M.records.get(t.name)!.fields) {
        const vs = valuesOf(f.type, M);
        recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [f.name]: v })));
      }
      return recs.map((fields) => ({ fields }) satisfies RecordValue);
    }
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

/** S57: how many addresses a Ref<target> ranges over alone; the last is self's when target is M itself. */
export function refCount(M: RMachine, target: string): number {
  const isRef = (x: RType) => x.k === 'ref' && x.machine === target;
  return M.fields.filter((f) => isRef(f.type)).length + Math.max(0, ...M.actions.map((a) => a.params.filter((p) => isRef(p.type)).length)) + (target === M.name ? 1 : 0);
}

/** A machine's own address when it is checked alone (S57): the last of its addresses. */
export function selfAlone(M: RMachine): string {
  return `${M.name}#${refCount(M, M.name)}`;
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
    case 'ref': return v === null || typeof v === 'string';
    case 'record': {
      if (!isRecord(v)) return false;
      const fs = M.records.get(t.name)!.fields;
      return Object.keys(v.fields).length === fs.length && fs.every((f) => f.name in v.fields && inType(v.fields[f.name], f.type, M));
    }
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
