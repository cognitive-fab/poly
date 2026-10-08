// `poly edit-check` and `poly_edit_check` (PT28.4, PT10h, S313): an edit is checked in memory, and the reply is short
// by construction: the verdict, each diagnostic's code and place, each finding's witness in brief, and the path of the
// full report. The edit is written only with apply, after the check ran, and only when its verdict is neither REFUSED,
// ERROR nor NONDETERMINISM. It calls the check alone: it never admits, signs or runs anything (PT28.4d).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadProject, toJson, type Diagnostic, type Module } from '@poly/core';
import { parse } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkFile, type CheckReport } from './pipeline.js';

export interface EditCheckInput {
  module: string;
  /** A replacement of exact text, which must occur exactly once. */
  old?: string;
  new?: string;
  /** Or the whole file. */
  text?: string;
  /** PT28.4a's configuration: the project whose poly.json names the program the module is checked with. */
  project?: string;
  apply?: boolean;
}

export interface EditCheckReply {
  status: 'checked' | 'refused';
  module: string;
  reason?: string;
  verdict?: string;
  exit?: number;
  findings?: { code: string; severity: string; line: number | null; col: number | null; machine: string | null; witness?: { id: string; length: number; actions: string[] } }[];
  report?: string;
  written: boolean;
}

const all = (r: CheckReport): Diagnostic[] => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics), ...(r.policies ?? []).flatMap((p) => p.diagnostics)];

export async function editCheck(input: EditCheckInput): Promise<EditCheckReply> {
  const file = resolve(input.module);
  const refused = (reason: string): EditCheckReply => ({ status: 'refused', module: file, reason, written: false });
  if (!existsSync(file)) return refused(`no such module ${file}`);
  const before = readFileSync(file, 'utf8');
  // Review D2: the target is a module, never poly.json, a certificate or a key; with a project, one of its modules.
  if (!file.endsWith('.poly') && !(file.endsWith('.ts') && readEmbedded(before, file).module)) return refused(`${file} is not a module: a .poly file, or a .ts file that holds one`);
  if (input.project && !loadProject(resolve(input.project)).files.some((f) => resolve(f) === file)) return refused(`${file} is not a module of the project ${resolve(input.project)}`);
  let after: string;
  if (typeof input.text === 'string') {
    if (input.old !== undefined || input.new !== undefined) return refused('an edit is old and new, or text, not both');
    after = input.text;
  } else {
    if (typeof input.old !== 'string' || typeof input.new !== 'string' || !input.old) return refused('an edit is old and new (a replacement of exact text), or text (the whole file)');
    const at = before.indexOf(input.old);
    if (at < 0) return refused('the old text does not occur in the module');
    if (before.indexOf(input.old, at + 1) >= 0) return refused('the old text occurs more than once in the module');
    after = before.slice(0, at) + input.new + before.slice(at + input.old.length);
  }
  const base = input.project ? resolve(input.project) : dirname(file);
  const work = join(base, '.poly', 'edit-check');
  mkdirSync(work, { recursive: true });
  // S176: with a project, the module is checked in the program its poly.json names, with the edited text in place.
  let program: Module[] | undefined;
  let programFiles: { file: string; module: Module }[] | undefined;
  if (input.project) {
    const { files } = loadProject(base);
    programFiles = [];
    for (const f of files) {
      const text = resolve(f) === file ? after : readFileSync(f, 'utf8');
      const m = (f.endsWith('.ts') ? readEmbedded(text, f) : parse(text)).module;
      if (m) programFiles.push({ file: f, module: m });
    }
    program = programFiles.map((x) => x.module);
  }
  const r = await checkFile(file, { root: join(work, 'build'), text: after, ...(program ? { program, programFiles } : {}) });
  const id = createHash('sha256').update(after, 'utf8').digest('hex').slice(0, 16);
  const report = join(work, `${id}.json`);
  writeFileSync(report, JSON.stringify({ ...r, diagnostics: r.diagnostics.map(toJson), machines: r.machines.map((m) => ({ ...m, diagnostics: m.diagnostics.map(toJson) })) }, null, 2) + '\n');
  const findings = all(r).map((d) => ({
    code: d.code, severity: d.severity, line: d.at.line ?? null, col: d.at.col ?? null, machine: d.at.machine ?? null,
    ...(d.witness ? { witness: { id: d.witness.id, length: d.witness.length, actions: d.witness.trace.map((s) => s.action) } } : {}),
  }));
  // PT28.4c, S313: written only when asked, after the check, and never when the edit does not check.
  const written = input.apply === true && !['REFUSED', 'ERROR', 'NONDETERMINISM'].includes(r.verdict);
  if (written) writeFileSync(file, after);
  return { status: 'checked', module: file, verdict: r.verdict, exit: r.exit, findings, report, written };
}
