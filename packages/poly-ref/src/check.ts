// poly-ref's checks over the explored graph of one machine:
//   - invariants (PS5.1), step properties (PS5.2), reject properties (PS5.3);
//   - leaving the instance: a declared type (PL3102) or a check domain (PL3901) (PS4.2a);
//   - deadlock (PS5.6).
// Liveness (PS6) and configurations (PS13) come in M1 and M2, as passes over
// the same Graph.
import type * as A from '@poly/core';
import type { Diagnostic, Expr, FairGroup as AstFairGroup, Module, Witness, WitnessStep } from '@poly/core';
import { buildMachine, dataDomain, valuesOf, inCheckDomain, selfAlone, monitorStart, monitorStep, clauseText, type PathClause, type RMachine, type RPathProperty, type RType } from './model.js';
import { explore, machineSystem, pathTo, type Edge, type Graph } from './explore.js';
import { evaluate } from './eval.js';
import { isTerminal, type Intent } from './step.js';
import { machineHome } from './channels.js';
import { statePlain, toPlain, keyOf, stateKey, type State, type Value } from './values.js';
import { createHash } from 'node:crypto';
import { fairCycles, type FairGroup } from './liveness.js';
import { taintSystem, firstBreaks, claimsClass, PENDING_BOUND, type TaintState } from './taint.js';
import { bare, isBottom, taintOf } from './values.js';
import { antecedents, emittingActions, judge, neverParts, type Members, type RefFault, type Vacuous } from './vacuity.js';

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
  PL6831: ['AUDIENCE_LEAK', 'finding', 'model-check'],
  PL6832: ['TAINT_DOWNGRADE', 'finding', 'model-check'],
  PL6838: ['FLOW_NOT_FOLLOWED', 'inconclusive', 'model-check'],
  PL5408: ['MESSAGE_OUTSIDE_DOMAIN', 'finding', 'model-check'],
} as const;

export const ENGINE = 'poly-ref@0.0.0';

export interface InstanceLine {
  fields: { name: string; domain: string }[];
  params: { name: string; domain: string }[];
  /** PD5.1.3c: the principal representatives, when the machine has claims or Principal fields. */
  principals?: number;
  /** PS4.1f: the content representatives, when the machine's state or labels hold a Content. */
  contents?: number;
  /** PS4.1g: the key representatives, when the machine's state or labels hold a Key. */
  keys?: number;
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
  /** PS17.3: the states the flow rule explored, with their taints; absent when the program declares no source. */
  flowStates?: number;
  /** PS17.3, PS17.5: the flow rule's findings (PL6831, PL6832, and its bound hits), reported in a stage of their own. */
  flowFindings?: Diagnostic[];
  /** PS1.4b, PS17.2 (S323, S325): the declassification points the certificate lists. */
  declassify?: Declassify;
}

/** S323, S325: each decision with a finite answer over tainted data, and each count over another owner's items. */
export interface Declassify {
  decisions: { kind: string; class: string; answers: number }[];
  counts: { machine: string; action: string; param: string; retrieval: string }[];
}

export interface CheckOptions {
  maxStates?: number;
  /** PD5.1.3c: the number of principal representatives, forced (a control); by default the rule's count. */
  principals?: number;
  /** PS4.1f: the number of content representatives, forced (a control); by default the rule's count. */
  contents?: number;
  /** PS4.1g: the number of key representatives, forced (a control); by default the rule's count. */
  keys?: number;
  /** PS1.0 (S176): the modules the machine's module uses, for a send to or a spawn of a machine named m.M. */
  program?: Module[];
  /** For one test each (ruled on M8 plan step 10): a deliberately broken check. */
  fault?: RefFault;
}

/**
 * PS4.4, PS5.2a (S178): whether a witness needs an environment nothing provided. A step does when it takes a completion
 * that no earlier step of the path asked for (an effect's or a decision's outcome, a timer, an attached child's
 * completion), or a message that a machine of the program sends to this one and no earlier step of the path sent.
 */
export function unconstrained(module: Module, M: RMachine, path: Edge<State>[], program: Module[] = []): boolean {
  // Review D-F4: one action may complete several things (an effect's outcome and a timer); any of them asks for it.
  const asks = new Map<string, ((i: Intent) => boolean)[]>();
  const ask = (a: string, f: (i: Intent) => boolean) => asks.set(a, [...(asks.get(a) ?? []), f]);
  const decl = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === M.name);
  if (!decl) return false;
  const walk = (body: A.Stmt[], visit: (s: A.IntentStmt) => void): void => {
    for (const s of body) {
      if (s.kind === 'Intent') visit(s);
      if (s.kind === 'If') { walk(s.then, visit); walk(s.else ?? [], visit); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body, visit);
      if (s.kind === 'For') walk(s.body, visit);
    }
  };
  for (const it of decl.items) {
    if (it.kind === 'EffectDecl' || it.kind === 'Decision') {
      const kind = it.kind === 'EffectDecl' ? M.effects.get(it.name)?.kind : M.decisions.get(it.name)?.kind;
      for (const o of it.items) if (o.kind === 'EffOutcome' && kind) ask(o.action, (i) => i.type === 'effect' && i.kind === kind);
    }
    if (it.kind === 'Handler') walk(it.body, (s) => {
      if (s.op === 'after') ask(s.target, (i) => i.type === 'timer' && i.action === s.target);
      const c = s.op === 'spawn' ? s.extra.indexOf('complete') : -1;
      if (c >= 0) { const a = s.extra[c + 1]; ask(a, (i) => i.type === 'spawn' && i.onComplete === a); }
    });
  }
  // A message to M: the target of a send in M itself (to self), or in a machine that can hold an address of M: a
  // Ref<M> anywhere in its fields' or actions' types. The address expression is not resolved (review D-F5): a let, a
  // map entry or a record field holding the address sends to M as a field does.
  for (const mod of [module, ...program]) {
    for (const x of mod.decls) {
      if (x.kind !== 'Machine') continue;
      const refTo = (t: A.TypeExpr | undefined): boolean => !!t && ((t.kind === 'TRef' && t.machine[t.machine.length - 1] === M.name && (t.machine.length === 1 ? mod.name === module.name : t.machine.slice(0, -1).join('.') === module.name)) || (t.kind === 'TMap' && refTo(t.value)));
      const decls = new Map(mod.decls.filter((d) => d.kind === 'TypeDecl').map((d) => [(d as { name: string }).name, d]));
      // Whether a type can hold an address of M: a Ref<M> in it, through maps, records and payloads.
      const holds = (t: unknown, seen = new Set<string>()): boolean => {
        if (!t || typeof t !== 'object') return false;
        if (Array.isArray(t)) return t.some((y) => holds(y, seen));
        const n = t as { kind?: string; name?: string };
        if (n.kind === 'TRef') return refTo(n as A.TypeExpr);
        if (n.kind === 'TName' && n.name && decls.has(n.name) && !seen.has(n.name)) { seen.add(n.name); return holds(decls.get(n.name), seen); }
        return Object.entries(n).some(([k, v]) => k !== 'span' && holds(v, seen));
      };
      const canName = (mod === module && x.name === M.name) || x.fields.some((f) => holds(f.type)) || x.items.some((a) => a.kind === 'Action' && a.params.some((p) => holds(p.type)));
      for (const h of x.items) {
        if (h.kind !== 'Handler') continue;
        walk(h.body, (s) => {
          if (s.op !== 'send' || !canName || !M.actions.some((a) => a.name === s.target)) return;
          if (s.to?.kind === 'Name' && s.to.name === 'self' && !(mod === module && x.name === M.name)) return;
          ask(s.target, (i) => i.type === 'send' && i.action === s.target);
        });
      }
    }
  }
  const issued: Intent[] = [];
  for (const e of path) {
    const askers = asks.get(e.label.action);
    if (askers) {
      const k = issued.findIndex((i) => askers.some((f) => f(i)));
      if (k < 0) return true;
      issued.splice(k, 1);
    }
    if (e.label.verdict.kind !== 'accepted') continue;
    for (const i of e.label.effects) {
      // Review D-F3: a cancel withdraws its timer, and a timer set again replaces the one under its key (PT6.3).
      if (i.type === 'cancel' || i.type === 'timer') { const j = issued.findIndex((x) => x.type === 'timer' && x.key === i.key); if (j >= 0) issued.splice(j, 1); }
      if (i.type !== 'cancel') issued.push(i);
    }
  }
  return false;
}

export function checkMachine(source: Module, sourceMachine: string, opts: CheckOptions = {}): MachineReport {
  // PS15: the machine where the channel's expansion puts it (c.Conversation is the machine Conversation of m.c).
  const home = machineHome(source, opts.program ?? [], sourceMachine);
  const module = home.module;
  const machineName = home.machine;
  opts = { ...opts, program: home.program };
  const M = buildMachine(module, machineName, { principals: opts.principals, contents: opts.contents, keys: opts.keys, program: opts.program });
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
    const violates = (x: Edge<State>) => x.label.verdict.kind === 'accepted' && evaluate(p.expr, {
      M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], post: x.outcome.state, action: x.label.action, intents: x.label.effects,
    }) !== true;
    const first = g.edges.find(violates);
    if (!first) continue;
    // PS5.2a, PS4.4: a never's witness that needs an environment nothing provided is marked, for a configuration to
    // judge. Review D-F1: only when every violating step's witness needs one; a constrained witness is the finding.
    const loose0 = (x: Edge<State>) => M.nevers.has(p.name) && unconstrained(module, M, [...pathTo(g, x.from), x], opts.program ?? []);
    const e = M.nevers.has(p.name) ? g.edges.find((x) => violates(x) && !loose0(x)) ?? first : first;
    const path = [...pathTo(g, e.from), e];
    const loose = loose0(e);
    const f = finding('PL3002', p.id, `${M.nevers.has(p.name) ? 'never' : 'step property'} ${p.name} is violated by ${e.label.action}${loose ? '; the witness takes a step nothing in its environment asked for (environment: unconstrained, PS4.4)' : ''}`, trace(path), { property: p.name, state: g.states[e.from] });
    if (loose) f.witness!.environment = 'unconstrained';
    findings.push(f);
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

  // PS13.6, F4: on a machine alone, an accepted step that sends, spawns with a creation action or signals data that the
  // receiving action's strict check domain refuses; the receiver would reject it outside-check-domain, untold. One
  // finding per receiving machine's action, at its first step in BFS order.
  const outsideSeen = new Set<string>();
  // The machine a handler's send of an action names, by the declared type of its address: a Ref field or parameter.
  const refMachineOf = (handler: string, action: string): string | null => {
    const h = M.handlers.get(handler);
    if (!h) return null;
    let found: string | null = null;
    const visit = (x: unknown): void => {
      if (!x || typeof x !== 'object' || found) return;
      if (Array.isArray(x)) { x.forEach(visit); return; }
      const n = x as { kind?: string; op?: string; target?: string; to?: { kind?: string; name?: string } };
      if (n.kind === 'Intent' && n.op === 'send' && n.target === action && n.to?.kind === 'Name') {
        const name = n.to.name!;
        const ty = M.fields.find((f) => f.name === name)?.type ?? M.actions.find((x) => x.name === handler)?.params.find((p) => p.name === name)?.type;
        if (ty?.k === 'ref') found = ty.machine.split('.').pop() ?? null;
      }
      for (const [k, v] of Object.entries(n)) if (k !== 'span') visit(v);
    };
    visit(h.body);
    return found;
  };
  for (const e of g.edges) {
    if (e.label.verdict.kind !== 'accepted') continue;
    for (const i of e.label.effects as unknown as { type: string; target?: unknown; action?: string; data?: Record<string, Value>; machine?: string; machineId?: string; key?: string; create?: { action: string; data: Record<string, Value> } | null }[]) {
      let machine: string | null = null;
      let action = '';
      let data: Record<string, Value> | null = null;
      // PS13.6: the receiver is known by the address's type, whatever its value: a send to none on a machine alone names
      // the machine its Ref field or parameter is declared for.
      if (i.type === 'send') { const a = bare((i.target ?? null) as Value); machine = typeof a === 'string' ? a.slice(0, a.lastIndexOf('#')) : refMachineOf(e.label.action, i.action ?? ''); action = i.action ?? ''; data = i.data ?? null; }
      else if ((i.type === 'create' || i.type === 'spawn') && i.create) { machine = (i.machine ?? i.machineId ?? '').split('.').pop() ?? null; action = i.create.action; data = i.create.data; }
      else if (i.type === 'signal') { machine = M.children.get(i.key ?? '')?.machine ?? null; action = i.action ?? ''; data = i.data ?? null; }
      if (!machine || !data) continue;
      const receiver = M.receivers.get(machine) ?? [...M.receivers.entries()].find(([k]) => k.split('.').pop() === machine)?.[1];
      const ra = receiver?.find((a) => a.name === action);
      if (!ra) continue;
      const bad = ra.params.filter((p) => p.strict && p.name in data! && !inCheckDomain(data![p.name], { type: p.type, check: p.check ?? null }, M));
      if (!bad.length) continue;
      const key = `${machine}.${action}`;
      if (outsideSeen.has(key)) continue;
      outsideSeen.add(key);
      findings.push(finding('PL5408', M.handlers.get(e.label.action)?.id, `${e.label.action} sends ${action} to ${machine} with ${bad.map((p) => `${p.name} = ${keyOf(data![p.name])}`).join(', ')}, outside its strict check domain; ${machine} would refuse it outside-check-domain and ${M.name} is not told (PS13.6, F4)`, trace([...pathTo(g, e.from), e]), { property: key, state: g.states[e.from] }));
    }
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

  const vacuous = machineVacuity(M, g, opts.fault);

  // PS17.3, PS17.5 (S301): the flow rule, over the machine with its taints, when the program declares a source.
  let flowStates: number | undefined;
  let declassify: Declassify | undefined;
  const flowFindings: Diagnostic[] = [];
  if (M.memory) {
    const tg = explore(taintSystem(M), opts.maxStates);
    flowStates = tg.states.length;
    const ttrace = (edges: Edge<TaintState>[]): WitnessStep[] => edges.map((e) => ({
      pre: statePlain(tg.states[e.from].s),
      action: e.label.action,
      data: Object.fromEntries(Object.entries(e.label.data).map(([k, v]) => [k, toPlain(v)])),
      post: statePlain(e.to !== null ? tg.states[e.to].s : e.outcome.state.s),
      verdict: e.label.verdict.kind === 'rejected' ? `rejected(${e.label.verdict.reason})` : e.label.verdict.kind,
      ...(e.label.effects.length ? { effects: e.label.effects.map((x) => x.kind) } : {}),
    }));
    for (const { edge, brk } of firstBreaks(M, tg)) flowFindings.push(finding(brk.code, M.handlers.get(edge.label.action)?.id, `${edge.label.action} breaks the flow rule: ${brk.text}`, ttrace([...pathTo(tg, edge.from), edge]), { property: brk.code === 'PL6831' ? 'flow' : 'remember', state: tg.states[edge.from].s }));
    const cut = tg.edges.find((e) => e.outcome.kind === 'bound' && e.outcome.field.startsWith('pending '));
    if (cut && cut.outcome.kind === 'bound') flowFindings.push(finding('PL3901', undefined, `the flow rule's exploration stopped: ${cut.outcome.field.slice(8)} would hold more than ${PENDING_BOUND} pending intents (PS17.2)`, ttrace([...pathTo(tg, cut.from), cut])));
    if (tg.capHit) flowFindings.push(finding('PL3901', undefined, `the flow rule's exploration stopped at ${tg.states.length} states`, []));
    const mem = M.memory;
    const program = [module, ...(opts.program ?? [])];
    // PS17.3, S322: a message no configuration follows. Two machines are followed together when some configuration of
    // the program holds both (two instances, for a message to another instance of the same machine).
    const counts = new Map<string, number>();
    const followed = (target: string): boolean => program.some((mod) => mod.decls.some((d) => {
      if (d.kind !== 'Configuration') return false;
      counts.clear();
      for (const x of d.instances) { const n = x.machine[x.machine.length - 1]; counts.set(n, (counts.get(n) ?? 0) + (x.count ?? 1)); }
      return target === M.name ? (counts.get(M.name) ?? 0) >= 2 : counts.has(M.name) && counts.has(target);
    }));
    const tainted = (data: Record<string, unknown>): string | null => {
      for (const [f, v] of Object.entries(data)) if (!isBottom(taintOf(v as never))) return f;
      return null;
    };
    const reported = new Set<string>();
    for (const e of tg.edges) {
      if (e.label.verdict.kind !== 'accepted') continue;
      for (const i of e.label.effects) {
        let target: string | null = null;
        let data: Record<string, unknown> | null = null;
        let action = '';
        if (i.type === 'send') { const a = bare(i.target); if (typeof a !== 'string' || a === selfAlone(M)) continue; target = a.slice(0, a.lastIndexOf('#')); data = i.data; action = i.action; }
        else if (i.type === 'create' || i.type === 'spawn') { target = (i.type === 'create' ? i.machine : i.machineId).split('.').pop()!; data = i.create?.data ?? null; action = i.create?.action ?? ''; }
        else if (i.type === 'signal') { target = M.children.get(i.key)?.machine ?? null; data = i.data; action = i.action; }
        if (!target || !data) continue;
        const f = tainted(data);
        if (f === null || followed(target)) continue;
        const key = `${e.label.action}>${target}.${action}`;
        if (reported.has(key)) continue;
        reported.add(key);
        flowFindings.push(finding('PL6838', M.handlers.get(e.label.action)?.id, `${e.label.action} sends ${action} to ${target} carrying ${f}, tainted, and no configuration of the program holds ${M.name} and ${target}, so the flow rule does not follow the message (PS17.3, S322)`, ttrace([...pathTo(tg, e.from), e])));
      }
    }
    // S323, S325: the declassification points, for the certificate.
    if (mem) {
      const decisions = new Map<string, { kind: string; class: string; answers: number }>();
      const foreign = new Set<string>();
      for (const e of tg.edges) {
        if (e.label.verdict.kind !== 'accepted') continue;
        const claimant = claimsClass(M, e.label.action, e.label.data)?.principal ?? null;
        for (const i of e.label.effects) {
          if (i.type !== 'effect') continue;
          const r = mem.retrievals.get(i.kind);
          if (r?.owned) { const v = r.owner === null ? null : bare(i.payload[r.owner] ?? null); if (r.owner === null || v === null || v !== claimant) foreign.add(i.kind); }
          if (!mem.decisions.has(i.kind)) continue;
          const d = [...M.decisions.values()].find((x) => x.kind === i.kind);
          const okAction = d?.ok ? M.actions.find((x) => x.name === d.ok!.action) : undefined;
          const answer = okAction?.params.filter((x) => d!.ok!.answer.includes(x.name)) ?? [];
          if (!answer.length || answer.some((x) => x.type.k === 'content' || x.type.k === 'items')) continue;
          let top = -1;
          for (const v of Object.values(i.payload)) { const tt = taintOf(v); if (!isBottom(tt)) top = Math.max(top, tt.c); }
          if (top < 0) continue;
          const answers = answer.reduce((n, x) => n * valuesOf(x.type, M).length, 1);
          const prev = decisions.get(i.kind);
          if (!prev || mem.classes.indexOf(prev.class) < top) decisions.set(i.kind, { kind: i.kind, class: mem.classes[top] ?? String(top), answers });
        }
      }
      // A count read: x.count in the handler of an action that completes a retrieval whose owner is not the claimant's.
      const countsOut: Declassify['counts'] = [];
      for (const [action, kinds] of mem.completes) for (const kind of kinds) {
        if (!foreign.has(kind)) continue;
        const a = M.actions.find((x) => x.name === action);
        const h = M.handlers.get(action);
        if (!a || !h) continue;
        for (const prm of a.params) if (prm.type.k === 'items' && readsCount(h, prm.name)) countsOut.push({ machine: M.name, action, param: prm.name, retrieval: kind });
      }
      declassify = { decisions: [...decisions.values()].sort((x, y) => (x.kind < y.kind ? -1 : 1)), counts: countsOut };
    }
  }

  return {
    vacuous,
    ...(flowStates !== undefined ? { flowStates, flowFindings, ...(declassify ? { declassify } : {}) } : {}),
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
  // PS1.4b: an Items by its count.
  if (t.k === 'items') return `Items count 0..${M.itemsLimit}`;
  if (!check) return typeText(t, M);
  // S57: the addresses a Ref ranges over, and none.
  if (t.k === 'ref') return `{${check.map((v) => (v === null ? 'none' : String(v))).join(', ')}}`;
  const nums = check.every((v) => typeof v === 'number') ? (check as number[]) : null;
  if (nums && nums.length > 2 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1)) return `${nums[0]}..${nums[nums.length - 1]}`;
  return `{${check.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ')}}`;
}

/** Whether the machine's labels or state hold a principal (PD5.1.3c), so its instance names the representatives. */
function usesPrincipals(M: RMachine): boolean {
  const deep = (x: RType, seen: Set<string>): boolean => x.k === 'principal' || (x.k === 'map' && deep(x.value, seen))
    || (x.k === 'record' && !seen.has(x.name) && (M.records.get(x.name)?.fields ?? []).some((f) => deep(f.type, new Set([...seen, x.name]))))
    || (x.k === 'union' && !seen.has(x.name) && (M.unions.get(x.name)?.ctors ?? []).some((c) => c.fields.some((f) => deep(f.type, new Set([...seen, x.name])))));
  return M.actions.some((a) => a.claims && deep(a.claims.type, new Set())) || M.fields.some((f) => deep(f.type, new Set()));
}

/** Whether the machine's labels or state hold a Key (PS4.1g), so its instance names the representatives. */
function usesKeys(M: RMachine): boolean {
  const deep = (x: RType, seen: Set<string>): boolean => x.k === 'key' || (x.k === 'map' && deep(x.value, seen))
    || (x.k === 'record' && !seen.has(x.name) && (M.records.get(x.name)?.fields ?? []).some((f) => deep(f.type, new Set([...seen, x.name]))))
    || (x.k === 'union' && !seen.has(x.name) && (M.unions.get(x.name)?.ctors ?? []).some((c) => c.fields.some((f) => deep(f.type, new Set([...seen, x.name])))));
  return M.fields.some((f) => deep(f.type, new Set())) || M.actions.some((a) => a.params.some((p) => deep(p.type, new Set())));
}

/** The checked instance a verdict holds for (PS4.3, PT12.3a). */
export function instanceOf(M: RMachine): InstanceLine {
  return {
    fields: M.fields.filter((f) => f.check || f.type.k === 'int').map((f) => ({ name: f.name, domain: domainText(f.check, f.type, M) })),
    params: M.actions.flatMap((a) => a.params.map((p) => ({ name: `${a.name}.${p.name}`, domain: domainText(p.check ?? (p.type.k === 'union' || p.type.k === 'record' || p.type.k === 'bool' ? null : valuesOf(p.type, M)), p.type, M) }))),
    ...(usesPrincipals(M) ? { principals: M.principals } : {}),
    // PS4.1f: and the content representatives, counted apart.
    ...([...M.fields.map((f) => f.type), ...M.actions.flatMap((a) => a.params.map((p) => p.type))].some(function deep(t: RType): boolean { return t.k === 'content' || (t.k === 'map' && deep(t.value)); }) ? { contents: M.contents } : {}),
    // PS4.1g: and the key representatives, counted apart.
    ...(usesKeys(M) ? { keys: M.keys } : {}),
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
/**
 * PS5.2a: why a never is not tested over the given steps and states, or null when it is: its while holds in no state,
 * or it holds and no action that can emit its effect is taken from such a state.
 */
export function untested(M: RMachine, p: { name: string; expr: Expr }, steps: { action: string; pre: State }[], states: State[]): string | null {
  const { cond, effect } = neverParts(p);
  const holds = (s: State) => cond === null || evaluate(cond, { M, state: s, data: {}, locals: new Map() }) === true;
  const acts = emittingActions(M.handlers, effect);
  if (steps.some((x) => acts.has(x.action) && holds(x.pre))) return null;
  return states.some(holds)
    ? `never ${p.name}: its while holds, and no action that can emit ${effect} (${[...acts].join(', ') || 'none'}) is taken from such a state`
    : `never ${p.name}: its while holds in no reachable state`;
}

export function machineVacuity(M: RMachine, g: Graph<State>, fault?: RefFault): Vacuous[] {
  const out: Vacuous[] = [];
  const states = () => g.states.map((s) => ({ M, state: s, data: {}, locals: new Map() }));
  const accepted = () => g.edges.filter((x) => x.label.verdict.kind === 'accepted').map((x) => ({
    M, state: g.states[x.from], data: x.label.data, locals: new Map(), pre: g.states[x.from], post: x.outcome.state, action: x.label.action, intents: x.label.effects,
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
  for (const p of M.stepProperties) {
    // PS5.2a, ruled on step 10: a never is tested where an action that can emit its effect is taken from a state where
    // its while holds; the weak measure (its while true on some accepted step) is the fault weak-vacuity.
    if (M.nevers.has(p.name) && fault !== 'weak-vacuity') {
      const why = untested(M, p, g.edges.filter((x) => x.label.verdict.kind === 'accepted').map((x) => ({ action: x.label.action, pre: g.states[x.from] })), g.states);
      if (why) out.push({ property: p.name, id: p.id, parts: [], text: why });
      continue;
    }
    judgeAll(p.name, p.id, p.expr, accepted);
  }
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

/** S325: whether a handler reads `p.count` anywhere in its body. */
function readsCount(h: A.Handler, p: string): boolean {
  let hit = false;
  const walk = (x: unknown): void => {
    if (hit || !x || typeof x !== 'object') return;
    const n = x as { kind?: string; object?: { kind?: string; name?: string }; prop?: string };
    if (n.kind === 'Member' && n.prop === 'count' && n.object?.kind === 'Name' && n.object.name === p) { hit = true; return; }
    for (const v of Object.values(x)) walk(v);
  };
  walk(h.body);
  return hit;
}
