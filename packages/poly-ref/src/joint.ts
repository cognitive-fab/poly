// The joint machine of a parent and its attached children (PS7.1, PS7.2, PS7.3).
//
// A joint state is the parent's state and each spawned child's, with every
// instance's status and each child's wiring (PS7.1, S45). A joint step is
// the cascade of one stimulus: the stimulus's own transition, then every
// transition it causes, in order, up to depth 8 (PS7.2):
//   - on an accepted parent step, its spawns, each followed by the child's
//     creation action (S43), then its signals;
//   - a child that becomes terminal delivers its completion to the parent;
//   - a parent that becomes terminal delivers each active child's cancel,
//     in spawn order.
// A delivery inside a cascade to a terminal instance is rejected and
// changes nothing. The stimuli are offered as the kernel delivers them
// (S45, kernel assumption K9): nothing to a terminal instance, and a child's
// completion action to the parent only once that child is terminal.
//
// Each transition of one instance is R_M of that machine (PS3.2), computed by
// this package's own step function; nothing here comes from the compiler.
import type { Diagnostic, Module, Witness, WitnessStep } from '@poly/core';
import { createHash } from 'node:crypto';
import { buildMachine, dataDomain, inCheckDomain, inType, type RMachine } from './model.js';
import { transition, initialState, isTerminal } from './step.js';
import { evaluate, type Verdict } from './eval.js';
import { stateKey, statePlain, toPlain, type State, type Value } from './values.js';
import { ENGINE } from './check.js';

export const MAX_CASCADE_DEPTH = 8;

export interface Instance {
  machine: RMachine;
  state: State;
  status: 'active' | 'terminal';
  onComplete: string | null;
  onParentTerminal: string | null;
}

export interface Joint {
  parent: Instance;
  /** Children in spawn order, by key. */
  children: [string, Instance][];
}

export interface Stimulus {
  target: string;
  action: string;
  data: Record<string, Value>;
}

/** One delivery of a cascade, as polyrun journals it. */
export interface CascadeStep {
  target: string;
  action: string;
  verdict: Verdict;
}

/** A doctrine finding of one cascade (S47). `halts` marks the classes after which the branch has no successor. */
interface Doctrine {
  code: 'PL5101' | 'PL5102' | 'PL5201';
  message: string;
  halts: boolean;
}

const PARENT = 'parent';

export function jointKey(j: Joint): string {
  const inst = (i: Instance) => `${i.machine.id}#${stateKey(i.state, i.machine.fieldNames)}#${i.status}#${i.onComplete ?? ''}#${i.onParentTerminal ?? ''}`;
  return [inst(j.parent), ...j.children.map(([k, c]) => `${k}=${inst(c)}`)].join('|');
}

export function jointPlain(j: Joint): Record<string, unknown> {
  return { parent: statePlain(j.parent.state), children: Object.fromEntries(j.children.map(([k, c]) => [k, statePlain(c.state)])) };
}

const clone = (j: Joint): Joint => ({ parent: { ...j.parent }, children: j.children.map(([k, c]) => [k, { ...c }]) });

/** The parameters a cascade delivery supplies to an action that declares them (S44). */
function deliveryData(M: RMachine, action: string, supplied: Record<string, Value>): Record<string, Value> {
  const a = M.actions.find((x) => x.name === action);
  return Object.fromEntries((a?.params ?? []).filter((p) => p.name in supplied).map((p) => [p.name, supplied[p.name]]));
}

/** One stimulus and its cascade (PS7.2). */
export function jointStep(j0: Joint, stim: Stimulus, childMachines: Map<string, RMachine>): { joint: Joint; cascade: CascadeStep[]; doctrine: Doctrine[] } {
  const j = clone(j0);
  const cascade: CascadeStep[] = [];
  const doctrine: Doctrine[] = [];
  class Halt extends Error {}
  const find = (key: string) => (key === PARENT ? j.parent : j.children.find(([k]) => k === key)?.[1]);

  const dispatch = (target: string, action: string, data: Record<string, Value>, depth: number, viaCascade: boolean): void => {
    if (depth > MAX_CASCADE_DEPTH) {
      doctrine.push({ code: 'PL5201', message: `the cascade of ${stim.target}.${stim.action} is deeper than ${MAX_CASCADE_DEPTH} at ${target}.${action}`, halts: true });
      throw new Halt();
    }
    const inst = find(target);
    if (!inst) {
      // S50 (provisional): a signal to a child that is not spawned; polyrun poisons the parent here.
      doctrine.push({ code: 'PL5102', message: `${action} is signalled to child ${target}, which is not spawned, so the runtime halts the parent`, halts: true });
      throw new Halt();
    }
    if (inst.status !== 'active') {
      cascade.push({ target, action, verdict: { kind: 'rejected', reason: 'terminal' } });
      return;
    }
    const st = transition(inst.machine, inst.state, action, deliveryData(inst.machine, action, data));
    cascade.push({ target, action, verdict: st.verdict });
    if (st.verdict.kind === 'unhandled' && viaCascade) {
      doctrine.push({ code: 'PL5102', message: `${action}, delivered by the cascade to ${target === PARENT ? 'the parent' : `child ${target}`}, has no handler`, halts: false });
    }
    if (st.verdict.kind !== 'accepted') return;
    inst.state = st.next;
    const terminal = isTerminal(inst.machine, st.next);
    if (terminal) inst.status = 'terminal';
    if (target === PARENT) {
      // The kernel executes a step's spawns, each with its creation action, and then its signals.
      for (const x of st.effects) {
        if (x.type !== 'spawn') continue;
        if (j.children.some(([k]) => k === x.key)) {
          doctrine.push({ code: 'PL5101', message: `${stim.action} spawns ${x.key} again while a child ${x.key} exists; the kernel would make a second instance behind one key`, halts: false });
          continue;
        }
        const M = childMachines.get(x.machineId)!;
        const s = initialState(M);
        j.children.push([x.key, { machine: M, state: s, status: isTerminal(M, s) ? 'terminal' : 'active', onComplete: x.onComplete, onParentTerminal: x.onParentTerminal }]);
        if (x.create) dispatch(x.key, x.create.action, x.create.data, depth + 1, true);
      }
      for (const x of st.effects) if (x.type === 'signal') dispatch(x.key, x.action, x.data, depth + 1, true);
    }
    if (terminal && target !== PARENT && inst.onComplete) {
      dispatch(PARENT, inst.onComplete, { childKey: target, childState: null }, depth + 1, true);
    }
    if (terminal && target === PARENT) {
      for (const [k, c] of [...j.children]) {
        if (c.status !== 'active' || !c.onParentTerminal) continue;
        dispatch(k, c.onParentTerminal, { reason: 'parent-terminal' }, depth + 1, true);
      }
    }
  };

  try {
    dispatch(stim.target, stim.action, stim.data, 0, false);
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
  }
  return { joint: j, cascade, doctrine };
}

/** The stimuli offered at a joint state (PS7.1, S45, K9). */
export function stimuliAt(j: Joint): Stimulus[] {
  const out: Stimulus[] = [];
  const owned = new Set(j.children.filter(([, c]) => c.status === 'active').map(([, c]) => c.onComplete).filter((a): a is string => !!a));
  if (j.parent.status === 'active') {
    for (const a of j.parent.machine.actions) {
      if (owned.has(a.name)) continue;
      for (const d of dataDomain(a, j.parent.machine)) out.push({ target: PARENT, action: a.name, data: d });
    }
  }
  for (const [k, c] of j.children) {
    if (c.status !== 'active') continue;
    for (const a of c.machine.actions) for (const d of dataDomain(a, c.machine)) out.push({ target: k, action: a.name, data: d });
  }
  return out;
}

/** The first field of an instance that leaves its type or check domain, if any (PS4.2a). */
function outside(j: Joint): string | null {
  for (const [who, i] of [[PARENT, j.parent] as const, ...j.children]) {
    for (const f of i.machine.fields) {
      if (!inType(i.state[f.name], f.type, i.machine) || !inCheckDomain(i.state[f.name], f, i.machine)) return `${who}.${f.name}`;
    }
  }
  return null;
}

export interface JointEdge {
  from: number;
  stimulus: Stimulus;
  cascade: CascadeStep[];
  to: number | null;
}

export interface JointReport {
  machine: string;
  states: number;
  transitions: number;
  findings: Diagnostic[];
  capHit: boolean;
  /** The joint states, for confirming polyrun's check-product findings. */
  graph: { states: Joint[]; index: Map<string, number>; edges: JointEdge[]; parent: (number | null)[] };
}

/**
 * Explores the joint machine of a parent and its attached children, and checks the compose invariants
 * (PS7.3, PL5001) and the doctrine classes (S47: PL5101, PL5102, PL5201). A joint state that leaves an
 * instance's type or check domain is not explored (PL3901); each machine's own check names the escape.
 */
export function checkJoint(module: Module, parentName: string, opts: { maxStates?: number } = {}): JointReport {
  const maxStates = opts.maxStates ?? 1_000_000;
  const P = buildMachine(module, parentName);
  const childMachines = new Map<string, RMachine>();
  for (const c of P.children.values()) if (!childMachines.has(c.machineId)) childMachines.set(c.machineId, buildMachine(module, c.machine));
  const compose = module.decls.find((d) => d.kind === 'Machine' && d.name === parentName)!;
  const invariants = compose.kind === 'Machine' ? compose.items.filter((i) => i.kind === 'Property' && i.form === 'compose') : [];

  const init: Joint = { parent: { machine: P, state: initialState(P), status: 'active', onComplete: null, onParentTerminal: null }, children: [] };
  if (isTerminal(P, init.parent.state)) init.parent.status = 'terminal';
  const states: Joint[] = [init];
  const index = new Map([[jointKey(init), 0]]);
  const parent: (number | null)[] = [null];
  const edges: JointEdge[] = [];
  let capHit = false;
  const findings: Diagnostic[] = [];
  const seen = new Set<string>();
  const at = { module: module.name, machine: P.name };
  const pathTo = (i: number): JointEdge[] => {
    const out: JointEdge[] = [];
    for (let k = i; parent[k] !== null; k = edges[parent[k]!].from) out.push(edges[parent[k]!]);
    return out.reverse();
  };
  const trace = (path: JointEdge[], last?: { edge: JointEdge; post: Joint }): WitnessStep[] => {
    const steps = path.map((e) => ({ e, post: states[e.to!] }));
    if (last) steps.push({ e: last.edge, post: last.post });
    return steps.map(({ e, post }) => ({
      pre: jointPlain(states[e.from]),
      action: e.stimulus.target === PARENT ? e.stimulus.action : `${e.stimulus.target}.${e.stimulus.action}`,
      data: Object.fromEntries(Object.entries(e.stimulus.data).map(([k, v]) => [k, toPlain(v)])),
      post: jointPlain(post),
      ...(e.cascade.length > 1 ? { effects: e.cascade.slice(1).map((c) => `${c.target}.${c.action}`) } : {}),
    }));
  };
  const finding = (code: string, name: string, severity: 'finding' | 'inconclusive', message: string, steps: WitnessStep[], property?: string): Diagnostic => {
    const witness: Witness = { id: '', length: steps.length, trace: steps };
    return { code, name, severity, stage: 'composition', engine: ENGINE, at, message, witness, ...(property ? { property } : {}) };
  };
  const NAMES: Record<string, string> = { PL5101: 'CHILDKEY_COLLISION', PL5102: 'UNHANDLED_CASCADE_DELIVERY', PL5201: 'CASCADE_DEPTH' };
  const checkInvariants = (i: number) => {
    const j = states[i];
    for (const p of invariants) {
      if (p.kind !== 'Property' || seen.has(`PL5001:${p.name}`)) continue;
      const env = { M: P, state: j.parent.state, data: {}, locals: new Map(), joint: { parent: j.parent.state, children: new Map(j.children.map(([k, c]) => [k, c.state])) } };
      if (evaluate(p.expr, env) !== true) {
        seen.add(`PL5001:${p.name}`);
        findings.push({ ...finding('PL5001', 'COMPOSE_INVARIANT', 'finding', `compose invariant ${p.name} is violated in a reachable joint state`, trace(pathTo(i)), p.name), at: { ...at, node: p.id } });
      }
    }
  };
  checkInvariants(0);

  for (let head = 0; head < states.length; head++) {
    for (const stim of stimuliAt(states[head])) {
      const { joint, cascade, doctrine } = jointStep(states[head], stim, childMachines);
      const edge: JointEdge = { from: head, stimulus: stim, cascade, to: null };
      edges.push(edge);
      for (const d of doctrine) {
        const k = `${d.code}:${stim.target}:${stim.action}`;
        if (seen.has(k)) continue;
        seen.add(k);
        findings.push(finding(d.code, NAMES[d.code], 'finding', d.message, trace(pathTo(head), { edge, post: joint })));
      }
      if (doctrine.some((d) => d.halts)) continue;
      const left = outside(joint);
      if (left) {
        if (!seen.has(`PL3901:${left}`)) {
          seen.add(`PL3901:${left}`);
          findings.push(finding('PL3901', 'BOUND_HIT', 'inconclusive', `the joint machine leaves the checked instance at ${left}; that state is not explored`, trace(pathTo(head), { edge, post: joint })));
        }
        continue;
      }
      const key = jointKey(joint);
      let to = index.get(key);
      if (to === undefined) {
        if (states.length >= maxStates) { capHit = true; continue; }
        to = states.length;
        index.set(key, to);
        states.push(joint);
        parent.push(edges.length - 1);
        edge.to = to;
        checkInvariants(to);
      }
      edge.to = to;
    }
  }
  if (capHit) findings.push(finding('PL3901', 'BOUND_HIT', 'inconclusive', `joint exploration stopped at ${states.length} states`, []));
  return { machine: P.name, states: states.length, transitions: edges.length, findings, capHit, graph: { states, index, edges, parent } };
}

/** `sha256:` of a joint state, for findings that name one. */
export function jointDigest(j: Joint): string {
  return 'sha256:' + createHash('sha256').update(jointKey(j)).digest('hex');
}
