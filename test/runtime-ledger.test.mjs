// The ledger in the step's transaction (PT16, S121, S122) and the K9 refusal through the runtime API (M4d).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import { genesis } from '@cognitive-fab/polyflow-kernel';
import { RefusedError } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const a = await admitted('ledger', ['conformance/m1/children.poly']);

test('every journal row has exactly one step event, chained on its run, with the digests of its bodies', async () => {
  const { rt } = await loaded(a);
  try {
    const o = await rt.create('shop.Order', { id: 'o-1' });
    await rt.dispatch(o.id, 'Checkout');
    await rt.dispatch(o.id, 'Checkout'); // rejected: not-open
    await rt.dispatch(o.id, 'Hurry');
    const journal = await rt.getJournal(o.id);
    const chain = await rt.chain(o.id);
    const steps = chain.filter((e) => e.kind === 'step');
    assert.equal(steps.length, journal.length);
    assert.deepEqual(chain[0].run, { ns: 'shop', wf: 'shop.Order', run: 'o-1' });
    assert.equal(chain[0].prev, genesis(chain[0].run));
    for (const [i, row] of journal.entries()) {
      const b = steps[i].body;
      assert.equal(b.seq, row.seq);
      assert.equal(b.action, row.action);
      assert.equal(b.stepKind, row.step_kind);
      assert.equal(b.rejectReason, row.reject_reason);
      for (const k of ['data', 'pre', 'post']) {
        assert.equal(b[k], digest(row[k]), `${row.seq} ${k}`);
        assert.deepEqual(await rt.store.body(b[k]), row[k]);
      }
    }
    assert.deepEqual(await rt.verifyChain(o.id), { ok: true, head: { seq: chain.length - 1, hash: chain.at(-1).hash }, count: chain.length });
    // The attached child steps in the cascade; its rows are chained on its own run.
    const [child] = await rt.list('shop.Shipment');
    const childChain = await rt.chain(child.instance_id);
    assert.equal(childChain.filter((e) => e.kind === 'step').length, (await rt.getJournal(child.instance_id)).length);
  } finally { await rt.close(); }
});

test('K1 extends to the ledger: a fault inside the step\'s transaction leaves neither the step nor its event', async () => {
  const { rt } = await loaded(a);
  try {
    const o = await rt.create('shop.Order', { id: 'o-2' });
    const before = (await rt.chain(o.id)).length;
    for (const point of ['after-journal', 'after-instance', 'after-outbox', 'after-timers']) {
      rt.store.fault = (p) => { if (p === point) throw new Error(`injected at ${p}`); };
      await assert.rejects(rt.dispatch(o.id, 'Checkout'), /injected/);
      rt.store.fault = null;
      assert.equal((await rt.getJournal(o.id)).length, 1, point);
      assert.equal((await rt.chain(o.id)).length, before, point);
    }
    assert.equal((await rt.dispatch(o.id, 'Checkout')).stepKind, 'accepted');
    assert.equal((await rt.chain(o.id)).length, before + 1);
    // The failed attempts left no child behind; the one that committed made one, chained on its own run.
    assert.equal((await rt.list('shop.Shipment')).length, 1);
  } catch (e) { rt.store.fault = null; throw e; } finally { await rt.close(); }
});

test('a changed event is found by the verifier at its seq', async () => {
  const { rt } = await loaded(a);
  try {
    const o = await rt.create('shop.Order', { id: 'o-3' });
    await rt.dispatch(o.id, 'Checkout');
    const row = rt.store.db.prepare('SELECT event FROM poly_ledger WHERE run = ? AND seq = 1').get(o.id);
    const e = JSON.parse(row.event);
    e.body.stepKind = 'rejected';
    rt.store.db.prepare('UPDATE poly_ledger SET event = ? WHERE run = ? AND seq = 1').run(JSON.stringify(e), o.id);
    assert.deepEqual(await rt.verifyChain(o.id), { ok: false, seq: 1, reason: 'hash does not match content' });
  } finally { await rt.close(); }
});

test('an advice event is chained and changes no state (PT16)', async () => {
  const { rt } = await loaded(a);
  try {
    const o = await rt.create('shop.Order', { id: 'o-4' });
    const before = await rt.getState(o.id);
    const ev = await rt.advise(o.id, { rule: 'r-1', verdict: 'suspicious' });
    assert.equal(ev.kind, 'advice');
    assert.deepEqual(await rt.getState(o.id), before);
    assert.equal((await rt.verifyChain(o.id)).ok, true);
  } finally { await rt.close(); }
});

test('M4d: an outside dispatch of a live child\'s completion is refused (K9): an error, an audit row, no step, no event', async () => {
  const { rt } = await loaded(a);
  try {
    const o = await rt.create('shop.Order', { id: 'o-5' });
    await rt.dispatch(o.id, 'Checkout');
    const journal = (await rt.getJournal(o.id)).length;
    const chain = (await rt.chain(o.id)).length;
    await assert.rejects(rt.dispatch(o.id, 'Shipped', {}, { actionId: 'outside-1' }), (e) => e instanceof RefusedError && e.rule === 'K9' && /K9/.test(e.message));
    assert.equal((await rt.getJournal(o.id)).length, journal);
    assert.equal((await rt.chain(o.id)).length, chain);
    const audit = await rt.audit(o.id);
    assert.deepEqual(audit.map((r) => [r.action, r.action_id, r.rule]), [['Shipped', 'outside-1', 'K9']]);
    // The kernel still delivers it, in the cascade, when the child ends.
    await rt.dispatch(o.id, 'Hurry');
    const [child] = await rt.list('shop.Shipment');
    await rt.dispatch(child.instance_id, 'Deliver');
    assert.equal((await rt.getState(o.id)).state.status, 'Done');
    assert.equal((await rt.verifyChain(o.id)).ok, true);
  } finally { await rt.close(); }
});
