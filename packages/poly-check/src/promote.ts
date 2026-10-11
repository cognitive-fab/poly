// `poly promote` (PF4.4, PF4.5, PS20.4, PS20.5, PS8.6, PT30.5, PT30.9, S511 to S513): a rule that a person adjudicated
// `real` is added to the program's sources as the candidate's own text, preceded by a marker line, and the project is
// checked. A promotion that makes a mandate undischargeable (`PL6501`), or that does not parse or type, is refused and
// the sources are left as they were. A promotion that leaves another finding (a path property the machine violates)
// stays: the person said the rule is real, and the finding is the news. Never offered over MCP.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { adjudicationSubject, EXIT_CODES, keyringsOf, loadProject, readAnchor, recordDigest, verifyRecord } from '@poly/core';
import { parse } from '@poly/lang';
import { AdmitError } from './admit.js';
import { projectAnchorId, readCandidates } from './adjudicate.js';
import { checkProject } from './pipeline.js';

/** A usage error: the command lacks something it needs (exit 64), as against a refusal of a promotion (exit 2). */
export class PromoteUsageError extends Error {}

export interface PromoteOptions { project: string; candidates: string; adjudications: string[]; scope?: string }
export interface PromoteResult { exit: number; promoted: { id: string; file: string; entry: string }[]; lines: string[] }

const sha = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

/** The index of the brace that closes the one at `open`, skipping strings and comments; -1 when there is none. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Inserts the lines before the line of the closing brace, indented two spaces deeper than it. */
function insertBeforeClose(text: string, close: number, lines: string[]): { text: string; block: string[] } {
  const lineStart = text.lastIndexOf('\n', close - 1) + 1;
  const before = text.slice(lineStart, close);
  if (!/^[ \t]*$/.test(before)) throw new AdmitError('the block\'s closing brace shares its line with other text, so a promotion cannot be inserted before it');
  const indent = before + '  ';
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const block = lines.map((l) => (l.length ? indent + l : l));
  return { text: text.slice(0, lineStart) + block.map((l) => l + nl).join('') + text.slice(lineStart), block };
}

function sourcesOf(project: string): string[] {
  return loadProject(project).files.filter((f) => f.endsWith('.poly'));
}

/** Where a candidate's text goes: the file, and the insertion of its lines into the file's text. */
function place(project: string, c: Record<string, unknown>, scope: string | undefined): { file: string; edit: (text: string, lines: string[]) => { text: string; block: string[] } } {
  const form = c.form as string;
  const machine = (c.target as { machine?: string } | undefined)?.machine ?? '';
  if (form === 'path-property') {
    const [mod, name] = [machine.slice(0, machine.indexOf('.')), machine.slice(machine.indexOf('.') + 1)];
    for (const file of sourcesOf(project)) {
      const text = readFileSync(file, 'utf8');
      if (parse(text).module?.name !== mod) continue;
      const m = new RegExp(`(^|\\s)machine\\s+${name}\\b[^{]*\\{`, 'm').exec(text);
      if (!m) continue;
      const open = m.index + m[0].length - 1;
      return { file, edit: (t, lines) => { const close = closeOf(t, open); if (close < 0) throw new AdmitError(`the machine ${machine} has no closing brace`); return insertBeforeClose(t, close, lines); } };
    }
    throw new AdmitError(`no source of the project declares the machine ${machine}, which the candidate names`);
  }
  if (form === 'policy-rule') {
    if (!scope) throw new PromoteUsageError('promote needs --scope <scope> to promote a policy rule: the policy scope that receives it');
    for (const file of sourcesOf(project)) {
      const text = readFileSync(file, 'utf8');
      const re = /\bpolicy\s+[\w-]+\s*\{/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const open = m.index + m[0].length - 1;
        const close = closeOf(text, open);
        if (close < 0) continue;
        if (new RegExp(`\\bscope\\s+"${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(text.slice(open, close))) {
          return { file, edit: (t, lines) => { const cl = closeOf(t, open); if (cl < 0) throw new AdmitError('the policy has no closing brace'); return insertBeforeClose(t, cl, lines); } };
        }
      }
    }
    throw new AdmitError(`no policy of the scope "${scope}" in the project`);
  }
  throw new AdmitError(`the candidate has the form ${String(form)}, which this release does not promote`);
}

/** Every diagnostic in a report, wherever it sits. */
function diagnosticsOf(x: unknown, out: { code: string; severity?: string; message: string }[] = [], seen = new Set<unknown>()): { code: string; severity?: string; message: string }[] {
  if (!x || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  if (Array.isArray(x)) { for (const y of x) diagnosticsOf(y, out, seen); return out; }
  const o = x as Record<string, unknown>;
  if (typeof o.code === 'string' && /^PL\d{4}$/.test(o.code) && typeof o.message === 'string') out.push({ code: o.code, severity: o.severity as string | undefined, message: o.message });
  for (const v of Object.values(o)) diagnosticsOf(v, out, seen);
  return out;
}
const key = (d: { code: string; message: string }) => `${d.code} ${d.message}`;

export async function promote(o: PromoteOptions): Promise<PromoteResult> {
  const project = o.project;
  const { manifest } = loadProject(project);
  const rings = keyringsOf(project, manifest);
  const anchorId = projectAnchorId(project);
  const anchor = readAnchor(project, manifest.name);
  const { candidates, doc } = readCandidates(o.candidates);
  const lines: string[] = [];
  const promoted: PromoteResult['promoted'] = [];
  const dir = join(project, 'promotions');
  const existing = () => (existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{4}-.+\.json$/.test(f)).sort() : []);
  let exit: number = EXIT_CODES.CLEAN;

  for (const file of o.adjudications) {
    if (!existsSync(file)) throw new AdmitError(`${file}: no such adjudication file`);
    let adj: { v?: number; kind?: string; candidate?: string; id?: string; verdict?: string; record?: unknown };
    try { adj = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new AdmitError(`${file} is not JSON`); }
    if (adj?.kind !== 'poly.adjudication' || adj.v !== 1) throw new AdmitError(`${file} is not a poly.adjudication file of version 1 (PT30.4)`);
    const c = candidates.find((x) => x.id === adj.id);
    if (!c) throw new AdmitError(`the adjudication ${file} is for the candidate ${String(adj.id)}, which ${o.candidates} does not have`);
    if (c.digest !== adj.candidate) throw new AdmitError(`the adjudication of ${String(adj.id)} names the candidate ${String(adj.candidate)}, and the candidate in ${o.candidates} has the digest ${String(c.digest)}: it was judged as another candidate (PS20.1)`);
    // PS20.3: the record is a person's, for this project, this candidate and this verdict.
    const v = verifyRecord(adj.record, rings, { kind: 'adjudication', subject: adjudicationSubject(anchorId, c.digest as string, String(adj.verdict)) });
    if (!v.ok) throw new AdmitError(`the adjudication of ${String(adj.id)} does not verify: ${v.problem}`);
    if (adj.verdict !== 'real') throw new AdmitError(`the adjudication of ${String(adj.id)} is ${String(adj.verdict)}: only a real verdict reaches a program (PS20.3)`);
    if (c.promotable !== true) throw new AdmitError(`the candidate ${String(adj.id)} is not promotable: ${String(c.reason ?? 'no reason given')}`);
    const corpus = doc.corpus as { digest: string; kind: string };
    if (corpus.kind === 'synthetic' && anchor?.source !== 'test') throw new AdmitError(`the candidate ${String(adj.id)} was mined from a synthetic corpus, which only a test certificate may cite (PS20.5)`);
    for (const f of existing()) if ((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id?: string }).id === adj.id) throw new AdmitError(`the candidate ${String(adj.id)} is already promoted (${f})`);

    // The edit, kept so it can be undone.
    const where = place(project, c, o.scope);
    const original = readFileSync(where.file, 'utf8');
    const record = recordDigest(adj.record as never);
    const inserted = [`// promoted: ${String(adj.id)} ${record}`, ...String(c.source).split('\n')];
    const baseline = new Set(diagnosticsOf(await checkProject(project)).filter((d) => d.severity === 'error' || d.code === 'PL6501').map(key));
    const next = existing().length + 1;
    const entry = join(dir, `${String(next).padStart(4, '0')}-${String(adj.id)}.json`);
    const undo = () => { writeFileSync(where.file, original); rmSync(entry, { force: true }); if (existing().length === 0) rmSync(dir, { recursive: true, force: true }); };
    try {
      const edited = where.edit(original, inserted);
      writeFileSync(where.file, edited.text);
      mkdirSync(dir, { recursive: true });
      const text = edited.block.join('\n');
      writeFileSync(entry, JSON.stringify({ candidate: c.digest, id: adj.id, adjudication: adj, tool: doc.tool, corpus, inserted: { file: relative(project, where.file).split(sep).join('/'), text, digest: sha(text) } }, null, 2) + '\n');
      const after = diagnosticsOf(await checkProject(project));
      const fresh = after.filter((d) => (d.severity === 'error' || d.code === 'PL6501') && !baseline.has(key(d)));
      if (fresh.length) {
        undo();
        const first = fresh.find((d) => d.code === 'PL6501') ?? fresh[0];
        throw new AdmitError(`${first.code} ${first.message}\n  the promotion of ${String(adj.id)} (record ${record}) is refused and the sources are as they were`);
      }
      const findings = after.filter((d) => d.severity === 'finding' && !baseline.has(key(d)));
      lines.push(`promoted ${String(adj.id)} into ${relative(project, where.file).split(sep).join('/')} (${relative(project, entry).split(sep).join('/')})`);
      for (const f of findings) lines.push(`  ${f.code} ${f.message}`);
      if (findings.length) exit = EXIT_CODES.FINDINGS;
      promoted.push({ id: String(adj.id), file: relative(project, where.file).split(sep).join('/'), entry: relative(project, entry).split(sep).join('/') });
    } catch (e) {
      if (existsSync(entry) || readFileSync(where.file, 'utf8') !== original) undo();
      throw e;
    }
  }
  return { exit, promoted, lines };
}
