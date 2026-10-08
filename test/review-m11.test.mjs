// The review of M11 (step 9): each finding fixed, with the test that failed on the code it found. Reviewer A read the
// checker and poly-ref, B the runtime, C admission, records, replay and `poly cost`. No test calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load, recordedProvider } from '@poly/runtime';
import { admit, checkFile, replayRuntime } from '@poly/check';
import { costOf } from '@poly/core';
import { printModule } from '@poly/embed';
import { parse } from '@poly/lang';
import { ACCEPT_TEST_ANCHORS, ROOT, TEST_STD } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';
import { admittedDesk, answer, DESK, FIX } from './routing-helpers.mjs';

const TEXT = { text: 'where is my refund' };
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const OUT = join(ROOT, '.poly', 'test-review-m11');
let n = 0;
async function check(src, file = 'desk.poly') {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  cpSync(join(FIX, 'prices'), join(d, 'prices'), { recursive: true });
  cpSync(join(FIX, 'maps'), join(d, 'maps'), { recursive: true });
  writeFileSync(join(d, file), src);
  return { r: await checkFile(join(d, file), { root: d, std: TEST_STD }), dir: d };
}
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)];
const reservations = (rt) => rt.store.db.prepare('SELECT intent, budget, amount, status FROM poly_reservation ORDER BY rowid').all();

test('review B1: a crash between the decision\'s HandlerOk and its SettleOk is taken again, and the decision completes', async () => {
  const a = await admittedDesk('review-m11-b1');
  const { rt, clock } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([answer('Status', 0.96)]));
    rt.provideTier('opus', recordedProvider([answer('Status', 0.96)]));
    await rt.create('desk.Ticket', { id: 'b1' });
    await rt.dispatch('b1', 'Received', TEXT);
    const commit = rt.store.commitStep.bind(rt.store);
    let crashed = 0;
    rt.store.commitStep = (step) => rt.store.txn(async () => {
      await commit(step);
      if (step.instanceId === 'b1' && step.journal.action === 'Classified' && !crashed++) throw new Error('crash before the commit');
    });
    for (let i = 0; i < 4; i++) await rt.worker.tick().catch((e) => { if (!/crash before the commit/.test(e.message)) throw e; });
    rt.store.commitStep = commit;
    for (let i = 0; i < 3; i++) { clock.advance(120_000); await rt.worker.tick(); }
    assert.ok(crashed >= 2, "the lost completion was taken again");
    assert.equal((await rt.getState('b1')).state.status, 'Routed');
    assert.equal(rt.store.db.prepare("SELECT status FROM pr_outbox WHERE kind = 'decision.classify'").get().status, 'done');
    assert.deepEqual(await rt.verifyProvenance('b1'), []);
  } finally { await rt.close(); }
});

test('review B2, C1: a call whose provider answered is settled with its cost and recorded, however its intent ends', async () => {
  const a = await admittedDesk('review-m11-b2');
  const { rt, clock } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([answer('Refund', 0.96, { input: 1000, output: 3000 })]));
    rt.provideTier('opus', recordedProvider([answer('Refund', 0.96)]));
    await rt.create('desk.Ticket', { id: 'b2' });
    await rt.dispatch('b2', 'Received', TEXT);
    // The small tier's completion is lost to a crash, after its provider answered.
    const commit = rt.store.commitStep.bind(rt.store);
    rt.store.commitStep = (step) => rt.store.txn(async () => {
      await commit(step);
      if (step.instanceId.startsWith('route:') && step.journal.action === 'Answer') throw new Error('crash before the commit');
    });
    for (let i = 0; i < 4; i++) await rt.worker.tick().catch((e) => { if (!/crash before the commit/.test(e.message)) throw e; });
    rt.store.commitStep = commit;
    clock.advance(61_000);
    for (let i = 0; i < 6; i++) await rt.worker.tick();
    const small = reservations(rt).filter((x) => x.amount === 1800);
    assert.ok(small.length === 2 && small.every((x) => x.status === 'settled'), JSON.stringify(small));
    // 1000 input and 3000 output tokens on the small tier: 100 + 1200 micro-units, charged though no completion came.
    const route = rt.store.db.prepare("SELECT instance FROM poly_route WHERE run = 'b2'").get().instance;
    const calls = (await rt.chain(route)).filter((e) => e.kind === 'decision').map((e) => e.body);
    const lost = calls.find((c) => c.tier === 'small');
    assert.deepEqual([lost.completed, lost.cost], [false, { units: 1300, unit: 'micro-usd' }]);
    const run = JSON.parse(rt.store.db.prepare("SELECT state FROM pr_instance WHERE instance_id LIKE 'budget:support:run:%'").get().state);
    assert.equal(run.spent, 1300 + 6000, 'the lost small call and the large one are both spent');
    const db = rt.store;
    void db;
  } finally { await rt.close(); }
  // A class named like an inherited property is priced as unpriced, at the table's highest price.
  const t = { perMillionTokens: { input: 100_000, output: 400_000 } };
  assert.deepEqual(costOf({ constructor: 10, toString: 10 }, t), { cost: 8, unpriced: ['constructor', 'toString'] });
});

test('review B3: a rechecked call that holds its reservation and is escalated releases it when the escalation times out', async () => {
  const a = await admittedDesk('review-m11-b3');
  const once = new Set();
  const gate = { propose: async (p) => (p.effectKind === 'route.triage.call' && p.rechecks ? { decision: 'escalate', reason: 'look again' } : { decision: 'allow' }), settle: async () => 'ok' };
  const { rt, clock } = await loaded(a, { gate: { gate, escalationTimeoutMs: 10_000 }, worker: { isStale: (row) => row.kind === 'route.triage.call' && !once.has(row.intent_id) && (once.add(row.intent_id), true) } });
  try {
    rt.provideTier('flash', recordedProvider([answer('Status', 0.96)]));
    rt.provideTier('opus', recordedProvider([answer('Status', 0.96)]));
    await rt.create('desk.Ticket', { id: 'b3' });
    await rt.dispatch('b3', 'Received', TEXT);
    for (let i = 0; i < 4; i++) await rt.worker.tick();
    assert.ok(reservations(rt).some((x) => x.status === 'held'));
    // Each tier's call is rechecked once and escalated, so each escalation's timeout passes in turn.
    for (let k = 0; k < 3; k++) { clock.advance(20_000); for (let i = 0; i < 6; i++) await rt.worker.tick(); }
    assert.ok(reservations(rt).every((x) => x.status !== 'held'), JSON.stringify(reservations(rt)));
    for (const r of rt.store.db.prepare("SELECT state FROM pr_instance WHERE machine_id = 'desk.support.Budget'").all()) assert.equal(JSON.parse(r.state).reserved, 0);
  } finally { await rt.close(); }
});

test('review A1: an embedded route or budget name that is not an identifier is refused before anything is written', async () => {
  const embedded = printModule(parse(DESK).module).split('"triage"').join('"../../../ESCROUTE"').split('"support"').join('"../../../ESCBUDGET"');
  const { r, dir } = await check(embedded, 'desk.ts');
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL1201' && /identifier/.test(d.message)), JSON.stringify(all(r).map((d) => d.message)));
  for (const f of [join(dir, 'ESCROUTE.json'), join(dir, 'ESCBUDGET.json'), join(dir, '..', 'ESCROUTE.json')]) assert.equal(existsSync(f), false, f);
});

test('review A2: a route whose escalation does not name failed is CLEAN: a failure exhausts it at any tier', { timeout: 300_000 }, async () => {
  const { r } = await check(swap(DESK, 'escalate when conf < 0.8 or margin < 0.1 or failed', 'escalate when conf < 0.8 or margin < 0.1'));
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`)));
});

test('review A5: a reservation beyond the safe integers is refused', async () => {
  // A token limit the lexer reads, whose reservation at 15 per million is beyond the integers an amount holds exactly.
  const { r } = await check(swap(DESK, 'max tokens 8000', 'max tokens 9000000000000000'));
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(all(r).some((d) => d.code === 'PL1201' && /beyond the integers/.test(d.message)), JSON.stringify(all(r).map((d) => d.message)));
});

test('review A3, C6: two modules of a project that declare one route name are refused at admission, saying so', { timeout: 300_000 }, async () => {
  const key = makeKey('review-m11-a3');
  const dir = project('review-m11-a3', ['test/fixtures/m11/desk.poly'], key, 'test-routing');
  for (const sub of ['prices', 'maps']) cpSync(join(FIX, sub), join(dir, 'src', sub), { recursive: true });
  writeFileSync(join(dir, 'src', 'helpdesk.poly'), swap(DESK, 'module desk', 'module helpdesk'));
  await assert.rejects(admit(dir), /route triage is declared in modules (desk and helpdesk|helpdesk and desk)/);
});

test('review C2 to C5: poly cost reprices only its provider\'s calls, refuses a broken chain, a missing store and a bad period', { timeout: 300_000 }, async () => {
  const a = await admittedDesk('review-m11-c');
  const db = join(a.dir, 'run.db');
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, now: () => Date.UTC(2026, 9, 7, 12) });
  try {
    rt.provideTier('flash', recordedProvider([answer('Refund', 0.6)]));
    rt.provideTier('opus', recordedProvider([answer('Refund', 0.96, { input: 2000, output: 1000 })]));
    await rt.create('desk.Ticket', { id: 'c-1' });
    await rt.dispatch('c-1', 'Received', TEXT);
    for (let i = 0; i < 6; i++) await rt.worker.tick();
  } finally { await rt.close(); }
  // C2: a table of another provider with the same model id prices nothing again.
  const other = join(a.dir, 'other.json');
  writeFileSync(other, JSON.stringify({ ...JSON.parse(readFileSync(join(FIX, 'prices', 'opus.json'), 'utf8')), provider: 'some-other-host' }));
  assert.equal(JSON.parse(poly('cost', '--db', db, '--prices', other, '--json').out).repriced.calls, 0);
  // C4: a store that does not exist is refused, and not created.
  const none = join(a.dir, 'none.db');
  assert.equal(poly('cost', '--db', none).code, 64);
  assert.equal(existsSync(none), false);
  // C5: a period that is no month or day is refused.
  for (const p of ['2026-1', '2026', '2026-10-3', '2026-02-30']) assert.equal(poly('cost', '--db', db, '--period', p).code, 64, p);
  // C3: a tier's decision event edited in the store is refused by poly cost and found by replay.
  const route = (() => { const s = new DatabaseSync(db); try { return s.prepare("SELECT instance FROM poly_route WHERE run = 'c-1'").get().instance; } finally { s.close(); } })();
  const s = new DatabaseSync(db);
  try {
    const e = s.prepare("SELECT seq, event FROM poly_ledger WHERE run = ? AND kind = 'decision' ORDER BY seq DESC LIMIT 1").get(route);
    const ev = JSON.parse(e.event);
    ev.body = { ...ev.body, tier: 'small', tierIndex: 0, cost: { units: 1, unit: 'micro-usd' }, usage: { input: 1 } };
    s.prepare('UPDATE poly_ledger SET event = ? WHERE run = ? AND seq = ?').run(JSON.stringify(ev), route, e.seq);
  } finally { s.close(); }
  const r = poly('cost', '--db', db, '--json');
  assert.notEqual(r.code, 0);
  assert.deepEqual(JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)).refused.map((x) => x.run), [route]);
  const rt2 = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db } });
  try {
    const replay = (await replayRuntime(rt2)).find((x) => x.run === route);
    assert.ok(replay.diagnostics.some((d) => /tier/.test(d.message)), JSON.stringify(replay.diagnostics.map((d) => d.message)));
  } finally { await rt2.close(); }
});

test('review C8: a certificate with a route lists what a call\'s cost does not count', { timeout: 300_000 }, async () => {
  const a = await admittedDesk('review-m11-c8');
  assert.ok(a.cert.poly.limits.some((l) => /K15/.test(l) && /released/.test(l) && /overrun/.test(l)));
});

test('polywatch on the rulings: a route with no budget records an answered call whose completion was lost', async () => {
  const a = await admittedDesk('review-m11-nobudget', swap(DESK, '  budget support\n}', '}'));
  const { rt, clock } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([answer('Refund', 0.96, { input: 1000, output: 3000 })]));
    rt.provideTier('opus', recordedProvider([answer('Refund', 0.96)]));
    await rt.create('desk.Ticket', { id: 'nb' });
    await rt.dispatch('nb', 'Received', TEXT);
    const commit = rt.store.commitStep.bind(rt.store);
    rt.store.commitStep = (step) => rt.store.txn(async () => {
      await commit(step);
      if (step.instanceId.startsWith('route:') && step.journal.action === 'Answer') throw new Error('crash before the commit');
    });
    for (let i = 0; i < 4; i++) await rt.worker.tick().catch((e) => { if (!/crash before the commit/.test(e.message)) throw e; });
    rt.store.commitStep = commit;
    clock.advance(61_000);
    for (let i = 0; i < 6; i++) await rt.worker.tick();
    assert.equal(reservations(rt).length, 0, 'no budget, no reservation');
    const route = rt.store.db.prepare("SELECT instance FROM poly_route WHERE run = 'nb'").get().instance;
    const lost = (await rt.chain(route)).filter((e) => e.kind === 'decision').map((e) => e.body).find((c) => c.tier === 'small');
    assert.ok(lost, 'the lost call is recorded');
    assert.deepEqual([lost.completed, lost.cost], [false, { units: 1300, unit: 'micro-usd' }]);
  } finally { await rt.close(); }
});
