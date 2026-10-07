// Policies by PS8, written from 04-semantics and sharing no code with the compiler (PS9.3).
//
// A proposal is the object the gate host gives the engine (PT9.1, S147): `{ proposal, effect: { kind, class,
// machine }, effects: labels, machines: { "m.M": { f: v } }, decisions: { d: { answer, conf, … } } }`. A field that
// is absent is unknown. Expressions take values in {T, F, U} (PS8.1); a rule's outcome is PS8.2's table; the
// gate's decision is PS8.3's combination. A machine obligation refuses in a state whose guard is true or unknown,
// and moves on an allowed proposal by the first transition whose condition is true (PT8.2).
//
// The decision table (S149) is the finite product of the proposals a program can make: one per effect it declares,
// with every value of each machine field the policies read (for the emitter, and for a service machine, which is a
// singleton), and every recorded-decision value the policies can tell apart (absent, each answer, each side of
// each confidence constant). Over it, poly-ref proves each `never` statement, and compares its own decisions with
// the engine's (translation validation of the lowered policy).
import type { Module, Policy, Expr, Diagnostic, WitnessStep, TypeExpr, MachineObligation } from '@poly/core';

export type V = string | number | boolean | null | string[];
export type Decision = 'allow' | 'deny' | 'escalate';

export interface PolicyFacts {
  machines: Map<string, { service: boolean; fields: Map<string, { values: (string | number | boolean)[] | null; conf: boolean }>; effects: { kind: string; class: string; labels: string[]; uses?: string; content?: boolean; items?: number; route?: { route: string; tier: string }; budget?: { budget: string } }[]; claims?: Record<string, (string | number | boolean)[] | null>[] }>;
  decisions: Map<string, { answers: (string | number | boolean)[] | null }>;
  /** PT9.9: each send a machine's handlers make to an address of a known machine. */
  sends: { from: string; to: string; action: string }[];
  /** PD5.2.2c: every action of the program as an intent, and the values of every claims type's fields. */
  intents?: string[];
  claimsValues?: Record<string, (string | number | boolean)[] | null>[];
  /** PT10k: the audience classes, and the largest limit among the retrievals. */
  audience?: string[];
  itemsLimit?: number;
}

/** The program facts a policy reads, from the modules' ASTs. */
export function policyFacts(modules: Module[]): PolicyFacts {
  // PS18.2, PS18.4: each route's tiers and budget; a call of route r is the effect route.r.call of m.r.Route.
  const routes = new Map(modules.flatMap((m) => m.decls.flatMap((d) => (d.kind === 'Route' ? [[`route.${d.name}.call` as string, { route: d.name, tiers: d.tiers.map((t) => t.name), budget: d.budget }] as const] : []))));
  const machines: PolicyFacts['machines'] = new Map();
  const decisions: PolicyFacts['decisions'] = new Map();
  const sends: PolicyFacts['sends'] = [];
  for (const m of modules) {
    const enums = new Map<string, string[]>();
    for (const d of m.decls) {
      if (d.kind === 'EnumDecl') enums.set(d.name, d.members);
      if (d.kind === 'TypeDecl' && d.ctors.every((c) => c.fields.length === 0)) enums.set(d.name, d.ctors.map((c) => c.name));
    }
    const values = (t: TypeExpr): (string | number | boolean)[] | null => {
      if (t.kind === 'TBool') return [false, true];
      if (t.kind === 'TRange') return Array.from({ length: t.hi - t.lo + 1 }, (_, k) => t.lo + k);
      if (t.kind === 'TName' && enums.has(t.name)) return enums.get(t.name)!;
      return null;
    };
    // PS18.2, read here from the declaration: a route r is the machine m.r.Route, whose call has the kind route.r.call,
    // class none and its decision's labels, proposed once per tier with its route and its budget (PS18.4).
    for (const d of m.decls) {
      if (d.kind !== 'Route') continue;
      let labels: string[] = ['egress:external'];
      for (const x of m.decls) if (x.kind === 'Machine') for (const i of x.items) if (i.kind === 'Decision' && i.items.some((y) => y.kind === 'DecRoute' && y.route === d.name)) labels = i.items.flatMap((y) => (y.kind === 'EffLabels' ? y.labels : []));
      machines.set(`${m.name}.${d.name}.Route`, { service: false, fields: new Map(), effects: d.tiers.map((t) => ({ kind: `route.${d.name}.call`, class: 'none', labels, route: { route: d.name, tier: t.name }, ...(d.budget ? { budget: { budget: d.budget } } : {}) })), claims: [] });
    }
    for (const d of m.decls) {
      if (d.kind !== 'Machine') continue;
      const fields = new Map<string, { values: (string | number | boolean)[] | null; conf: boolean }>();
      // Review B5: a field with a check domain (a string field must have one, PL1101) takes its values from it.
      const checked = (f: { check: { domain: { kind: string; values?: { kind: string; value?: unknown }[]; lo?: number; hi?: number } } | null }): (string | number | boolean)[] | null => {
        const dom = f.check?.domain;
        if (!dom) return null;
        if (dom.kind === 'DomainRange') return Array.from({ length: dom.hi! - dom.lo! + 1 }, (_, k) => dom.lo! + k);
        const vs = dom.values!.map((v) => (v.kind === 'String' || v.kind === 'Int' || v.kind === 'Bool' ? v.value : undefined));
        return vs.every((v) => v !== undefined) ? (vs as (string | number | boolean)[]) : null;
      };
      for (const f of d.fields) fields.set(f.name, { values: values(f.type) ?? checked(f as never), conf: f.type.kind === 'TConf' });
      const effects: { kind: string; class: string; labels: string[]; uses?: string; content?: boolean; items?: number; route?: { route: string; tier: string }; budget?: { budget: string } }[] = [];
      const isContent = (x: TypeExpr) => x.kind === 'TName' && x.name === 'Content';
      const isItems = (x: TypeExpr) => x.kind === 'TName' && x.name === 'Items';
      for (const it of d.items) {
        if (it.kind === 'EffectDecl') {
          const kind = it.items.find((x) => x.kind === 'EffKind') as { value: string } | undefined;
          const cls = it.items.find((x) => x.kind === 'EffClass') as { value: string } | undefined;
          // PS16.3: the credential an effect uses, whose grant the runtime checks before any policy.
          const uses = it.items.find((x) => x.kind === 'EffUses') as { credential: string } | undefined;
          // PS17.2, PS17.5: a retrieval's and a remember's kind and labels are the runtime's, read from the source here.
          const r = it.items.find((x) => x.kind === 'EffRetrieve') as { source: string } | undefined;
          const w = it.items.find((x) => x.kind === 'EffRemember') as { source: string } | undefined;
          const src = r ? m.decls.find((x) => x.kind === 'Source' && (x as { name: string }).name === r.source) as { owned: boolean; audience: string } | undefined : undefined;
          const lowest = (m.decls.find((x) => x.kind === 'Audience') as { classes: string[] } | undefined)?.classes[0];
          const memKind = r ? `source.${r.source}.retrieve` : w ? `source.${w.source}.remember` : null;
          const memLabels = w ? ['write:store'] : r ? [src && (src.owned || src.audience !== lowest) ? 'read:private' : 'read:store'] : null;
          const effect = { kind: memKind ?? kind?.value ?? it.name, class: cls?.value ?? 'none', labels: memLabels ?? it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])), ...(uses ? { uses: uses.credential } : {}), ...(!memKind && it.params.some((x) => isContent(x.type)) ? { content: true } : {}), ...(!memKind && it.params.some((x) => isItems(x.type)) ? { items: it.params.filter((x) => isItems(x.type)).length } : {}) };
          // PS18.4: the budget check precedes the policy, so a call reaches it once per tier, with its route and budget.
          const routed = routes.get(effect.kind);
          if (routed) for (const tier of routed.tiers) effects.push({ ...effect, route: { route: routed.route, tier }, ...(routed.budget ? { budget: { budget: routed.budget } } : {}) });
          else effects.push(effect);
        }
        if (it.kind === 'Decision') {
          effects.push({ kind: `decision.${it.name}`, class: 'none', labels: it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])), ...(it.params.some((x) => isItems(x.type)) ? { items: it.params.filter((x) => isItems(x.type)).length } : {}), ...(it.params.some((x) => isContent(x.type) || isItems(x.type)) ? { content: true } : {}) });
          decisions.set(it.name, { answers: values(it.result) });
        }
      }
      // PD5.1.2d: the claims types the machine's actions require, each field's values (a Principal's are not read).
      const claimsTypes = [...new Set(d.items.flatMap((i) => (i.kind === 'Handler' && i.by ? [i.by.type] : [])))];
      const claims = claimsTypes.map((t) => { const rec = m.decls.find((x) => x.kind === 'RecordDecl' && x.name === t) as { fields: { name: string; type: TypeExpr }[] } | undefined; return Object.fromEntries((rec?.fields ?? []).map((f) => [f.name, values(f.type)])); });
      machines.set(`${m.name}.${d.name}`, { service: d.service, fields, effects, claims });
      // A send's target machine, when its address is a field or a parameter of type Ref<M>.
      const refs = new Map<string, string>();
      for (const f of d.fields) if (f.type.kind === 'TRef') refs.set(f.name, f.type.machine.length > 1 ? f.type.machine.join('.') : `${m.name}.${f.type.machine[0]}`);
      for (const it of d.items) if (it.kind === 'Action') for (const p of it.params) if (p.type.kind === 'TRef') refs.set(p.name, p.type.machine.length > 1 ? p.type.machine.join('.') : `${m.name}.${p.type.machine[0]}`);
      const walk = (x: unknown): void => {
        if (!x || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        const n = x as { kind?: string; op?: string; to?: { kind: string; name?: string }; target?: string };
        if (n.kind === 'Intent' && n.op === 'send' && n.to?.kind === 'Name' && refs.has(n.to.name!)) sends.push({ from: `${m.name}.${d.name}`, to: refs.get(n.to.name!)!, action: n.target! });
        for (const v of Object.values(n)) walk(v);
      };
      for (const it of d.items) if (it.kind === 'Handler') walk(it.body);
    }
  }
  const intents = modules.flatMap((m) => m.decls.flatMap((d) => (d.kind === 'Machine' ? d.items.filter((i) => i.kind === 'Action').map((i) => `${m.name}.${d.name}.${(i as { name: string }).name}`) : []))).sort();
  const claimsValues = [...machines.values()].flatMap((x) => x.claims ?? []);
  // PT10k: the audience classes, and the largest limit among the retrievals.
  const audience = [...new Set(modules.flatMap((m) => m.decls.flatMap((d) => (d.kind === 'Audience' ? d.classes : []))))];
  let itemsLimit = 0;
  for (const m of modules) for (const d of m.decls) if (d.kind === 'Machine') for (const it of d.items) if (it.kind === 'EffectDecl') for (const y of it.items) if (y.kind === 'EffRetrieve') itemsLimit = Math.max(itemsLimit, y.limit);
  return { machines, decisions, sends, intents, claimsValues, audience, itemsLimit };
}

// ── PS8.1: Kleene values ────────────────────────────────────────────────────

type T3 = true | false | null;
const not3 = (a: T3): T3 => (a === null ? null : !a);
const and3 = (a: T3, b: T3): T3 => (a === false || b === false ? false : a === null || b === null ? null : true);
const or3 = (a: T3, b: T3): T3 => (a === true || b === true ? true : a === null || b === null ? null : false);
const truth = (v: V): T3 => (v === true ? true : v === false ? false : null);

/** The value of a policy expression on a proposal and the policy's variables (PS8.1). */
export function evalPolicyExpr(e: Expr, proposal: Record<string, any>, vars: Record<string, V>): V {
  const r = (x: Expr) => evalPolicyExpr(x, proposal, vars);
  switch (e.kind) {
    case 'Bool': return e.value;
    case 'Int': return e.value;
    case 'Decimal': return e.value;
    case 'String': return e.value;
    case 'Name': return e.name in vars ? vars[e.name] : e.name;
    case 'Member': {
      const o = e.object;
      if (o.kind === 'Name' && o.name === 'effect' && !('effect' in vars)) return e.prop === 'labels' ? (proposal.effects ?? null) : (proposal.effect?.[e.prop] ?? null);
      if (o.kind === 'Name' && o.name === 'proposal' && !('proposal' in vars)) return proposal.proposal ?? null;
      if (o.kind === 'Name' && o.name === 'send' && !('send' in vars)) return proposal.send?.[e.prop] ?? null;
      if (o.kind === 'Name' && o.name === 'step' && !('step' in vars)) return (proposal.step?.[e.prop] ?? null) as V;
      if (o.kind === 'Name' && o.name === 'lineage' && !('lineage' in vars)) return (proposal.lineage?.[e.prop] ?? null) as V;
      if (o.kind === 'Call' && o.callee === 'machine') return proposal.machines?.[(o.args[0] as { value: string }).value]?.[e.prop] ?? null;
      if (o.kind === 'Call' && o.callee === 'decision') {
        const d = proposal.decisions?.[(o.args[0] as { value: string }).value];
        if (e.prop === 'taken') return d !== undefined && d !== null;
        return d?.[e.prop] ?? null;
      }
      if (o.kind === 'Member' && o.object.kind === 'Call' && o.object.callee === 'decision') {
        const inner = r(o) as unknown as Record<string, V> | null;
        return inner && typeof inner === 'object' ? (inner[e.prop] ?? null) : null;
      }
      if (o.kind === 'Name') return e.prop; // a qualified constructor, Type.C
      // A field of a record the proposal carries (step.claims.f).
      const inner = r(o) as unknown;
      return inner && typeof inner === 'object' && !Array.isArray(inner) ? ((inner as Record<string, V>)[e.prop] ?? null) : null;
    }
    case 'Call':
      if (e.callee === 'unknown') return r(e.args[0]) === null;
      // PS8.8: the ages the proposal carries, unknown when absent.
      if (e.callee === 'age' || e.callee === 'statusAge') return (proposal.step?.[e.callee] ?? null) as V;
      if (e.callee === 'has') { const s = r(e.args[0]); const x = r(e.args[1]); return Array.isArray(s) && x !== null ? s.includes(x as string) : null; }
      return null;
    case 'Unary': {
      const a = r(e.arg);
      if (e.op === '!') return not3(truth(a));
      return typeof a === 'number' ? -a : null;
    }
    case 'Binary': {
      if (e.op === '&&') return and3(truth(r(e.left)), truth(r(e.right)));
      if (e.op === '||') return or3(truth(r(e.left)), truth(r(e.right)));
      if (e.op === 'implies') return or3(not3(truth(r(e.left))), truth(r(e.right)));
      const a = r(e.left); const b = r(e.right);
      if (a === null || b === null) return null;
      switch (e.op) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '<': return (a as number) < (b as number);
        case '<=': return (a as number) <= (b as number);
        case '>': return (a as number) > (b as number);
        case '>=': return (a as number) >= (b as number);
        case '+': return (a as number) + (b as number);
        case '-': return (a as number) - (b as number);
        case '*': return (a as number) * (b as number);
        default: return null;
      }
    }
    case 'In': {
      const a = r(e.expr);
      if (a === null) return null;
      return e.set.some((x) => r(x) === a);
    }
    default: return null;
  }
}

// ── PS8.2, PS8.3: the gate's decision ──────────────────────────────────────

export interface PolicyScope { scope: string; policies: Policy[] }
export type Sigma = Record<string, string>;

const machineObligations = (s: PolicyScope) => s.policies.flatMap((p) => p.items.filter((i): i is MachineObligation => i.kind === 'MachineObligation').map((o) => ({ id: `${p.name}.${o.name}`, o })));

export function initialSigma(s: PolicyScope): Sigma {
  return Object.fromEntries(machineObligations(s).map(({ id, o }) => [id, o.initial]));
}

function varsOf(s: PolicyScope): Record<string, V> {
  const out: Record<string, V> = {};
  for (const p of s.policies) for (const v of p.vars) out[v.name] = v.init.kind === 'Bool' || v.init.kind === 'Int' ? v.init.value : null;
  return out;
}

/**
 * PS8.2 per rule, PT8.2 per machine guard, PS8.3 combined; and Σ after an allowed proposal. `approved`: the proposal
 * carries a person's approval (PT12.5), which lifts every escalation and leaves a deny standing.
 */
export function decide(s: PolicyScope, sigma: Sigma, proposal: Record<string, any>, opts: { approved?: boolean } = {}): { decision: Decision; reasons: string[]; next: Sigma } {
  const vars = varsOf(s);
  const outcomes: { o: string; out: 'deny' | 'escalate' | 'warn' }[] = [];
  for (const p of s.policies) for (const it of p.items) {
    if (it.kind !== 'RuleObligation') continue;
    const w: T3 = it.when ? truth(evalPolicyExpr(it.when, proposal, vars)) : true;
    if (w === false) continue;
    const u = it.onUnknown ?? (it.severity === 'warn' ? 'warn' : 'escalate');
    if (w === null) { if (u !== 'skip') outcomes.push({ o: `${p.name}.${it.name}`, out: u }); continue; }
    const q = truth(evalPolicyExpr(it.require, proposal, vars));
    if (q !== true) outcomes.push({ o: `${p.name}.${it.name}`, out: it.severity });
  }
  // S156, PD5.2.3: in a scope that requires attribution, a compensable or irreversible effect needs an origin with claims.
  if (s.policies.some((p) => p.requiresAttribution) && proposal.proposal === 'effect' && ['compensable', 'irreversible'].includes(proposal.effect?.class) && !(proposal.lineage?.origin)) outcomes.push({ o: `${s.scope}.attribution`, out: 'deny' });
  for (const { id, o } of machineObligations(s)) {
    for (const g of o.guards) {
      if (!g.in.includes(sigma[id])) continue;
      if (truth(evalPolicyExpr(g.when, proposal, vars)) !== false) { outcomes.push({ o: `${id}:${g.reason}`, out: 'deny' }); break; }
    }
  }
  const deny = outcomes.filter((x) => x.out === 'deny');
  const esc = opts.approved ? [] : outcomes.filter((x) => x.out === 'escalate');
  const decision: Decision = deny.length ? 'deny' : esc.length ? 'escalate' : 'allow';
  const next: Sigma = { ...sigma };
  if (decision === 'allow') {
    for (const { id, o } of machineObligations(s)) {
      const t = o.transitions.find((x) => (x.from === '*' || x.from.includes(sigma[id])) && truth(evalPolicyExpr(x.when, proposal, vars)) === true);
      if (t) next[id] = t.to;
    }
  }
  return { decision, reasons: (deny.length ? deny : esc).map((x) => x.o), next };
}

// ── The decision table (S149) ──────────────────────────────────────────────

interface Reads { machines: Map<string, Set<string>>; decisions: Map<string, Set<string>>; confConstants: Map<string, Set<number>>; claims: Set<string>; origin: Set<string>; intent: boolean; attribution: boolean; ages: Map<string, Set<number>>; mandate: boolean; taint: boolean; items: Set<string>; itemAges: Set<number> }

function readsOf(s: PolicyScope): Reads {
  const reads: Reads = { machines: new Map(), decisions: new Map(), confConstants: new Map(), claims: new Set(), origin: new Set(), intent: false, attribution: s.policies.some((p) => p.requiresAttribution), ages: new Map(), mandate: false, taint: false, items: new Set(), itemAges: new Set() };
  const isItemsField = (x: Expr): x is Expr & { kind: 'Member'; prop: string } => x.kind === 'Member' && x.object.kind === 'Member' && x.object.prop === 'items' && x.object.object.kind === 'Name' && x.object.object.name === 'effect';
  const walk = (e: Expr | null | undefined): void => {
    if (!e) return;
    // PT10k: effect.taint and effect.items.f, read; an age's thresholds cut its intervals.
    if (e.kind === 'Member' && e.object.kind === 'Name' && e.object.name === 'effect' && e.prop === 'taint') reads.taint = true;
    if (e.kind === 'Member' && e.object.kind === 'Name' && e.object.name === 'effect' && e.prop === 'items') reads.items.add('*');
    if (isItemsField(e)) reads.items.add(e.prop);
    if (e.kind === 'Binary' && ['<', '<=', '>', '>=', '==', '!='].includes(e.op)) for (const [x, c] of [[e.left, e.right], [e.right, e.left]] as const) if (c.kind === 'Int' && isItemsField(x) && x.prop === 'age') reads.itemAges.add(c.value);
    if (e.kind === 'Member' && e.object.kind === 'Call' && (e.object.callee === 'machine' || e.object.callee === 'decision')) {
      const name = (e.object.args[0] as { value: string }).value;
      const map = e.object.callee === 'machine' ? reads.machines : reads.decisions;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name)!.add(e.prop);
    }
    // PD5.1.2d: step.claims.f.
    if (e.kind === 'Member' && e.object.kind === 'Member' && e.object.object.kind === 'Name' && e.object.object.name === 'step' && e.object.prop === 'claims') reads.claims.add(e.prop);
    // Review C2: step.claims or lineage.origin read as a whole (unknown(step.claims), say) reads every field.
    if (e.kind === 'Member' && e.object.kind === 'Name' && e.object.name === 'step' && e.prop === 'claims') reads.claims.add('*');
    if (e.kind === 'Member' && e.object.kind === 'Name' && e.object.name === 'lineage' && e.prop === 'origin') reads.origin.add('*');
    // PS8.9, review A1 (M9): step.mandate, read whole or by its delegate and delegator.
    if (e.kind === 'Member' && e.object.kind === 'Name' && e.object.name === 'step' && e.prop === 'mandate') reads.mandate = true;
    // PD5.2.2c: lineage.origin.f and lineage.intent.
    if (e.kind === 'Member' && e.object.kind === 'Member' && e.object.object.kind === 'Name' && e.object.object.name === 'lineage' && e.object.prop === 'origin') reads.origin.add(e.prop);
    if (e.kind === 'Member' && e.object.kind === 'Name' && e.object.name === 'lineage' && e.prop === 'intent') reads.intent = true;
    // PS8.8: an age read, and the thresholds it is compared with, which cut its intervals.
    if (e.kind === 'Call' && (e.callee === 'age' || e.callee === 'statusAge') && !reads.ages.has(e.callee)) reads.ages.set(e.callee, new Set());
    if (e.kind === 'Binary' && ['<', '<=', '>', '>=', '==', '!='].includes(e.op)) {
      for (const [x, c] of [[e.left, e.right], [e.right, e.left]] as const) {
        if (c.kind === 'Int' && x.kind === 'Call' && (x.callee === 'age' || x.callee === 'statusAge')) {
          if (!reads.ages.has(x.callee)) reads.ages.set(x.callee, new Set());
          reads.ages.get(x.callee)!.add(c.value);
        }
        if (c.kind === 'Decimal' && x.kind === 'Member' && x.object.kind === 'Call' && x.object.callee === 'decision') {
          const k = `${(x.object.args[0] as { value: string }).value}.${x.prop}`;
          if (!reads.confConstants.has(k)) reads.confConstants.set(k, new Set());
          reads.confConstants.get(k)!.add(c.value);
        }
      }
    }
    for (const v of Object.values(e)) {
      if (Array.isArray(v)) v.forEach((x) => (x && typeof x === 'object' && 'kind' in x ? walk(x as Expr) : undefined));
      else if (v && typeof v === 'object' && 'kind' in (v as object)) walk(v as Expr);
    }
  };
  for (const p of s.policies) for (const it of p.items) {
    if (it.kind === 'RuleObligation') { walk(it.when); walk(it.require); }
    if (it.kind === 'MachineObligation') { it.transitions.forEach((t) => walk(t.when)); it.guards.forEach((g) => walk(g.when)); }
    if (it.kind === 'Never') walk(it.when);
    if (it.kind === 'InvariantObligation') walk(it.expr);
  }
  return reads;
}

const product = <X>(lists: X[][]): X[][] => lists.reduce<X[][]>((acc, l) => acc.flatMap((a) => l.map((x) => [...a, x])), [[]]);

/** Every proposal the program can make, with every value of what the policies read; `open` when a read has no finite domain. */
export function proposalTable(s: PolicyScope, facts: PolicyFacts, maxRows = 200_000): { rows: Record<string, any>[]; open: string[]; capHit: boolean } {
  const reads = readsOf(s);
  const open: string[] = [];
  const confReps = (key: string): number[] => {
    const cs = [...(reads.confConstants.get(key) ?? [])];
    return [...new Set([0, 1000, ...cs.flatMap((c) => [c - 1, c, c + 1])].filter((x) => x >= 0 && x <= 1000))].sort((a, b) => a - b);
  };
  const rows: Record<string, any>[] = [];
  let capHit = false;
  // PT9.9: each send the program makes is a proposal too, from its sender machine.
  const proposals: { machine: string; row: (machines: Record<string, unknown>, decisions: Record<string, unknown>) => Record<string, any> }[] = [];
  // PS16.3, review A1 (M9): the grant check precedes the policy, so a proposal of an effect that uses a credential
  // reaches the policy only with its grant Granted.
  // PT10k: where a policy reads them, an effect with a Content takes each class of taint and none, and a decision with an
  // Items each count, class and age its thresholds cut, and none.
  const classes = facts.audience ?? [];
  const taintChoices = (eff: { content?: boolean }): (Record<string, V> | null)[] => (reads.taint && eff.content ? [null, ...classes.map((c) => ({ class: c }))] : [null]);
  const ageCuts = [...new Set([0, ...[...reads.itemAges].flatMap((x) => [x, x + 1])])].filter((x) => x >= 0).sort((x, y) => x - y);
  // Review A F3, F4: any intent carrying an Items is proposed with items, its count the sum over its Items, so an effect
  // or a decision with n Items parameters counts to n times the largest limit.
  const itemsChoices = (eff: { items?: number }): (Record<string, V> | null)[] => {
    if (!reads.items.size || !eff.items) return [null];
    const want = (f: string) => reads.items.has('*') || reads.items.has(f);
    const counts = want('count') ? Array.from({ length: (facts.itemsLimit ?? 0) * (eff.items ?? 1) + 1 }, (_, k) => k) : [0];
    const cls = want('class') ? classes : classes.slice(0, 1);
    const ages = want('age') ? ageCuts : [0];
    // PT10l: an item's provenance, observed, derived or verified (PS17.5).
    const provs = want('provenance') ? ['observed', 'derived', 'verified'] : ['observed'];
    return [null, ...product([counts, cls, ages, provs] as unknown[][]).map(([count, c, age, provenance]) => ({ count, class: c, age, provenance } as Record<string, V>))];
  };
  for (const [machine, m] of facts.machines) for (const eff of m.effects) for (const taint of taintChoices(eff)) for (const items of itemsChoices(eff)) proposals.push({ machine, row: (machines, decisions) => ({ proposal: 'effect', effect: { kind: eff.kind, class: eff.class, machine, ...(eff.uses ? { credential: { name: eff.uses, grantState: 'Granted' } } : {}), ...(taint ? { taint } : {}), ...(items ? { items } : {}), ...(eff.route ? { route: eff.route } : {}), ...(eff.budget ? { budget: eff.budget } : {}) }, effects: eff.labels, machines, decisions }) });
  for (const s of facts.sends) proposals.push({ machine: s.from, row: (machines, decisions) => ({ proposal: 'send', send: { to: s.to, action: s.action, scope: s.to.slice(0, s.to.lastIndexOf('.')) }, machines, decisions }) });
  for (const { machine, row: build } of proposals) {
    const m = facts.machines.get(machine)!;
    void m;
    {
      // Each read machine: the emitter's snapshot, a service machine's (a singleton), or nothing (unknown).
      const machineChoices: [string, Record<string, V>[]][] = [];
      for (const [rm, fieldsRead] of reads.machines) {
        const target = facts.machines.get(rm);
        if (!target || (rm !== machine && !target.service)) { machineChoices.push([rm, [{}]]); continue; }
        const perField = [...fieldsRead].map((f) => {
          const fd = target.fields.get(f);
          if (!fd || (!fd.values && !fd.conf)) { open.push(`${rm}.${f}`); return [[f, null]] as [string, V][]; }
          return (fd.conf ? confReps(`${rm}.${f}`) : fd.values!).map((v) => [f, v] as [string, V]);
        });
        machineChoices.push([rm, product(perField).map((pairs) => Object.fromEntries(pairs))]);
      }
      // Review B2: a model id is an open string. The ids a policy can tell apart are the strings it names, so the table
  // takes each of them and one more, each once with a map fitted for it and once with a map fitted for another.
  const strings = new Set<string>();
  const lits = (x: unknown): void => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(lits); return; } const n = x as { kind?: string; value?: unknown }; if (n.kind === 'String' && typeof n.value === 'string') strings.add(n.value); for (const v of Object.values(n)) lits(v); };
  for (const p of s.policies) lits(p.items);
  const ids = ['m-a', 'm-b', ...[...strings].filter((x) => x !== 'm-a' && x !== 'm-b').sort()];
  const modelPairs: [string | null, string | null][] = ids.flatMap((x) => [[x, x], [x, ids.find((y) => y !== x)!]] as [string, string][]);
  const decisionChoices: [string, (Record<string, V> | null)[]][] = [];
      for (const [d, fieldsRead] of reads.decisions) {
        const info = facts.decisions.get(d);
        const options: (Record<string, V> | null)[] = [null];
        const answers = info?.answers ?? (fieldsRead.has('answer') ? (open.push(`decision ${d}.answer`), [null]) : [null]);
        for (const answer of fieldsRead.has('answer') ? answers : [null]) {
          for (const conf of fieldsRead.has('conf') ? confReps(`${d}.conf`) : [null]) {
            for (const margin of fieldsRead.has('margin') ? confReps(`${d}.margin`) : [null]) {
              for (const [model, fitted] of (fieldsRead.has('model') || fieldsRead.has('calibration')) ? modelPairs : [[null, null]]) {
                options.push({ answer, conf, margin, ...(model ? { model: { id: model, reported: model } as unknown as V, calibration: { fittedFor: fitted, version: 1 } as unknown as V } : {}) });
              }
            }
          }
        }
        decisionChoices.push([d, options]);
      }
      // PD5.1.2d: the emitting step's claims: none (an action without claims), or each value of the read fields.
      const claimChoices: Record<string, V>[] = [];
      if (reads.claims.size || reads.ages.size) {
        for (const c of m.claims ?? []) {
          const fieldsRead = reads.claims.has('*') ? Object.keys(c) : [...reads.claims];
          const perField = fieldsRead.map((f) => (c[f] ?? [null]).map((v) => [f, v] as [string, V]));
          for (const pairs of product(perField)) claimChoices.push(Object.fromEntries(pairs));
        }
      }
      // PS8.8: each age read, by the intervals its thresholds cut: 0, each threshold and the next millisecond, and unknown.
      const ageChoices = product([...reads.ages].map(([fn, ts]) => [null, ...[...new Set([0, ...[...ts].flatMap((t) => [t, t + 1])])].filter((x) => x >= 0).sort((a, b) => a - b)].map((v) => [fn, v] as [string, V | null])));
      const stepChoices: (Record<string, V | Record<string, V>> | null)[] = [null];
      for (const claims of claimChoices) for (const ages of ageChoices) stepChoices.push({ claims, ...Object.fromEntries(ages.filter(([, v]) => v !== null)) });
      // PS8.9, review A1 (M9): a step with claims may carry a mandate (PT2.4f), whose delegate and delegator a policy
      // tells apart only by the strings it names: each pair of distinct values among them and one more, since the agent
      // is never the delegator. A machine whose actions take no claims carries none.
      if (reads.mandate && (m.claims ?? []).length) {
        const named = new Set<string>();
        const lits = (x: unknown): void => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(lits); return; } const n = x as { kind?: string; value?: unknown }; if (n.kind === 'String' && typeof n.value === 'string') named.add(n.value); for (const v of Object.values(n)) lits(v); };
        for (const p of s.policies) lits(p.items);
        const values = [...[...named].sort(), [...named].includes('p-other') ? 'p-other-2' : 'p-other'];
        const mandates = values.flatMap((a) => values.filter((b) => b !== a).map((b) => ({ delegate: a, delegator: b })));
        const bases = stepChoices.some((x) => x) ? stepChoices.filter((x): x is Record<string, V | Record<string, V>> => !!x) : [{}];
        for (const b of bases) for (const mandate of mandates) stepChoices.push({ ...b, mandate });
      }
      // PD5.2.2c, S156: the emitting step's lineage: an origin with no claims, or each value of the read origin fields;
      // and each intent of the program, when the policies read it.
      const originChoices: (Record<string, V> | null)[] = [null];
      if (reads.origin.size || reads.attribution) {
        for (const c of facts.claimsValues ?? []) {
          const fieldsRead = reads.origin.has('*') ? Object.keys(c) : [...reads.origin];
          const perField = fieldsRead.map((f) => (c[f] ?? [null]).map((v) => [f, v] as [string, V]));
          for (const pairs of product(perField)) originChoices.push(Object.fromEntries(pairs));
        }
        if (originChoices.length === 1) originChoices.push({});
      }
      const intentChoices: (string | null)[] = reads.intent ? [...(facts.intents ?? [])] : [null];
      const lineageChoices: (Record<string, V> | null)[] = (reads.origin.size || reads.intent || reads.attribution) ? product([originChoices as unknown[], intentChoices as unknown[]]).map(([o, i]) => ({ origin: o as V, ...(i ? { intent: i as V } : {}) })) : [null];
      const seen = new Set<string>();
      const lineages = lineageChoices.filter((l) => { const k = JSON.stringify(l); if (seen.has(k)) return false; seen.add(k); return true; });
      const combos = product([...machineChoices.map(([, l]) => l as unknown[]), ...decisionChoices.map(([, l]) => l as unknown[]), stepChoices as unknown[], lineages as unknown[]]);
      for (const c of combos) {
        if (rows.length >= maxRows) { capHit = true; break; }
        const machines: Record<string, unknown> = {};
        machineChoices.forEach(([rm], k) => { if (Object.keys(c[k] as object).length) machines[rm] = c[k]; });
        const decisions: Record<string, unknown> = {};
        decisionChoices.forEach(([d], k) => { const v = c[machineChoices.length + k]; if (v) decisions[d] = v; });
        const step = c[machineChoices.length + decisionChoices.length];
        const lineage = c[machineChoices.length + decisionChoices.length + 1];
        rows.push({ ...build(machines, decisions), ...(step ? { step } : {}), ...(lineage ? { lineage } : {}) });
      }
    }
  }
  return { rows, open: [...new Set(open)].sort(), capHit };
}

export interface TableResult {
  findings: Diagnostic[];
  vacuous: { property: string; text: string }[];
  runtimeOnly: string[];
  states: number;
  rows: number;
  capHit: boolean;
}

const sigmaKey = (s: Sigma) => JSON.stringify(Object.entries(s).sort());

/**
 * The proposals that move Σ from `sigma`: each allowed one, and each escalated one a person approves (PT12.5: the
 * approval lifts the escalation, and the engine then moves its machines). Review B1.
 */
function moves(s: PolicyScope, sigma: Sigma, row: Record<string, any>): { next: Sigma; verdict: string } | null {
  const d = decide(s, sigma, row);
  if (d.decision === 'allow') return { next: d.next, verdict: 'allow' };
  if (d.decision !== 'escalate') return null;
  const a = decide(s, sigma, row, { approved: true });
  return a.decision === 'allow' ? { next: a.next, verdict: 'allow (approved)' } : null;
}

/** The Σ reachable from the initial one by allowed or approved proposals, each with the path to it (S149). */
function explore(s: PolicyScope, rows: Record<string, any>[], maxStates: number): { states: { sigma: Sigma; path: WitnessStep[] }[]; edges: [number, number][]; capHit: boolean } {
  const start = initialSigma(s);
  const seen = new Map<string, number>([[sigmaKey(start), 0]]);
  const states = [{ sigma: start, path: [] as WitnessStep[] }];
  const edges: [number, number][] = [];
  let capHit = false;
  for (let i = 0; i < states.length; i++) {
    for (const row of rows) {
      const m = moves(s, states[i].sigma, row);
      if (!m) continue;
      const k = sigmaKey(m.next);
      if (seen.has(k)) { edges.push([i, seen.get(k)!]); continue; }
      if (states.length >= maxStates) { capHit = true; continue; }
      seen.set(k, states.length);
      edges.push([i, states.length]);
      states.push({ sigma: m.next, path: [...states[i].path, { pre: states[i].sigma, action: 'propose', data: row, post: m.next, verdict: m.verdict }] });
    }
  }
  return { states, edges, capHit };
}

/**
 * PS8.6: whether a mandate (a machine obligation with end states) is dischargeable under the scope's obligations,
 * explored together over the decision table: from every Σ reachable by allowed or approved proposals, some such path
 * reaches a Σ where the mandate is in one of its end states. An escalation is not a deny on the way. Returns the first
 * reachable Σ from which no path does (with the path to it), or null; `capHit` when the exploration stopped at its
 * bound, in which case nothing is concluded. `keep` narrows the proposals (a mode, PD4.4b).
 */
export function dischargeCheck(s: PolicyScope, facts: PolicyFacts, mandate: string, opts: { keep?: (row: Record<string, any>) => boolean; maxStates?: number } = {}): { trap: { sigma: Sigma; path: WitnessStep[] } | null; capHit: boolean } {
  const m = machineObligations(s).find((x) => x.id === mandate);
  if (!m) return { trap: null, capHit: false };
  const table = proposalTable(s, facts);
  const rows = opts.keep ? table.rows.filter(opts.keep) : table.rows;
  const { states, edges, capHit } = explore(s, rows, opts.maxStates ?? 10_000);
  if (capHit || table.capHit) return { trap: null, capHit: true };
  const good = new Set<number>(states.map((st, i) => (m.o.end.includes(st.sigma[mandate]) ? i : -1)).filter((i) => i >= 0));
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of edges) if (!good.has(a) && good.has(b)) { good.add(a); changed = true; }
  }
  const i = states.findIndex((_, k) => !good.has(k));
  return { trap: i < 0 ? null : { sigma: states[i].sigma, path: states[i].path }, capHit: false };
}

/** S149: each `never` statement of the scope, proved over the decision table, with a witness when it fails. */
export function checkNever(s: PolicyScope, facts: PolicyFacts, at: (node: string) => { module?: string; node?: string; line?: number; col?: number }, opts: { evaluate?: typeof decide; maxStates?: number } = {}): TableResult {
  const evaluate = opts.evaluate ?? decide;
  const table = proposalTable(s, facts);
  const { states, capHit } = explore(s, table.rows, opts.maxStates ?? 10_000);
  const findings: Diagnostic[] = [];
  const vacuous: TableResult['vacuous'] = [];
  const runtimeOnly: string[] = [];
  const vars = varsOf(s);
  for (const p of s.policies) for (const it of p.items) {
    if (it.kind !== 'Never') continue;
    const reads = readsOf({ scope: s.scope, policies: [{ ...p, items: [it] }] });
    // S149: an open domain, a machine field's or a decision's answer, is checked at run time only.
    const touchesOpen = [...reads.machines].some(([m, fs]) => [...fs].some((f) => table.open.includes(`${m}.${f}`)))
      || [...reads.decisions].some(([d, fs]) => [...fs].some((f) => table.open.includes(`decision ${d}.${f}`)));
    if (touchesOpen) { runtimeOnly.push(`${p.name}.${it.name}`); continue; }
    let applies = false;
    let hit: { path: WitnessStep[]; row: Record<string, any>; sigma: Sigma; verdict: string } | null = null;
    for (const st of states) {
      for (const row of table.rows) {
        if (truth(evalPolicyExpr(it.when, row, vars)) !== true) continue;
        applies = true;
        // An escalated proposal is allowed once a person approves it (PT12.5), so it violates the statement too.
        const d = evaluate(s, st.sigma, row).decision;
        const verdict = d === 'allow' ? 'allow' : d === 'escalate' && evaluate(s, st.sigma, row, { approved: true }).decision === 'allow' ? 'allow (approved)' : null;
        if (verdict) { hit = { path: st.path, row, sigma: st.sigma, verdict }; break; }
      }
      if (hit) break;
    }
    if (hit) {
      const trace = [...hit.path, { pre: hit.sigma, action: 'propose', data: hit.row, post: hit.sigma, verdict: hit.verdict }];
      const n = at(it.id);
      findings.push({ code: 'PL6503', name: 'NEVER_VIOLATED', severity: 'finding', stage: 'policy', at: n, message: `policy ${p.name} allows a proposal its statement ${it.name} forbids ("${it.text}")`, property: `${p.name}.${it.name}`, witness: { id: '', length: trace.length, trace } } as Diagnostic);
    } else if (!applies) vacuous.push({ property: `${p.name}.${it.name}`, text: `no proposal of the program satisfies its condition` });
  }
  return { findings, vacuous, runtimeOnly, states: states.length, rows: table.rows.length, capHit: capHit || table.capHit };
}

/**
 * Translation validation of a lowered policy: over every reachable pair of Σ (poly-ref's, and the engine's own
 * model) and every proposal of the table, the engine's decision is PS8's. `engine` steps the lowered document.
 */
export function validatePolicy(s: PolicyScope, facts: PolicyFacts, engine: { initial: () => unknown; step: (model: unknown, proposal: Record<string, any>, opts?: { approved?: boolean }) => { decision: Decision; next: unknown } }, opts: { maxStates?: number; evaluate?: typeof decide } = {}): { mismatch: WitnessStep[] | null; detail: string; pairs: number; rows: number; capHit: boolean } {
  const table = proposalTable(s, facts);
  const maxStates = opts.maxStates ?? 10_000;
  const start = { sigma: initialSigma(s), model: engine.initial(), path: [] as WitnessStep[] };
  const key = (x: { sigma: Sigma; model: unknown }) => sigmaKey(x.sigma) + '|' + JSON.stringify(x.model);
  const seen = new Set([key(start)]);
  const queue = [start];
  let capHit = table.capHit;
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const row of table.rows) {
      const want = (opts.evaluate ?? decide)(s, cur.sigma, row);
      const got = engine.step(cur.model, row);
      const step: WitnessStep = { pre: cur.sigma, action: 'propose', data: row, post: want.next, verdict: want.decision };
      if (got.decision !== want.decision) return { mismatch: [...cur.path, step], detail: `PS8 decides ${want.decision}${want.reasons.length ? ` (${want.reasons.join(', ')})` : ''} and the lowered policy ${got.decision}`, pairs: queue.length, rows: table.rows.length, capHit };
      // Review B1: an escalation a person approves is decided again with the approval, and its Σ explored.
      let next = want.decision === 'allow' ? { sigma: want.next, model: got.next, verdict: 'allow' } : null;
      if (want.decision === 'escalate') {
        const wantA = (opts.evaluate ?? decide)(s, cur.sigma, row, { approved: true });
        const gotA = engine.step(cur.model, row, { approved: true });
        if (gotA.decision !== wantA.decision) return { mismatch: [...cur.path, { ...step, verdict: `${wantA.decision} (approved)` }], detail: `with a person's approval, PS8 decides ${wantA.decision} and the lowered policy ${gotA.decision}`, pairs: queue.length, rows: table.rows.length, capHit };
        if (wantA.decision === 'allow') next = { sigma: wantA.next, model: gotA.next, verdict: 'allow (approved)' };
      }
      if (!next) continue;
      const nx = { sigma: next.sigma, model: next.model, path: [...cur.path, { ...step, post: next.sigma, verdict: next.verdict }] };
      const k = key(nx);
      if (seen.has(k)) continue;
      if (queue.length >= maxStates) { capHit = true; continue; }
      seen.add(k);
      queue.push(nx);
    }
  }
  return { mismatch: null, detail: '', pairs: queue.length, rows: table.rows.length, capHit };
}
