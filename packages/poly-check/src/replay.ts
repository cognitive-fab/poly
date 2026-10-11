// Journal replay (AC6, PS11.3, PS11.4, M4a): a run's state is the fold of the step over its journal, so replay
// folds every row again and compares. Two folds, independent of each other:
//   - poly-ref's δ, written from 04-semantics, over the certified source: every verdict, reason and post-state;
//   - polygraph's replayer over the certified lowered module, every accepted window.
// The snapshot polyrun keeps is the fold's cache: one that disagrees with the fold is a kernel fault, not a
// program fault (PS11.4). Every divergence is PL9001. Kernel rows ($create, $undeliverable, a poisoned
// instance's refusals) are checked as what they are. A decision's answer comes from the journal, never from a
// model (K10).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, costOf, diag, sha256OfBytes, type Diagnostic } from '@poly/core';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import type { PolyRuntime } from '@poly/runtime';
import type * as A from '@poly/core';
import { buildMachine, initialState, transition, flatten, alpha, alphaData, type State } from '@poly/ref';
import { replaySpecResults } from '@cognitive-fab/polygraph/scripts/replay.mjs';
import { STD as STD_ROOT } from './uses.js';

export interface JournalRowLike {
  seq: number;
  action: string;
  action_id: string;
  data: Record<string, unknown>;
  pre: Record<string, unknown>;
  post: Record<string, unknown>;
  step_kind: 'accepted' | 'rejected' | 'unhandled';
  reject_reason: string | null;
}

export interface GateDecisionLike { seq: number; decision: string; recompute: (() => string) | null; bySession?: boolean }

export interface RunReplay {
  run: string;
  machine: string;
  rows: number;
  /** Rows folded through poly-ref's δ, and windows replayed by polygraph. */
  folded: number;
  windows: number;
  /** Review B7: why the run was not replayed (an archived run's journal is gone), when it was not. */
  notRun?: string;
  /** Review B5: recorded gate decisions not replayed, for want of the gate they were made by (listed as not run). */
  gateNotRun: number;
  /** PS11.3a: each step whose data names an erased body, with the forget event that erased it; no divergence. */
  forgotten?: { seq: number; digest: string; forget: string | null }[];
  diagnostics: Diagnostic[];
}

const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);
const KERNEL_ROWS = new Set(['$create', '$undeliverable', '$migrate']);

export function replayRun(module: A.Module, machineId: string, instanceId: string, rows: JournalRowLike[], opts: { modulePath?: string; snapshot?: Record<string, unknown> | null; gate?: GateDecisionLike[]; erased?: Map<string, string | null>; program?: A.Module[] } = {}): RunReplay {
  const machineName = machineId.slice(machineId.indexOf('.') + 1);
  // PS18.0: a route's or a budget's machine is read by poly-ref from the source and the std module it instantiates.
  const M = buildMachine(module, machineName, opts.program ? { program: opts.program } : {});
  const at = { module: module.name, machine: machineName };
  const out: Diagnostic[] = [];
  const diverge = (seq: number, message: string) => out.push(diag('PL9001', at, `run ${instanceId}, seq ${seq}: ${message}`));
  let s: State = initialState(M);
  let folded = 0;
  for (const row of rows) {
    const flat = flatten(s, M);
    if (row.action === '$create') {
      if (!same(row.post, flat) || !same(row.pre, flat)) diverge(row.seq, 'the creation row is not the initial state');
      folded++;
      continue;
    }
    if (!same(row.pre, flat)) diverge(row.seq, `the journal's pre-state of ${row.action} is not the fold of the rows before it`);
    if (KERNEL_ROWS.has(row.action) || row.reject_reason === 'poisoned') {
      // A row the kernel writes without the module: a labelled stutter, pre equal to post (PS3.3, S89).
      if (row.step_kind === 'accepted' || !same(row.pre, row.post)) diverge(row.seq, `the kernel row ${row.action} is not a stutter`);
      folded++;
      continue;
    }
    let step;
    try {
      step = transition(M, alpha(row.pre, M), row.action, alphaData(row.data, row.action, M), instanceId);
    } catch (e) {
      diverge(row.seq, `poly-ref cannot take ${row.action}: ${(e as Error).message}`);
      continue;
    }
    const kind = step.verdict.kind;
    const reason = step.verdict.kind === 'rejected' ? step.verdict.reason : null;
    if (kind !== row.step_kind) diverge(row.seq, `${row.action} is ${kind} by the semantics and ${row.step_kind} in the journal`);
    else if ((reason ?? null) !== (row.reject_reason ?? null)) diverge(row.seq, `${row.action} is rejected "${reason}" by the semantics and "${row.reject_reason}" in the journal`);
    const next = flatten(kind === 'accepted' ? step.next : s, M);
    if (!same(next, row.post)) diverge(row.seq, `the post-state of ${row.action} is not δ of its pre-state`);
    if (kind === 'accepted') s = step.next;
    folded++;
  }
  if (opts.snapshot !== undefined && opts.snapshot !== null && !same(opts.snapshot, flatten(s, M))) {
    out.push(diag('PL9001', at, `run ${instanceId}: the snapshot disagrees with the fold of the journal, a kernel fault (PS11.4)`));
  }

  // The engine's own replay of the certified module, window by window.
  const windows = rows.filter((r) => r.step_kind === 'accepted' && !KERNEL_ROWS.has(r.action)).map((r) => ({ action: r.action, data: r.data, pre: r.pre, post: r.post }));
  if (opts.modulePath && windows.length) {
    const res = replaySpecResults(opts.modulePath, windows);
    if (!res.ok) out.push(diag('PL9001', at, `run ${instanceId}: polygraph could not replay the certified module: ${res.error ?? 'no result'}`));
    else res.results.forEach((r: { status: string }, i: number) => {
      if (r.status !== 'pass') diverge(rows.filter((x) => x.step_kind === 'accepted' && !KERNEL_ROWS.has(x.action))[i].seq, `polygraph's replay of the certified module gives ${r.status}`);
    });
  }

  // Gate decisions (S118): each recorded verdict, recomputed from its proposal and its snapshot.
  let gateNotRun = 0;
  for (const g of opts.gate ?? []) {
    if (g.bySession) continue; // replayed with its session (S146)
    if (!g.recompute) { gateNotRun++; continue; }
    const again = g.recompute();
    if (again !== g.decision) out.push(diag('PL9001', at, `run ${instanceId}: the gate decision at ledger seq ${g.seq} was ${g.decision}, and replay gives ${again}`));
  }
  // PS11.3a: replay reads no body, so a step whose data names an erased body folds as before; it is listed as forgotten.
  const forgotten: NonNullable<RunReplay['forgotten']> = [];
  const digests = (x: unknown, acc: string[] = []): string[] => { if (typeof x === 'string') { if (/^sha256:[0-9a-f]{64}$/.test(x)) acc.push(x); } else if (x && typeof x === 'object') for (const v of Object.values(x)) digests(v, acc); return acc; };
  if (opts.erased?.size) for (const row of rows) for (const d of new Set(digests(row.data))) if (opts.erased.has(d)) forgotten.push({ seq: row.seq, digest: d, forget: opts.erased.get(d) ?? null });
  return { run: instanceId, machine: machineId, rows: rows.length, folded, windows: opts.modulePath ? windows.length : 0, gateNotRun, diagnostics: out, ...(forgotten.length ? { forgotten } : {}) };
}

/** Review C3 (M11): what is wrong with a route run's call records, against its journal and its certified tiers. */
async function routeRecordProblems(rt: PolyRuntime, run: string, rows: JournalRowLike[], route: PolyRuntime['verified']['routes'][number]): Promise<string[]> {
  const out: string[] = [];
  const events = (await rt.chain(run)).filter((e) => e.kind === 'decision').map((e) => e.body as Record<string, any>);
  const answers = rows.filter((x) => x.action === 'Answer' && x.step_kind === 'accepted');
  const answered = events.filter((b) => b.completed !== false);
  if (answered.length !== answers.length) out.push(`${answers.length} Answer steps and ${answered.length} answered calls' decision events`);
  answers.forEach((row, i) => {
    const b = answered[i];
    if (!b) return;
    const tier = (row.pre as { tier?: unknown }).tier;
    if (b.tierIndex !== tier || route.tiers[tier as number]?.name !== b.tier) out.push(`the call answered at seq ${row.seq} was on tier ${String(tier)}, and its decision event names tier ${String(b.tier)} (${String(b.tierIndex)})`);
    if (b.conf !== (row.data as { conf?: unknown }).conf || b.margin !== (row.data as { margin?: unknown }).margin) out.push(`the call answered at seq ${row.seq}: its decision event's conf and margin are not the Answer step's`);
  });
  for (const b of events) {
    const t = route.tiers[b.tierIndex as number];
    if (!t) { out.push(`a decision event names tier ${String(b.tierIndex)}, which route ${route.name} does not have`); continue; }
    if (b.prices !== t.prices.digest) out.push(`a call on tier ${t.name} names the prices ${String(b.prices)}, and the certificate's are ${t.prices.digest}`);
    let want: number | null = null;
    // S361: a call whose usage poly could not price is charged its tier's reservation.
    if (b.usageViolation) want = t.reservation;
    else try { want = costOf(b.usage ?? {}, t.prices).cost; } catch { want = null; }
    if (b.cost?.units !== want || b.cost?.unit !== `micro-${t.prices.currency}`) out.push(`a call on tier ${t.name} records the cost ${JSON.stringify(b.cost)}, and its usage at the certified prices is ${String(want)} micro-${t.prices.currency}`);
  }
  return out;
}

/** The certified sources of a build, read and checked against the certificate's digests, parsed, by module name. */
export function certifiedModules(root: string, sources: Record<string, string>): Map<string, A.Module> {
  const out = new Map<string, A.Module>();
  for (const [path, want] of Object.entries(sources)) {
    const bytes = readFileSync(join(root, path));
    const have = sha256OfBytes(bytes);
    if (have !== want) throw new Error(`${path}: the source changed since certification (certified ${want}, found ${have})`);
    const text = bytes.toString('utf8');
    const m = (path.endsWith('.ts') ? readEmbedded(text, path) : parse(text)).module;
    if (!m) throw new Error(`${path}: the certified source does not parse`);
    out.set(m.name, m);
  }
  return out;
}

/** S118, S146: each gate session the runs touched, replayed in sseq order; PL9001 for a decision or Σ that differs. */
export async function replaySessions(rt: PolyRuntime): Promise<{ session: string; proposals: number; settles: number; diagnostics: Diagnostic[]; notRun: string[] }[]> {
  return (await rt.replaySessions()).map((s) => ({ ...s, diagnostics: s.diagnostics.map((d) => diag(d.code, { node: s.session }, d.message)) }));
}

/** The certified modules of a build and the std modules it was made from (PS18.0), each checked against the certificate. */
export function certifiedProgram(rt: PolyRuntime): { modules: Map<string, A.Module>; program: A.Module[] } {
  const modules = certifiedModules(rt.root, rt.certificate.poly.sources);
  // PS18.0, S190: the std modules the build was made from, each read from std and checked against the certificate.
  const std: A.Module[] = [];
  for (const [name, x] of Object.entries(rt.certificate.poly.typeModules ?? {})) {
    if (!name.startsWith('std.') || !x.path.startsWith('std:')) continue;
    const file = join(rt.verified.std ?? STD_ROOT, x.path.slice(4));
    // Probe reviewer B on V4: a missing file is refused as load refuses it, naming the module, not with a bare ENOENT.
    if (!existsSync(file)) throw new Error(`${x.path}: the std module changed since certification (certified ${x.file}, found nothing)`);
    const bytes = readFileSync(file);
    if (sha256OfBytes(bytes) !== x.file) throw new Error(`${x.path}: the std module changed since certification (certified ${x.file}, found ${sha256OfBytes(bytes)})`);
    const m = parse(bytes.toString('utf8')).module;
    if (m) std.push(m);
  }
  return { modules, program: [...modules.values(), ...std] };
}

/** Every run a runtime's store holds, replayed: its journal, its snapshot, and the certified module it ran. */
export async function replayRuntime(rt: PolyRuntime, opts: { runs?: string[] } = {}): Promise<RunReplay[]> {
  const { modules, program } = certifiedProgram(rt);
  const instances = await rt.instances();
  const out: RunReplay[] = [];
  // Review B7: an archived run has no journal to fold; it is listed as not replayed, never skipped.
  const live = new Set(instances.map((i) => i.id));
  for (const run of await rt.runs()) {
    if (live.has(run.run) || (opts.runs && !opts.runs.includes(run.run))) continue;
    // V4: runtime:ingress, runtime:approvals, runtime:content and the like are the runtime's own records, events of no
    // machine: there was never a journal to fold, so they are not runs here, and not archived ones (their chains are
    // verified with every other by journal verify).
    if (run.run.startsWith('runtime:')) continue;
    out.push({ run: run.run, machine: run.wf, rows: 0, folded: 0, windows: 0, gateNotRun: 0, diagnostics: [], notRun: 'archived, its journal is gone; not replayed' });
  }
  for (const inst of instances) {
    if (opts.runs && !opts.runs.includes(inst.id)) continue;
    const rows = (await rt.getJournal(inst.id)) as unknown as JournalRowLike[];
    const model = rt.modelOf(inst.machineId);
    if (model) {
      // A worker's intent: its journal is the worker's trace, replayed against the OutboxIntent model (M4b).
      const parsed = parse(model.source).module;
      if (!parsed) throw new Error(`${inst.machineId}: the model does not parse`);
      out.push(replayRun(parsed, inst.machineId, inst.id, rows, { modulePath: model.module, snapshot: inst.state }));
      continue;
    }
    const module = modules.get(inst.machineId.slice(0, inst.machineId.indexOf('.')));
    if (!module) throw new Error(`${inst.id}: machine ${inst.machineId} is not in the certified sources`);
    const r = replayRun(module, inst.machineId, inst.id, rows, { modulePath: rt.modulePath(inst.machineId), snapshot: inst.state, gate: await rt.gateReplays(inst.id), erased: rt.forgottenBodies(), program });
    // PD5-A11: the claims and lineage digests each step event records are reproduced.
    for (const p of await rt.verifyAttribution(inst.id)) r.diagnostics.push(diag('PL9001', { machine: inst.machineId }, `run ${inst.id}: ${p}`));
    // Review C3 (M11): a route's tier choices are its Answer steps, so each call's decision event is checked against
    // them, and its cost against its usage under the certified tier's prices (PS18.3, PS18.6).
    const route = rt.verified.routes.find((x) => x.machine === inst.machineId);
    if (route) for (const p of await routeRecordProblems(rt, inst.id, rows, route)) r.diagnostics.push(diag('PL9001', { machine: inst.machineId }, `run ${inst.id}: ${p}`));
    out.push(r);
  }
  return out;
}
