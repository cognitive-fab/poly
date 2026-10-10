// The shadowing warning (PT12, "Warnings (v1, ruled 2026-10-09)"; S19, PS2.2 step 0). `poly check` prints a warning,
// beside the verdict and never in it, for each action parameter named after a state field of its machine, naming
// both. The report lists them under `warnings` as `{ machine, action, param, field }`. A warning is not a diagnostic,
// changes no verdict and is not certified. Written from the specification text alone, before the change.
//
// The subject is conformance/m0/shadowing.poly: Tank has a field `level` and `action Set(level: 0..3)`, and Drain has
// no parameter, so exactly one warning is expected. Measured before the change: checkFile gives CLEAN with no
// diagnostic at module level or on Tank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const SHADOWING = join(ROOT, 'conformance', 'm0', 'shadowing.poly');
const SRC = readFileSync(SHADOWING, 'utf8');
const OUT = join(ROOT, '.poly', 'test-shadow-warning');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const EXPECTED = [{ machine: 'Tank', action: 'Set', param: 'level', field: 'level' }];

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;

// The same module with Set's parameter renamed `v` wherever it denotes the parameter (S19: narrowed to Set, or in
// Set's handler). It means the same program, and no parameter is named after a field.
const EOL = SRC.includes('\r\n') ? '\r\n' : '\n';
const RENAMED = [
  ['action Set(level: 0..3)', 'action Set(v: 0..3)'],
  ['action == Set && level == 3 reject', 'action == Set && v == 3 reject'],
  ['on Set(level) {', 'on Set(v) {'],
  ['require level != pre.level else reject "same"', 'require v != pre.level else reject "same"'],
  ["level' = level" + EOL, "level' = v" + EOL],
  ['(action == Set && level == 1)', '(action == Set && v == 1)'],
  ['(action == Set && level == 3) implies', '(action == Set && v == 3) implies'],
].reduce((s, [a, b]) => swap(s, a, b), SRC);

let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'shadowing.poly'), src);
  const r = await checkFile(join(d, 'shadowing.poly'), { root: d });
  assert.ok(!r.error, text(r));
  return r;
}

test('PT12 warnings, S19: checkFile on shadowing.poly lists one warning for Set.level and keeps its verdict CLEAN with no diagnostic', { timeout: 120_000 }, async () => {
  const r = await check(SRC);
  // A warning is not a diagnostic and changes no verdict: the result measured before the change.
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.deepEqual(all(r), [], text(r));
  assert.deepEqual((r.machines ?? []).map((m) => [m.machine, m.verdict]), [['Tank', 'CLEAN']]);
  // Drain has no parameter, so Set's is the only warning.
  assert.deepEqual(r.warnings, EXPECTED, JSON.stringify(r.warnings));
  // Not a diagnostic: no diagnostic anywhere carries the warning's text.
  assert.ok(!all(r).some((d) => /shadow/i.test(`${d.code} ${d.message}`)), text(r));
});

test('PT12 warnings: the same program with the parameter renamed has no warning, and the same verdict, diagnostics and state count', { timeout: 120_000 }, async () => {
  const shadowed = await check(SRC);
  const renamed = await check(RENAMED);
  // "The report lists them under `warnings`": with none to list, the list is empty. The text does not say whether an
  // empty list is written or the key left out, so both are accepted here.
  assert.ok(renamed.warnings === undefined || (Array.isArray(renamed.warnings) && renamed.warnings.length === 0), JSON.stringify(renamed.warnings));
  assert.equal(shadowed.verdict, renamed.verdict, `${text(shadowed)} | ${text(renamed)}`);
  assert.deepEqual(all(shadowed).map((d) => d.code).sort(), all(renamed).map((d) => d.code).sort());
  assert.deepEqual((shadowed.machines ?? []).map((m) => [m.machine, m.verdict]), (renamed.machines ?? []).map((m) => [m.machine, m.verdict]));
  const counts = (r) => (r.machines ?? []).map((m) => [m.machine, m.instance?.states, m.instance?.transitions]);
  assert.deepEqual(counts(shadowed), counts(renamed));
  // The change under test is the warning itself, so the shadowed module must list one.
  assert.deepEqual(shadowed.warnings, EXPECTED, JSON.stringify(shadowed.warnings));
});

test('PT12 warnings: poly check prints the warning beside the verdict, naming the parameter and the field, exits 0, and writes it to .poly/report.json', { timeout: 120_000 }, () => {
  const dir = join(OUT, 'cli');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'shadowing.poly');
  copyFileSync(SHADOWING, file);
  const r = spawnSync(process.execPath, [CLI, 'check', file, '--root', dir], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  // Changes no verdict: CLEAN, exit 0 (PT12.3).
  assert.equal(r.status, 0, out);
  assert.match(r.stdout, /verdict: CLEAN \(exit 0\)/);
  const lines = out.split(/\r?\n/);
  const warning = lines.filter((l) => /warning/i.test(l));
  assert.ok(warning.length >= 1, `a warning line is printed:\n${out}`);
  // Naming both: the action's parameter and the machine's field. Here both are called `level`, so the line names
  // `level` twice, with the action and the machine it belongs to.
  const named = warning.find((l) => /Set/.test(l) && /Tank/.test(l) && (l.match(/level/g) ?? []).length >= 2);
  assert.ok(named, `a warning names Tank, Set, the parameter level and the field level:\n${warning.join('\n')}`);
  // Beside the verdict and never in it.
  const verdict = lines.filter((l) => /verdict:/.test(l));
  assert.ok(verdict.length >= 1, out);
  for (const v of verdict) assert.doesNotMatch(v, /warning|shadow/i, v);
  const report = JSON.parse(readFileSync(join(dir, '.poly', 'report.json'), 'utf8'));
  assert.equal(report.verdict, 'CLEAN');
  assert.deepEqual(report.warnings, EXPECTED, JSON.stringify(report.warnings));
});

test('PT12 warnings: a warning is not certified: the certificate of an admitted shadowing.poly carries no warning', { timeout: 180_000 }, async () => {
  const key = makeKey('tank-cert');
  const dir = project('tank-cert', ['conformance/m0/shadowing.poly'], key, 'test-shadow-warning');
  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  const raw = readFileSync(join(dir, '.poly', 'certificate.json'), 'utf8');
  // The source file's own name contains "shadow", so the check is on the record's shape: no `warnings` key and no
  // `{ machine, action, param, field }` record anywhere in the certificate.
  assert.doesNotMatch(raw, /"warnings"/);
  const records = [];
  const walk = (x) => { if (x && typeof x === 'object') { if ('param' in x && 'field' in x) records.push(x); for (const v of Object.values(x)) walk(v); } };
  walk(JSON.parse(raw));
  assert.deepEqual(records, []);
});
