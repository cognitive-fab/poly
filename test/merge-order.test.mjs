// The merge of M10 and M11 (PT10k, PS17.4, PS18.4): the checks before the policy run in one order, the memory check
// (the flow rule and freshness), the budget's fit, the grant check, the mandate, then the policy, and the first that
// refuses decides. A routed decision over a body with no taint record, under a budget too small for any call, is denied
// audience at the decision's own intent: its route never starts, so no call is checked against the budget, no budget
// verdict is recorded and nothing is reserved. F1 refused this program PL6839 (1302e534); S402 admits it again, so the test
// runs as it did at the merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedProvider } from '@poly/runtime';
import { loaded } from './runtime-helpers.mjs';
import { admittedDesk, answer, DESK } from './routing-helpers.mjs';

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };

test('PT10k, PS18.4: a call that breaks the flow rule and the budget is denied audience, with no budget verdict and no reservation', { timeout: 300_000 }, async () => {
  let src = swap(DESK, 'enum Branch', 'audience { public < customer }\n\nenum Branch');
  src = swap(src, '  action Received(text: string check { "where is my refund" })', '  action Received(text: string check { "where is my refund" }, note: Content)');
  src = swap(src, '  on Received(text) {', '  on Received(text, note) {');
  src = swap(src, '    decide classify(text)', '    decide classify(text, note)');
  src = swap(src, '  decision classify(text: string) -> Branch {', '  decision classify(text: string, note: Content) -> Branch {');
  // A cap each tier's reservation fits alone (PL6845), and that the large tier's breaks once the small tier spent its own.
  src = swap(src, '  cap usd 0.5 per run', '  cap usd 0.127 per run');
  const a = await admittedDesk('merge-order', src);
  // The control: with a taint record, the small tier answers below the thresholds at its full reservation, and the
  // large tier's call breaks the budget, escalated budget as the budget says.
  {
    const { rt } = await loaded(a);
    try {
      rt.provideTier('flash', recordedProvider([{ match: { tier: 'small' }, ...answer('Refund', 0.5, { input: 2000, output: 4000 }) }]));
      rt.provideTier('opus', recordedProvider([{ match: { tier: 'large' }, ...answer('Refund', 0.95) }]));
      const note = await rt.putContent('A note.');
      await rt.create('desk.Ticket', { id: 't-0' });
      await rt.dispatch('t-0', 'Received', { text: 'where is my refund', note });
      for (let i = 0; i < 8; i++) await rt.worker.tick();
      const all = rt.store.db.prepare("SELECT event FROM poly_ledger WHERE kind = 'verdict'").all().map((r) => JSON.parse(r.event).body).filter((b) => b.effectKind);
      assert.ok(all.some((b) => b.reason === 'budget'), 'the control breaks the budget (escalated, as the budget says on exhausted): ' + JSON.stringify(all.map((b) => [b.effectKind, b.outcome, b.reason ?? null])));
    } finally { await rt.close(); }
  }
  const { rt } = await loaded(a);
  try {
    rt.provideTier('flash', recordedProvider([{ match: { tier: 'small' }, ...answer('Refund', 0.5, { input: 2000, output: 4000 }) }]));
    rt.provideTier('opus', recordedProvider([{ match: { tier: 'large' }, ...answer('Refund', 0.95) }]));
    const note = await rt.putContent('A note with no taint record.');
    rt.store.db.prepare('DELETE FROM poly_taint WHERE digest = ?').run(note);
    await rt.create('desk.Ticket', { id: 't-1' });
    await rt.dispatch('t-1', 'Received', { text: 'where is my refund', note });
    for (let i = 0; i < 6; i++) await rt.worker.tick();
    const verdicts = rt.store.db.prepare("SELECT run, event FROM poly_ledger WHERE kind = 'verdict'").all().map((r) => [r.run, JSON.parse(r.event).body]).filter(([, b]) => b.effectKind);
    const v = verdicts.filter(([run]) => run === 't-1').map(([, b]) => [b.effectKind, b.outcome, b.reason ?? null]);
    assert.deepEqual(v, [['decision.classify', 'denied', 'audience']], JSON.stringify(verdicts));
    assert.ok(!verdicts.some(([, b]) => b.reason === 'budget'), 'no budget verdict');
    assert.equal(rt.store.db.prepare('SELECT count(*) AS n FROM poly_route').get().n, 0, 'the route never started');
    const reserves = rt.store.db.prepare("SELECT count(*) AS n FROM pr_journal WHERE action = 'Reserve'").get().n;
    assert.equal(reserves, 0, 'nothing reserved');
  } finally { await rt.close(); }
});
