// Seeded defects (PT14a): `poly check <file> --defects <file> [--only a,b]`. Each defect is a list of find-and-replace
// edits that seeds one fault, with the finding the check must then report. The edits are applied in memory and the
// patched program is checked through the cache, so a machine the patch leaves alone is read back and only the machine it
// changes, and the configurations it keeps, are checked. A defect the check no longer finds means a property no longer
// sees the fault it was written for. The format is the one agentapp's defects/defects.json already has.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from '@poly/lang';
import type { Diagnostic } from '@poly/core';
import { checkFile, type CheckReport } from './pipeline.js';
import { CheckUsageError } from './goals.js';

export interface DefectSpec {
  name: string;
  note?: string;
  /** `FINDING PLxxxx`, or `CLEAN`. */
  expected: string;
  /** The property the expected finding names. */
  finding?: string;
  /** The configurations the defect is checked in; none when empty. */
  keep: string[];
  edits: { find: string; replace: string }[];
}

export interface DefectResult {
  name: string;
  expected: string;
  finding?: string;
  found: boolean;
  verdict: CheckReport['verdict'];
  /** Every diagnostic of the patched program's check. */
  findings: Diagnostic[];
  error?: string;
}

/** Reads a defects file, a JSON array of { name, note, expected, finding, keep, edits: [{ find, replace }] }. */
export function readDefects(file: string): DefectSpec[] {
  let list: unknown;
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new CheckUsageError(`the defects file ${file} is not JSON: ${(e as Error).message}`); }
  if (!Array.isArray(list)) throw new CheckUsageError(`the defects file ${file} is not an array of defects`);
  const names = new Set<string>();
  return list.map((x: Record<string, unknown>, i) => {
    const name = x?.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new CheckUsageError(`defect ${i + 1} of ${file} has no name of letters, digits, _, . or -`);
    if (names.has(name)) throw new CheckUsageError(`defect ${name} is named twice`);
    names.add(name);
    const expected = x.expected;
    if (typeof expected !== 'string' || !/^(CLEAN|FINDING PL\d{4})$/.test(expected)) throw new CheckUsageError(`defect ${name}: expected is "CLEAN" or "FINDING PLxxxx"`);
    if (expected !== 'CLEAN' && (typeof x.finding !== 'string' || !x.finding)) throw new CheckUsageError(`defect ${name}: a FINDING names its property in finding`);
    const keep = x.keep ?? [];
    if (!Array.isArray(keep) || keep.some((k) => typeof k !== 'string')) throw new CheckUsageError(`defect ${name}: keep is a list of configuration names`);
    const edits = x.edits;
    if (!Array.isArray(edits) || !edits.length || edits.some((e) => typeof e?.find !== 'string' || typeof e?.replace !== 'string')) throw new CheckUsageError(`defect ${name}: edits is a non-empty list of { find, replace }`);
    return { name, ...(typeof x.note === 'string' ? { note: x.note } : {}), expected, ...(typeof x.finding === 'string' ? { finding: x.finding } : {}), keep: keep as string[], edits: edits as DefectSpec['edits'] };
  });
}

/** The source with a defect's edits applied; an edit found other than once, or that changes nothing, is a usage error. */
export function applyDefect(src: string, d: DefectSpec): string {
  let out = src;
  for (const { find, replace } of d.edits) {
    if (find === replace) throw new CheckUsageError(`defect ${d.name}: an edit replaces its text with itself, which seeds no fault`);
    const n = out.split(find).length - 1;
    if (n !== 1) throw new CheckUsageError(`defect ${d.name}: the text to replace is found ${n} times, not once:\n${find}`);
    const at = out.indexOf(find);
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every diagnostic of a report: the file's, each machine's, each configuration's, each policy scope's. */
export function allDiagnostics(r: CheckReport): Diagnostic[] {
  return [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics), ...(r.policies ?? []).flatMap((p) => p.diagnostics)];
}

/**
 * Whether a check found the defect: the expected code on the named property (what the finding is about: its property,
 * field or machine), and nothing else but a bound (PL3901, PL5301), since a fault that makes a counter run away also
 * leaves the range the check was run within. CLEAN expected: the verdict is CLEAN.
 */
export function judgeDefect(r: CheckReport, d: DefectSpec): boolean {
  if (r.verdict === 'ERROR' || r.verdict === 'NONDETERMINISM') return false;
  if (d.expected === 'CLEAN') return r.verdict === 'CLEAN';
  const code = d.expected.slice('FINDING '.length);
  const named = new RegExp(`(^|[^A-Za-z0-9_-])${escape(d.finding!)}($|[^A-Za-z0-9_-])`);
  const all = allDiagnostics(r);
  const mine = all.filter((x) => x.code === code && named.test(x.property ?? x.field ?? x.at.machine ?? ''));
  const other = all.filter((x) => !mine.includes(x) && x.code !== 'PL3901' && x.code !== 'PL5301');
  return mine.length > 0 && other.length === 0;
}

/**
 * Checks each chosen defect, one after the other, under <root>/.poly/defects/<name>/ and through the cache. Every edit of
 * every chosen defect is applied before any check, so a defect file that no longer fits the source stops at once.
 */
export async function checkDefects(target: string, specs: DefectSpec[], opts: { root?: string; cache?: string; only?: string[] }): Promise<DefectResult[]> {
  const unknown = (opts.only ?? []).filter((n) => !specs.some((d) => d.name === n));
  if (unknown.length) throw new CheckUsageError(`no such defect: ${unknown.join(', ')}`);
  const chosen = opts.only ? specs.filter((d) => opts.only!.includes(d.name)) : specs;
  const src = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  const parsed = parse(src).module;
  const configs = new Set((parsed?.decls ?? []).filter((x) => x.kind === 'Configuration').map((x) => (x as { name: string }).name));
  const texts = chosen.map((d) => {
    const missing = d.keep.filter((k) => !configs.has(k));
    if (missing.length) throw new CheckUsageError(`defect ${d.name} keeps the configuration ${missing.join(', ')}, which the source does not declare`);
    return applyDefect(src, d);
  });
  const base = resolve(opts.root ?? process.cwd());
  const out: DefectResult[] = [];
  for (const [i, d] of chosen.entries()) {
    const r = await checkFile(target, { root: join(base, '.poly', 'defects', d.name), text: texts[i], configs: d.keep, ...(opts.cache ? { cache: opts.cache } : {}) });
    out.push({ name: d.name, expected: d.expected, ...(d.finding ? { finding: d.finding } : {}), found: judgeDefect(r, d), verdict: r.verdict, findings: allDiagnostics(r), ...(r.error ? { error: r.error } : {}) });
  }
  return out;
}
