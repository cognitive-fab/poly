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
  machines: Map<string, { service: boolean; fields: Map<string, { values: (string | number | boolean)[] | null; conf: boolean }>; effects: { kind: string; class: string; labels: string[] }[] }>;
  decisions: Map<string, { answers: (string | number | boolean)[] | null }>;
  /** PT9.9: each send a machine's handlers make to an address of a known machine. */
  sends: { from: string; to: string; action: string }[];
}

/** The program facts a policy reads, from the modules' ASTs. */
export function policyFacts(modules: Module[]): PolicyFacts {
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
    for (const d of m.decls) {
      if (d.kind !== 'Machine') continue;
      const fields = new Map<string, { values: (string | number | boolean)[] | null; conf: boolean }>();
      for (const f of d.fields) fields.set(f.name, { values: values(f.type), conf: f.type.kind === 'TConf' });
      const effects: { kind: string; class: string; labels: string[] }[] = [];
      for (const it of d.items) {
        if (it.kind === 'EffectDecl') {
          const kind = it.items.find((x) => x.kind === 'EffKind') as { value: string } | undefined;
          const cls = it.items.find((x) => x.kind === 'EffClass') as { value: string } | undefined;
          effects.push({ kind: kind?.value ?? it.name, class: cls?.value ?? 'none', labels: it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])) });
        }
        if (it.kind === 'Decision') {
          effects.push({ kind: `decision.${it.name}`, class: 'none', labels: it.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])) });
          decisions.set(it.name, { answers: values(it.result) });
        }
      }
      machines.set(`${m.name}.${d.name}`, { service: d.service, fields, effects });
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
  return { machines, decisions, sends };
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
      return null;
    }
    case 'Call':
      if (e.callee === 'unknown') return r(e.args[0]) === null;
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

interface Reads { machines: Map<string, Set<string>>; decisions: Map<string, Set<string>>; confConstants: Map<string, Set<number>> }

function readsOf(s: PolicyScope): Reads {
  const reads: Reads = { machines: new Map(), decisions: new Map(), confConstants: new Map() };
  const walk = (e: Expr | null | undefined): void => {
    if (!e) return;
    if (e.kind === 'Member' && e.object.kind === 'Call' && (e.object.callee === 'machine' || e.object.callee === 'decision')) {
      const name = (e.object.args[0] as { value: string }).value;
      const map = e.object.callee === 'machine' ? reads.machines : reads.decisions;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name)!.add(e.prop);
    }
    if (e.kind === 'Binary' && ['<', '<=', '>', '>=', '==', '!='].includes(e.op)) {
      for (const [x, c] of [[e.left, e.right], [e.right, e.left]] as const) {
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
  for (const [machine, m] of facts.machines) for (const eff of m.effects) proposals.push({ machine, row: (machines, decisions) => ({ proposal: 'effect', effect: { kind: eff.kind, class: eff.class, machine }, effects: eff.labels, machines, decisions }) });
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
      const decisionChoices: [string, (Record<string, V> | null)[]][] = [];
      for (const [d, fieldsRead] of reads.decisions) {
        const info = facts.decisions.get(d);
        const options: (Record<string, V> | null)[] = [null];
        const answers = info?.answers ?? (fieldsRead.has('answer') ? (open.push(`decision ${d}.answer`), [null]) : [null]);
        for (const answer of fieldsRead.has('answer') ? answers : [null]) {
          for (const conf of fieldsRead.has('conf') ? confReps(`${d}.conf`) : [null]) {
            for (const margin of fieldsRead.has('margin') ? confReps(`${d}.margin`) : [null]) {
              for (const [model, fitted] of (fieldsRead.has('model') || fieldsRead.has('calibration')) ? [['m-a', 'm-a'], ['m-a', 'm-b']] : [[null, null]]) {
                options.push({ answer, conf, margin, ...(model ? { model: { id: model, reported: model } as unknown as V, calibration: { fittedFor: fitted, version: 1 } as unknown as V } : {}) });
              }
            }
          }
        }
        decisionChoices.push([d, options]);
      }
      const combos = product([...machineChoices.map(([, l]) => l as unknown[]), ...decisionChoices.map(([, l]) => l as unknown[])]);
      for (const c of combos) {
        if (rows.length >= maxRows) { capHit = true; break; }
        const machines: Record<string, unknown> = {};
        machineChoices.forEach(([rm], k) => { if (Object.keys(c[k] as object).length) machines[rm] = c[k]; });
        const decisions: Record<string, unknown> = {};
        decisionChoices.forEach(([d], k) => { const v = c[machineChoices.length + k]; if (v) decisions[d] = v; });
        rows.push(build(machines, decisions));
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
    let hit: { path: WitnessStep[]; row: Record<string, any>; sigma: Sigma } | null = null;
    for (const st of states) {
      for (const row of table.rows) {
        if (truth(evalPolicyExpr(it.when, row, vars)) !== true) continue;
        applies = true;
        if (evaluate(s, st.sigma, row).decision === 'allow') { hit = { path: st.path, row, sigma: st.sigma }; break; }
      }
      if (hit) break;
    }
    if (hit) {
      const trace = [...hit.path, { pre: hit.sigma, action: 'propose', data: hit.row, post: hit.sigma, verdict: 'allow' }];
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
