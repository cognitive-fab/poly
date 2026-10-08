// `poly try` (PT28.2, PF15.2, S362, ruled at M11): a playground over one machine. A session is a list of operations,
// replayed from the start on every call, so the command line, the MCP server and the language server serve it alike
// with no state between calls. The machine is lowered as `poly check` lowers it (stages 0 to 2), and each step is taken
// by polyrun's kernel over the lowered module, the step the runtime takes (PT28.2c), in an in-memory store that nothing
// keeps: no handler runs, no model is called, no intent is executed, and nothing is admitted, signed or written to a
// store or a ledger (PT28.2d). A witness is the shortest path poly-ref's exploration finds, as `poly check` reports it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, parseFragment } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { diag, type Diagnostic, type Module } from '@poly/core';
import type * as A from '@poly/core';
import { buildMachine, checkMachine, evaluate, isTerminal, pathTo, decide, initialSigma, type PolicyScope } from '@poly/ref';
import { checkFile } from './pipeline.js';
import { resolveUses } from './uses.js';

/** One operation of a session (PT28.2b). `start` is the session's own: its file and machine. */
export type TryOp =
  | { op: 'dispatch'; action: string; data?: Record<string, unknown> }
  | { op: 'state' }
  | { op: 'intents' }
  | { op: 'gate'; policy: string }
  | { op: 'witness'; predicate: string }
  | { op: 'reset' };

export interface TryResult {
  machine: string;
  /** One result per operation, in order; the session stops at the first refused one (PL6846). */
  results: Record<string, unknown>[];
  /** PT28.2d: each accepted or rejected step as a window, which `poly check --against` can replay. */
  trace: { pre: Record<string, unknown>; action: string; data: Record<string, unknown>; post: Record<string, unknown> }[];
  diagnostics: Diagnostic[];
}

const sourceOf = (file: string): Module | null => {
  const text = readFileSync(file, 'utf8');
  return (file.endsWith('.ts') ? readEmbedded(text, file) : parse(text)).module;
};

/**
 * The shortest path, in breadth-first order, to the first state that the predicate holds in, as poly check gives its
 * witnesses: `deadlock` is a reachable state, not terminal, of a machine that is no service, from which no action is
 * accepted (PS5.6, PL3201); any other predicate is an expression over the state, read by poly-ref.
 */
function witnessOf(module: Module, program: Module[], machine: string, predicate: string): { found: boolean; path: { action: string; data: unknown }[]; capHit: boolean } {
  const report = checkMachine(module, machine, { program });
  const g = report.graph;
  const M = report.model;
  const e = predicate === 'deadlock' ? null : (parseFragment('expr', predicate) as A.Expr);
  const holds = (i: number): boolean => e === null
    ? !M.service && !isTerminal(M, g.states[i]) && !g.out[i].some((k) => g.edges[k].label.verdict.kind === 'accepted')
    : evaluate(e, { M, state: g.states[i], data: {}, locals: new Map() } as never) === true;
  for (let i = 0; i < g.states.length; i++) {
    if (!holds(i)) continue;
    return { found: true, path: pathTo(g, i).map((x) => ({ action: x.label.action, data: x.label.data })), capHit: g.capHit };
  }
  return { found: false, path: [], capHit: g.capHit };
}

export async function trySession(input: { file: string; machine: string; ops: TryOp[] }): Promise<TryResult> {
  const file = resolve(input.file);
  const root = mkdtempSync(join(tmpdir(), 'poly-try-'));
  const out: TryResult = { machine: input.machine, results: [], trace: [], diagnostics: [] };
  try {
    // Stages 0 to 2 only, into a folder of the session's own: the module as poly check lowers it, never admitted.
    const report = await checkFile(file, { root, through: 2 });
    const errors = [...report.diagnostics, ...report.machines.flatMap((m) => m.diagnostics)].filter((d) => d.severity === 'error');
    const mc = report.machines.find((m) => m.machine === input.machine);
    if (errors.length || !mc?.buildDir || !report.module) {
      out.diagnostics.push(...(errors.length ? errors : [diag('PL6846', { module: report.module ?? undefined }, `poly try: no machine ${input.machine} in ${input.file} to try (PT28.2)`)]));
      return out;
    }
    const machineId = `${report.module}.${input.machine}`;
    const source = sourceOf(file)!;
    const program = resolveUses(source, file).program;
    const M = buildMachine(source, input.machine, { program });
    // The kernel is loaded only here, so the command line and poly check never load it (node:sqlite among it).
    const { createRuntime, Store } = await import('@cognitive-fab/polygraph/polyrun/src/index.mjs');
    const store = new Store(':memory:').initSync();
    const kernel = await createRuntime({ store, machines: [{ machineId, module: join(mc.buildDir, 'next.cjs'), contract: join(mc.buildDir, 'contract.json'), ...(mc.artefactDigests?.['effects.cjs'] ? { effects: { mapper: join(mc.buildDir, 'effects.cjs'), manifest: join(mc.buildDir, 'effects.manifest.json') } } : {}) }] });
    const manifest = (() => { try { return JSON.parse(readFileSync(join(mc.buildDir, 'effects.manifest.json'), 'utf8')).effects ?? {}; } catch { return {}; } })() as Record<string, { labels?: string[]; class?: string }>;
    let instance = 0;
    let id = `try#${instance}`;
    await kernel.create(machineId, id);
    let last: { seq: number } | null = null;
    try {
      for (const [k, op] of input.ops.entries()) {
        if (op.op === 'reset') { id = `try#${++instance}`; await kernel.create(machineId, id); last = null; out.results.push({ op: 'reset', state: (await kernel.getState(id)).state }); continue; }
        if (op.op === 'state') { out.results.push({ op: 'state', state: (await kernel.getState(id)).state }); continue; }
        if (op.op === 'dispatch') {
          if (!M.actions.some((a) => a.name === op.action)) {
            out.diagnostics.push(diag('PL6846', { module: report.module, machine: input.machine }, `poly try: operation ${k} dispatches ${op.action}, which ${input.machine} does not declare; the session stops here (PT28.2)`));
            break;
          }
          const pre = (await kernel.getState(id)).state;
          let r;
          try { r = await kernel.dispatch(id, op.action, op.data ?? {}, `try:${k}`); } catch (e) {
            out.diagnostics.push(diag('PL6846', { module: report.module, machine: input.machine }, `poly try: operation ${k} (${op.action}) is no step: ${(e as Error).message}; the session stops here (PT28.2)`));
            break;
          }
          last = { seq: r.seq };
          out.trace.push({ pre, action: op.action, data: op.data ?? {}, post: r.state });
          out.results.push({ op: 'dispatch', action: op.action, stepKind: r.stepKind, ...(r.rejectReason ? { rejectReason: r.rejectReason } : {}), state: r.state });
          continue;
        }
        // The intents the last step emitted, not run (PT28.2b).
        const intents = last === null ? [] : (store.db.prepare('SELECT kind, payload FROM pr_outbox WHERE instance_id = ? AND seq = ? ORDER BY intent_id').all(id, last.seq) as { kind: string; payload: string }[]).map((x) => ({ kind: x.kind, payload: JSON.parse(x.payload) }));
        if (op.op === 'intents') { out.results.push({ op: 'intents', intents }); continue; }
        if (op.op === 'gate') {
          // PT28.2b: the decision each intent would get from the policies of one file, against the emitting step's state
          // (PT9.3), by PS8's definition in poly-ref; no engine is called and nothing is journaled.
          const pol = sourceOf(resolve(op.policy));
          const policies = (pol?.decls ?? []).filter((d): d is A.Policy => d.kind === 'Policy');
          const state = (await kernel.getState(id)).state;
          const byScope = new Map<string, A.Policy[]>();
          for (const p of policies) byScope.set(p.scope, [...(byScope.get(p.scope) ?? []), p]);
          const decisions = intents.map((x) => {
            const row = { proposal: 'effect', effect: { kind: x.kind, class: manifest[x.kind]?.class ?? 'none', machine: machineId }, effects: manifest[x.kind]?.labels ?? [], machines: { [machineId]: state }, decisions: {} };
            const per = [...byScope].map(([scope, ps]) => { const s: PolicyScope = { scope, policies: ps }; const d = decide(s, initialSigma(s), row); return { scope, decision: d.decision, reasons: d.reasons }; });
            return { kind: x.kind, scopes: per };
          });
          out.results.push({ op: 'gate', policy: op.policy, decisions });
          continue;
        }
        if (op.op === 'witness') {
          const w = witnessOf(source, program, input.machine, op.predicate);
          out.results.push({ op: 'witness', predicate: op.predicate, ...w });
          continue;
        }
      }
    } finally { await kernel.close?.(); }
    return out;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
