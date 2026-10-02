// The M2 code review over 9e1d045..HEAD, and the polywatch findings on the rulings' commits. Each finding has
// a test here that failed before its fix; the programs are in test/fixtures/review-m2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { checkFile, exportWitness, findWitness, render } from '@poly/check';
import { ROOT, BUILD } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'review-m2');
const src = (name) => readFileSync(join(FIX, `${name}.poly`), 'utf8');
const codes = (text) => {
  const p = parse(text);
  assert.ok(p.module, JSON.stringify(p.diagnostics));
  return checkModule(p.module).diagnostics.map((d) => d.code);
};
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
async function check(name, text) {
  const dir = join(BUILD, 'review-m2', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'm.poly');
  writeFileSync(f, text);
  return { dir, f, r: await checkFile(f, { root: dir }) };
}
/** Exports the witness of the first diagnostic with this code and runs it as a user would. */
function runWitness(r, dir, code) {
  const d = all(r).find((x) => x.code === code);
  assert.ok(d?.witness, `no ${code} with a witness\n${render(r)}`);
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
}

// ── polywatch, on the rulings' commits ─────────────────────────────────────

test('polywatch 2: a witness of no steps, for an invariant false in the initial state, still fails its exported test', async () => {
  const { dir, r } = await check('pw-initial', src('pw-initial'));
  const run = runWitness(r, dir, 'PL3001');
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(run.stdout, /invariant positive is violated in the initial state/);
});

// ── the front ends and the checker (A) ─────────────────────────────────────

const ROUTER = readFileSync(join(ROOT, 'conformance', 'm2', 'decisions', 'router.poly'), 'utf8');
const DETACHED = readFileSync(join(ROOT, 'conformance', 'm2', 'detached.poly'), 'utf8');
const STUCK = readFileSync(join(ROOT, 'conformance', 'm2', 'seeded', 'stuck', 'unfixed.poly'), 'utf8');
const swap = (base, a, b) => { const s = base.replace(a, b); assert.notEqual(s, base, a); return s; };

test('A1: a decimal ending in .0 reads from the embedded surface as the decimal it is (S76, S71)', async () => {
  const { printModule, readEmbedded } = await import('@poly/embed');
  const { digest } = await import('@poly/core');
  const poly = swap(ROUTER, 'if conf >= 0.8 && margin >= 0.3 {', 'if conf >= 1.0 && margin >= 0.0 {');
  const m = parse(poly).module;
  const back = readEmbedded(printModule(m));
  assert.ok(back.module, JSON.stringify(back.diagnostics));
  assert.equal(digest(back.module), digest(m));
  // Four digits after the point are refused, as the standalone lexer refuses them.
  const four = readEmbedded(printModule(m).replace('>= 1.0', '>= 0.8000'));
  assert.equal(four.module, null);
});

test('A2: a decimal in a configuration property is PL1201 (S76)', () => {
  assert.deepEqual(codes(STUCK.replace('invariant confirmed-within-stock:', 'invariant half: inv.onHand + 0.5 >= 1\n  invariant confirmed-within-stock:')), ['PL1201']);
});

test('A3: a fair InputRef names a member of its group, as an input does (S73, S31)', () => {
  const src = STUCK.replace('  invariant confirmed-within-stock:', '  liveness done: eventually inv.onHand == 0 under fair { order[5].Place }\n  invariant confirmed-within-stock:');
  assert.deepEqual(codes(src), ['PL1201']);
});

test('A4, A5: a Conf is only a completion parameter bound from a reply (PD1.3b, PD1.4b)', () => {
  assert.deepEqual(codes(swap(ROUTER, '    order  : 1..2         = 1\n', '    order  : 1..2         = 1\n    cm     : map<0..1, Conf> = { 0: 1, 1: 1 }\n')), ['PL1205']);
  assert.deepEqual(codes(swap(ROUTER, 'enum Branch', 'type Sc = { c: Conf }\nenum Branch')), ['PL1205']);
  assert.deepEqual(codes(swap(swap(ROUTER, '  action RouteFailed()\n', '  action RouteFailed()\n  action Poke(c: Conf)\n'), '  on RouteFailed {', '  on Poke(c) { require c >= 0.5 else reject "low"   status\' = Handled }\n  on RouteFailed {')), ['PL1205']);
});

test('A6: an effect whose kind is a decision\'s kind is PL1208 since M4 review D1 (PD1.7, S41)', () => {
  assert.deepEqual(codes(swap(ROUTER, 'kind "support.reply"', 'kind "decision.route"')), ['PL1208']);
});

test('A7: one key, one child, whatever the order of the handlers (PT6.4, S60)', () => {
  const base = DETACHED.slice(0, DETACHED.indexOf('configuration pool'));
  const second = swap(swap(base, '  action Done()\n', '  action Done()\n  action Go2()\n'), '  on Done {', '  on Go2 { require started else reject "x"   spawn Worker as w -> Start(n: 1)   done\' = 1 }\n  on Done {');
  assert.deepEqual(codes(second), ['PL1002']);
});

test('A8: one mistake, one diagnostic, for a decimal compared with an int, a negated Conf, and a missing bound', () => {
  assert.deepEqual(codes(swap(ROUTER, 'if conf >= 0.8 && margin >= 0.3 {', 'if order >= 0.5 {')), ['PL1201']);
  assert.deepEqual(codes(swap(ROUTER, 'if conf >= 0.8 && margin >= 0.3 {', 'if -conf < 0 {')), ['PL1205']);
  assert.deepEqual(codes(swap(DETACHED, '  bounds  { transit 2, instances 2 }\n', '')), ['PL5303']);
});

test('A9: Tri.Unknown is always legal (S76)', () => {
  assert.deepEqual(codes(swap(ROUTER, '  path property one-routing', '  invariant tri: Tri.Unknown == Tri.Unknown\n  path property one-routing')), []);
});

// ── the lowering (B) ───────────────────────────────────────────────────────

test('B1: a record parameter bound from a reply is checked by value at dispatch, so the program checks clean', async () => {
  const { r } = await check('b1', src('b1-record-reply'));
  assert.equal(r.verdict, 'CLEAN', render(r));
});

test('B3, B4: an int beside a Conf means thousandths in poly-ref and in a completion constant (PD1.3a)', async () => {
  const { dir, r } = await check('b3', src('b3-conf-eq'));
  assert.equal(r.verdict, 'CLEAN', render(r));
  const manifest = JSON.parse(readFileSync(join(dir, '.poly', 'build', 'b3.M', 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['decision.pick'].onFailure, { action: 'Go', data: { k: 'Y', conf: 1000 } });
});

test('B5: a detached child\'s address is stored, sent to or passed on, never compared before its step commits (S78)', () => {
  assert.deepEqual(codes(src('b5-marker-compare')), ['PL0901']);
  assert.deepEqual(codes(src('b5-marker-compare').replace("    same' = last == w\n", '')), []);
});

test('B6: a decision whose result is a record with a Tri field is read back, not a crash', async () => {
  const { r } = await check('b6', src('b6-tri-record'));
  assert.notEqual(r.verdict, 'ERROR', render(r));
  assert.equal(r.verdict, 'CLEAN', render(r));
});

// ── poly-ref (C) ───────────────────────────────────────────────────────────

test('C1, C3: an input names only instances that exist, and reaches a spawned child only after its creation action', async () => {
  const { r } = await check('c1', src('c1-poke'));
  assert.notEqual(r.verdict, 'ERROR', r.error);
  // Tell may send without end, so the transit bound is hit (PL5301); nothing else is found, and no invariant fails.
  assert.deepEqual(r.configurations[0].diagnostics.map((d) => d.code).filter((c) => c !== 'PL5301'), [], render(r));
});

test('C2: a spawned group is read through a quantifier or an aggregate, never by a constant index (S60)', () => {
  const s = src('c1-poke').replace('  invariant start-first:', '  invariant direct: Worker[0].poked implies d.started\n  invariant start-first:');
  assert.deepEqual(codes(s), ['PL1201']);
});

test('C4: per-value input fairness ranges over the configuration\'s addresses, so no spurious lasso (S73)', async () => {
  const { r } = await check('c4', src('c4-ping'));
  assert.deepEqual(r.configurations[0].diagnostics.filter((d) => d.code === 'PL3301'), [], render(r));
});

test('C5: the path-property read-back tells apart a predicate that counts another kind or every emission (PS5.4)', async () => {
  const { translationValidate } = await import('@poly/ref');
  const text = readFileSync(join(ROOT, 'conformance', 'm1', 'effects.poly'), 'utf8');
  for (const [i, wrong] of ['p.emitted.length <= 2', 'p.count("mail.notice") <= 2 && p.count("mail.receipt") == 0'].entries()) {
    const { dir } = await check(`c5-${i}`, text);
    const file = join(dir, '.poly', 'build', 'effects.Account', 'effect-invariants.mjs');
    writeFileSync(file, readFileSync(file, 'utf8').replace('p.count("mail.notice") <= 2', wrong));
    const tv = await translationValidate(parse(text).module, 'Account', join(dir, '.poly', 'build', 'effects.Account'));
    assert.ok(tv.mismatches.some((m) => /effect-invariants\.mjs few-notices/.test(m.message)), wrong);
  }
});

test('C6: translation validation resolves a child marker only in the step that creates the child (S78)', async () => {
  const { translationValidate } = await import('@poly/ref');
  const { dir } = await check('c6', DETACHED);
  const build = join(dir, '.poly', 'build', 'detached.Dispatcher');
  const next = join(build, 'next.cjs');
  writeFileSync(next, readFileSync(next, 'utf8').replace('next["done"] = 1;', 'next["done"] = 1; next["worker"] = ({ $ref: "child", key: "w" });'));
  const tv = await translationValidate(parse(DETACHED).module, 'Dispatcher', build);
  assert.ok(tv.mismatches.some((m) => /Done/.test(m.message)), JSON.stringify(tv.mismatches.map((m) => m.message)));
});

// ── the pipeline, witnesses, fixes and the lint (D), and polywatch 1 ───────

/** Checks a source, exports the witness of `code`, then checks `fixed` in place and runs the exported test. */
async function beforeAndAfter(name, unfixed, fixed, code) {
  const { dir, f, r } = await check(name, unfixed);
  const d = all(r).find((x) => x.code === code);
  assert.ok(d?.witness, `no ${code}\n${render(r)}`);
  const out = exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', out], { encoding: 'utf8', env });
  const failing = run();
  writeFileSync(f, fixed);
  const after = await checkFile(f, { root: dir });
  return { failing, after, passing: run() };
}

test('polywatch 1: a lasso for P leads to Q no longer counts once P is never true, in a machine and in a configuration', async () => {
  for (const name of ['pw-leads-to', 'pw-leads-to-config']) {
    const text = src(name);
    const { failing, after, passing } = await beforeAndAfter(name, text, swap(text, "flag' = true", "flag' = false"), 'PL3301');
    assert.notEqual(failing.status, 0, failing.stdout);
    assert.deepEqual(all(after).filter((d) => d.code === 'PL3301'), [], render(after));
    assert.equal(passing.status, 0, passing.stdout);
  }
});

test('D2: a configuration lasso is judged against the fair inputs too, so the fixed program\'s test passes', async () => {
  const text = src('pw-leads-to-config');
  const { failing, after, passing } = await beforeAndAfter('d2', text, swap(text, 'require x > 1 else reject "never"', 'require x >= 0 else reject "never"'), 'PL3301');
  assert.notEqual(failing.status, 0);
  assert.deepEqual(all(after).filter((d) => d.code === 'PL3301'), [], render(after));
  assert.equal(passing.status, 0, passing.stdout);
});

test('D1: an ungated decision\'s exported test fails, and passes once a confidence gates it (PL6201)', async () => {
  const ungated = swap(ROUTER, "if conf >= 0.8 && margin >= 0.3 { status' = Refunding   emit refund(order) }\n        else { status' = NeedsHuman }", "status' = Refunding   emit refund(order)")
    .replace('  step property refund-needs-margin: (action == Routed && post.status == Refunding) implies (conf >= 0.8 && margin >= 0.3)\n', '');
  const { failing, after, passing } = await beforeAndAfter('d1-gate', ungated, ROUTER.replace('  step property refund-needs-margin: (action == Routed && post.status == Refunding) implies (conf >= 0.8 && margin >= 0.3)\n', ''), 'PL6201');
  assert.notEqual(failing.status, 0);
  assert.match(failing.stdout, /decision route is ungated/);
  assert.equal(after.verdict, 'CLEAN', render(after));
  assert.equal(passing.status, 0, passing.stdout);
});

test('D1: a witness whose defect no exported test can judge yet is refused at export, never exported to pass', async () => {
  const children = readFileSync(join(ROOT, 'conformance', 'm1', 'children.poly'), 'utf8');
  const { dir, r } = await check('d1-compose', swap(children, 'children.box.ship in { Delivered, Voided }', 'children.box.ship == Delivered'));
  const d = all(r).find((x) => x.code === 'PL5001');
  assert.ok(d?.witness, render(r));
  assert.throws(() => exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'test' }), /PL5001 has no exported test yet/);
  // The trace export still works.
  exportWitness(findWitness(JSON.parse(JSON.stringify(r)), d.witness.id), { root: dir, kind: 'trace' });
});

test('D3: PL6201 is reported once, by the decisions stage, and the model check stays clean', async () => {
  const ungated = swap(ROUTER, "if conf >= 0.8 && margin >= 0.3 { status' = Refunding   emit refund(order) }\n        else { status' = NeedsHuman }", "status' = Refunding   emit refund(order)")
    .replace('  step property refund-needs-margin: (action == Routed && post.status == Refunding) implies (conf >= 0.8 && margin >= 0.3)\n', '');
  const { r } = await check('d3', ungated);
  assert.equal(all(r).filter((d) => d.code === 'PL6201').length, 1, render(r));
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'model-check').verdict, 'CLEAN');
});

test('D4: the report holds the source\'s absolute path, so witness and fix work from any directory', async () => {
  const dir = join(BUILD, 'review-m2', 'd4');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'm.poly'), readFileSync(join(ROOT, 'conformance', 'm2', 'seeded', 'deadlock', 'unfixed.poly'), 'utf8'));
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  assert.equal(spawnSync(process.execPath, [cli, 'check', 'm.poly', '--root', '.'], { cwd: dir, encoding: 'utf8' }).status, 1);
  const report = JSON.parse(readFileSync(join(dir, '.poly', 'report.json'), 'utf8'));
  assert.equal(report.file, join(dir, 'm.poly'));
});

test('D5, D6: cover-rest and move-require are offered only where they remove the diagnostic without another (S70)', async () => {
  const { r } = await check('d5', src('d5-cover-after-write'));
  const fixes = all(r).flatMap((d) => (d.fixes ?? []).map((f) => `${d.code}:${f.id.split('@')[0]}`));
  assert.ok(!fixes.includes('PL1501:cover-rest'), fixes.join(' '));
  assert.ok(!fixes.includes('PL2101:move-require'), fixes.join(' '));
});

// D7 kept fixes off the embedded surface, where poly fix did not apply (S70). M3-3 puts them there.
test('D7, since M3-3: the embedded surface is offered the fixes of the standalone one, and poly fix applies them', async () => {
  const { printModule } = await import('@poly/embed');
  const dir = join(BUILD, 'review-m2', 'd7');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'm.ts');
  writeFileSync(f, printModule(parse(readFileSync(join(ROOT, 'conformance', 'm0', 'errors', 'PL2101-write-before-require.poly'), 'utf8')).module));
  const r = await checkFile(f, { root: dir });
  const d = all(r).find((x) => x.code === 'PL2101');
  assert.ok(d, render(r));
  // The same module digest on both surfaces (PT1.4), so the same fix ids (S69).
  const std = join(dir, 'm.poly');
  copyFileSync(join(ROOT, 'conformance', 'm0', 'errors', 'PL2101-write-before-require.poly'), std);
  const rs = await checkFile(std, { root: join(dir, 'poly') });
  assert.deepEqual(d.fixes.map((x) => x.id), all(rs).find((x) => x.code === 'PL2101').fixes.map((x) => x.id));
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  spawnSync(process.execPath, [cli, 'check', f, '--root', dir], { encoding: 'utf8' });
  const out = spawnSync(process.execPath, [cli, 'fix', d.fixes[0].id, '--root', dir], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!all(await checkFile(f, { root: dir })).some((x) => x.code === 'PL2101'));
});

test('D8: two machines with the same defect have witnesses with different ids, each exported for its own machine', async () => {
  const { r } = await check('d8', src('d8-twins'));
  const ids = r.machines.map((m) => m.diagnostics.find((d) => d.code === 'PL3201').witness.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(findWitness(JSON.parse(JSON.stringify(r)), ids[1]).machine, 'B');
});

test('D9: poly witness takes an id or a prefix of at least 12 hex digits, and says when a prefix is ambiguous', async () => {
  // A report with one witness, so a short prefix is not merely ambiguous.
  const { dir } = await check('d9', readFileSync(join(ROOT, 'conformance', 'm2', 'seeded', 'deadlock', 'unfixed.poly'), 'utf8'));
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  spawnSync(process.execPath, [cli, 'check', join(dir, 'm.poly'), '--root', dir], { encoding: 'utf8' });
  const full = JSON.parse(readFileSync(join(dir, '.poly', 'report.json'), 'utf8')).machines[0].diagnostics.find((d) => d.witness).witness.id.slice(7);
  assert.equal(spawnSync(process.execPath, [cli, 'witness', full.slice(0, 12), '--trace', '--root', dir], { encoding: 'utf8' }).status, 0);
  for (const id of [full.slice(0, 1), full.slice(0, 5), full.slice(0, 11)]) {
    const run = spawnSync(process.execPath, [cli, 'witness', id, '--trace', '--root', dir], { encoding: 'utf8' });
    assert.equal(run.status, 64, `${id}: ${run.stdout}`);
  }
});

test('D10: the handler lint catches more routes to ambient authority, and lets a type import and a local name through (PT6.5)', async () => {
  const { lintHandlerText } = await import('@poly/check');
  const caught = [
    'const { env } = process;',
    'const p = process; p.env.K;',
    'global.fetch("x");',
    'process.getBuiltinModule("fs");',
    'const r = require; r("fs");',
    'module.require("fs");',
    'import { DatabaseSync } from "node:sqlite";',
    'new WebSocket("wss://x");',
    'const f = fetch;',
    '(0, fetch)("x");',
    'eval("1");',
    'new Function("return 1");',
  ];
  for (const s of caught) assert.ok(lintHandlerText(`${s}\n`, 'h.ts').length >= 1, s);
  const legitimate = [
    'import type { Stats } from "node:fs";\nexport const n = (s: Stats) => s.size;',
    'export async function h(p, egress) { const fetch = egress.get; return fetch("/x"); }',
  ];
  for (const s of legitimate) assert.deepEqual(lintHandlerText(`${s}\n`, 'h.ts').map((d) => d.message), [], s);
});

test('review, minor: a configuration lasso is rendered with its cycle (S74)', async () => {
  const { r } = await check('lasso-render', src('pw-leads-to-config'));
  assert.match(render(r), /cycle, repeated for ever:/);
});

// ── polywatch, on the review's fixes ──────────────────────────────────────

test('polywatch (review) 1: a local name shadows an ambient global only in its own scope (PT6.5)', async () => {
  const { lintHandlerText } = await import('@poly/check');
  const src2 = 'export function a() { const fetch = () => 1; return fetch(); }\nexport function b() { return fetch("https://x"); }\n';
  assert.equal(lintHandlerText(src2, 'h.ts').length, 1);
  assert.equal(lintHandlerText('export function a(fetch) { return fetch("/x"); }\n', 'h.ts').length, 0);
  assert.equal(lintHandlerText('export function a() { const process = { env: {} }; return process.env.K; }\nexport const k = process.env.K;\n', 'h.ts').length, 1);
});

test('polywatch (review) 2: forall over a group of detached instances judges the members that exist (S60, PS13.6)', async () => {
  const { r } = await check('pw-spawned-eventually', src('pw-spawned-eventually'));
  assert.deepEqual(r.configurations[0].diagnostics.filter((d) => d.code === 'PL3301'), [], render(r));
});

test('ruling on the refused exports: the report marks a finding with no test export until M4', async () => {
  const children = readFileSync(join(ROOT, 'conformance', 'm1', 'children.poly'), 'utf8');
  const { r } = await check('m4-mark', children.replace('children.box.ship in { Delivered, Voided }', 'children.box.ship == Delivered'));
  const d = all(r).find((x) => x.code === 'PL5001');
  assert.equal(d.testExport, 'no test export until M4');
  assert.match(render(r), /no test export until M4/);
  assert.equal(all(r).filter((x) => x.witness && x.code !== 'PL5001').every((x) => x.testExport === undefined), true);
});
