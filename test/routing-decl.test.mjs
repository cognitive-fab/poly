// M11 step 5 (PT10r, PS18.0 to PS18.3, PT24.1): `route` and `budget` on both surfaces, the modules m.r and m.b checked
// like a credential's Grant, the route's and the budget's descriptors read back by poly-ref, and the checks PL6841,
// PL6843 to PL6845. The price tables and maps are the tests' own, beside the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { parse, format } from '@poly/lang';
import { digest } from '@poly/core';
import { printModule, readEmbedded } from '@poly/embed';
import { ROOT, TEST_STD } from './helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'm11');
const SRC = readFileSync(join(FIX, 'desk.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-routing-decl');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
const sha = (file) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
let n = 0;
/** Checks a source in a fresh directory holding the fixture's price tables and maps, with `files` written over them. */
async function check(src, files = {}) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  cpSync(join(FIX, 'maps'), join(d, 'maps'), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), typeof body === 'string' ? body : JSON.stringify(body));
  writeFileSync(join(d, 'desk.poly'), src);
  return { r: await checkFile(join(d, 'desk.poly'), { root: d, std: TEST_STD }), dir: d, build: join(d, '.poly', 'build') };
}
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('PT10r: a route, a budget and a routed decision format and print on both surfaces to the same digest', () => {
  const a = parse(SRC);
  assert.ok(a.module, JSON.stringify(a.diagnostics));
  assert.equal(format(a.module, a.trivia), SRC, 'the fixture is in canonical form');
  const formatted = format(a.module);
  assert.equal(digest(parse(formatted).module), digest(a.module));
  const back = readEmbedded(printModule(a.module));
  assert.ok(back.module, JSON.stringify(back.diagnostics));
  assert.equal(digest(back.module), digest(a.module));
  const r = a.module.decls.find((d) => d.kind === 'Route');
  assert.deepEqual(r.escalate, [{ on: 'conf', below: 800 }, { on: 'margin', below: 100 }, { on: 'failed' }]);
  const b = a.module.decls.find((d) => d.kind === 'Budget');
  assert.deepEqual(b.caps.map((c) => [c.currency, c.amount, c.run, c.period, c.scope]), [['usd', 500_000, true, null, false], ['usd', 20_000_000, false, 'day', true]]);
  assert.equal(b.onExhausted, 'escalate');
  for (const line of ['  cap usd 0.5 per run', '  cap usd 20 per day per scope', '  escalate when conf < 0.8 or margin < 0.1 or failed', '    route triage']) assert.ok(formatted.includes(line + '\n'), line);
});

test('PT10r: each clause of a route and a budget is written in its place, and the escalation is required', () => {
  for (const [from, to] of [
    ['  budget support\n}', '  budget support\n  budget support\n}'],
    ['  escalate when conf < 0.8 or margin < 0.1 or failed\n', ''],
    ['  escalate when conf < 0.8 or margin < 0.1 or failed\n', '  escalate when conf < 0.8\n  escalate when failed\n'],
    ['  on exhausted escalate\n', '  on exhausted escalate\n  on exhausted deny\n'],
    ['  on exhausted escalate\n', '  on exhausted retry\n'],
    ['cap usd 0.5 per run', 'cap usd 0.5 per week'],
    ['max tokens 4000', 'tokens 4000'],
    ['escalate when conf < 0.8', 'escalate when conf <= 0.8'],
  ]) {
    const r = parse(swap(SRC, from, to));
    assert.equal(r.module, null, `${from} -> ${to}`);
  }
});

test('PS18.0, PT10r: the desk checks CLEAN, with r.Route and b.Budget checked as their modules', { timeout: 300_000 }, async () => {
  const { r, build } = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.deepEqual(r.machines.map((m) => m.machine).sort(), ['Ticket', 'support.Budget', 'triage.Route']);
  for (const m of r.machines) assert.equal(m.stages.find((s) => s.stage === 'translation-validation').verdict, 'CLEAN', m.machine);
  const route = r.machines.find((m) => m.machine === 'triage.Route');
  assert.equal(route.stages.find((s) => s.stage === 'liveness').verdict, 'CLEAN');
  // PS18.1: two tiers, so 0..1, and the condition's own thresholds cut conf and margin.
  assert.ok(route.instance.domains.includes('Answer.conf ∈ {0, 800}') && route.instance.domains.includes('Answer.margin ∈ {0, 100}'), JSON.stringify(route.instance.domains));
  const manifest = json(join(build, 'desk.triage.Route', 'effects.manifest.json'));
  assert.deepEqual(Object.keys(manifest.effects), ['route.triage.call']);
  assert.deepEqual(manifest.effects['route.triage.call'].labels, ['egress:external', 'read:private']);
  assert.deepEqual(manifest.effects['route.triage.call'].retry.maxAttempts, 1);
  assert.deepEqual(manifest.effects['route.triage.call'].retry.timeoutMs, 800);
  const app = json(join(build, 'desk.Ticket', 'effects.manifest.json'));
  assert.deepEqual(app.effects['decision.classify'].decision, { provider: null, route: 'triage', result: ['Refund', 'Status', 'Other'] });
});

test('PT10r: the route\'s and the budget\'s descriptors hold the tiers, prices, maps, condition and caps, certified by digest', { timeout: 300_000 }, async () => {
  const { r, dir, build } = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const d = json(join(build, 'routes', 'triage.json'));
  assert.deepEqual([d.v, d.route, d.module, d.machine, d.effectKind, d.decision, d.budget], [1, 'triage', 'desk', 'desk.triage.Route', 'route.triage.call', { machine: 'desk.Ticket', name: 'classify' }, 'support']);
  assert.deepEqual(d.escalate, [{ on: 'conf', below: 800 }, { on: 'margin', below: 100 }, { on: 'failed' }]);
  const [small, large] = d.tiers;
  // 4000 tokens at 0.40 per million: 1,600 micro-units; 8000 at 15 per million: 120,000 (PS18.3).
  assert.deepEqual([small.name, small.provider, small.model, small.maxTokens, small.reservation], ['small', 'flash', 'flash-2026-09', 4000, 1600]);
  assert.deepEqual([large.name, large.provider, large.model, large.maxTokens, large.reservation], ['large', 'opus', 'opus-2026-08', 8000, 120_000]);
  assert.equal(small.prices.digest, sha(join(dir, 'prices', 'flash.json')));
  assert.deepEqual(small.prices.perMillionTokens, { input: 100_000, output: 400_000 });
  assert.equal(large.calibration.digest, sha(join(dir, 'maps', 'opus.json')));
  assert.equal(large.calibration.fittedFor, 'opus-2026-08');
  assert.deepEqual(json(join(build, 'budgets', 'support.json')), { v: 1, budget: 'support', module: 'desk', machine: 'desk.support.Budget', caps: [{ currency: 'usd', amount: 500_000, run: true, period: null, scope: false }, { currency: 'usd', amount: 20_000_000, run: false, period: 'day', scope: true }], onExhausted: 'escalate' });
  const ticket = r.machines.find((m) => m.machine === 'Ticket');
  assert.ok(ticket.artefactDigests['../routes/triage.json'] && ticket.artefactDigests['../budgets/support.json']);
});

test('PL6841: a route that escalates on conf or margin has a calibration map for every tier', { timeout: 300_000 }, async () => {
  const { r } = await check(swap(SRC, ' calibration "maps/opus.json"', ''));
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL6841' && /tier large/.test(d.message)), text(r));
  // Escalating on failure alone reads no confidence, so a tier with no map is allowed. Its condition is false, so the
  // rule that an answer below the thresholds escalates holds vacuously, and the check says so rather than read CLEAN.
  const ok = await check(swap(swap(SRC, ' calibration "maps/opus.json"', ''), 'escalate when conf < 0.8 or margin < 0.1 or failed', 'escalate when failed'));
  assert.ok(!codes(ok.r).includes('PL6841'), text(ok.r));
  assert.equal(ok.r.verdict, 'INCONCLUSIVE', text(ok.r));
  const route = ok.r.machines.find((m) => m.machine === 'triage.Route');
  assert.deepEqual(route.vacuous.map((v) => v.property), ['below-thresholds-escalates']);
  assert.ok(ok.r.machines.filter((m) => m !== route).every((m) => m.verdict === 'CLEAN'));
});

test('PL6843: a price table that does not name its source and the date it was read is refused', { timeout: 300_000 }, async () => {
  const table = json(join(FIX, 'prices', 'opus.json'));
  delete table.readOn;
  const { r } = await check(SRC, { 'prices/opus.json': table });
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL6843' && /prices\/opus\.json/.test(d.message)), text(r));
});

test('PL6844, PL6845: one currency per route and budget, and no tier reserving above a cap', { timeout: 300_000 }, async () => {
  const eur = { ...json(join(FIX, 'prices', 'opus.json')), currency: 'eur' };
  const a = await check(SRC, { 'prices/opus.json': eur });
  assert.ok(codes(a.r).includes('PL6844'), text(a.r));
  const b = await check(swap(SRC, 'cap usd 0.5 per run', 'cap gbp 0.5 per run'));
  assert.ok(codes(b.r).includes('PL6844'), text(b.r));
  // 0.1 per run is 100,000 micro-units, below the large tier's reservation of 120,000.
  const c = await check(swap(SRC, 'cap usd 0.5 per run', 'cap usd 0.1 per run'));
  assert.equal(c.r.verdict, 'REFUSED');
  assert.ok(all(c.r).some((d) => d.code === 'PL6845' && /tier large/.test(d.message)), text(c.r));
});

test('PT10r: the files a route names, and what a routed decision may be, are checked', { timeout: 300_000 }, async () => {
  const cases = [
    [swap(SRC, '"prices/opus.json"', '"../prices/opus.json"'), {}, 'PL1201', /relative path/],
    [swap(SRC, '"prices/opus.json"', '"prices/none.json"'), {}, 'PL1001', /no price table/],
    [swap(SRC, '"maps/opus.json"', '"maps/none.json"'), {}, 'PL1001', /no calibration map/],
    [SRC, { 'maps/opus.json': { ...json(join(FIX, 'maps', 'opus.json')), digest: `sha256:${'0'.repeat(64)}` } }, 'PL1201', /digest/],
    [SRC, { 'maps/opus.json': { ...json(join(FIX, 'maps', 'opus.json')), points: [[0, 500], [500, 400]] } }, 'PL1201', /non-decreasing|digest/],
    [swap(SRC, '    route triage\n', '    route triage\n    provider "jev"\n'), {}, 'PL1201', /names no provider/],
    [swap(SRC, '    route triage\n', '    route other\n'), {}, 'PL1001', /route other/],
    [swap(SRC, '  budget support\n}', '  budget elsewhere\n}'), {}, 'PL1001', /budget elsewhere/],
    [swap(SRC, 'tier large provider "opus"', 'tier small provider "opus"'), {}, 'PL1002', /two tiers small/],
    [swap(SRC, '  cap usd 20 per day per scope\n', '  cap usd 20 per run\n'), {}, 'PL1002', /two caps per run/],
    [swap(SRC, 'conf < 0.8', 'conf < 0.0'), {}, 'PL1201', /0 < c <= 1/],
    [swap(SRC, 'budget support {', 'budget triage {').split('budget support\n}').join('budget triage\n}'), {}, 'PL1002', /triage/],
  ];
  for (const [src, files, code, re] of cases) {
    const { r } = await check(src, files);
    assert.equal(r.verdict, 'REFUSED', `${code} ${re}`);
    assert.ok(all(r).some((d) => d.code === code && re.test(d.message)), `${code} ${re}: ${text(r)}`);
  }
});

test('PS18.2: a route serves one decision', { timeout: 300_000 }, async () => {
  const two = swap(SRC, '  path property one-classification', `  decision again(text: string) -> Branch {
    route triage
    labels { egress:external }
    timeout 800ms
    ok(r) -> Classified(branch: r.answer, conf: r.conf, margin: r.margin)
    failed -> Unclassified()
  }

  path property one-classification`);
  const { r } = await check(two);
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL1201' && /serves one decision/.test(d.message)), text(r));
});

test('PT10r, PT24.5: admission certifies the route and the budget, each tier with its provider, model and map; load reads them', { timeout: 300_000 }, async () => {
  const { admittedDesk } = await import('./routing-helpers.mjs');
  const { loaded } = await import('./runtime-helpers.mjs');
  const a = await admittedDesk('routing-decl-admit');
  const poly = a.cert.poly;
  assert.deepEqual(poly.routes.map((r) => r.name), ['triage']);
  assert.deepEqual(poly.budgets.map((b) => b.name), ['support']);
  const d = poly.decisions.find((x) => x.kind === 'decision.classify');
  assert.deepEqual([d.route, d.modelBound, d.calibration, d.provider], ['triage', true, 'certified per tier', null]);
  assert.deepEqual(d.tiers.map((t) => [t.name, t.provider, t.model]), [['small', 'flash', 'flash-2026-09'], ['large', 'opus', 'opus-2026-08']]);
  assert.equal(d.tiers[1].calibration, json(join(FIX, 'maps', 'opus.json')).digest);
  assert.ok(poly.kernelAssumptions.includes('K15'));
  for (const p of [...poly.routes, ...poly.budgets]) assert.ok(a.cert.artefacts[p.descriptor], p.descriptor);
  const { rt } = await loaded(a);
  await rt.close();
  // A descriptor changed after admission is refused at load, as every certified artefact is.
  const file = join(a.dir, poly.budgets[0].descriptor);
  writeFileSync(file, readFileSync(file, 'utf8').replace('20000000', '90000000'));
  await assert.rejects(loaded(a), /refused at load/);
});
