// S586, RT15: what the toolchain makes of an untagged policy, recorded the same way on two trees so the bytes can be
// compared. For each policy source of examples/, demo/ and conformance/:
//   - the document lowerPolicyScope gives for each scope, as RFC 8785 canonical JSON (with a fixed source digest);
//   - for a policy with its program beside it (`<name>.poly` with `<name>.policy.poly`), the project of the two, as
//     test/examples-expected.mjs builds it: the lowered document poly check writes and its SHA-256, the subject a
//     person signs for each scope (policySubjects, PT12.5), and the output of `poly check` with the report it writes;
//   - for a policy with no program beside it, the output of `poly check` on the file alone.
// Paths are written relative to the repository and the test key folder, so two trees record the same text. Shared by
// record-v151.mjs, which wrote v1.5.1-untagged.json from a build of the tag v1.5.1, and test/s586-tags-language.test.mjs,
// which records the same on the tree under test and compares.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse } from '@poly/lang';
import { lowerPolicyScope } from '@poly/lower';
import { canonicalize } from '@poly/core';
import { policySubjects } from '@poly/check';
import { ROOT, ACCEPT_TEST_ANCHORS } from '../../helpers.mjs';
import { makeKey, project } from '../../runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const OUT = join(ROOT, '.poly', 'test-s586-untagged');
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const slashed = (f) => relative(ROOT, f).split(sep).join('/');

/** Every policy source under the three folders: a `.policy.poly`, or a `.poly` that declares a policy. */
export function policySources() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== '.poly') walk(p); continue; }
      if (!p.endsWith('.poly')) continue;
      if (p.endsWith('.policy.poly') || /^\s*policy\s+[A-Za-z_][\w-]*\s*\{/m.test(readFileSync(p, 'utf8'))) out.push(p);
    }
  };
  for (const d of ['examples', 'demo', 'conformance']) walk(join(ROOT, d));
  return out.map(slashed).sort();
}

/** Whether a policy source carries a tag (PT8.6): a `mitigates` or `implements` clause after an item's text. */
export const tagged = (text) => /"\s+(mitigates|implements)\s+"/.test(text);

/** The text with this tree's absolute paths written relative, in every spelling a path takes in output and JSON. */
export function normalized(text, extra = []) {
  let s = String(text);
  const roots = [[ROOT.replace(/[\\/]+$/, ''), '<root>'], ...extra];
  for (const [abs, name] of roots) {
    const forms = new Set([abs, abs.split('\\').join('/'), abs.split('\\').join('\\\\'), abs.split('/').join('\\'), abs.split('/').join('\\\\')]);
    for (const f of [...forms]) { forms.add(f.toLowerCase()); forms.add(f[0].toUpperCase() + f.slice(1)); }
    for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.split(f).join(name);
  }
  return s.split('\r\n').join('\n');
}

/** The report without its timings: each stage records how long it took, in `ms`, which no two runs share. */
export function timeless(v) {
  if (Array.isArray(v)) return v.map(timeless);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'ms').map(([k, x]) => [k, timeless(x)]));
  return v;
}

/** The lines of standard error that depend on the clock, not on the program. */
export const QUIET = /ExperimentalWarning|--trace-warnings|^\[check\] exploring /;

function check(target, root) {
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, 'check', target, '--root', root, '--no-cache'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, POLY_NO_CACHE: '1' } });
  // Node's notice that SQLite is experimental goes to standard error at a time of its own, and so do the model
  // checker's progress lines (`[check] exploring (pass n)… k states discovered, …, 10s elapsed`), which report how far
  // it got in each ten seconds: both are left out. Measured on the inbox and the concierge, the only sources that print
  // progress, whose progress lines differed between two runs of one tree.
  const err = r.stderr.split(/\r?\n/).filter((l) => !QUIET.test(l)).join('\n');
  return { exit: r.status, out: `${r.stdout}${err}` };
}

/** The record of one policy source, by its path from the repository. */
export async function recordPolicy(rel) {
  const file = join(ROOT, rel);
  const text = readFileSync(file, 'utf8');
  const parsed = parse(text);
  const pols = (parsed.module?.decls ?? []).filter((d) => d.kind === 'Policy');
  const scopes = [...new Set(pols.map((p) => p.scope))].sort();
  const lowered = Object.fromEntries(scopes.map((s) => {
    try { return [s, sha(canonicalize(lowerPolicyScope(s, pols.filter((p) => p.scope === s), 'sha256:s586-rt15')))]; } catch (e) { return [s, `error: ${e.message}`]; }
  }));
  const program = file.endsWith('.policy.poly') ? join(dirname(file), `${basename(file, '.policy.poly')}.poly`) : null;
  const slug = rel.replace(/[^a-z0-9]+/gi, '-');
  const record = { file: rel, sourceDigest: sha(readFileSync(file)), lowered };
  if (program && existsSync(program)) {
    const key = makeKey(`s586-${slug}`);
    const dir = project(`s586-${slug}`, [slashed(program), rel], key, 'test-s586-untagged');
    for (const d of ['maps', 'prices']) if (existsSync(join(dirname(file), d))) cpSync(join(dirname(file), d), join(dir, 'src', d), { recursive: true });
    // The keys are drawn for the run: the admission key's file and the people ring are not part of what is compared.
    const keysDir = dirname(key.file);
    const c = check(dir, dir);
    const reportFile = join(dir, '.poly', 'report.json');
    const documents = {};
    const policiesDir = join(dir, '.poly', 'build', 'policies');
    if (existsSync(policiesDir)) for (const f of readdirSync(policiesDir).filter((x) => x.endsWith('.policy.json')).sort()) {
      const bytes = readFileSync(join(policiesDir, f));
      documents[f] = sha(bytes);
    }
    let subjects;
    try { subjects = (await policySubjects(dir)).map((s) => ({ scope: s.scope, subject: s.subject })); } catch (e) { subjects = `error: ${normalized(e.message, [[keysDir, '<keys>']])}`; }
    const report = existsSync(reportFile) ? normalized(canonicalize(timeless(JSON.parse(readFileSync(reportFile, 'utf8')))), [[keysDir, '<keys>']]) : null;
    Object.assign(record, { project: true, exit: c.exit, output: normalized(c.out, [[keysDir, '<keys>']]), report: report && sha(report), documents, subjects });
    rmSync(dir, { recursive: true, force: true });
  } else {
    const root = join(OUT, slug);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const c = check(file, root);
    Object.assign(record, { project: false, exit: c.exit, output: normalized(c.out) });
    rmSync(root, { recursive: true, force: true });
  }
  return record;
}

/** Records every source given and writes them as one JSON file. */
export async function recordAll(files, out) {
  const records = [];
  for (const f of files) records.push(await recordPolicy(f));
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify({ v: 1, records }, null, 2) + '\n'); }
  return records;
}
