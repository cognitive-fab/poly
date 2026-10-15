// `poly witness <id> --trace | --test` (PT12.4, S68, S69, S74).
//
// A witness is found in the last report by its id, the digest of { moduleDigest, subject, property, trace } (S69, S86).
// --trace writes it as {pre, action, data, post} windows, with the cycle's index for a lasso.
// --test writes a host test that walks the witness through the lowered artefacts (S68: the runtime API
// arrives in M4) and asserts the violated predicate; the walking is done by witness-runtime.ts, which the
// test imports, so every exported test shares one tested implementation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Diagnostic } from '@poly/core';
import { walkRoute, type WitnessSpec } from './witness-runtime.js';

interface FileReport { file: string; module: string | null; moduleDigest?: string; machines: { machine: string; diagnostics: Diagnostic[] }[]; configurations?: { configuration: string; diagnostics: Diagnostic[] }[] }

export interface FoundWitness {
  report: FileReport;
  machine: string | null;
  configuration: string | null;
  diagnostic: Diagnostic;
}

/** The witness with this id (or an unambiguous prefix of at least 12 hex digits) in a file or project report. */
export function findWitness(report: unknown, id: string): FoundWitness | null {
  const r = lookupWitness(report, id);
  return 'found' in r ? r.found : null;
}

/** As findWitness, with the reason when there is none: a malformed id, no match, or an ambiguous prefix (review D9). */
export function lookupWitness(report: unknown, id: string): { found: FoundWitness } | { reason: string } {
  if (!/^(sha256:)?[0-9a-f]{12,64}$/.test(id)) return { reason: `${id || '(empty)'} is not a witness id: give the id, or at least its first 12 hex digits` };
  const files = ((report as { files?: FileReport[] }).files ?? [report as FileReport]);
  const want = id.startsWith('sha256:') ? id : `sha256:${id}`;
  const hits: FoundWitness[] = [];
  for (const r of files) {
    for (const m of r.machines ?? []) for (const d of m.diagnostics) if (d.witness?.id?.startsWith(want)) hits.push({ report: r, machine: m.machine, configuration: null, diagnostic: d });
    for (const c of r.configurations ?? []) for (const d of c.diagnostics) if (d.witness?.id?.startsWith(want)) hits.push({ report: r, machine: null, configuration: c.configuration, diagnostic: d });
  }
  if (!hits.length) return { reason: `no witness ${id} in the report` };
  if (hits.some((h) => h.diagnostic.witness!.id !== hits[0].diagnostic.witness!.id)) return { reason: `${id} is the prefix of several witnesses; give more of the id` };
  return { found: hits[0] };
}

/** The exported spec a test walks (S68). */
export function witnessSpec(found: FoundWitness, root: string): WitnessSpec {
  const d = found.diagnostic;
  return {
    id: d.witness!.id,
    code: d.code,
    property: d.property ?? null,
    source: resolve(found.report.file),
    buildRoot: resolve(root),
    module: found.report.module!,
    machine: found.machine,
    configuration: found.configuration,
    member: (d as Diagnostic & { member?: number }).member ?? null,
    cycle: d.witness!.cycle ?? null,
    steps: d.witness!.trace.map((s) => ({ action: s.action, data: s.data as Record<string, unknown>, verdict: s.verdict ?? 'accepted', ...(s.global ? { global: s.global } : {}) })),
  };
}

/** The codes an exported test can judge: a machine's through its lowered module, a configuration's through its machines'. */
const JUDGED = {
  machine: new Set(['PL3001', 'PL3002', 'PL3003', 'PL3102', 'PL3901', 'PL3201', 'PL3301', 'PL4001', 'PL4002', 'PL6201', 'PL6203', 'PL4003']),
  configuration: new Set(['PL5401', 'PL5402', 'PL5404', 'PL3301', 'PL5101']),
};

/** Whether an exported test can judge a witness of this code, about a machine or about a configuration. */
export function exportable(code: string, configuration: boolean): boolean {
  return JUDGED[configuration ? 'configuration' : 'machine'].has(code);
}

/** A witness no exported test can judge yet (review D1): it is refused, never exported as a test that passes. */
export class WitnessExportError extends Error {}

export function exportWitness(found: FoundWitness, opts: { root: string; kind: 'trace' | 'test'; out?: string }): string {
  const d = found.diagnostic;
  if (opts.kind === 'test' && !JUDGED[found.configuration ? 'configuration' : 'machine'].has(d.code)) {
    throw new WitnessExportError(`${d.code} has no exported test yet: the joint machine or the bound it is about is not walked by one; export its trace with --trace (PT12.4)`);
  }
  const short = d.witness!.id.slice('sha256:'.length, 'sha256:'.length + 12);
  const out = resolve(opts.out ?? join(opts.root, '.poly', 'witness', `${short}.${opts.kind === 'trace' ? 'trace.json' : 'test.mjs'}`));
  mkdirSync(dirname(out), { recursive: true });
  if (opts.kind === 'trace') {
    const windows = d.witness!.trace.map((s) => ({ pre: s.pre, action: s.action, data: s.data, post: s.post, ...(s.verdict ? { verdict: s.verdict } : {}) }));
    writeFileSync(out, JSON.stringify({ id: d.witness!.id, code: d.code, property: d.property ?? null, moduleDigest: found.report.moduleDigest, ...(d.witness!.cycle !== undefined ? { cycle: d.witness!.cycle } : {}), windows }, null, 2) + '\n');
    return out;
  }
  const runtime = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'witness-runtime.js')).href;
  const spec = witnessSpec(found, opts.root);
  // S139, S141: the header says which way the test walks; one through the artefacts is not a runtime-API test.
  const route = walkRoute(spec);
  const how = route === 'runtime'
    ? [`// through the runtime API, under a witness certificate (S139), and asserts the violated predicate: it fails`, `// while the defect is there, and`]
    : [`// through the certified lowered artefacts, ${route === 'configuration' ? 'since the runtime cannot start instances from a configuration\'s initial values' : 'since the machine spawns children, which the runtime would run itself'};`, `// it is not a test through the runtime API (S141). It asserts the violated predicate: it fails while the defect is there, and`];
  writeFileSync(out, [
    `// Generated by poly witness ${short} --test (PT12.4, S68). It walks the witness of ${d.code}${d.property ? ` ${d.property}` : ''}`,
    ...how,
    `// passes once the program no longer takes the path or no longer breaks the predicate. It refuses a build`,
    `// that is not the build of the source as it is now: run poly check first.`,
    `import { test } from 'node:test';`,
    `import { runWitness } from ${JSON.stringify(runtime)};`,
    ``,
    `const spec = ${JSON.stringify(spec, null, 2)};`,
    ``,
    `test(${JSON.stringify(`witness ${short}: ${d.code}${d.property ? ` ${d.property}` : ''}`)}, async () => {`,
    `  await runWitness(spec);`,
    `});`,
    ``,
  ].join('\n'));
  return out;
}
