// S454 (PS18.4a, PT10r): a budget on an unrouted decision. A decision that names a provider may name its price table,
// both token limits and a budget in one clause; its call then reserves its worst-case cost on the budget before the
// policy, settles with its reported cost, and is released when it has no answer. S361 is unchanged: a call with no
// usage report is charged its full reservation. Written from the specification text alone (decisions-v1, "S454,
// accepted": drafts stop at the monthly cap). No test calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile } from '@poly/check';
import { load } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT, TEST_STD } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'decision-budget');
const M11 = join(ROOT, 'test', 'fixtures', 'm11');
const SRC = readFileSync(join(FIX, 'writer.poly'), 'utf8');
const DESK = readFileSync(join(M11, 'desk.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-decision-budget');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const TEXT = { text: 'draft a reply' };
const CLAUSE = '    prices "prices/flash.json" max input tokens 2000 max tokens 4000 budget monthly\n';
// PS18.3, S360: 2000 input tokens at 100,000 and 4000 output at 400,000 micro-units per million: 200 + 1,600.
const RESERVATION = 1800;

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

let n = 0;
/** Checks a source in a fresh directory holding the fixtures' price tables (and the M11 maps), `files` written over them. */
async function check(src, files = {}, name = 'writer.poly') {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(M11, 'prices'), join(d, 'prices'), { recursive: true });
  cpSync(join(M11, 'maps'), join(d, 'maps'), { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), typeof body === 'string' ? body : JSON.stringify(body));
  writeFileSync(join(d, name), src);
  return { r: await checkFile(join(d, name), { root: d, std: TEST_STD }), dir: d, build: join(d, '.poly', 'build') };
}

/** Admits a writer source (the fixture, or a variant of it) as a project, with its price table beside it. */
async function admittedWriter(name, src = SRC) {
  const key = makeKey(name);
  const dir = project(name, ['test/fixtures/decision-budget/writer.poly'], key, 'test-decision-budget');
  writeFileSync(join(dir, 'src', 'writer.poly'), src);
  cpSync(join(FIX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, cert: r.certificate };
}

/** A recorded provider of the draft: each call answers in turn, and every question is kept. */
function drafts(answers) {
  const asked = [];
  const provider = (q) => {
    asked.push(q);
    const next = answers[Math.min(asked.length - 1, answers.length - 1)];
    if (next.fail) throw new Error(next.fail);
    return next;
  };
  return { provider, asked };
}
const tone = (t, p, usage) => ({ answer: t, distribution: [[t, p], ['Other', Math.max(0, 1 - p)]], ...(usage === undefined ? {} : { usage }) });

async function write(rt, id) {
  await rt.create('writer.Draft', { id });
  await rt.dispatch(id, 'Requested', TEXT);
  for (let i = 0; i < 4; i++) await rt.worker.tick();
}

/** Every state the instance took, folded from its journal's step events, oldest first. */
async function states(rt, instance) {
  const out = [];
  for (const e of await rt.chain(instance)) if (e.kind === 'step' && e.body.stepKind === 'accepted') out.push({ action: e.body.action, post: await rt.store.body(e.body.post) });
  return out;
}
const budgetsOf = (rt) => rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = 'writer.monthly.Budget' ORDER BY instance_id").all().map((r) => r.instance_id);
const held = (rt) => rt.store.db.prepare("SELECT COUNT(*) AS n FROM poly_reservation WHERE status = 'held'").get().n;
const verdicts = (rt) => rt.store.db.prepare("SELECT event FROM poly_ledger WHERE kind = 'verdict'").all().map((r) => JSON.parse(r.event).body);
const decisionsOf = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'decision').map((e) => e.body);
const within = (seen) => { for (const s of seen) assert.ok(s.post.spent + s.post.reserved <= s.post.cap + s.post.overrun, `${s.action}: spent ${s.post.spent} + reserved ${s.post.reserved} > cap ${s.post.cap} + overrun ${s.post.overrun}`); };

test('S454: a decision with a provider and the clause checks CLEAN, and its manifest entry records its budget, prices, limits and reservation', { timeout: 300_000 }, async () => {
  const { r, build } = await check(SRC);
  assert.ok(!codes(r).includes('PL1201') && !codes(r).includes('PL1001'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
  const manifest = json(join(build, 'writer.Draft', 'effects.manifest.json'));
  const d = manifest.effects['decision.draft'].decision;
  assert.equal(d.provider, 'flash');
  assert.ok(d.budget, JSON.stringify(d));
  assert.deepEqual([d.budget.budget, d.budget.maxInputTokens, d.budget.maxTokens, d.budget.reservation], ['monthly', 2000, 4000, RESERVATION]);
  const prices = typeof d.budget.prices === 'string' ? d.budget.prices : d.budget.prices?.path;
  assert.equal(prices, 'prices/flash.json', JSON.stringify(d.budget.prices));
  // The budget is written as for a route (PT10r).
  assert.deepEqual(json(join(build, 'budgets', 'monthly.json')), { v: 1, budget: 'monthly', module: 'writer', machine: 'writer.monthly.Budget', caps: [{ currency: 'usd', amount: 4000, run: false, period: 'month', scope: false }], onExhausted: 'deny' });
});

test('S454: a budget with no prices or limits, or with a route, is PL1201; an undeclared budget is PL1001', { timeout: 300_000 }, async () => {
  const cases = [
    [swap(SRC, CLAUSE, '    budget monthly\n'), 'PL1201'],
    [swap(SRC, 'budget monthly\n', 'budget nowhere\n'), 'PL1001'],
  ];
  for (const [src, code] of cases) {
    const { r } = await check(src);
    assert.equal(r.verdict, 'REFUSED', `${code}: ${text(r)}`);
    assert.ok(codes(r).includes(code), `${code}: ${text(r)}`);
  }
  // A routed decision names its budget on its route, never with the clause.
  const routed = swap(DESK, '    route triage\n', '    route triage\n    prices "prices/flash.json" max input tokens 2000 max tokens 4000 budget support\n');
  const { r } = await check(routed, {}, 'desk.poly');
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
});

test('S454: PL6843, PL6844 and PL6845 apply to the decision\'s price table and budget as to a tier\'s', { timeout: 300_000 }, async () => {
  // 0.001 usd a month is 1,000 micro-units, below the reservation of 1,800.
  const c = await check(swap(SRC, 'cap usd 0.004 per month', 'cap usd 0.001 per month'));
  assert.equal(c.r.verdict, 'REFUSED', text(c.r));
  assert.ok(codes(c.r).includes('PL6845'), text(c.r));
  const eur = await check(swap(SRC, 'cap usd 0.004 per month', 'cap eur 0.004 per month'));
  assert.ok(codes(eur.r).includes('PL6844'), text(eur.r));
  const unsourced = json(join(FIX, 'prices', 'flash.json'));
  delete unsourced.readOn;
  const u = await check(SRC, { 'prices/flash.json': unsourced });
  assert.equal(u.r.verdict, 'REFUSED', text(u.r));
  assert.ok(codes(u.r).includes('PL6843'), text(u.r));
});

for (const onExhausted of ['deny', 'escalate']) {
  test(`S454: drafts stop at the monthly cap: two are answered and settled, the third is ${onExhausted === 'deny' ? 'denied' : 'escalated'} budget and never asked (on exhausted ${onExhausted})`, { timeout: 300_000 }, async () => {
    const src = onExhausted === 'deny' ? SRC : swap(SRC, '  cap usd 0.004 per month\n', '  cap usd 0.004 per month\n  on exhausted escalate\n');
    const a = await admittedWriter(`decision-budget-cap-${onExhausted}`, src);
    const { rt, clock } = await loaded(a);
    try {
      // Each call uses both of its limits, so it costs its reservation: two fit in 4,000 micro-units, and a third does not.
      const p = drafts([tone('Warm', 0.9, { input: 2000, output: 4000 })]);
      rt.provide('draft', { provider: p.provider, model: 'flash-2026-09' });
      for (const id of ['d-1', 'd-2', 'd-3']) await write(rt, id);
      assert.equal(p.asked.length, 2, 'the third draft never reached its provider');
      // K15: the provider is given both limits with the question.
      assert.deepEqual(p.asked[0].limits, { maxInputTokens: 2000, maxTokens: 4000 });
      assert.equal((await rt.getState('d-1')).state.status, 'Written');
      assert.equal((await rt.getState('d-2')).state.status, 'Written');
      // Each answered call's decision event records its usage, cost, reservation and prices (PS18.4a).
      for (const id of ['d-1', 'd-2']) {
        const [d] = await decisionsOf(rt, id);
        assert.ok(d, `${id}: a decision event`);
        assert.deepEqual([d.usage, d.cost, d.reservation], [{ input: 2000, output: 4000 }, { units: RESERVATION, unit: 'micro-usd' }, RESERVATION], id);
        assert.ok(d.prices, `${id}: the prices are recorded`);
      }
      // The proposal carried the budget, as a tier's does.
      const allowed = verdicts(rt).find((v) => v.effectKind === 'decision.draft' && v.outcome === 'allowed');
      assert.ok(allowed, 'an allowed draft');
      const proposal = await rt.store.body(allowed.proposal);
      assert.equal(proposal.budget?.budget, 'monthly', JSON.stringify(proposal));
      assert.equal(typeof proposal.budget.remaining, 'number');
      // The third is refused budget before any policy, as the budget says.
      const third = verdicts(rt).filter((v) => v.effectKind === 'decision.draft' && v.outcome !== 'allowed');
      const want = onExhausted === 'deny' ? 'denied' : 'escalated';
      assert.ok(third.some((v) => v.outcome === want && v.reason === 'budget'), JSON.stringify(third));
      assert.equal((await rt.getState('d-3')).state.status, onExhausted === 'deny' ? 'Unwritten' : 'Writing');
      assert.equal((await decisionsOf(rt, 'd-3')).length, 0);
      // One instance, per month, at the runtime's clock in UTC (PS18.4); spent plus reserved never passes the cap.
      const month = new Date(clock.now()).toISOString().slice(0, 7);
      assert.deepEqual(budgetsOf(rt), [`budget:monthly:month:${month}`]);
      const seen = await states(rt, `budget:monthly:month:${month}`);
      within(seen);
      assert.equal(seen.find((s) => s.action === 'Open').post.cap, 4000);
      assert.equal(seen.filter((s) => s.action === 'Reserve').length, 2);
      assert.equal(seen.filter((s) => s.action === 'Settle').length, 2);
      assert.equal(seen.filter((s) => s.action === 'Release').length, 0);
      const last = seen.at(-1).post;
      assert.deepEqual([last.spent, last.reserved, last.overrun], [2 * RESERVATION, 0, 0]);
      assert.equal(held(rt), 0);
    } finally { await rt.close(); }
  });
}

test('S454, S361: a draft whose provider reports no usage is charged its full reservation, recorded, and never released', { timeout: 300_000 }, async () => {
  const a = await admittedWriter('decision-budget-s361');
  const { rt, clock } = await loaded(a);
  try {
    const p = drafts([tone('Plain', 0.9)]);
    rt.provide('draft', { provider: p.provider, model: 'flash-2026-09' });
    await write(rt, 'm-1');
    assert.equal(p.asked.length, 1);
    assert.equal((await rt.getState('m-1')).state.status, 'Written');
    const [d] = await decisionsOf(rt, 'm-1');
    assert.ok(d, 'the call is recorded');
    assert.deepEqual([d.usageViolation, d.usage, d.cost], ['usage-missing', null, { units: RESERVATION, unit: 'micro-usd' }]);
    const seen = await states(rt, `budget:monthly:month:${new Date(clock.now()).toISOString().slice(0, 7)}`);
    within(seen);
    assert.equal(seen.filter((s) => s.action === 'Release').length, 0, 'never released for free');
    assert.equal(seen.filter((s) => s.action === 'Settle').length, 1);
    assert.deepEqual([seen.at(-1).post.spent, seen.at(-1).post.reserved], [RESERVATION, 0]);
    assert.equal(held(rt), 0);
  } finally { await rt.close(); }
});

test('S454: a draft whose call fails is released, and nothing stays reserved', { timeout: 300_000 }, async () => {
  const a = await admittedWriter('decision-budget-fail');
  const { rt, clock } = await loaded(a);
  try {
    const p = drafts([{ fail: 'provider unavailable' }]);
    rt.provide('draft', { provider: p.provider, model: 'flash-2026-09' });
    await write(rt, 'f-1');
    assert.equal(p.asked.length, 1, 'the call was made, once');
    assert.equal((await rt.getState('f-1')).state.status, 'Unwritten');
    const seen = await states(rt, `budget:monthly:month:${new Date(clock.now()).toISOString().slice(0, 7)}`);
    within(seen);
    assert.deepEqual(seen.filter((s) => ['Reserve', 'Settle', 'Release'].includes(s.action)).map((s) => s.action), ['Reserve', 'Release']);
    assert.deepEqual([seen.at(-1).post.spent, seen.at(-1).post.reserved], [0, 0]);
    assert.equal(held(rt), 0);
  } finally { await rt.close(); }
});

test('S454: poly cost sums the decision\'s calls from the ledger, by run, scope and day', { timeout: 300_000 }, async () => {
  const a = await admittedWriter('decision-budget-cost');
  const db = join(a.dir, 'run.db');
  rmSync(db, { force: true });
  const T0 = Date.UTC(2026, 9, 7, 12);
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, now: () => T0 });
  try {
    // 1000 input and 200 output tokens: 100 + 80 micro-units; the full limits: 1,800.
    const p = drafts([tone('Warm', 0.9, { input: 1000, output: 200 }), tone('Plain', 0.9, { input: 2000, output: 4000 })]);
    rt.provide('draft', { provider: p.provider, model: 'flash-2026-09' });
    await write(rt, 'c-1');
    await write(rt, 'c-2');
    assert.deepEqual([(await rt.getState('c-1')).state.status, (await rt.getState('c-2')).state.status], ['Written', 'Written']);
  } finally { await rt.close(); }
  const r = poly('cost', '--db', db, '--json');
  assert.equal(r.code, 0, r.out);
  const report = JSON.parse(r.out);
  assert.equal(report.calls, 2);
  assert.deepEqual(report.total, { usd: 1980 });
  assert.deepEqual(report.byRun, { 'c-1': { usd: 180 }, 'c-2': { usd: 1800 } });
  assert.deepEqual(report.byDay, { '2026-10-07': { usd: 1980 } });
  assert.equal(JSON.parse(poly('cost', '--db', db, '--run', 'c-1', '--json').out).calls, 1);
});
