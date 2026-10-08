// S401 (PT9.1, PT9.3, PS8.5): an approved re-proposal also reads the state at approval. A refund escalated on an open
// order and approved after Cancel is denied `stale-approval`, and session replay reproduces the denial; the same
// approval before Cancel is allowed; a control policy without the cancellation rule allows both. The checker's policy
// stage gives no finding for a policy that allows on the emitting snapshot and denies on a later one (PS8.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { polyaxionPeer } from '@poly/runtime';
import { checkProject } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith, approveAs } from './runtime-helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;
const FIX = 'test/fixtures/stale-approval';
const PROGRAM = `${FIX}/refunds.poly`;
const POLICY_A = `${FIX}/refunds.policy.poly`;
const POLICY_B = `${FIX}/refunds-control.policy.poly`;
const verdicts = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'verdict').map((e) => e.body);
const show = (vs) => JSON.stringify(vs.map((b) => [b.outcome, b.reason, b.sseq, b.later]));

async function started(name, policy) {
  const a = await admitted(name, [PROGRAM, policy]);
  const { rt } = await loaded(a);
  const ran = [];
  handleWith(rt, 'payments.refund', (p, caps, ctx) => { ran.push(ctx?.instanceId ?? 'run'); return 'ok'; });
  return { rt, ran };
}

/** Requests a refund on a new open order and ticks the worker: the intent is escalated (PT9.2). */
async function escalated(rt, id) {
  await rt.create('refunds.Order', { id });
  await rt.dispatch(id, 'RequestRefund');
  await rt.worker.tick();
  const [row] = await rt.outbox(id);
  assert.ok(row, 'the refund is an intent in the outbox');
  assert.equal((await rt.worker.intentState(row)).intent, 'Escalated', show(await verdicts(rt, id)));
  const emitting = (await rt.getJournal(id)).find((r) => r.action === 'RequestRefund').seq;
  return { row, emitting };
}

test('S401: a refund approved after Cancel is denied stale-approval, the handler never runs, and replay reproduces it', { skip }, async () => {
  const { rt, ran } = await started('s401-stale', POLICY_A);
  try {
    const { row, emitting } = await escalated(rt, 'o1');
    await rt.dispatch('o1', 'Cancel');
    assert.equal((await rt.getState('o1')).state.status, 'Cancelled');
    await approveAs(rt, row.intent_id);
    await rt.worker.tick();
    const vs = await verdicts(rt, 'o1');
    assert.ok(!vs.some((b) => b.outcome === 'allowed'), `no allow after a stale approval: ${show(vs)}`);
    const denied = vs.find((b) => b.outcome === 'denied');
    assert.ok(denied, `a denied verdict: ${show(vs)}`);
    assert.equal(denied.reason, 'stale-approval');
    assert.ok(denied.sseq > vs.find((b) => b.outcome === 'escalated').sseq, 'the re-proposal took a new sseq');
    // PT9.1, PT9.3: the re-proposal names the emitter's latest post-state at approval, after the emitting step.
    assert.ok(denied.later, `the verdict records later: ${JSON.stringify(denied)}`);
    assert.ok(denied.later.seq > emitting, `later.seq ${denied.later.seq} follows the emitting seq ${emitting}`);
    assert.equal(denied.later.seq, (await rt.getState('o1')).seq, 'later is the post-state of Cancel');
    assert.match(denied.later.stateDigest, /^sha256:/);
    assert.deepEqual(ran, [], 'the payments.refund handler never ran');
    assert.notEqual((await rt.worker.intentState((await rt.outbox('o1'))[0])).intent, 'Escalated', 'the intent is no longer waiting');
    // PS11.2: session replay re-applies the recorded action and reproduces the denial.
    const replay = await rt.replaySessions();
    assert.ok(replay.length > 0, 'a session was replayed');
    assert.ok(replay.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(replay));
  } finally { await rt.close(); }
});

test('S401: a refund approved before Cancel is allowed and the handler runs once', { skip }, async () => {
  const { rt, ran } = await started('s401-fresh', POLICY_A);
  try {
    const { row } = await escalated(rt, 'o2');
    await approveAs(rt, row.intent_id);
    await rt.worker.tick();
    const vs = await verdicts(rt, 'o2');
    assert.ok(vs.some((b) => b.outcome === 'allowed'), `an allowed verdict: ${show(vs)}`);
    assert.ok(!vs.some((b) => b.outcome === 'denied'), show(vs));
    assert.equal(ran.length, 1, 'the handler ran once');
    await rt.dispatch('o2', 'Cancel');
    await rt.worker.tick();
    assert.equal(ran.length, 1, 'a later Cancel does not run the handler again');
  } finally { await rt.close(); }
});

// Probe reviewer B on V1 to V5: an approved allow read the emitter's latest state, but its reads did not name the
// emitter, so a Cancel committed between the allow and the start was never rechecked (S147) and the refund ran on a
// cancelled order. The allow now reads the emitter at later.seq, so the stale check rechecks it, and the
// rechecked intent is proposed afresh and waits for a person again. The Cancel is dispatched where the worker checks for a stale allow, as a
// concurrent dispatch or a recovery after a crash would land.
test('S401, probe B1: a Cancel between an approved allow and the start is rechecked, and the refund never runs', { skip }, async () => {
  const { rt, ran } = await started('s401-window', POLICY_A);
  try {
    const { row } = await escalated(rt, 'o5');
    await approveAs(rt, row.intent_id);
    const w = rt.worker;
    const stale = w.stale.bind(w);
    let cancelled = false;
    w.stale = async (r) => { if (!cancelled) { cancelled = true; await rt.dispatch('o5', 'Cancel'); } return stale(r); };
    for (let i = 0; i < 4; i++) await rt.worker.tick();
    const vs = await verdicts(rt, 'o5');
    assert.ok(cancelled, 'the Cancel landed after the allow');
    assert.equal((await rt.getState('o5')).state.status, 'Cancelled');
    assert.deepEqual(ran, [], `the refund never ran on the cancelled order: ${show(vs)}`);
    assert.ok(vs.some((b) => b.outcome === 'rechecked'), `the allow was rechecked: ${show(vs)}`);
    // A rechecked intent is proposed afresh (S147): the earlier approval is not reused, so it waits for a person again.
    assert.equal(vs.at(-1).outcome, 'escalated', show(vs));
    assert.ok(vs.at(-1).sseq > vs.find((b) => b.outcome === 'allowed').sseq, show(vs));
  } finally { await rt.close(); }
});

test('S401: under the control policy, an approval after Cancel and one before Cancel are both allowed', { skip }, async () => {
  const { rt, ran } = await started('s401-control', POLICY_B);
  try {
    const after = await escalated(rt, 'c1');
    await rt.dispatch('c1', 'Cancel');
    await approveAs(rt, after.row.intent_id);
    await rt.worker.tick();
    const v1 = await verdicts(rt, 'c1');
    assert.ok(v1.some((b) => b.outcome === 'allowed') && !v1.some((b) => b.outcome === 'denied'), `approval after Cancel: ${show(v1)}`);
    const before = await escalated(rt, 'c2');
    await approveAs(rt, before.row.intent_id);
    await rt.worker.tick();
    await rt.dispatch('c2', 'Cancel');
    await rt.worker.tick();
    const v2 = await verdicts(rt, 'c2');
    assert.ok(v2.some((b) => b.outcome === 'allowed') && !v2.some((b) => b.outcome === 'denied'), `approval before Cancel: ${show(v2)}`);
    assert.equal(ran.length, 2, 'the handler ran once for each order');
    const replay = await rt.replaySessions();
    assert.ok(replay.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(replay));
  } finally { await rt.close(); }
});

// PS8.5: a policy that allows on the emitting snapshot and denies on a later one is not a finding. The program checked
// with policy A beside it is not refused because of the policy (no PL6503, no PL2501).
test('S401: the checker gives no finding for the cancellation rule under policy A (confirmation)', async () => {
  const dir = join(ROOT, '.poly', 'test-s401', 'check');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of [PROGRAM, POLICY_A]) copyFileSync(join(ROOT, f), join(dir, 'src', f.split('/').pop()));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: 's401-check', modules: ['src/*.poly'] }));
  const r = await checkProject(dir, { root: dir });
  const text = JSON.stringify(r);
  assert.ok(!/"PL6503"/.test(text), 'no PL6503 NEVER_VIOLATED');
  assert.ok(!/"PL2501"/.test(text), 'no PL2501');
  const scope = r.files.flatMap((f) => f.policies ?? []).find((x) => x.scope === 'refunds');
  assert.ok(scope, 'the refunds scope was checked');
  assert.notEqual(scope.verdict, 'REFUSED', JSON.stringify(scope.diagnostics));
  assert.notEqual(r.verdict, 'REFUSED', JSON.stringify(r.files.flatMap((f) => (f.policies ?? []).flatMap((p) => p.diagnostics))));
});
