// Signed heads, the anchor, closure at archive and the verification of a run (PT16, S122, S123, S131).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyChain as polyflowVerifyChain } from '@cognitive-fab/polyflow-kernel';
import { verifyAnchor, polyflowAcceptsPolyKinds } from '@poly/runtime';
import { admitted, loaded, makeKey } from './runtime-helpers.mjs';

const a = await admitted('journal', ['conformance/m1/children.poly']);
const signer = makeKey('ledger');
const ledger = { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') };
const trust = { [signer.id]: signer.publicKey };

test('a live run verifies as open-and-signed through its newest head, never as fully signed (S123)', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-1' });
    assert.equal((await rt.verifyRun(o.id, trust)).verdict, 'open-unsigned');
    await rt.signHeads();
    const v1 = await rt.verifyRun(o.id, trust);
    assert.deepEqual([v1.verdict, v1.signedThrough, v1.unsignedTail], ['open-and-signed', 0, 0]);
    await rt.dispatch(o.id, 'Checkout');
    const v2 = await rt.verifyRun(o.id, trust);
    assert.deepEqual([v2.verdict, v2.signedThrough, v2.unsignedTail], ['open-and-signed', 0, 1]);
    assert.deepEqual((await rt.signHeads()).map((h) => [h.run.run, h.seq]).filter(([r]) => r === 'j-1'), [['j-1', 1]]);
    assert.deepEqual((await rt.signHeads()), [], 'a run that did not move is not signed again');
  } finally { await rt.close(); }
});

test('a forged head, a head by an untrusted key, and a journal row changed after its step are not ok', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-2' });
    await rt.dispatch(o.id, 'Checkout');
    await rt.signHeads();
    assert.equal((await rt.verifyRun(o.id, { [signer.id]: makeKey('other').publicKey })).verdict, 'not-ok');
    rt.store.db.prepare("UPDATE pr_journal SET data = '{\"x\":1}' WHERE instance_id = ? AND seq = 1").run(o.id);
    const v = await rt.verifyRun(o.id, trust);
    assert.equal(v.verdict, 'not-ok');
    assert.match(v.problems.join('; '), /journal row 1 differs from its step event/);
  } finally { await rt.close(); }
});

test('archive writes the closure, purges, and signs: the run verifies closed-and-signed without its journal', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-3' });
    await rt.dispatch(o.id, 'Cancel');
    const closure = await rt.archive(o.id);
    assert.equal(closure.kind, 'closure');
    assert.equal(await rt.store.getInstance(o.id), null);
    const v = await rt.verifyRun(o.id, trust);
    assert.deepEqual([v.verdict, v.closed, v.unsignedTail], ['closed-and-signed', true, 0]);
    const exported = await rt.exportRun(o.id);
    assert.equal(exported.events.length, 3);
    for (const e of exported.events.filter((x) => x.kind === 'step')) assert.ok(e.body.post in exported.bodies);
  } finally { await rt.close(); }
});

test('an archive polyrun refuses (a live instance) writes no closure', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-4' });
    await rt.dispatch(o.id, 'Checkout');
    const before = (await rt.chain(o.id)).length;
    await assert.rejects(rt.archive(o.id));
    assert.equal((await rt.chain(o.id)).length, before);
  } finally { await rt.close(); }
});

test('the anchor roots every run\'s latest signed head; a dropped run or an untrusted key does not verify', async () => {
  const { rt, clock } = await loaded(a, { ledger });
  try {
    for (const id of ['j-5', 'j-6', 'j-7']) { const o = await rt.create('shop.Order', { id }); await rt.dispatch(o.id, 'Checkout'); }
    await rt.signHeads();
    const from = clock.now();
    clock.advance(60_000);
    const { anchor, heads } = await rt.publishAnchor({ from, to: clock.now() });
    assert.equal(anchor.runs, heads.length);
    assert.ok(heads.length >= 6, 'three orders and their three shipments');
    assert.deepEqual(verifyAnchor(anchor, heads, trust), []);
    assert.match(verifyAnchor(anchor, heads.slice(1), trust).join('; '), /dropped, added or changed/);
    assert.match(verifyAnchor(anchor, heads, { [signer.id]: makeKey('x').publicKey }).join('; '), /does not verify/);
  } finally { await rt.close(); }
});

test('polyflow\'s own verifier accepts poly\'s chains once E2 is vendored (S122)',
  polyflowAcceptsPolyKinds() ? {} : { todo: 'waiting on E2: polyflow\'s KINDS refuses step, advice, decision and outcome' },
  async () => {
    if (!polyflowAcceptsPolyKinds()) return;
    const { rt } = await loaded(a, { ledger });
    try {
      const o = await rt.create('shop.Order', { id: 'j-8' });
      await rt.dispatch(o.id, 'Checkout');
      assert.equal(polyflowVerifyChain(await rt.chain(o.id)).ok, true);
    } finally { await rt.close(); }
  });

test('review B6: an archived instance\'s id is not created again, so its closed chain is never extended', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-reuse' });
    await rt.dispatch(o.id, 'Cancel');
    await rt.archive(o.id);
    const before = (await rt.chain(o.id)).length;
    await assert.rejects(rt.create('shop.Order', { id: 'j-reuse' }), /archived/);
    assert.equal((await rt.chain(o.id)).length, before);
    assert.equal((await rt.verifyRun(o.id, trust)).verdict, 'closed-and-signed');
  } finally { await rt.close(); }
});

test('review B8: no event is appended after a closure, and a chain with one is not ok', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-after' });
    await rt.dispatch(o.id, 'Cancel');
    await rt.archive(o.id);
    const before = await rt.chain(o.id);
    await assert.rejects(rt.advise(o.id, { rule: 'late', verdict: 'after the end' }), /closed/);
    assert.equal((await rt.chain(o.id)).length, before.length);
    // An event written past the store's refusal is still found by verification.
    const { verifyRun } = await import('@poly/runtime');
    const { nextEvent } = await import('@poly/runtime');
    const last = before.at(-1);
    const late = nextEvent(last.run, { seq: last.seq, hash: last.hash }, 'advice', { rule: 'late' }, last.at + 1);
    const v = verifyRun([...before, late], [], trust, null);
    assert.match(v.problems.join('; '), /seq \d+ follows the closure/);
  } finally { await rt.close(); }
});

test('review B9: a journal row whose action id or machine version changed differs from its step event', async () => {
  const { rt } = await loaded(a, { ledger });
  try {
    const o = await rt.create('shop.Order', { id: 'j-bind' });
    await rt.dispatch(o.id, 'Checkout', {}, { actionId: 'req-1' });
    assert.equal((await rt.verifyRun(o.id, trust)).problems.length, 0);
    rt.store.db.prepare("UPDATE pr_journal SET action_id = 'req-forged' WHERE instance_id = ? AND seq = 1").run(o.id);
    assert.match((await rt.verifyRun(o.id, trust)).problems.join('; '), /journal row 1 differs from its step event/);
    rt.store.db.prepare("UPDATE pr_journal SET action_id = 'req-1', machine_version = 'v-forged' WHERE instance_id = ? AND seq = 1").run(o.id);
    assert.match((await rt.verifyRun(o.id, trust)).problems.join('; '), /journal row 1 differs from its step event/);
  } finally { await rt.close(); }
});
