// `poly journal verify | replay | export` (PT14, PF8.6, S131).
//
//   poly journal verify --db <store> --trust <keyId>=<public key file> … [--run <id>]
//   poly journal replay --db <store> --build <.poly/build> --certificate <file> --trust <keyId>=<file> … [--run <id>]
//   poly journal export --db <store> --run <id>
//
// verify needs no certificate: the chain, the signed heads, the closure and the binding to the journal are the
// ledger's own (PL9002 for each problem). replay loads the certified build, so it refuses a tampered artefact as
// the runtime does, and reports every divergence as PL9001.
import { readFileSync } from 'node:fs';
import { diag, EXIT_CODES, type Diagnostic } from '@poly/core';
import { load, openJournal, verifyRun } from '@poly/runtime';
import { replayRuntime } from './replay.js';

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
        const v = verifyRun(await store.chain(r.run), await store.heads(r.run), trust, await store.journal(r.run));
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
      let n = 0;
      for (const r of runs) {
        write(`${r.run} (${r.machine}): ${r.rows} rows folded by poly-ref, ${r.windows} windows replayed by polygraph${r.diagnostics.length ? '' : ', reproduced'}\n`);
        for (const d of r.diagnostics) { n++; write(`  ${d.code} ${d.name}  ${d.message}\n`); }
      }
      write(`replay: ${runs.length} run(s), ${n ? 'FINDINGS' : 'every post-state reproduced'}\n`);
      return n ? EXIT_CODES.FINDINGS : EXIT_CODES.CLEAN;
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
  throw new JournalUsageError(`poly journal ${sub}: expected verify, replay or export`);
}
