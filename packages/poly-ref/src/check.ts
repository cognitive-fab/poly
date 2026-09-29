// poly-ref's checks over the explored graph of one machine:
//   - invariants (PS5.1), step properties (PS5.2), reject properties (PS5.3);
//   - leaving the instance: a declared type (PL3102) or a check domain (PL3901) (PS4.2a);
//   - deadlock (PS5.6).
// Liveness (PS6) and configurations (PS13) come in M1 and M2, as passes over
// the same Graph.
import type { Diagnostic, Module, Witness, WitnessStep } from '@poly/core';
import { buildMachine, dataDomain, valuesOf, type RMachine, type RType } from './model.js';
import { explore, machineSystem, pathTo, type Edge, type Graph } from './explore.js';
import { evaluate } from './eval.js';
import { isTerminal } from './step.js';
import { statePlain, toPlain, keyOf, type State } from './values.js';

// poly-ref names its own codes (PT12.2): it imports no value from the compiler.
const CODE = {
  PL3001: ['INVARIANT_REACHABLE', 'finding', 'model-check'],
  PL3002: ['STEP_PROPERTY', 'finding', 'model-check'],
  PL3003: ['REJECT_PROPERTY', 'finding', 'model-check'],
  PL3102: ['DOMAIN_ESCAPE', 'finding', 'model-check'],
  PL3201: ['DEADLOCK', 'finding', 'deadlock'],
  PL3901: ['BOUND_HIT', 'inconclusive', 'model-check'],
} as const;

export const ENGINE = 'poly-ref@0.0.0';

export interface InstanceLine {
  fields: { name: string; domain: string }[];
  params: { name: string; domain: string }[];
}

export interface MachineReport {
  machine: string;
  /** |Reach(I)|. */
  states: number;
  /** Every labelled transition from a reachable state, rejected and unhandled stutters included. */
  transitions: number;
  /** Accepted transitions from reachable states, the count the evidence scripts print. */
  accepted: number;
  deadlocks: Record<string, unknown>[];
  findings: Diagnostic[];
  instance: InstanceLine;
  capHit: boolean;
  graph: Graph<State>;
  model: RMachine;
}

export interface CheckOptions {
  maxStates?: number;
}

export function checkMachine(module: Module, machineName: string, opts: CheckOptions = {}): MachineReport {
  const M = buildMachine(module, machineName);
  const g = explore(machineSystem(M), opts.maxStates);
  const findings: Diagnostic[] = [];
  const at = (node?: string) => ({ module: module.name, machine: M.name, ...(node ? { node } : {}) });
  const finding = (code: keyof typeof CODE, node: string | undefined, message: string, trace: WitnessStep[]): Diagnostic => {
    const [name, severity, stage] = CODE[code];
    const witness: Witness = { id: '', length: trace.length, trace };
    return { code, name, severity, stage, engine: ENGINE, at: at(node), message, witness };
  };
  const trace = (edges: Edge<State>[]): WitnessStep[] => edges.map((e) => ({
    pre: statePlain(g.states[e.from]),
    action: e.label.action,
    data: Object.fromEntries(Object.entries(e.label.data).map(([k, v]) => [k, toPlain(v)])),
    post: statePlain(e.to !== null ? g.states[e.to] : e.outcome.state),
    verdict: e.label.verdict.kind === 'rejected' ? `rejected(${e.label.verdict.reason})` : e.label.verdict.kind,
  }));

  // Invariants: the first violating state in BFS order has the shortest witness.
  for (const p of M.invariants) {
    const i = g.states.findIndex((s) => evaluate(p.expr, { M, state: s, data: {}, locals: new Map() }) !== true);
    if (i >= 0) findings.push(finding('PL3001', p.id, `invariant ${p.name} is violated in a reachable state`, trace(pathTo(g, i))));
  }
  // Step and reject properties, over edges in BFS order of their source.
  for (const p of M.stepProperties) {
    const e = g.edges.find((x) => x.label.verdict.kind === 'accepted' && evaluate(p.expr, {
      M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], post: x.outcome.state, action: x.label.action,
    }) !== true);
    if (e) findings.push(finding('PL3002', p.id, `step property ${p.name} is violated by ${e.label.action}`, trace([...pathTo(g, e.from), e])));
  }
  for (const p of M.rejectProperties) {
    const e = g.edges.find((x) => evaluate(p.expr, {
      M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], action: x.label.action, verdict: x.label.verdict,
    }) !== true);
    if (e) findings.push(finding('PL3003', p.id, `reject property ${p.name} is violated by ${e.label.action} (${e.label.verdict.kind}${e.label.verdict.reason ? ' ' + e.label.verdict.reason : ''})`, trace([...pathTo(g, e.from), e])));
  }
  // Leaving the instance (PS4.2a): one finding per field, the first in BFS order.
  const reported = new Set<string>();
  for (const e of g.edges) {
    const o = e.outcome;
    if (o.kind === 'state') continue;
    const key = `${o.kind}:${o.field}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const f = M.fields.find((x) => x.name === o.field)!;
    if (o.kind === 'escape') {
      findings.push(finding('PL3102', undefined, `${o.field} can leave its type ${typeText(f.type, M)} (value ${keyOf(o.value)})`, trace([...pathTo(g, e.from), e])));
    } else {
      findings.push(finding('PL3901', undefined, `${o.field} can leave its check domain ${domainText(f.check, f.type, M)} (value ${keyOf(o.value)}); the state is not explored`, trace([...pathTo(g, e.from), e])));
    }
  }
  if (g.capHit) findings.push(finding('PL3901', undefined, `exploration stopped at ${g.states.length} states`, []));

  // Deadlock (PS5.6): reachable, not terminal, and no action accepts. A service is exempt (PS1.7).
  const deadlocks: Record<string, unknown>[] = [];
  if (!M.service) {
    g.states.forEach((s, i) => {
      if (isTerminal(M, s)) return;
      if (g.out[i].some((k) => g.edges[k].label.verdict.kind === 'accepted')) return;
      deadlocks.push(statePlain(s));
      const f = finding('PL3201', undefined, 'no action is accepted in a reachable non-terminal state', trace(pathTo(g, i)));
      (f as Diagnostic & { rejections?: string[] }).rejections = g.out[i].map((k) => {
        const e = g.edges[k];
        return `${e.label.action}: ${e.label.verdict.kind === 'rejected' ? e.label.verdict.reason : e.label.verdict.kind}`;
      });
      findings.push(f);
    });
  }

  return {
    machine: M.name,
    states: g.states.length,
    transitions: g.edges.length,
    accepted: g.edges.filter((e) => e.label.verdict.kind === 'accepted').length,
    deadlocks,
    findings,
    instance: instanceOf(M),
    capHit: g.capHit,
    graph: g,
    model: M,
  };
}

function typeText(t: RType, M: RMachine): string {
  switch (t.k) {
    case 'int': return Number.isFinite(t.lo) ? `${t.lo}..${t.hi}` : 'int';
    case 'union': return t.name;
    case 'map': return `map<${typeText(t.key, M)}, ${typeText(t.value, M)}>`;
    default: return t.k;
  }
}

function domainText(check: unknown[] | null, t: RType, M: RMachine): string {
  if (!check) return typeText(t, M);
  const nums = check.every((v) => typeof v === 'number') ? (check as number[]) : null;
  if (nums && nums.length > 2 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1)) return `${nums[0]}..${nums[nums.length - 1]}`;
  return `{${check.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ')}}`;
}

/** The checked instance a verdict holds for (PS4.3, PT12.3a). */
export function instanceOf(M: RMachine): InstanceLine {
  return {
    fields: M.fields.filter((f) => f.check || f.type.k === 'int').map((f) => ({ name: f.name, domain: domainText(f.check, f.type, M) })),
    params: M.actions.flatMap((a) => a.params.map((p) => ({ name: `${a.name}.${p.name}`, domain: domainText(p.check ?? (p.type.k === 'union' || p.type.k === 'bool' ? null : valuesOf(p.type, M)), p.type, M) }))),
  };
}

/** How many data records each action is offered in every state: |D(a)|. */
export function alphabetSize(M: RMachine): number {
  return M.actions.reduce((n, a) => n + dataDomain(a, M).length, 0);
}
