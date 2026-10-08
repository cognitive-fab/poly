// M11 step 6 (AC26, PS18.4, S352 to S354, S357): budgets at run time. Every tier's call reserves before it is proposed
// and settles after; 64 concurrent runs in one scope never take spent plus reserved past the cap at any step of the
// budget's journal; an overrun is recorded in the settlement's verdict and the Budget instance, and the next
// reservation is refused when the overrun has used the remainder; a crash between the reservation and the completion
// leaves the reservation held until the intent dies, and it is released once. No test calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedProvider } from '@poly/runtime';
import { approveAs, loaded } from './runtime-helpers.mjs';
import { admittedDesk, DESK } from './routing-helpers.mjs';

const TEXT = { text: 'where is my refund' };
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };

/** Every state the instance took, folded from its journal's step events, oldest first. */
async function states(rt, instance) {
  const out = [];
  for (const e of await rt.chain(instance)) if (e.kind === 'step' && e.body.stepKind === 'accepted') out.push({ action: e.body.action, post: await rt.store.body(e.body.post) });
  return out;
}
const budgetsOf = (rt) => rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = 'desk.support.Budget' ORDER BY instance_id").all().map((r) => r.instance_id);

test('AC26: 64 concurrent runs in one scope: spent plus reserved never exceeds the cap at any step of the budget', { timeout: 600_000 }, async () => {
  // One cap, per day per scope, of 1 usd: seven large reservations of 0.126 fit in it at once, and each large call
  // costs 0.096, so about ten are answered before the remainder is spent and the rest are refused `budget`.
  const src = swap(swap(swap(DESK, '  cap usd 0.5 per run\n', ''), 'cap usd 20 per day per scope', 'cap usd 1 per day per scope'), '  on exhausted escalate\n', '');
  const a = await admittedDesk('budget-64', src);
  const { rt } = await loaded(a);
  try {
    // Every call waits until the test lets it answer, so reservations are held together, as concurrent runs hold them.
    const waiting = [];
    const hold = (inner) => (q) => new Promise((done) => waiting.push(() => done(inner(q))));
    rt.provideTier('flash', hold(recordedProvider([{ answer: 'Refund', distribution: [['Refund', 0.6], ['Other', 0.4]], usage: { input: 1000, output: 200 } }])));
    rt.provideTier('opus', hold(recordedProvider([{ answer: 'Refund', distribution: [['Refund', 0.96], ['Other', 0.04]], usage: { input: 2000, output: 6000 } }])));
    for (let i = 0; i < 64; i++) {
      await rt.create('desk.Ticket', { id: `t-${i}` });
      await rt.dispatch(`t-${i}`, 'Received', TEXT);
    }
    let maxHeld = 0;
    for (let round = 0; round < 40; round++) {
      let running = true;
      const ticks = Promise.all(Array.from({ length: 8 }, () => rt.worker.tick())).finally(() => { running = false; });
      // While the passes run, the calls that reached their providers are answered a few at a time, well within the
      // decision's timeout, after the reservations held at that moment are counted.
      while (running) {
        await new Promise((r) => setTimeout(r, 5));
        maxHeld = Math.max(maxHeld, rt.store.db.prepare("SELECT COUNT(*) AS n FROM poly_reservation WHERE status = 'held'").get().n);
        while (waiting.length) waiting.shift()();
      }
      await ticks;
      const open = rt.store.db.prepare("SELECT COUNT(*) AS n FROM pr_outbox WHERE status IN ('pending', 'inflight')").get().n;
      if (!open) break;
    }
    const done = await Promise.all(Array.from({ length: 64 }, async (_, i) => (await rt.getState(`t-${i}`)).state.status));
    assert.ok(done.every((s) => s === 'Routed' || s === 'NeedsHuman'), JSON.stringify(done));
    assert.ok(maxHeld > 1, `reservations were held together: at most ${maxHeld}`);
    const [only] = budgetsOf(rt);
    assert.match(only, /^budget:support:scope:desk:day:\d{4}-\d{2}-\d{2}$/);
    const seen = await states(rt, only);
    for (const s of seen) assert.ok(s.post.spent + s.post.reserved <= s.post.cap, `${s.action}: spent ${s.post.spent} + reserved ${s.post.reserved} > cap ${s.post.cap}`);
    assert.equal(seen.find((x) => x.action === 'Open').post.cap, 1_000_000);
    const last = seen[seen.length - 1].post;
    assert.deepEqual([last.reserved, last.overrun], [0, 0]);
    // The cap bound: some runs were answered and some refused, and every refusal says budget.
    assert.ok(done.includes('Routed') && done.includes('NeedsHuman'), JSON.stringify(done));
    const denied = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE kind = 'verdict'").all().map((r) => JSON.parse(r.event).body).filter((b) => b.outcome === 'denied');
    assert.ok(denied.length && denied.every((b) => b.reason === 'budget'), JSON.stringify(denied.slice(0, 3)));
    // Every reservation was settled or released, once.
    assert.equal(rt.store.db.prepare("SELECT COUNT(*) AS n FROM poly_reservation WHERE status = 'held'").get().n, 0);
    const reserves = seen.filter((s) => s.action === 'Reserve').length;
    const ends = seen.filter((s) => s.action === 'Settle' || s.action === 'Release').length;
    assert.equal(reserves, ends);
  } finally { await rt.close(); }
});

test('AC26, S352 as ruled: an overrun is recorded in the verdict and the budget, and the next reservation is refused when it used the remainder', { timeout: 300_000 }, async () => {
  const a = await admittedDesk('budget-overrun');
  const { rt } = await loaded(a);
  try {
    // The small tier reserves 1,800 micro-units and reports 2,000,000 output tokens: 800,000, above the run's cap of
    // 500,000. Its answer is below the thresholds, so the route asks the large tier, whose reservation must now fail.
    rt.provideTier('flash', recordedProvider([{ answer: 'Refund', distribution: [['Refund', 0.6], ['Other', 0.4]], usage: { output: 2_000_000 } }]));
    const opus = recordedProvider([{ answer: 'Refund', distribution: [['Refund', 0.96]], usage: { input: 10 } }]);
    rt.provideTier('opus', opus);
    await rt.create('desk.Ticket', { id: 'o-1' });
    await rt.dispatch('o-1', 'Received', TEXT);
    for (let i = 0; i < 6; i++) await rt.worker.tick();
    const run = budgetsOf(rt).find((b) => b.includes(':run:'));
    const after = (await states(rt, run)).at(-1).post;
    assert.deepEqual([after.spent, after.reserved, after.overrun, after.b], [800_000, 0, 798_200, 'Spent']);
    // The settlement's verdict names the overrun.
    const route = rt.store.db.prepare("SELECT instance FROM poly_route WHERE run = 'o-1'").get().instance;
    const settled = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.stage === 'budget');
    assert.deepEqual(settled[0].body.budgets.find((b) => b.instance === run), { instance: run, reserved: 1800, actual: 800_000, overrun: 798_200 });
    // The large tier's reservation does not fit, so before any policy the call is escalated, as the budget says
    // (on exhausted escalate), and nothing called opus.
    const escalated = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.outcome === 'escalated');
    assert.deepEqual(escalated.map((e) => e.body.reason), ['budget']);
    assert.equal(opus.asked.length, 0);
    assert.equal((await rt.getState('o-1')).state.status, 'Classifying');
    // A person's approval does not raise the cap: the approved call is read again, and denied budget (PS18.4).
    await approveAs(rt, escalated[0].body.intent);
    for (let i = 0; i < 6; i++) await rt.worker.tick();
    const denied = (await rt.chain(route)).filter((e) => e.kind === 'verdict' && e.body.outcome === 'denied');
    assert.deepEqual(denied.map((e) => e.body.reason), ['budget']);
    assert.equal(opus.asked.length, 0);
    assert.equal((await rt.getState('o-1')).state.status, 'NeedsHuman');
  } finally { await rt.close(); }
});

test('S352: a crash between the reservation and the completion leaves the reservation held; it is settled once when the intent dies', { timeout: 300_000 }, async () => {
  const a = await admittedDesk('budget-crash');
  const { rt, clock } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([{ answer: 'Status', distribution: [['Status', 0.96]], usage: { input: 1000 } }]));
    rt.provideTier('opus', recordedProvider([{ answer: 'Status', distribution: [['Status', 0.96]], usage: { input: 1000 } }]));
    await rt.create('desk.Ticket', { id: 'c-1' });
    await rt.dispatch('c-1', 'Received', TEXT);
    // The small tier's completion is lost to a crash before it commits.
    const commit = rt.store.commitStep.bind(rt.store);
    rt.store.commitStep = (step) => rt.store.txn(async () => {
      await commit(step);
      if (step.instanceId.startsWith('route:') && step.journal.action === 'Answer') throw new Error('crash before the commit');
    });
    for (let i = 0; i < 4; i++) await rt.worker.tick().catch((e) => { if (!/crash before the commit/.test(e.message)) throw e; });
    rt.store.commitStep = commit;
    const held = rt.store.db.prepare("SELECT budget, status FROM poly_reservation").all();
    assert.equal(held.length, 2, 'one reservation per cap');
    assert.ok(held.every((h) => h.status === 'held'), JSON.stringify(held));
    for (const b of budgetsOf(rt)) assert.equal((await states(rt, b)).at(-1).post.reserved, 1800);
    // After the lease, the worker finds the call's completion lost: the intent dies, and since its provider answered,
    // its reservation is settled with the call's cost, once (review B2); the route goes on.
    clock.advance(61_000);
    for (let i = 0; i < 6; i++) await rt.worker.tick();
    assert.ok(rt.store.db.prepare("SELECT status FROM poly_reservation").all().every((h) => h.status !== 'held'));
    for (const b of budgetsOf(rt)) {
      const s = await states(rt, b);
      assert.equal(s.at(-1).post.reserved, 0, `${b}: nothing stays reserved`);
      assert.equal(s.filter((x) => x.action === 'Release').length, 0, `${b}: an answered call is not released`);
      // Two calls settled, each once: the lost small call (1000 input tokens, 100 micro-units) and the large one.
      assert.deepEqual(s.filter((x) => x.action === 'Settle').map((x) => x.post.spent), [100, 3100], b);
    }
  } finally { await rt.close(); }
});
