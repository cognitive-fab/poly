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
  | { k: 'ref'; machine: string }
  /** `Conf` (PD1.3): a confidence in thousandths, 0..1000. */
  | { k: 'conf' }
  /** `Principal` (PD5.1.2b): an opaque identity, a string at run time, or null for `none`. */
  | { k: 'principal' }
  /** PS1.4a (S180): an opaque reference to a body, or none. */
  | { k: 'content' };

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

/** `decision d(params) -> R` (PD1): an effect of kind decision.<d>, and the completion its reply arrives by. */
export interface RDecision {
  id: string;
  name: string;
  kind: string;
  params: { name: string; type: RType }[];
  /** The ok completion's action, and which of its parameters carry the answer and which a confidence or margin. */
  ok: { action: string; answer: string[]; confidence: string[] } | null;
}

export interface RAction {
  name: string;
  params: RParam[];
  /** PD5.1.2: the claims the action requires (its handler's `by`): the binder and the claims type. */
  claims: { binder: string; type: RType } | null;
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

/** `spawn detached M as k -> A(…)` (PS7.5, S60). */
export interface RDetached {
  key: string;
  machine: string;
  machineId: string;
  create: string | null;
  createParams: { name: string; type: RType }[];
}

export interface RMachine {
  name: string;
  records: Map<string, RRecord>;
  /** `<module>.<Machine>` (S28). */
  id: string;
  service: boolean;
  children: Map<string, RChild>;
  /** S60: detached children by key, in the order of their first spawn; each is a separate actor. */
  detached: RDetached[];
  /** S49: child families by name, with the indices their keys take. */
  families: Map<string, { lo: number; hi: number }>;
  effects: Map<string, REffect>;
  /** PD1: the machine's decisions by name. */
  decisions: Map<string, RDecision>;
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
  /** PD5.1.3c: how many principal representatives the check offers. */
  principals: number;
  /** PS4.1f: how many content representatives the check offers, besides none. */
  contents: number;
}

/**
 * PS1.0 (S176): a program is a set of modules, and a machine is named m.M. `program` holds the modules `use` may name;
 * `view` is the module whose spelling names take: M for its own machines, m.M for any other's. A machine built for a
 * configuration of another module is built with that module as its view.
 */
export interface BuildOptions { principals?: number; contents?: number; program?: A.Module[]; view?: string }

/** PS1.0: the module a `use` path names, the whole path when it is a module, else the path without its machine. */
export function usedModule(path: string[], program: A.Module[]): string {
  const whole = path.join('.');
  return program.some((m) => m.name === whole) ? whole : path.slice(0, -1).join('.');
}

export function buildMachine(module: A.Module, machineName: string, opts: BuildOptions = {}): RMachine {
  const view = opts.view ?? module.name;
  const program = opts.program ?? [];
  const spell = (mod: string, name: string) => (mod === view ? name : `${mod}.${name}`);
  const moduleNamed = (mod: string) => (mod === module.name ? module : program.find((x) => x.name === mod));
  /** A machine named in module `inMod`'s source, spelled from the view. */
  const named = (parts: string[], inMod: string) => spell(parts.length > 1 ? parts.slice(0, -1).join('.') : inMod, parts[parts.length - 1]);
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
      case 'TName':
        if (recordNames.has(t.name)) return { k: 'record', name: t.name };
        // PD5.1.2b: Principal is built in, unless the module declares a type of that name.
        if (t.name === 'Principal' && !decls.some((d) => (d.kind === 'TypeDecl' || d.kind === 'EnumDecl') && d.name === 'Principal')) return { k: 'principal' };
        // PS1.4a: Content is built in, unless the module declares a type of that name.
        if (t.name === 'Content' && !decls.some((d) => (d.kind === 'TypeDecl' || d.kind === 'EnumDecl') && d.name === 'Content')) return { k: 'content' };
        return { k: 'union', name: t.name };
      case 'TMap': return { k: 'map', key: typeOf(t.key), value: typeOf(t.value) };
      case 'TRef': return { k: 'ref', machine: named(t.machine, module.name) };
      case 'TConf': return { k: 'conf' };
    }
  };
  // A parameter of a used module's action: its addresses are spelled from the view; the checker lets only types that
  // need no module cross (S176), so a named type here is a builtin.
  const typeIn = (mod: string) => (t: A.TypeExpr): RType => (mod === module.name ? typeOf(t) : t.kind === 'TRef' ? { k: 'ref', machine: named(t.machine, mod) } : t.kind === 'TName' && t.name === 'Principal' ? { k: 'principal' } : t.kind === 'TName' && t.name === 'Content' ? { k: 'content' } : typeOf(t));
  for (const d of decls) {
    if (d.kind === 'EnumDecl') unions.set(d.name, { name: d.name, ctors: d.members.map((m) => ({ name: m, fields: [] })) });
    if (d.kind === 'TypeDecl') unions.set(d.name, { name: d.name, ctors: d.ctors.map((c) => ({ name: c.name, fields: c.fields.map((f) => ({ name: f.name, type: typeOf(f.type) })) })) });
  }
  // S76: Tri, the enum True | False | Unknown, when a machine names it and the module declares none.
  if (!unions.has('Tri') && !recordNames.has('Tri') && mentionsType(decls, 'Tri')) unions.set('Tri', { name: 'Tri', ctors: ['True', 'False', 'Unknown'].map((name) => ({ name, fields: [] })) });
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
  // PD1.7: a decision is an effect of kind decision.<d>, class none.
  const decisions = new Map<string, RDecision>();
  for (const it of m.items) {
    if (it.kind !== 'Decision') continue;
    const ok = it.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === 'ok');
    const bound = (head: string[]) => (ok?.bind === undefined ? [] : ok.args.filter((a) => { const p = replyPath(a.value, ok.bind!); return p !== null && head.includes(p[0]); }).map((a) => a.name!));
    decisions.set(it.name, { id: it.id, name: it.name, kind: `decision.${it.name}`, params: it.params.map((p) => ({ name: p.name, type: typeOf(p.type) })), ok: ok ? { action: ok.action, answer: bound(['answer']), confidence: bound(['conf', 'margin']) } : null });
  }
  const guardedInputs = strictInputs(m, effects);
  // PS2.2, S176: what a send may name: this module's machines, and those of the modules it uses.
  const receiverModules = [module.name, ...decls.filter((d): d is A.UseDecl => d.kind === 'Use').map((d) => usedModule(d.path, program))];
  const receivers = new Map([...new Set(receiverModules)].flatMap((mod) => (moduleNamed(mod)?.decls ?? []).filter((d): d is A.Machine => d.kind === 'Machine').map((d) => [spell(mod, d.name), d.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => ({ name: a.name, params: a.params.map((p) => ({ name: p.name, type: typeIn(mod)(p.type) })) }))] as const)));
  // PT6.4: attached children, by the key their spawn names (declared by use, like timer keys).
  const children = new Map<string, RChild>();
  const detached: RDetached[] = [];
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
      if (s.kind === 'Intent' && s.op === 'spawn' && s.modifier === 'detached' && s.as && !detached.some((x) => x.key === s.as)) {
        // S176: a detached child may be a used module's machine, spelled m.M; its id is always module.Machine.
        const parts = s.target.split('.');
        const mod = parts.length > 1 ? parts.slice(0, -1).join('.') : module.name;
        const name = parts[parts.length - 1];
        const child = moduleNamed(mod)?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === name);
        if (!child) throw new Error(`poly-ref: no machine ${s.target}`);
        const i = s.extra.indexOf('create');
        const create = i >= 0 ? s.extra[i + 1] : null;
        const act = create ? child.items.find((x): x is A.Action => x.kind === 'Action' && x.name === create) : undefined;
        detached.push({ key: s.as, machine: spell(mod, name), machineId: `${mod}.${name}`, create, createParams: (act?.params ?? []).map((p) => ({ name: p.name, type: typeIn(mod)(p.type) })) });
      }
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
      const by = m.items.find((h): h is A.Handler => h.kind === 'Handler' && h.action === it.name)?.by;
      actions.push({
        name: it.name,
        claims: by ? { binder: by.name, type: typeOf({ kind: 'TName', name: by.type } as A.TName) } : null,
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
  // PD1.4a, S79: a parameter a completion binds from the handler's reply is strict unless written disclosed; a
  // Conf is explored by the intervals its comparisons induce (PD1.4b), and at runtime is 0..1000 (PD1.3a).
  for (const it of m.items) {
    if (it.kind !== 'EffectDecl' && it.kind !== 'Decision') continue;
    for (const o of it.items) {
      if (o.kind !== 'EffOutcome' || o.bind === undefined) continue;
      const act = actions.find((a) => a.name === o.action);
      const decl = m.items.find((x): x is A.Action => x.kind === 'Action' && x.name === o.action);
      for (const a of o.args) {
        if (replyPath(a.value, o.bind) === null) continue;
        const p = act?.params.find((x) => x.name === a.name);
        if (!p) continue;
        if (decl?.params.find((x) => x.name === a.name)?.check?.mode !== 'disclosed') p.strict = true;
        if (p.type.k === 'conf') p.check = confPartition(m, o.action, p.name);
      }
    }
  }
  // S51: a completion's childKey ranges over the keys whose spawn names that action as its completion.
  for (const a of actions) {
    const keys = [...children.values()].filter((c) => c.onComplete === a.name).map((c) => c.key);
    for (const p of a.params) if (p.name === 'childKey' && p.type.k === 'string' && p.check === null && keys.length) p.check = keys;
  }
  // PD5.1.3c, S102: the Principal positions of the state, plus one, and never fewer than 2.
  const positions = (t: RType, seen: Set<string>): number => {
    if (t.k === 'principal') return 1;
    if (t.k === 'record' && !seen.has(t.name)) return (records.get(t.name)?.fields ?? []).reduce((n, f) => n + positions(f.type, new Set([...seen, t.name])), 0);
    if (t.k === 'union' && !seen.has(t.name)) return (unions.get(t.name)?.ctors ?? []).reduce((n, c) => n + c.fields.reduce((k, f) => k + positions(f.type, new Set([...seen, t.name])), 0), 0);
    // Review A-F3: a map holds one value per key.
    if (t.k === 'map') return positions(t.value, seen) * (t.key.k === 'int' ? t.key.hi - t.key.lo + 1 : t.key.k === 'union' ? (unions.get(t.key.name)?.ctors.length ?? 1) : 1);
    return 0;
  };
  // PS4.1c: the Principal positions of the state plus the most principals one label carries (at least one), and never
  // fewer than 2 (S102, review A-F3).
  const label = Math.max(1, ...actions.map((a) => a.params.reduce((n, p) => n + positions(p.type, new Set()), 0) + (a.claims ? positions(a.claims.type, new Set()) : 0)));
  const principals = opts.principals ?? Math.max(2, fields.reduce((n, f) => n + positions(f.type, new Set()), 0) + label);
  // PS4.1f: the same rule applied to Content apart: its positions in the state, plus the most Content values one label
  // carries (at least one), and never fewer than 2. Content is never a record field or a payload (PS1.4a).
  const contentPositions = (t: RType): number => (t.k === 'content' ? 1 : t.k === 'map' ? contentPositions(t.value) * (t.key.k === 'int' ? t.key.hi - t.key.lo + 1 : t.key.k === 'union' ? (unions.get(t.key.name)?.ctors.length ?? 1) : 1) : 0);
  const contentLabel = Math.max(1, ...actions.map((a) => a.params.reduce((n, p) => n + contentPositions(p.type), 0)));
  const contents = opts.contents ?? Math.max(2, fields.reduce((n, f) => n + contentPositions(f.type), 0) + contentLabel);
  return {
    principals,
    contents,
    name: spell(module.name, m.name), records, id: `${module.name}.${m.name}`, service: m.service, children, detached, families, effects, decisions, pathProperties, receivers, unions, ctors, fields, fieldNames: fields.map((f) => f.name),
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
    // PD1.4b: a Conf is explored by its parameter's partition, which buildMachine sets as its check values.
    case 'conf': return Array.from({ length: 1001 }, (_, k) => k);
    case 'bool': return [false, true];
    case 'int':
      if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi)) throw new Error('poly-ref: an unbounded int has no enumeration; it needs a check domain (PT3.2)');
      return Array.from({ length: t.hi - t.lo + 1 }, (_, k) => t.lo + k);
    case 'string': throw new Error('poly-ref: a string has no enumeration; it needs a check domain (PT3.2)');
    // PD5.1.3: a principal ranges over the representatives p1..pn; none is never asserted, only stored.
    case 'principal': return Array.from({ length: M.principals }, (_, i) => `p${i + 1}`);
    // PS4.1f: a Content ranges over none and the representatives c1..cn, ci written as the digest of i (PT: Content lowers
    // to sha256:<hex>), so a representative is a value of the runtime's type.
    case 'content': return [null, ...Array.from({ length: M.contents }, (_, i) => `sha256:${(i + 1).toString(16).padStart(64, '0')}`)];
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

/**
 * S57: how many addresses a Ref<target> ranges over alone; the last is self's when target is M itself. S78: each
 * key of a detached spawn of target is one more, after those of the fields and parameters.
 */
export function refCount(M: RMachine, target: string): number {
  return plainRefs(M, target) + M.detached.filter((x) => x.machine === target).length + (target === M.name ? 1 : 0);
}

function plainRefs(M: RMachine, target: string): number {
  const isRef = (x: RType) => x.k === 'ref' && x.machine === target;
  return M.fields.filter((f) => isRef(f.type)).length + Math.max(0, ...M.actions.map((a) => a.params.filter((p) => isRef(p.type)).length));
}

/** S78: a detached child's address when its parent is checked alone: its own symbolic address. */
export function detachedAlone(M: RMachine, key: string): string {
  const d = M.detached.find((x) => x.key === key);
  if (!d) throw new Error(`poly-ref: no detached child ${key} in ${M.name}`);
  const same = M.detached.filter((x) => x.machine === d.machine);
  return `${d.machine}#${plainRefs(M, d.machine) + same.indexOf(d) + 1}`;
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
  // PD5.1.2c, S155: the claims are part of the label, carried under the reserved key $claims; every value is offered.
  if (a.claims) {
    const cs = valuesOf(a.claims.type, M);
    recs = recs.flatMap((r) => cs.map((c) => ({ ...r, $claims: c })));
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
    case 'principal': return v === null || (typeof v === 'string' && v.length > 0);
    case 'content': return v === null || (typeof v === 'string' && v.length > 0);
    case 'conf': return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1000;
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
  // PD1.3a: a Conf's domain at runtime is 0..1000; its check values are only what the exploration offers.
  if (f.type.k === 'conf') return inType(v, f.type, M);
  if (f.check) return f.check.some((x) => keyOf(x) === keyOf(v));
  return inType(v, f.type, M);
}

/** Whether a declaration names the type `name` anywhere. */
function mentionsType(n: unknown, name: string): boolean {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some((x) => mentionsType(x, name));
  const o = n as { kind?: string; name?: string };
  // S76: `Tri.Unknown` names Tri as well as a type does.
  const c = (o as { ctor?: string }).ctor;
  if ((o.kind === 'TName' || o.kind === 'Name') && o.name === name) return true;
  if ((o.kind === 'PCtor' || o.kind === 'CtorExpr') && typeof c === 'string' && c.startsWith(`${name}.`)) return true;
  return Object.entries(o).some(([k, v]) => k !== 'span' && mentionsType(v, name));
}

/** PD1.2b, S79: `r.x.y` as [x, y] when it is rooted at the reply's name; null otherwise. */
export function replyPath(e: A.Expr, bind: string): string[] | null {
  const path: string[] = [];
  let x = e;
  while (x.kind === 'Member') { path.unshift(x.prop); x = x.object; }
  return x.kind === 'Name' && x.name === bind ? path : null;
}

/**
 * PD1.4b, read from the source: every comparison of the parameter with a constant, in its action's handler and
 * in the machine's properties and guards, and the least value of 0..1000 for each pattern of their outcomes.
 * Two values with the same outcomes cannot be told apart by any expression (PD1.3b).
 */
export function confPartition(m: A.Machine, action: string, param: string): number[] {
  const tests: ((v: number) => boolean)[] = [];
  const constant = (x: A.Expr): number | null => (x.kind === 'Decimal' ? x.value : x.kind === 'Int' ? x.value * 1000 : null);
  const compare = (op: string, a: number, b: number) => (op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b);
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const e = n as A.Expr;
    if (e.kind === 'Binary' && ['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
      const l = e.left, r = e.right;
      const cr = constant(r), cl = constant(l);
      if (l.kind === 'Name' && l.name === param && cr !== null) tests.push((v) => compare(e.op, v, cr));
      if (r.kind === 'Name' && r.name === param && cl !== null) tests.push((v) => compare(e.op, cl, v));
    }
    for (const [k, v] of Object.entries(e)) if (k !== 'span' && k !== 'id') visit(v);
  };
  for (const it of m.items) if ((it.kind === 'Handler' && it.action === action) || it.kind === 'Property' || it.kind === 'Guard') visit(it);
  const classes = new Map<string, number>();
  for (let v = 0; v <= 1000; v++) {
    const sig = tests.map((t) => (t(v) ? 1 : 0)).join('');
    if (!classes.has(sig)) classes.set(sig, v);
  }
  return [...classes.values()];
}
