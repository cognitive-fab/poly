// poly-ref's checks over the explored graph of one machine:
//   - invariants (PS5.1), step properties (PS5.2), reject properties (PS5.3);
//   - leaving the instance: a declared type (PL3102) or a check domain (PL3901) (PS4.2a);
//   - deadlock (PS5.6).
// Liveness (PS6) and configurations (PS13) come in M1 and M2, as passes over
// the same Graph.
import type { Diagnostic, Expr, FairGroup as AstFairGroup, Module, Witness, WitnessStep } from '@poly/core';
import { buildMachine, dataDomain, valuesOf, monitorStart, monitorStep, clauseText, type PathClause, type RMachine, type RPathProperty, type RType } from './model.js';
import { explore, machineSystem, pathTo, type Edge, type Graph } from './explore.js';
import { evaluate } from './eval.js';
import { isTerminal } from './step.js';
import { statePlain, toPlain, keyOf, stateKey, type State } from './values.js';
import { createHash } from 'node:crypto';
import { fairCycles, type FairGroup } from './liveness.js';
import { antecedents, judge, type Members, type Vacuous } from './vacuity.js';

// poly-ref names its own codes (PT12.2): it imports no value from the compiler.
const CODE = {
  PL3001: ['INVARIANT_REACHABLE', 'finding', 'model-check'],
  PL3002: ['STEP_PROPERTY', 'finding', 'model-check'],
  PL3003: ['REJECT_PROPERTY', 'finding', 'model-check'],
  PL3102: ['DOMAIN_ESCAPE', 'finding', 'model-check'],
  PL3201: ['DEADLOCK', 'finding', 'deadlock'],
  PL3301: ['LIVENESS_LASSO', 'finding', 'liveness'],
  PL3901: ['BOUND_HIT', 'inconclusive', 'model-check'],
  PL4001: ['PATH_PROPERTY', 'finding', 'effects'],
  PL4002: ['EMIT_WITHOUT_STATE_CHANGE', 'finding', 'effects'],
  PL6201: ['UNGATED_DECISION', 'finding', 'effects'],
  PL6203: ['ADJUDICATION_WITHOUT_DECISION', 'finding', 'effects'],
} as const;

export const ENGINE = 'poly-ref@0.0.0';

export interface InstanceLine {
  fields: { name: string; domain: string }[];
  params: { name: string; domain: string }[];
  /** PD5.1.3c: the principal representatives, when the machine has claims or Principal fields. */
  principals?: number;
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
  /** S33: every accepted edge that emits and leaves the state unchanged, the steps PL4002 is about. */
  identityEmits: Edge<State>[];
  /** PT12.3, S128: properties whose antecedent is never true where they are judged. */
  vacuous: Vacuous[];
}

export interface CheckOptions {
  maxStates?: number;
  /** PD5.1.3c: the number of principal representatives, forced (a control); by default the rule's count. */
  principals?: number;
}

export function checkMachine(module: Module, machineName: string, opts: CheckOptions = {}): MachineReport {
  const M = buildMachine(module, machineName, { principals: opts.principals });
  const g = explore(machineSystem(M), opts.maxStates);
  const findings: Diagnostic[] = [];
  const at = (node?: string) => ({ module: module.name, machine: M.name, ...(node ? { node } : {}) });
  // Findings carry their property or field and a digest of the state they name (review finding 8).
  const digestOf = (s: State) => 'sha256:' + createHash('sha256').update(stateKey(s, M.fieldNames)).digest('hex');
  const finding = (code: keyof typeof CODE, node: string | undefined, message: string, trace: WitnessStep[], about: { property?: string; field?: string; state?: State; cycle?: number } = {}): Diagnostic => {
    const [name, severity, stage] = CODE[code];
    const witness: Witness = { id: '', length: trace.length, trace, ...(about.cycle !== undefined ? { cycle: about.cycle } : {}) };
    return {
      code, name, severity, stage, engine: ENGINE, at: at(node), message, witness,
      ...(about.property ? { property: about.property } : {}),
      ...(about.field ? { field: about.field } : {}),
      ...(about.state ? { stateDigest: digestOf(about.state) } : {}),
    };
  };
  const trace = (edges: Edge<State>[]): WitnessStep[] => edges.map((e) => ({
    pre: statePlain(g.states[e.from]),
    action: e.label.action,
    data: Object.fromEntries(Object.entries(e.label.data).map(([k, v]) => [k, toPlain(v)])),
    post: statePlain(e.to !== null ? g.states[e.to] : e.outcome.state),
    verdict: e.label.verdict.kind === 'rejected' ? `rejected(${e.label.verdict.reason})` : e.label.verdict.kind,
    ...(e.label.effects.length ? { effects: e.label.effects.map((x) => x.kind) } : {}),
  }));

  // Invariants: the first violating state in BFS order has the shortest witness.
  for (const p of M.invariants) {
    const i = g.states.findIndex((s) => evaluate(p.expr, { M, state: s, data: {}, locals: new Map() }) !== true);
    if (i >= 0) findings.push(finding('PL3001', p.id, `invariant ${p.name} is violated in a reachable state`, trace(pathTo(g, i)), { property: p.name, state: g.states[i] }));
  }
  // Step and reject properties, over edges in BFS order of their source.
  for (const p of M.stepProperties) {
    const e = g.edges.find((x) => x.label.verdict.kind === 'accepted' && evaluate(p.expr, {
      M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], post: x.outcome.state, action: x.label.action,
    }) !== true);
    if (e) findings.push(finding('PL3002', p.id, `step property ${p.name} is violated by ${e.label.action}`, trace([...pathTo(g, e.from), e]), { property: p.name, state: g.states[e.from] }));
  }
  for (const p of M.rejectProperties) {
    const e = g.edges.find((x) => evaluate(p.expr, {
      M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], action: x.label.action, verdict: x.label.verdict,
    }) !== true);
    if (e) findings.push(finding('PL3003', p.id, `reject property ${p.name} is violated by ${e.label.action} (${e.label.verdict.kind}${e.label.verdict.reason ? ' ' + e.label.verdict.reason : ''})`, trace([...pathTo(g, e.from), e]), { property: p.name, state: g.states[e.from] }));
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
      findings.push(finding('PL3102', undefined, `${o.field} can leave its type ${typeText(f.type, M)} (value ${keyOf(o.value)})`, trace([...pathTo(g, e.from), e]), { field: o.field, state: o.state }));
    } else {
      findings.push(finding('PL3901', undefined, `${o.field} can leave its check domain ${domainText(f.check, f.type, M)} (value ${keyOf(o.value)}); the state is not explored`, trace([...pathTo(g, e.from), e]), { field: o.field, state: o.state }));
    }
  }
  if (g.capHit) findings.push(finding('PL3901', undefined, `exploration stopped at ${g.states.length} states`, []));

  // Path properties (PS5.4) hold iff they hold on every path of I. Each is a conjunction of bounds on
  // emission counts, so it is decided exactly on the product of the graph with a counter per bounded
  // kind, saturated one above its bound: cycles included, no depth bound. BFS gives a shortest witness.
  for (const p of M.pathProperties) {
    const hit = pathViolation(g, p);
    if (hit) {
      findings.push(finding('PL4001', p.id, `path property ${p.name} is violated: ${clauseText(hit.clause)} on this path`, trace(hit.path), { property: p.name, state: g.states[hit.path[hit.path.length - 1].from] }));
    }
  }

  // S33: an accepted step that emits and leaves the state unchanged is enabled again after itself and
  // repeats its effects without limit. One finding per action, at its first such step in BFS order; the
  // witness is the path to that step followed by two repetitions.
  // S63: a send does not count; a reply is one step per request, checked where its receiver is (PS13.3, PS14.3).
  const identityEmits = g.edges.filter((e) => e.label.verdict.kind === 'accepted' && e.label.effects.some((x) => x.type !== 'send') && e.to === e.from);
  const seenAction = new Set<string>();
  for (const e of identityEmits) {
    if (seenAction.has(e.label.action)) continue;
    seenAction.add(e.label.action);
    const kinds = [...new Set(e.label.effects.filter((x) => x.type !== 'send').map((x) => x.kind))].join(', ');
    findings.push(finding('PL4002', M.handlers.get(e.label.action)?.id, `${e.label.action} emits ${kinds} and leaves the state unchanged, so it can repeat its effect without limit`, trace([...pathTo(g, e.from), e, e]), { property: e.label.action, state: g.states[e.from] }));
  }

  // PD1.4d, S75, S85: a decision is gated when, for each answer whose completion can emit a compensable or
  // irreversible effect, some confidence or margin interval keeps it from doing so. The completion step alone is
  // judged (S75): an answer stored and acted on later is covered by the author's properties. Rejected steps emit
  // nothing and prove nothing, so only accepted completion steps count.
  const risky = new Set([...M.effects.values()].filter((e) => e.cls === 'compensable' || e.cls === 'irreversible').map((e) => e.kind));
  for (const d of M.decisions.values()) {
    if (!d.ok) continue;
    const ok = d.ok;
    const key = (data: Record<string, unknown>, names: string[]) => JSON.stringify(names.map((n) => keyOf(data[n] as never)));
    const byAnswer = new Map<string, Map<string, Edge<State>[]>>();
    const intervals = new Map<string, Set<string>>();
    for (const e of g.edges) {
      if (e.label.action !== ok.action) continue;
      const a = key(e.label.data, ok.answer);
      const i = key(e.label.data, ok.confidence);
      if (!intervals.has(a)) intervals.set(a, new Set());
      intervals.get(a)!.add(i);
      if (e.label.verdict.kind !== 'accepted' || !e.label.effects.some((x) => risky.has(x.kind))) continue;
      if (!byAnswer.has(a)) byAnswer.set(a, new Map());
      const m = byAnswer.get(a)!;
      if (!m.has(i)) m.set(i, []);
      m.get(i)!.push(e);
    }
    for (const [a, reach] of byAnswer) {
      if (reach.size < intervals.get(a)!.size) continue; // some interval never reaches a risky effect: gated
      const e = [...reach.values()][0][0];
      const answer = ok.answer.map((n) => `${n} = ${keyOf(e.label.data[n] as never)}`).join(', ');
      findings.push(finding('PL6201', d.id, `decision ${d.name} is ungated: for ${answer || 'its answer'}, its completion ${ok.action} can emit a compensable or irreversible effect at every confidence and margin the program tells apart (PD1.4d)`, trace([...pathTo(g, e.from), e]), { property: d.name, state: g.states[e.from] }));
      break;
    }
  }

  // PD2.4, S129: an accepted adjudication of d is reachable only after an accepted ok completion of d on the same
  // path, or the runtime would have no decision event to link the outcome to. Decided on the product of the graph
  // with one bit per decision, "taken"; BFS gives a shortest witness.
  const ds = [...M.decisions.values()].map((x) => ({ name: x.name, kind: x.kind, ok: x.ok?.action ?? null }));
  for (const d of M.decisions.values()) {
    const hit = adjudicationWithoutDecision(g, d.name, ds);
    if (hit) findings.push(finding('PL6203', d.id, `${hit[hit.length - 1].label.action} adjudicates ${d.name} on a path where no ${d.ok?.action ?? 'ok completion'} answering ${d.name} was accepted, so there is no decision to link the outcome to (PD2.4)`, trace(hit), { property: d.name, state: g.states[hit[hit.length - 1].from] }));
  }

  // Liveness (PS6.4): each fair component that never reaches the goal, with its lasso.
  for (const p of M.liveness) {
    if (p.quant || !p.fair) continue; // refused by the checker in a machine (S56)
    const holds = (e: Expr) => (i: number) => evaluate(e, { M, state: g.states[i], data: {}, locals: new Map() }) === true;
    const lassos = fairCycles(g, { goal: holds(p.expr), from: p.from ? holds(p.from) : null, groups: machineGroups(M, p.fair) });
    // One finding per property (one mistake, one diagnostic): the lasso of the first fair component reached,
    // and every fair component's states, so each can be read without a second finding.
    if (lassos.length) {
      const l = lassos[0];
      const edges = [...l.prefix, ...l.cycle] as Edge<State>[];
      const f = finding('PL3301', p.id, `liveness ${p.name} fails: ${lassos.length} fair component${lassos.length === 1 ? '' : 's'} never reach${lassos.length === 1 ? 'es' : ''} its goal; the witness is a lasso through the first`, trace(edges), { property: p.name, state: g.states[l.component[0]], cycle: l.prefix.length });
      (f as Diagnostic & { components?: unknown[][] }).components = lassos.map((x) => x.component.map((i) => statePlain(g.states[i])));
      findings.push(f);
    }
  }

  // Deadlock (PS5.6): reachable, not terminal, and no action accepts. A service is exempt (PS1.7).
  const deadlocks: Record<string, unknown>[] = [];
  if (!M.service) {
    g.states.forEach((s, i) => {
      if (isTerminal(M, s)) return;
      if (g.out[i].some((k) => g.edges[k].label.verdict.kind === 'accepted')) return;
      deadlocks.push(statePlain(s));
      const f = finding('PL3201', undefined, 'no action is accepted in a reachable non-terminal state', trace(pathTo(g, i)), { state: s });
      (f as Diagnostic & { rejections?: string[] }).rejections = g.out[i].map((k) => {
        const e = g.edges[k];
        return `${e.label.action}: ${e.label.verdict.kind === 'rejected' ? e.label.verdict.reason : e.label.verdict.kind}`;
      });
      findings.push(f);
    });
  }

  const vacuous = machineVacuity(M, g);

  return {
    vacuous,
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
    identityEmits,
  };
}

/**
 * PL6203: the shortest path to an accepted step that adjudicates `decision` before the runtime has a decision event
 * for it. Decided on the product of the graph with two bits per decision: asked (a `decide` is outstanding) and
 * taken (its ok completion was accepted). An ok completion takes the decision it answers: the one asked, of the
 * decisions sharing that action (review D2); when two are asked it cannot tell which, and takes neither, so the check
 * stays sound. The completion's own step counts before its adjudication, since the runtime writes the decision event
 * before the step (review D3).
 */
export function adjudicationWithoutDecision(g: Graph<State>, decision: string, decisions: { name: string; kind: string; ok: string | null }[]): Edge<State>[] | null {
  const outcome = `outcome.${decision}`;
  const at = new Map(decisions.map((d, i) => [d.name, i]));
  const me = at.get(decision)!;
  const start = { node: 0, asked: 0, taken: 0, path: [] as Edge<State>[] };
  const seen = new Set<string>(['0:0:0']);
  const queue = [start];
  while (queue.length) {
    const { node, asked, taken, path } = queue.shift()!;
    for (const k of g.out[node]) {
      const e = g.edges[k];
      const accepted = e.label.verdict.kind === 'accepted';
      let a = asked;
      let t = taken;
      if (accepted) {
        const answering = decisions.map((d, i) => (d.ok !== null && d.ok === e.label.action && (a & (1 << i)) ? i : -1)).filter((i) => i >= 0);
        if (answering.length === 1) { t |= 1 << answering[0]; a &= ~(1 << answering[0]); }
        for (const x of e.label.effects) { const i = decisions.findIndex((d) => d.kind === x.kind); if (i >= 0) a |= 1 << i; }
        if (e.label.effects.some((x) => x.kind === outcome) && !(t & (1 << me))) return [...path, e];
      }
      if (e.to === null) continue;
      const key = `${e.to}:${a}:${t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ node: e.to, asked: a, taken: t, path: [...path, e] });
    }
  }
  return null;
}

/**
 * The shortest path of I on which some clause of p breaks, or null (PS5.4). A node of the product is a
 * state and the property's monitor (model.ts): finite, so the search ends, cycles included. An edge that
 * leaves the instance still emits on its step, so it can break a clause; nothing is explored beyond it.
 */
export function pathViolation(g: Graph<State>, p: RPathProperty): { path: Edge<State>[]; clause: PathClause } | null {
  const key = (s: number, c: number[]) => `${s}|${c.join(',')}`;
  const start = { s: 0, c: monitorStart(p) };
  const parent = new Map<string, { prev: string; edge: Edge<State> } | null>([[key(start.s, start.c), null]]);
  const queue = [start];
  const pathOf = (k: string, last: Edge<State>) => {
    const out = [last];
    for (let at = parent.get(k); at; at = parent.get(at.prev)) out.push(at.edge);
    return out.reverse();
  };
  for (let head = 0; head < queue.length; head++) {
    const { s, c } = queue[head];
    const here = key(s, c);
    for (const ei of g.out[s]) {
      const e = g.edges[ei];
      const { next, broken } = monitorStep(p, c, e.label.effects.map((x) => x.kind));
      if (broken >= 0) return { path: pathOf(here, e), clause: p.clauses[broken] };
      if (e.to === null) continue;
      const k = key(e.to, next);
      if (parent.has(k)) continue;
      parent.set(k, { prev: here, edge: e });
      queue.push({ s: e.to, c: next });
    }
  }
  return null;
}

function typeText(t: RType, M: RMachine): string {
  switch (t.k) {
    case 'int': return Number.isFinite(t.lo) ? `${t.lo}..${t.hi}` : 'int';
    case 'union': return t.name;
    case 'record': return t.name;
    case 'map': return `map<${typeText(t.key, M)}, ${typeText(t.value, M)}>`;
    default: return t.k;
  }
}

function domainText(check: unknown[] | null, t: RType, M: RMachine): string {
  if (!check) return typeText(t, M);
  // S57: the addresses a Ref ranges over, and none.
  if (t.k === 'ref') return `{${check.map((v) => (v === null ? 'none' : String(v))).join(', ')}}`;
  const nums = check.every((v) => typeof v === 'number') ? (check as number[]) : null;
  if (nums && nums.length > 2 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1)) return `${nums[0]}..${nums[nums.length - 1]}`;
  return `{${check.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ')}}`;
}

/** Whether the machine's labels or state hold a principal (PD5.1.3c), so its instance names the representatives. */
function usesPrincipals(M: RMachine): boolean {
  return M.actions.some((a) => a.claims) || JSON.stringify([...M.fields.map((f) => f.type), ...[...M.records.values()], ...[...M.unions.values()]]).includes('"principal"');
}

/** The checked instance a verdict holds for (PS4.3, PT12.3a). */
export function instanceOf(M: RMachine): InstanceLine {
  return {
    fields: M.fields.filter((f) => f.check || f.type.k === 'int').map((f) => ({ name: f.name, domain: domainText(f.check, f.type, M) })),
    params: M.actions.flatMap((a) => a.params.map((p) => ({ name: `${a.name}.${p.name}`, domain: domainText(p.check ?? (p.type.k === 'union' || p.type.k === 'record' || p.type.k === 'bool' ? null : valuesOf(p.type, M)), p.type, M) }))),
    ...(usesPrincipals(M) ? { principals: M.principals } : {}),
  };
}

/**
 * The fairness groups of a machine's liveness property (PS6.1). `A` is one group; `A(*)` is one group per data
 * value of A; in a group written `A(*) | B`, each value of A forms a group with B.
 */
export function machineGroups(M: RMachine, fair: AstFairGroup[]): FairGroup[] {
  const out: FairGroup[] = [];
  for (const grp of fair) {
    const plain = grp.members.filter((m) => !m.perValue).map((m) => m.action);
    const starred = grp.members.filter((m) => m.perValue);
    const accepted = (e: Edge<unknown>) => e.label.verdict.kind === 'accepted';
    if (!starred.length) { out.push({ name: plain.join(' | '), takes: (e) => accepted(e) && plain.includes(e.label.action) }); continue; }
    for (const m of starred) {
      const a = M.actions.find((x) => x.name === m.action);
      for (const d of a ? dataDomain(a, M) : []) {
        const key = JSON.stringify(Object.keys(d).sort().map((k) => [k, keyOf(d[k])]));
        const same = (e: Edge<unknown>) => JSON.stringify(Object.keys(e.label.data).sort().map((k) => [k, keyOf(e.label.data[k])])) === key;
        out.push({ name: `${m.action}(${key})`, takes: (e) => accepted(e) && (plain.includes(e.label.action) || (e.label.action === m.action && same(e))) });
      }
    }
  }
  return out;
}

/** How many data records each action is offered in every state: |D(a)|. */
export function alphabetSize(M: RMachine): number {
  return M.actions.reduce((n, a) => n + dataDomain(a, M).length, 0);
}

/** S49: a quantifier in a machine ranges over a family's indices. */
export const familyMembers: Members = (env, group) => {
  const r = env.M.families.get(group);
  if (!r) return [];
  const out: number[] = [];
  for (let k = r.lo; k <= r.hi; k++) out.push(k);
  return out;
};

/** PT12.3, S128: each property of the machine whose antecedent is never true where the property is judged. */
export function machineVacuity(M: RMachine, g: Graph<State>): Vacuous[] {
  const out: Vacuous[] = [];
  const states = () => g.states.map((s) => ({ M, state: s, data: {}, locals: new Map() }));
  const accepted = () => g.edges.filter((x) => x.label.verdict.kind === 'accepted').map((x) => ({
    M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], post: x.outcome.state, action: x.label.action,
  }));
  const every = () => g.edges.map((x) => ({
    M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], action: x.label.action, verdict: x.label.verdict,
  }));
  const judgeAll = (name: string, id: string, e: Expr, envs: () => Iterable<import('./eval.js').Env>) => {
    for (const a of antecedents(e)) {
      const v = judge(a, envs, familyMembers);
      if (v) { out.push({ property: name, id, parts: a.parts, ...v }); return; }
    }
  };
  for (const p of M.invariants) judgeAll(p.name, p.id, p.expr, states);
  for (const p of M.stepProperties) judgeAll(p.name, p.id, p.expr, accepted);
  for (const p of M.rejectProperties) judgeAll(p.name, p.id, p.expr, every);
  for (const p of M.liveness) {
    if (!p.from || p.quant) continue; // a quantified liveness is refused in a machine (S56)
    const v = judge({ parts: [p.from], quant: null }, states, familyMembers);
    if (v) out.push({ property: p.name, id: p.id, parts: [p.from], ...v });
  }
  // before(k1, k2) is about every k2 emitted: none on any explored step is vacuous (S128).
  const emitted = new Set(g.edges.filter((x) => x.label.verdict.kind === 'accepted').flatMap((x) => x.label.effects.map((f) => f.kind)));
  for (const p of M.pathProperties) {
    const c = p.clauses.find((x): x is Extract<PathClause, { k: 'before' }> => x.k === 'before' && !emitted.has(x.then));
    if (c) out.push({ property: p.name, id: p.id, parts: [], text: `before("${c.first}", "${c.then}"): no ${c.then} is emitted` });
  }
  return out;
}
