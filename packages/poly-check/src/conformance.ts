// The worker's conformance to OutboxIntent, in the runtime's CI (PT9.7, M4b, S119). The worker hosts the
// machine, so its trace is the journal of each intent instance. Three checks, each a PL2401 RUNTIME_MODEL_DRIFT
// when it fails:
//   1. every action the worker's source can take is an action of the machine;
//   2. every transition the worker took was accepted by the machine and replays through poly-ref's δ: a
//      rejected row is a transition the worker attempted and the machine refuses;
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
  return [...new Set([...source.matchAll(/transition\(\s*\w+\s*,\s*'(\w+)'\s*\)/g)].map((m) => m[1]))].sort();
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
  // A transition the machine refused rolls back with its transaction; the worker records it as a runtime fault.
  for (const r of await rt.audit()) if (r.rule === 'PL2401') diagnostics.push(diag('PL2401', AT, r.reason));
  return { diagnostics, intents, states, edges };
}
