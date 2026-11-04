// PT34.3, S586, written from the specification and sharing no code with the compiler: the certificate's `poly.risk` read
// back against the sources. Every policy item of every scope is listed under `<policy>.<item>`, with its scope, its kind
// and its tags as written (sorted, without repeats); each catalog with its version and the digest std/PINS.json pins
// for it; the exposure as poly.json declares it.
import type { Module } from '@poly/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES: Record<string, string> = { iso: 'iso-42001.json', mit: 'mit-ai-risk.json', nist: 'nist-ai-rmf.json' };
const KINDS: Record<string, string> = { RuleObligation: 'rule', MachineObligation: 'machine', InvariantObligation: 'invariant', Recalled: 'recalled', Never: 'never' };

/** What `poly.risk` must hold for these sources, exposure and std. */
export function expectedRisk(program: readonly Module[], exposure: readonly string[] | undefined, std: string): unknown {
  const pins = (JSON.parse(readFileSync(join(std, 'PINS.json'), 'utf8')) as { files: Record<string, string> }).files;
  const catalogs = Object.keys(FILES).sort().map((c) => {
    const doc = JSON.parse(readFileSync(join(std, 'catalogs', FILES[c]), 'utf8')) as { catalog: string; version: string };
    return { catalog: doc.catalog, version: doc.version, digest: pins[`catalogs/${FILES[c]}`] };
  });
  const tags = (xs: { tag: string }[] | undefined) => Array.from(new Set((xs ?? []).map((x) => x.tag))).sort();
  const items: Record<string, unknown> = {};
  for (const m of program) for (const d of m.decls) {
    if (d.kind !== 'Policy') continue;
    for (const it of d.items) items[`${d.name}.${it.name}`] = { scope: d.scope, kind: KINDS[it.kind], risks: tags(it.mitigates), controls: tags(it.implements) };
  }
  return { catalogs, exposure: Array.from(new Set(exposure ?? [])).sort(), items };
}

/** The differences between a certificate's `poly.risk` and the sources', each a sentence; empty when they agree. */
export function riskProblems(risk: unknown, program: readonly Module[], exposure: readonly string[] | undefined, std: string): string[] {
  const want = expectedRisk(program, exposure, std) as { catalogs: unknown; exposure: unknown; items: Record<string, unknown> };
  const got = (risk ?? {}) as { catalogs?: unknown; exposure?: unknown; items?: Record<string, unknown> };
  const out: string[] = [];
  if (JSON.stringify(got.catalogs) !== JSON.stringify(want.catalogs)) out.push(`poly.risk names the catalogs ${JSON.stringify(got.catalogs)}, and std pins ${JSON.stringify(want.catalogs)} (PT34.3)`);
  if (JSON.stringify(got.exposure) !== JSON.stringify(want.exposure)) out.push(`poly.risk names the exposure ${JSON.stringify(got.exposure)}, and poly.json declares ${JSON.stringify(want.exposure)} (PT34.3)`);
  const ids = Array.from(new Set([...Object.keys(got.items ?? {}), ...Object.keys(want.items)])).sort();
  for (const id of ids) {
    const g = JSON.stringify((got.items ?? {})[id] ?? null);
    const w = JSON.stringify(want.items[id] ?? null);
    if (g !== w) out.push(`poly.risk records ${id} as ${g}, and its source as ${w} (PT34.3)`);
  }
  return out;
}
