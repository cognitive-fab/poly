// Configurations of communicating machines (PS13), a third System for the explorer.
//
// A global state is (σ, μ): σ gives each instance its state, and μ holds the
// messages in transit. A global step is an input the configuration declares,
// or the delivery of any one message in transit to its target, which takes
// its step by R_M of its machine (PS3.2). An accepted step's sends join μ; a
// send to none adds nothing and is PL5404 (S29); its other intents are
// completed only through declared inputs (S61). A delivery the target
// rejects consumes the message and changes no state (PS13.3).
//
// μ is kept as the multiset of message values (PS13.2a): two copies of one
// (target, action, data) produce the same step at the receiver, so the
// quotient is exact for safety. Identities (sender, step, position) and
// oldest-copy delivery matter for fairness (PS13.2b), which M2 checks; they
// are not part of the state here, as they are not in the evidence script.
//
// Every transition is computed by this package's own step function, from
// 04-semantics; nothing here comes from the compiler.
import type * as A from '@poly/core';
import type { Diagnostic, Module, Witness, WitnessStep } from '@poly/core';
import { createHash } from 'node:crypto';
import { buildMachine, inCheckDomain, inType, valuesOf, type RMachine } from './model.js';
import { transition, initialState, isTerminal } from './step.js';
import { evaluate, evaluateAt, type GlobalView } from './eval.js';
import { explore, pathTo, type Edge, type Graph, type Label, type Outcome, type System } from './explore.js';
import { keyOf, stateKey, statePlain, toPlain, type State, type Value } from './values.js';
import { ENGINE } from './check.js';

/** A message in transit: its target instance, action and data (PS13.2). */
export interface Message {
  target: number;
  action: string;
  data: Record<string, Value>;
}

export interface GlobalState {
  sigma: State[];
  /** The multiset μ, sorted by the messages' keys (PS13.2a). */
  mu: Message[];
}

export interface ConfigInstance {
  /** Its address: `inv`, or `order[0]` for a member of the group `order`. */
  name: string;
  group: string | null;
  machine: RMachine;
  init: State;
}

/** A global step's label: the step at its instance, and what kind of global step it was (PS13.3). */
export interface GlobalLabel extends Label {
  via: 'input' | 'deliver';
  instance: number;
  /** A send of this step to none (S29). */
  toNone: boolean;
}

// poly-ref names its own codes (PT12.2): it imports no value from the compiler.
const CODE = {
  PL3102: ['DOMAIN_ESCAPE', 'finding'],
  PL3901: ['BOUND_HIT', 'inconclusive'],
  PL5301: ['TRANSIT_BOUND_HIT', 'inconclusive'],
  PL5401: ['CONFIGURATION_INVARIANT', 'finding'],
  PL5402: ['STUCK', 'finding'],
  PL5404: ['SEND_TO_NONE', 'finding'],
} as const;

export interface ConfigReport {
  configuration: string;
  /** Reachable global states within the bounds. */
  states: number;
  transitions: number;
  instances: ConfigInstance[];
  bounds: { transit: number; instances: number | null };
  findings: Diagnostic[];
  /** Liveness properties, listed as not run in M1 (M1-2). */
  liveness: string[];
  capHit: boolean;
  graph: Graph<GlobalState>;
}

const msgKey = (m: Message) => `${m.target}:${m.action}:${Object.keys(m.data).sort().map((k) => `${k}=${keyOf(m.data[k])}`).join(',')}`;
const sortMu = (mu: Message[]) => [...mu].sort((a, b) => (msgKey(a) < msgKey(b) ? -1 : msgKey(a) > msgKey(b) ? 1 : 0));

export function buildConfiguration(module: Module, name: string): { decl: A.Configuration; instances: ConfigInstance[] } {
  const decl = module.decls.find((d): d is A.Configuration => d.kind === 'Configuration' && d.name === name);
  if (!decl) throw new Error(`poly-ref: no configuration ${name} in module ${module.name}`);
  const machines = new Map<string, RMachine>();
  const machineOf = (qual: string[]) => {
    const n = qual[qual.length - 1];
    if (!machines.has(n)) machines.set(n, buildMachine(module, n));
    return machines.get(n)!;
  };
  const instances: ConfigInstance[] = [];
  for (const i of decl.instances) {
    const M = machineOf(i.machine);
    const names = i.count === null ? [i.name] : Array.from({ length: i.count }, (_, k) => `${i.name}[${k}]`);
    for (const n of names) instances.push({ name: n, group: i.count === null ? null : i.name, machine: M, init: {} });
  }
  // PS13.1: each instance starts at its machine's initial state, with the configuration's values in place;
  // an address is the name of an instance (PS1.6).
  for (const i of decl.instances) {
    for (const inst of instances.filter((x) => (x.group ?? x.name) === i.name)) {
      const s = initialState(inst.machine);
      for (const x of i.init) {
        const f = inst.machine.fields.find((y) => y.name === x.field);
        if (!f) throw new Error(`poly-ref: ${inst.machine.name} has no field ${x.field}`);
        s[x.field] = f.type.k === 'ref' ? addressOf(x.value) : evaluateAt(x.value, { M: inst.machine, state: {}, data: {}, locals: new Map() }, f.type);
      }
      inst.init = s;
    }
  }
  return { decl, instances };
}

function addressOf(e: A.Expr): Value {
  if (e.kind === 'Name') return e.name === 'none' ? null : e.name;
  if (e.kind === 'Index' && e.object.kind === 'Name' && e.index.kind === 'Int') return `${e.object.name}[${e.index.value}]`;
  throw new Error('poly-ref: an address in a configuration is none, an instance or a member g[k]');
}

/** The global view σ gives a configuration property (PS13.6). */
function view(instances: ConfigInstance[], sigma: State[], initial: GlobalView | null): GlobalView {
  const byName = new Map(instances.map((x, k) => [x.name, k]));
  const groups = new Map<string, number>();
  for (const x of instances) if (x.group) groups.set(x.group, (groups.get(x.group) ?? 0) + 1);
  return {
    instance: (n) => { const k = byName.get(n); return k === undefined ? undefined : { M: instances[k].machine, state: sigma[k] }; },
    groups,
    initial,
  };
}

/** The configuration as a System over global states (PS13.2, PS13.3). */
export function configurationSystem(decl: A.Configuration, instances: ConfigInstance[]): System<GlobalState> {
  const B = decl.bounds?.transit ?? Infinity;
  const index = new Map(instances.map((x, k) => [x.name, k]));
  // PS1.6: in a configuration an address of M ranges over the addresses of M's instances, and none.
  const addresses = (machine: string): Value[] => [null, ...instances.filter((x) => x.machine.name === machine).map((x) => x.name)];
  const dataOf = (M: RMachine, action: string): Record<string, Value>[] => {
    const a = M.actions.find((x) => x.name === action)!;
    let recs: Record<string, Value>[] = [{}];
    for (const p of a.params) {
      const vs = p.check ?? (p.type.k === 'ref' ? addresses(p.type.machine) : valuesOf(p.type, M));
      recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [p.name]: v })));
    }
    return recs;
  };
  // S31: the inputs, instance by instance, in declaration order.
  const inputs: { instance: number; action: string; data: Record<string, Value>[] }[] = [];
  for (const r of decl.inputs) {
    const members = r.index === null ? [r.instance] : r.index === '*' ? instances.filter((x) => x.group === r.instance).map((x) => x.name) : [`${r.instance}[${r.index}]`];
    for (const n of members) {
      const k = index.get(n)!;
      inputs.push({ instance: k, action: r.action, data: dataOf(instances[k].machine, r.action) });
    }
  }
  const step = (s: GlobalState, k: number, action: string, data: Record<string, Value>, mu: Message[], via: 'input' | 'deliver'): { label: GlobalLabel; outcome: Outcome<GlobalState> } => {
    const inst = instances[k];
    const st = transition(inst.machine, s.sigma[k], action, data, inst.name);
    const sigma = [...s.sigma];
    sigma[k] = st.next;
    const next = [...mu];
    let toNone = false;
    for (const x of st.effects) {
      if (x.type !== 'send') continue; // S61: other intents are completed only through declared inputs
      if (x.target === null) { toNone = true; continue; } // S29: nothing joins μ
      const t = index.get(x.target as string);
      if (t === undefined) throw new Error(`poly-ref: ${inst.name} sends to ${keyOf(x.target)}, which is no instance of the configuration`);
      next.push({ target: t, action: x.action, data: x.data });
    }
    const label: GlobalLabel = { action, data, verdict: st.verdict, effects: st.effects, via, instance: k, toNone };
    const g: GlobalState = { sigma, mu: sortMu(next) };
    // PS13.5: a step that would exceed B messages in transit is not explored.
    if (g.mu.length > B) return { label, outcome: { kind: 'bound', state: g, field: 'transit', value: g.mu.length } };
    for (const f of inst.machine.fields) {
      if (!inType(st.next[f.name], f.type, inst.machine)) return { label, outcome: { kind: 'escape', state: g, field: `${inst.name}.${f.name}`, value: st.next[f.name] } };
      if (!inCheckDomain(st.next[f.name], f, inst.machine)) return { label, outcome: { kind: 'bound', state: g, field: `${inst.name}.${f.name}`, value: st.next[f.name] } };
    }
    return { label, outcome: { kind: 'state', state: g } };
  };
  return {
    initial: () => ({ sigma: instances.map((x) => x.init), mu: [] }),
    key: (s) => `${s.sigma.map((x, k) => stateKey(x, instances[k].machine.fieldNames)).join('|')}||${s.mu.map(msgKey).join(';')}`,
    successors: (s) => {
      const out: { label: GlobalLabel; outcome: Outcome<GlobalState> }[] = [];
      for (const inp of inputs) for (const d of inp.data) out.push(step(s, inp.instance, inp.action, d, s.mu, 'input'));
      // PS13.3, PS13.4: any one message in transit may be delivered next; copies of one value are one choice.
      const seen = new Set<string>();
      s.mu.forEach((m, j) => {
        const key = msgKey(m);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(step(s, m.target, m.action, m.data, [...s.mu.slice(0, j), ...s.mu.slice(j + 1)], 'deliver'));
      });
      return out;
    },
  };
}

/** Explores a configuration and checks it (PS13.5, PS13.6). */
export function checkConfiguration(module: Module, name: string, opts: { maxStates?: number } = {}): ConfigReport {
  const { decl, instances } = buildConfiguration(module, name);
  const sys = configurationSystem(decl, instances);
  const g = explore(sys, opts.maxStates);
  const findings: Diagnostic[] = [];
  const at = (node?: string) => ({ module: module.name, ...(node ? { node } : {}) });
  const digestOf = (s: GlobalState) => 'sha256:' + createHash('sha256').update(sys.key(s)).digest('hex');
  const finding = (code: keyof typeof CODE, node: string | undefined, message: string, edges: Edge<GlobalState>[], about: { property?: string; field?: string; state?: GlobalState } = {}): Diagnostic => {
    const [cname, severity] = CODE[code];
    const witness: Witness = { id: '', length: edges.length, trace: trace(edges) };
    return {
      code, name: cname, severity, stage: 'configuration', engine: ENGINE, at: at(node), message, witness,
      ...(about.property ? { property: about.property } : {}),
      ...(about.field ? { field: about.field } : {}),
      ...(about.state ? { stateDigest: digestOf(about.state) } : {}),
    };
  };
  const plainData = (d: Record<string, Value>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, toPlain(v)]));
  const trace = (edges: Edge<GlobalState>[]): WitnessStep[] => edges.map((e) => {
    const l = e.label as GlobalLabel;
    const inst = instances[l.instance];
    const vals = Object.values(l.data).map((v) => (v === null ? 'none' : typeof v === 'object' ? keyOf(v) : String(v)));
    const call = `${l.action}${vals.length || l.via === 'deliver' ? `(${vals.join(', ')})` : ''}`;
    const text = l.via === 'input' ? `${l.action}@${inst.name}` : `${call} -> ${inst.name}`;
    const post = e.to !== null ? g.states[e.to] : e.outcome.state;
    return {
      pre: statePlain(g.states[e.from].sigma[l.instance]),
      action: l.action,
      data: plainData(l.data),
      post: statePlain(post.sigma[l.instance]),
      verdict: l.verdict.kind === 'rejected' ? `rejected(${l.verdict.reason})` : l.verdict.kind,
      ...(l.effects.length ? { effects: l.effects.map((x) => x.kind) } : {}),
      global: { kind: l.via, instance: inst.name, text },
    };
  });

  // PS13.6: each configuration invariant, at its first violating state in BFS order (a shortest witness).
  const initial = view(instances, g.states[0].sigma, null);
  const envOf = (s: GlobalState) => ({ M: instances[0].machine, state: {}, data: {}, locals: new Map<string, Value>(), global: view(instances, s.sigma, initial) });
  const liveness: string[] = [];
  for (const p of decl.properties) {
    if (p.kind === 'Liveness') { liveness.push(p.name); continue; }
    const i = g.states.findIndex((s) => evaluate(p.expr, envOf(s)) !== true);
    if (i >= 0) findings.push(finding('PL5401', p.id, `configuration invariant ${p.name} is violated in a reachable global state`, pathTo(g, i), { property: p.name, state: g.states[i] }));
  }
  // S29: a send to none, one finding per instance's action, at its first step in BFS order.
  const none = new Set<string>();
  for (const e of g.edges) {
    const l = e.label as GlobalLabel;
    if (!l.toNone || l.verdict.kind !== 'accepted') continue;
    const key = `${instances[l.instance].machine.name}.${l.action}`;
    if (none.has(key)) continue;
    none.add(key);
    findings.push(finding('PL5404', instances[l.instance].machine.handlers.get(l.action)?.id, `${instances[l.instance].name} sends to none on ${l.action}; the message goes nowhere (S29)`, [...pathTo(g, e.from), e], { property: key }));
  }
  // PS13.6: a quiescent state (μ empty, no declared input accepted) where a non-service instance is not terminal.
  const stuck = g.states.findIndex((s, i) => s.mu.length === 0
    && !g.out[i].some((k) => (g.edges[k].label as GlobalLabel).via === 'input' && g.edges[k].label.verdict.kind === 'accepted')
    && instances.some((x, k) => !x.machine.service && !isTerminal(x.machine, s.sigma[k])));
  if (stuck >= 0) {
    const s = g.states[stuck];
    const waiting = instances.filter((x, k) => !x.machine.service && !isTerminal(x.machine, s.sigma[k])).map((x) => x.name);
    findings.push(finding('PL5402', undefined, `a quiescent global state in which ${waiting.join(', ')} ${waiting.length === 1 ? 'is' : 'are'} not terminal: nothing is in transit and no input is accepted`, pathTo(g, stuck), { state: s }));
  }
  // PS13.5 and PS4.2a: bounds are reported, never silently applied; one finding per bound or field.
  const reported = new Set<string>();
  for (const e of g.edges) {
    const o = e.outcome;
    if (o.kind === 'state' || reported.has(`${o.kind}:${o.field}`)) continue;
    reported.add(`${o.kind}:${o.field}`);
    const path = [...pathTo(g, e.from), e];
    if (o.field === 'transit') findings.push(finding('PL5301', undefined, `a step would put ${String(o.value)} messages in transit, above the bound ${decl.bounds?.transit}; it is not explored`, path, { field: 'transit', state: o.state }));
    else if (o.kind === 'escape') findings.push(finding('PL3102', undefined, `${o.field} can leave its type (value ${keyOf(o.value)})`, path, { field: o.field, state: o.state }));
    else findings.push(finding('PL3901', undefined, `${o.field} can leave its check domain (value ${keyOf(o.value)}); the state is not explored`, path, { field: o.field, state: o.state }));
  }
  if (g.capHit) findings.push(finding('PL3901', undefined, `exploration stopped at ${g.states.length} global states`, []));
  return {
    configuration: decl.name,
    states: g.states.length,
    transitions: g.edges.length,
    instances,
    bounds: { transit: decl.bounds?.transit ?? Infinity, instances: decl.bounds?.instances ?? null },
    findings,
    liveness,
    capHit: g.capHit,
    graph: g,
  };
}

/** A global state as plain JSON: each instance's state, and the messages in transit. */
export function globalPlain(instances: ConfigInstance[], s: GlobalState): Record<string, unknown> {
  return {
    sigma: Object.fromEntries(instances.map((x, k) => [x.name, statePlain(s.sigma[k])])),
    mu: s.mu.map((m) => ({ target: instances[m.target].name, action: m.action, data: Object.fromEntries(Object.entries(m.data).map(([k, v]) => [k, toPlain(v)])) })),
  };
}
