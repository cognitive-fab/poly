// `poly journal verify | replay | export` (PT14, PF8.6, S131).
//
//   poly journal verify --db <store> --trust <keyId>=<public key file> … [--run <id>]
//   poly journal replay --db <store> --build <.poly/build> --certificate <file> --trust <keyId>=<file> … [--run <id>]
//   poly journal export --db <store> --run <id>
//
// verify needs no certificate: the chain, the signed heads, the closure and the binding to the journal are the
// ledger's own (PL9002 for each problem). replay loads the certified build, so it refuses a tampered artefact as
// the runtime does, and reports every divergence as PL9001.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diag, EXIT_CODES, type Diagnostic } from '@poly/core';
import type { JournalReader, Provider } from '@poly/runtime';
import { evaluate, fit } from './evaluate.js';
import { replayRuntime, replaySessions } from './replay.js';

export class JournalUsageError extends Error {}

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}
const one = (args: string[], name: string): string | undefined => values(args, name)[0];

function trustOf(args: string[]): Record<string, string> {
  return Object.fromEntries(values(args, '--trust').map((t) => {
    const eq = t.indexOf('=');
    if (eq <= 0) throw new JournalUsageError(`--trust takes <keyId>=<public key file>, not ${t}`);
    return [t.slice(0, eq), readFileSync(t.slice(eq + 1), 'utf8')];
  }));
}

export async function journalCommand(sub: string, args: string[], write: (s: string) => void): Promise<number> {
  // The runtime is loaded only here, so `poly check` and its tests run in a toolchain without it.
  const { load, openJournal, verifyRun, ledgerProblems } = await import('@poly/runtime');
  const db = one(args, '--db');
  if (!db) throw new JournalUsageError('poly journal needs --db <store>');
  const only = one(args, '--run');
  if (sub === 'verify') {
    const store = openJournal(db);
    try {
      const trust = trustOf(args);
      const runs = (await store.runs()).filter((r) => !only || r.run === only);
      if (only && !runs.length) throw new JournalUsageError(`no run ${only} in ${db}`);
      const found: Diagnostic[] = [];
      for (const r of runs) {
        const heads = await store.heads(r.run);
        const v = verifyRun(await store.chain(r.run), heads, trust, await store.journal(r.run));
        const all = await store.anchors();
        // Review B1: a run must be signed, and covered by the latest anchor at its latest signed head.
        v.problems.push(...ledgerProblems(r.run, heads, all.length ? all[all.length - 1] : null, trust));
        write(`${r.run} (${r.wf}): ${v.verdict}${v.signedThrough !== null ? `, signed through seq ${v.signedThrough}` : ''}${v.unsignedTail ? `, ${v.unsignedTail} event(s) not yet signed` : ''}\n`);
        for (const p of v.problems) { const d = diag('PL9002', { module: r.ns, machine: r.wf.slice(r.wf.indexOf('.') + 1) }, `run ${r.run}: ${p}`); found.push(d); write(`  ${d.code} ${d.name}  ${d.message}\n`); }
      }
      write(`journal: ${runs.length} run(s), ${found.length ? 'FINDINGS' : 'verified'}\n`);
      return found.length ? EXIT_CODES.FINDINGS : EXIT_CODES.CLEAN;
    } finally { await store.close(); }
  }
  if (sub === 'replay') {
    const build = one(args, '--build');
    const certificate = one(args, '--certificate');
    if (!build || !certificate) throw new JournalUsageError('poly journal replay needs --build and --certificate');
    const rt = await load(build, { certificate, trust: trustOf(args), store: { sqlite: db } });
    try {
      const runs = await replayRuntime(rt, only ? { runs: [only] } : {});
      if (only && !runs.length) throw new JournalUsageError(`no run ${only} in ${db}`);
      let n = 0;
      let notRun = 0;
      for (const r of runs) {
        if (r.notRun) { notRun++; write(`${r.run} (${r.machine}): ${r.notRun} (not run)\n`); continue; }
        write(`${r.run} (${r.machine}): ${r.rows} rows folded by poly-ref, ${r.windows} windows replayed by polygraph${r.diagnostics.length ? '' : ', reproduced'}\n`);
        for (const d of r.diagnostics) { n++; write(`  ${d.code} ${d.name}  ${d.message}\n`); }
        if (r.gateNotRun) { notRun++; write(`  ${r.gateNotRun} gate decision(s) recorded, not replayed: no gate was given (not run)\n`); }
        // PD2.2d, S131: every decision completion links its decision event, with the data it records.
        for (const p of await rt.verifyProvenance(r.run)) { n++; const d = diag('PL9003', { machine: r.machine }, `run ${r.run}: ${p}`); write(`  ${d.code} ${d.name}  ${d.message}\n`); }
      }
      // S118, S146: the gate's sessions, each replayed in sseq order: every decision and Σ digest reproduced (AC6).
      for (const s of only ? [] : await replaySessions(rt)) {
        write(`session ${s.session}: ${s.proposals} decision(s) and ${s.settles} settle(s) replayed in sseq order${s.diagnostics.length || s.notRun.length ? '' : ', every decision and Σ digest reproduced'}\n`);
        for (const d of s.diagnostics) { n++; write(`  ${d.code} ${d.name}  ${d.message}\n`); }
        for (const x of s.notRun) { notRun++; write(`  ${x} (not run)\n`); }
      }
      if (only && rt.policyGate) { notRun++; write('  the gate sessions are replayed only with every run (not run with --run)\n'); }
      write(`replay: ${runs.length} run(s), ${n ? 'FINDINGS' : notRun ? 'every replayed post-state reproduced, and some of the replay not run' : 'every post-state reproduced'}\n`);
      return n ? EXIT_CODES.FINDINGS : notRun ? EXIT_CODES.INCONCLUSIVE : EXIT_CODES.CLEAN;
    } finally { await rt.close(); }
  }
  if (sub === 'export') {
    if (!only) throw new JournalUsageError('poly journal export needs --run <id>');
    const store = openJournal(db);
    try {
      const events = await store.chain(only);
      if (!events.length) throw new JournalUsageError(`no run ${only} in ${db}`);
      const bodies: Record<string, unknown> = {};
      for (const e of events) if (e.kind === 'step') for (const k of ['data', 'pre', 'post']) { const d = (e.body as Record<string, string>)[k]; bodies[d] = await store.body(d); }
      write(JSON.stringify({ events, heads: await store.heads(only), bodies }, null, 2) + '\n');
      return EXIT_CODES.CLEAN;
    } finally { await store.close(); }
  }
  if (sub === 'eval' || sub === 'fit') {
    const decision = one(args, '--decision');
    if (!decision) throw new JournalUsageError(`poly journal ${sub} needs --decision <name>`);
    const store = openJournal(db);
    try {
      const before = await heads(store);
      if (sub === 'eval') {
        const candidatePath = one(args, '--candidate');
        if (!candidatePath) throw new JournalUsageError('poly journal eval needs --candidate <provider module>');
        // The operator's provider, recorded in tests (S132); poly imports no model SDK, and the result changes no verdict (PD3.3).
        const mod = await import(pathToFileURL(resolve(candidatePath)).href) as { default: Provider };
        const r = await evaluate(store, decision, mod.default);
        write(JSON.stringify(r, null, 2) + '\n');
      } else {
        const model = one(args, '--model');
        const version = Number(one(args, '--version') ?? '1');
        if (!model) throw new JournalUsageError('poly journal fit needs --model <model id>');
        const map = await fit(store, decision, model, version);
        const out = one(args, '--out');
        if (out) writeFileSync(out, JSON.stringify(map, null, 2) + '\n'); else write(JSON.stringify(map, null, 2) + '\n');
      }
      // PD2.4b: evaluation and fitting read the chains and write to none of them.
      if (JSON.stringify(await heads(store)) !== JSON.stringify(before)) throw new Error(`poly journal ${sub} changed a chain, which it must never do`);
      return EXIT_CODES.CLEAN;
    } finally { await store.close(); }
  }
  throw new JournalUsageError(`poly journal ${sub}: expected verify, replay, export, eval or fit`);
}

async function heads(store: JournalReader): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const r of await store.runs()) { const c = await store.chain(r.run); out[r.run] = c.at(-1)?.hash ?? null; }
  return out;
}
