// `poly fix <id>` (PT12.1, S69, S70): finds the fix in the last report and applies it to the source as it
// is now, or refuses it with PL0201 STALE_FIX. A refused fix leaves the file as it was.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Diagnostic, Fix } from '@poly/core';
import { applyFix } from './fixes.js';

export interface FixResult { status: 'applied' | 'refused'; file?: string; code?: string; message: string }

interface FileReport { file: string; diagnostics?: Diagnostic[]; machines?: { diagnostics: Diagnostic[] }[]; configurations?: { diagnostics: Diagnostic[] }[] }

/** The fix with this id, and the file it is for. */
export function findFix(report: unknown, id: string): { file: string; fix: Fix } | null {
  const files = (report as { files?: FileReport[] }).files ?? [report as FileReport];
  for (const r of files) {
    const all = [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
    for (const d of all) for (const f of d.fixes ?? []) if (f.id === id) return { file: r.file, fix: f };
  }
  return null;
}

export function applyFixById(report: unknown, id: string): FixResult {
  const found = findFix(report, id);
  if (!found) return { status: 'refused', message: `no fix ${id} in the report` };
  if (!found.file.endsWith('.poly')) return { status: 'refused', message: `fixes apply to the standalone surface only (S70); ${found.file} is not a .poly file` };
  const r = applyFix(readFileSync(found.file, 'utf8'), found.fix);
  if (r.status === 'refused') return { status: 'refused', file: found.file, code: r.code, message: r.message };
  writeFileSync(found.file, r.text);
  return { status: 'applied', file: found.file, message: `applied ${id}` };
}
