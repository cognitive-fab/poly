// The worker's conformance to OutboxIntent, in the runtime's CI (PT9.7, M4b, S119). The worker hosts the
// machine, so its trace is the journal of each intent instance. Three checks, each a PL2401 RUNTIME_MODEL_DRIFT
// when it fails:
//   1. every action the worker's source can take is an action of the machine;
//   2. every transition the worker took was accepted by the machine and replays through poly-ref's δ: a
//      rejected row is a transition the worker attempted and the machine refuses;
//   2b. every handler outcome the worker observed matches the transition it took (S138): ok is HandlerOk, a
//       failure or a crash HandlerFailed, a permanent error HandlerFailedPermanent;
//   2a. a transition the machine refused at runtime, which the worker recorded in the audit log;
//   3. every intent's state agrees with its outbox row: an intent still in flight is pending or inflight, a Done
//      intent is done, a Denied or Dead intent is dead. A status the machine does not account for is drift.
import { readFileSync } from 'node:fs';
import { canonicalize, diag, type Diagnostic } from '@poly/core';
import { parse } from '@poly/lang';
import type { PolyRuntime } from '@poly/runtime';
import { replayRun, type JournalRowLike } from './replay.js';

const STATUS: Record<string, string[]> = {
  Pending: ['pending', 'inflight'], Proposed: ['pending', 'inflight'], Escalated: ['pending', 'inflight'],
  Allowed: ['pending', 'inflight'], Running: ['pending', 'inflight'], Settled: ['pending', 'inflight'],
  Done: ['done'], Denied: ['dead'], Dead: ['dead'],
};

export interface Conformance {
  diagnostics: Diagnostic[];
  intents: number;
  /** Flat states visited, and accepted transitions taken as `<state> -<action>->`, over every intent. */
  states: Set<string>;
  edges: Set<string>;
}

const AT = { module: 'runtime', machine: 'OutboxIntent' };

/** The actions a worker source can take: every `transition(row, 'Action')`. */
export function workerActions(source: string): string[] {
  return [...new Set([...source.matchAll(/(?:transition|attempt|finish)\(\s*\w+\s*,\s*'(\w+)'/g)].map((m) => m[1]))].sort();
}

export async function workerConformance(rt: PolyRuntime, workerSourcePath: string): Promise<Conformance> {
  const diagnostics: Diagnostic[] = [];
  const states = new Set<string>();
  const edges = new Set<string>();
  const model = rt.modelOf('runtime.OutboxIntent')!;
  const machine = parse(model.source).module!.decls.find((d) => d.kind === 'Machine')! as { items: { kind: string; name?: string }[] };
  const actions = new Set(machine.items.filter((i) => i.kind === 'Action').map((i) => i.name!));
  for (const a of workerActions(readFileSync(workerSourcePath, 'utf8'))) {
    if (!actions.has(a)) diagnostics.push(diag('PL2401', AT, `the worker can take ${a}, which OutboxIntent does not have`));
  }
  let intents = 0;
  for (const inst of await rt.instances()) {
    const m = rt.modelOf(inst.machineId);
    if (!m) continue;
    intents++;
    const rows = (await rt.getJournal(inst.id)) as unknown as JournalRowLike[];
    for (const r of rows) {
      if (r.action === '$create') { states.add(canonicalize(r.post)); continue; }
      // Review C3: Approve and EscalationTimeout race, and the one that loses is a rejected step of the machine, not drift.
      if (r.step_kind !== 'accepted' && (r.action === 'Approve' || r.action === 'EscalationTimeout')) continue;
      if (r.step_kind !== 'accepted') { diagnostics.push(diag('PL2401', AT, `intent ${inst.id}, seq ${r.seq}: the worker took ${r.action} in ${String(r.pre.intent)}, and the machine refuses it (${r.step_kind}${r.reject_reason ? ` "${r.reject_reason}"` : ''})`)); continue; }
      edges.add(`${canonicalize(r.pre)} -${r.action}->`);
      states.add(canonicalize(r.post));
    }
    const replay = replayRun(parse(m.source).module!, inst.machineId, inst.id, rows, { snapshot: inst.state });
    for (const d of replay.diagnostics) diagnostics.push(diag('PL2401', AT, `the worker's trace does not replay: ${d.message}`));
    const intentId = inst.id.replace(/^intent:/, '');
    const row = await rt.outboxRow(intentId);
    const tag = String(inst.state.intent);
    if (!row) diagnostics.push(diag('PL2401', AT, `intent ${inst.id} has no outbox row`));
    else if (!(STATUS[tag] ?? []).includes(row.status)) diagnostics.push(diag('PL2401', AT, `intent ${inst.id} is ${tag} and its outbox row is ${row.status}, a pair OutboxIntent does not account for`));
  }
  // S138: each handler outcome observed on the emitting run is paired, in order, with the transition the worker took.
  const expected: Record<string, string> = { ok: 'HandlerOk', failed: 'HandlerFailed', lost: 'HandlerFailed', permanent: 'HandlerFailedPermanent' };
  for (const inst of await rt.instances()) {
    if (!rt.modelOf(inst.machineId)) continue;
    const intentId = inst.id.replace(/^intent:/, '');
    const row = await rt.outboxRow(intentId);
    if (!row) continue;
    const taken = ((await rt.getJournal(inst.id)) as unknown as JournalRowLike[]).filter((r) => r.step_kind === 'accepted' && /^Handler/.test(r.action)).map((r) => r.action);
    const seen = (await rt.chain(row.instance_id)).filter((e) => e.kind === 'observation' && (e.body as { stage?: string; intent?: string }).stage === 'handler' && (e.body as { intent: string }).intent === intentId).map((e) => e.body as { attempt: number; outcome: string });
    // PS23.7: a lapsed window is observed beside the transition WindowLapsed, once for once, and is no handler outcome.
    const lapsed = seen.filter((o) => o.outcome === 'lapsed').length;
    const lapses = ((await rt.getJournal(inst.id)) as unknown as JournalRowLike[]).filter((r) => r.step_kind === 'accepted' && r.action === 'WindowLapsed').length;
    if (lapsed !== lapses) diagnostics.push(diag('PL2401', AT, `intent ${inst.id} took WindowLapsed ${lapses} times and observed ${lapsed} lapses`));
    seen.splice(0, seen.length, ...seen.filter((o) => o.outcome !== 'lapsed'));
    if (taken.length !== seen.length) diagnostics.push(diag('PL2401', AT, `intent ${inst.id} took ${taken.length} handler transitions and observed ${seen.length} handler outcomes`));
    seen.forEach((o, k) => {
      if (taken[k] !== undefined && taken[k] !== expected[o.outcome]) diagnostics.push(diag('PL2401', AT, `intent ${inst.id}: handler outcome ${o.outcome} at attempt ${o.attempt}, and the worker took ${taken[k]}`));
    });
  }
  // Review C7: each intent's end and the program's completion steps tell one story. Done has its success completion
  // and no failure; Denied and Dead have a failure (failed or exhausted) and no success; an intent still in flight has
  // none. A completion the manifest does not declare is not looked for.
  for (const inst of await rt.instances()) {
    if (!rt.modelOf(inst.machineId)) continue;
    const intentId = inst.id.replace(/^intent:/, '');
    const row = await rt.outboxRow(intentId);
    if (!row) continue;
    const hooks = rt.effectDeclaration(row.instance_id, row.kind) ?? {};
    const steps = new Set(((await rt.getJournal(row.instance_id)) as unknown as JournalRowLike[]).map((r) => r.action_id).filter((a) => a.startsWith(`${intentId}:`)).map((a) => a.slice(intentId.length)));
    const tag = String(inst.state.intent);
    const failure = steps.has(':failed') || steps.has(':exhausted');
    const say = (what: string) => diagnostics.push(diag('PL2401', AT, `intent ${inst.id} is ${tag}, and ${what}`));
    if (tag === 'Done') {
      if (failure) say('the program took a failure completion for it');
      if (hooks.onSuccess?.action && !steps.has(':done')) say('the program took no success completion for it');
    } else if (tag === 'Denied' || tag === 'Dead') {
      if (steps.has(':done')) say('the program took a success completion for it');
      if ((hooks.onFailure?.action || hooks.onExhausted?.action) && !failure) say('the program took no failure completion for it');
    } else if (steps.size) say(`the program already took ${[...steps].join(', ')} for it`);
  }
  // A transition the machine refused rolls back with its transaction; the worker records it as a runtime fault.
  for (const r of await rt.audit()) if (r.rule === 'PL2401') diagnostics.push(diag('PL2401', AT, r.reason));
  return { diagnostics, intents, states, edges };
}
