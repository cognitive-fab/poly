// AC4 and M5a step 3 (PT9.3, S146, S147): the policy gate. A policy with a machine obligation over effect labels
// compiles, is admitted, and denies an irreversible effect in the forbidden state, with a witness and a signed
// receipt. Each decision is a verdict event with its session, sseq and Σ digests; a singleton the decision read
// is recorded with its seq, and an allow it has outlived is rechecked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyaxionPeer, LoadError, load } from '@poly/runtime';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';
import { ROOT } from './helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;
const verdicts = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict').map((e) => e.body);

async function ac4() {
  const a = await admitted('ac4-gate', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  const { rt, clock } = await loaded(a);
  const ran = [];
  handleWith(rt, 'stock.reserve', (p, caps, ctx) => { ran.push(ctx.instanceId); return 'ok'; });
  const h = rt.handlerExports('src/handlers.ts');
  rt.handle('payment.charge', h.handle);
  rt.handle('payment.fee', h.handle);
  return { a, rt, clock, ran };
}

test('AC4: the policy gate denies a charge before any reserve, with the reason, a witness and the session record', { skip }, async () => {
  const { rt } = await ac4();
  try {
    await rt.create('orders.Order', { id: 'o1' });
    await rt.dispatch('o1', 'Charge');
    await rt.worker.tick();
    const [v] = (await verdicts(rt, 'o1')).filter((b) => b.outcome === 'denied');
    assert.ok(v, 'a denied verdict');
    assert.match(v.reason, /charge-before-reserve/);
    assert.match(v.witness, /^sha256:/);
    assert.equal(v.session, 'scope:orders');
    assert.equal(v.sseq, 1);
    assert.match(v.stateBefore, /^sha256:/);
    const { verified } = await rt.policyGate.receipts('orders');
    assert.equal(verified.ok, true, JSON.stringify(verified));
  } finally { await rt.close(); }
});

test('AC4: an irreversible effect of a cancelled order is denied; after a reserve a charge is allowed and runs', { skip }, async () => {
  const { rt, ran } = await ac4();
  try {
    await rt.create('orders.Order', { id: 'c1' });
    await rt.dispatch('c1', 'Cancel');
    await rt.worker.tick();
    assert.match((await verdicts(rt, 'c1')).find((b) => b.outcome === 'denied').reason, /orders-irreversible/);
    await rt.create('orders.Order', { id: 'r1' });
    await rt.dispatch('r1', 'Reserve');
    await rt.worker.tick();
    assert.deepEqual(ran, ['r1']);
    await rt.create('orders.Order', { id: 'r2' });
    await rt.dispatch('r2', 'Charge');
    await rt.worker.tick();
    assert.ok((await verdicts(rt, 'r2')).some((b) => b.outcome === 'allowed'), 'the charge is allowed once stock was reserved in the scope');
    // S146: one session for the scope, its sequence strictly increasing over proposals and settles.
    const perMachine = await Promise.all(['c1', 'r1', 'r2'].map(async (id) => (await verdicts(rt, id)).filter((b) => b.sseq).map((b) => b.sseq)));
    // Within a machine's chain the sequence only rises, and across the scope no number repeats.
    for (const own of perMachine) assert.deepEqual(own, [...own].sort((x, y) => x - y), 'a chain\'s sequence rises');
    const seqs = perMachine.flat().sort((x, y) => x - y);
    assert.deepEqual(seqs, [...new Set(seqs)]);
    assert.ok(seqs.length >= 4, 'proposals and settles each take a sequence number');
  } finally { await rt.close(); }
});

test('PT9: a build with policies takes no other gate, and does not load without the engine', { skip }, async () => {
  const a = await admitted('ac4-gate-only', ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly']);
  await assert.rejects(load(a.build, { certificate: a.certificate, trust: a.trust, gate: { gate: { propose: () => ({ decision: 'allow' }), settle: () => 'ok' } } }), (e) => e instanceof LoadError && /policy gate/.test(e.message));
  const prev = process.env.POLY_POLYAXION_DIR;
  process.env.POLY_POLYAXION_DIR = 'C:/no/such/polyaxion';
  try {
    assert.equal(polyaxionPeer({ fresh: true }).ok, false);
    await assert.rejects(load(a.build, { certificate: a.certificate, trust: a.trust }), (e) => e instanceof LoadError && /gate engine is not available/.test(e.message));
  } finally {
    if (prev === undefined) delete process.env.POLY_POLYAXION_DIR; else process.env.POLY_POLYAXION_DIR = prev;
    polyaxionPeer({ fresh: true });
  }
});

/** The shop with its charge retried, which the retry-safety rule allows once the charge is keyed (G2): the stale-allow recheck is made on the retry. */
function retryingShop(name) {
  const dir = join(ROOT, '.poly', 'test-controls', name);
  mkdirSync(dir, { recursive: true });
  const text = readFileSync(join(ROOT, 'conformance/m5/shop.poly'), 'utf8').replace('    retry { attempts 1, base 10ms, timeout 1s }', '    retry { attempts 3, base 10ms, timeout 1s }\n    idempotent header "Idempotency-Key" window 1h');
  writeFileSync(join(dir, 'shop.poly'), text);
  return `.poly/test-controls/${name}/shop.poly`;
}

test('S147: an allow that read a singleton is not acted on once the singleton moved; the recheck is a new proposal', { skip }, async () => {
  const a = await admitted('s147', ['conformance/m5/switch.poly', retryingShop('s147-shop'), 'conformance/m5/shop.policy.poly']);
  const { rt, clock } = await loaded(a);
  try {
    let calls = 0;
    handleWith(rt, 'till.charge', () => { calls++; throw new Error('transient'); });
    await rt.create('ops.Switch', { id: 'sw' });
    await rt.create('shop.Till', { id: 't1' });
    await rt.dispatch('t1', 'Charge');
    await rt.worker.tick(); // allowed (the switch is on), then the first attempt fails
    const allowed = (await verdicts(rt, 't1')).find((b) => b.outcome === 'allowed');
    assert.deepEqual(allowed.reads, { sw: (await rt.getState('sw')).seq });
    assert.equal(calls, 1);
    await rt.dispatch('sw', 'Flip'); // the switch moves on
    clock.advance(61_000);
    await rt.worker.tick();
    const after = await verdicts(rt, 't1');
    assert.ok(after.some((b) => b.outcome === 'rechecked'), 'the stale allow is rechecked');
    const denied = after.find((b) => b.outcome === 'denied');
    assert.ok(denied && /switch-on/.test(denied.reason), JSON.stringify(after.map((b) => [b.outcome, b.reason, b.sseq])));
    assert.equal(calls, 1, 'no attempt ran on the stale allow');
    assert.ok(denied.sseq > allowed.sseq, 'the recheck took a new sseq');
    assert.equal((await rt.getState('t1')).state.phase, 'Failed');
  } finally { await rt.close(); }
});

test('PT9.2, PT12.5: an escalation is lifted only by a person\'s signed approval, and the engine records who', { skip }, async () => {
  const { approveAs } = await import('./runtime-helpers.mjs');
  const a = await admitted('escalate-gate', ['conformance/m5/switch.poly', 'conformance/m5/shop.poly', 'conformance/m5/shop-escalate.policy.poly']);
  const { rt } = await loaded(a);
  try {
    handleWith(rt, 'till.charge', () => 'ok');
    await rt.create('shop.Till', { id: 't2' });
    await rt.dispatch('t2', 'Charge');
    await rt.worker.tick();
    const [row] = await rt.outbox('t2');
    assert.equal((await rt.worker.intentState(row)).intent, 'Escalated');
    await approveAs(rt, row.intent_id);
    await rt.worker.tick();
    assert.equal((await rt.getState('t2')).state.phase, 'Done');
    const vs = await verdicts(rt, 't2');
    const allowed = vs.find((b) => b.outcome === 'allowed');
    assert.equal(allowed.engineDecision, 'allow');
    assert.ok(allowed.sseq > vs.find((b) => b.outcome === 'escalated').sseq);
  } finally { await rt.close(); }
});
