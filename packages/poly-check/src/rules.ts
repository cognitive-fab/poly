// PT14, S589: poly rules, one page that lists every rule a program states, read from its sources alone. It parses and
// prints; it runs no check stage, calls no engine, verifies no signature and writes no file. A removed or changed rule
// shows in a diff of the page, and --check says which (S589); signing the rules is planned for v2.0.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { loadProject, toJson, type Diagnostic } from '@poly/core';
import type * as A from '@poly/core';
import { parse, ruleText, type RuleNode } from '@poly/lang';
import { policySlug } from './policies.js';

export interface RuleEntry {
  id: string;
  name: string;
  kind: string;
  module: string;
  owner: { kind: 'machine' | 'configuration' | 'policy'; name: string; scope?: string };
  file: string;
  line: number;
  text: string;
  mitigates?: string[];
  implements?: string[];
  signature?: { by: unknown; sequence: unknown } | null;
}

export interface RulesIndex { v: 1; rules: RuleEntry[]; diagnostics?: Record<string, unknown>[] }

const POLICY_KINDS: Record<A.PolicyItem['kind'], string> = {
  RuleObligation: 'policy-rule', MachineObligation: 'policy-machine', InvariantObligation: 'policy-invariant', Recalled: 'policy-recalled', Never: 'policy-never',
};

/** Code-unit order, so the page is the same bytes on every host. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The rule kind PT14 names for a machine or configuration item. */
function kindOf(it: A.Property | A.Liveness | A.NeverEmit): string {
  if (it.kind === 'NeverEmit') return 'never';
  if (it.kind === 'Liveness') return 'liveness';
  return it.form;
}

/** What `policies/<slug>.sig.json` states for a scope: its record's `by` and its `sequence`, or null with no file. */
function signatureOf(base: string, scope: string): { by: unknown; sequence: unknown } | null {
  const f = join(base, 'policies', `${policySlug(scope)}.sig.json`);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { sequence?: unknown; record?: { by?: unknown } };
    return { by: j.record?.by ?? null, sequence: j.sequence ?? null };
  } catch {
    return { by: null, sequence: null };
  }
}

/** The files a target names, each with the path the page shows, and the folder signatures are read from. */
function filesOf(target: string): { base: string; files: { path: string; shown: string }[] } {
  if (existsSync(target) && statSync(target).isDirectory()) {
    // Embedded modules (.ts) are not read in this version (S589, amendment 1).
    const files = loadProject(target).files.filter((f) => f.endsWith('.poly'));
    return { base: target, files: files.map((f) => ({ path: f, shown: relative(target, f).split(sep).join('/') })) };
  }
  return { base: dirname(target), files: [{ path: target, shown: basename(target) }] };
}

/** PT14, S589: the index of every rule of a file or a project, or the parse diagnostics that refuse it. */
export function rulesIndex(target: string): { index: RulesIndex; refused: boolean } {
  const { base, files } = filesOf(target);
  const rules: RuleEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const { path, shown } of files) {
    const parsed = parse(readFileSync(path, 'utf8'));
    const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
    if (!parsed.module || errors.length) { diagnostics.push(...(errors.length ? errors : parsed.diagnostics)); continue; }
    const m = parsed.module;
    const at = (n: A.NodeBase) => n.span?.line ?? 0;
    // The fields in the order PT14 lists them, so the JSON reads as the paragraph does.
    const entry = (r: RuleNode, e: Omit<RuleEntry, 'file' | 'line' | 'text' | 'module'>): RuleEntry => {
      const { id, name, kind, owner, ...rest } = e;
      return { id, name, kind, module: m.name, owner, file: shown, line: at(r), text: ruleText(r), ...rest };
    };
    for (const d of m.decls) {
      if (d.kind === 'Machine') {
        for (const it of d.items) {
          if (it.kind !== 'Property' && it.kind !== 'Liveness' && it.kind !== 'NeverEmit') continue;
          rules.push(entry(it, { id: `${m.name}.${d.name}.${it.name}`, name: it.name, kind: kindOf(it), owner: { kind: 'machine', name: d.name } }));
        }
      } else if (d.kind === 'Configuration') {
        for (const it of d.properties) rules.push(entry(it, { id: `${m.name}.${d.name}.${it.name}`, name: it.name, kind: kindOf(it), owner: { kind: 'configuration', name: d.name } }));
      } else if (d.kind === 'Policy') {
        for (const it of d.items) {
          const tags = it as A.Tags;
          rules.push(entry(it, {
            id: `${d.name}.${it.name}`, name: it.name, kind: POLICY_KINDS[it.kind], owner: { kind: 'policy', name: d.name, scope: d.scope },
            ...(tags.mitigates?.length ? { mitigates: tags.mitigates.map((t) => t.tag) } : {}),
            ...(tags.implements?.length ? { implements: tags.implements.map((t) => t.tag) } : {}),
            signature: signatureOf(base, d.scope),
          }));
        }
      }
    }
  }
  if (diagnostics.length) return { index: { v: 1, rules: [], diagnostics: diagnostics.map(toJson) }, refused: true };
  rules.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.id, b.id));
  return { index: { v: 1, rules }, refused: false };
}

/** The JSON form, the same bytes for the same sources. */
export const rulesJson = (index: RulesIndex): string => JSON.stringify(index, null, 2) + '\n';

/** PT14, S589: the Markdown page, rendered from the index alone. */
export function rulesMarkdown(index: RulesIndex): string {
  const out = ['# Rules', '', 'Generated by `poly rules` from the sources. Do not edit it by hand: `poly rules --check` fails when it is out of date.', ''];
  if (!index.rules.length) return [...out, 'No rules.', ''].join('\n');
  let file: string | null = null;
  for (const r of index.rules) {
    if (r.file !== file) { file = r.file; out.push(`## ${r.file}`, ''); }
    let clause = `${r.kind}, line ${r.line}`;
    if (r.mitigates?.length) clause += `, mitigates ${r.mitigates.join(', ')}`;
    if (r.implements?.length) clause += `, implements ${r.implements.join(', ')}`;
    if (r.owner.kind === 'policy') clause += r.signature ? `, signed by ${String(r.signature.by)} (sequence ${String(r.signature.sequence)})` : ', not signed';
    out.push(`### ${r.id}`, '', clause, '', '```poly', r.text, '```', '');
  }
  return out.join('\n');
}

/**
 * The rules of a page, by id, read back from its `### <id>` entries. What is compared is the whole entry with the file
 * whose `## <file>` section holds it, since a rule's `file` is part of its entry (polywatch: a rule moved to a renamed
 * file was read as unchanged).
 */
function entriesOf(page: string): Map<string, string> {
  const out = new Map<string, string>();
  let file = '';
  let id: string | null = null;
  let body: string[] = [];
  const close = () => { if (id !== null) out.set(id, `${file}\n${body.join('\n').trimEnd()}`); id = null; body = []; };
  for (const line of page.split('\n')) {
    if (line.startsWith('## ')) { close(); file = line.slice(3); continue; }
    if (line.startsWith('### ')) { close(); id = line.slice(4); continue; }
    if (id !== null) body.push(line);
  }
  close();
  return out;
}

export interface RulesCheck { upToDate: boolean; added: string[]; removed: string[]; changed: string[] }

/** PT14, S589: the page compared with a committed copy, and the rules added, removed or changed. */
export function rulesCheck(index: RulesIndex, file: string): { result: RulesCheck; text: string } {
  const page = rulesMarkdown(index);
  const committed = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  const n = index.rules.length;
  if (committed === page) return { result: { upToDate: true, added: [], removed: [], changed: [] }, text: `up to date: ${n} rule${n === 1 ? '' : 's'}\n` };
  const now = entriesOf(page);
  const then = committed === null ? new Map<string, string>() : entriesOf(committed);
  const added = [...now.keys()].filter((id) => !then.has(id)).sort(cmp);
  const removed = [...then.keys()].filter((id) => !now.has(id)).sort(cmp);
  const changed = [...now.keys()].filter((id) => then.has(id) && then.get(id) !== now.get(id)).sort(cmp);
  const lines = [...added.map((id) => ['added', id]), ...removed.map((id) => ['removed', id]), ...changed.map((id) => ['changed', id])].sort((a, b) => cmp(a[1], b[1])).map(([w, id]) => `${w} ${id}`);
  const text = lines.length ? lines.join('\n') + '\n' : 'changed: the file is not what poly rules prints\n';
  return { result: { upToDate: false, added, removed, changed }, text };
}
