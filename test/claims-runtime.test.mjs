// PD5.1 at run time (S101, S107, S155): the runtime asks the host's verifier adapter for the caller's claims, carries
// them to the module under $claims, and the module's first acceptor rejects claims that are missing, malformed or
// outside their domains with the reserved reason claims-unverified, journaled, with the state unchanged (PD5-A1). A
// dispatch that supplies $claims itself is refused before any step (S155). The person-key adapter turns a person's
// signature into { kind: Person, attest: Verified, assurance: 3, principal: <key owner> } (PD5-A8, S107).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRecord, invocationSubject } from '@poly/core';
import { RefusedDispatch, personKeyVerifier } from '@poly/runtime';
import { admitted, loaded, PERSON, AGENT } from './runtime-helpers.mjs';

const a = await admitted('claims-runtime', ['conformance/m5/refund.poly']);
const signed = (who, instance, action, data, actionId) => signRecord({ kind: 'invocation', subject: invocationSubject({ instance, action, data, actionId }), by: who.keyId, at: '2026-10-03T00:00:00.000Z' }, who.privateKeyPem);

test('PD5-A1: missing, malformed or out-of-domain claims are rejected(claims-unverified), journaled, the state unchanged', async () => {
  let answer = null;
  const { rt } = await loaded(a, { verifier: () => answer });
  try {
    await rt.create('refund.Refund', { id: 'r' });
    const cases = [
      ['no claims', null],
      ['malformed', 'a person'],
      ['an unknown kind', { kind: 'Robot', attest: 'Verified', assurance: 3, principal: 'ann' }],
      ['assurance outside 0..3', { kind: 'Person', attest: 'Verified', assurance: 7, principal: 'ann' }],
      ['an empty principal', { kind: 'Person', attest: 'Verified', assurance: 3, principal: '' }],
      ['a field too many', { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann', role: 'admin' }],
    ];
    for (const [k, [why, c]] of cases.entries()) {
      answer = c;
      const r = await rt.dispatch('r', 'Request', { a: 2 }, { actionId: `req-${k}`, credentials: 'token' });
      assert.deepEqual([r.stepKind, r.rejectReason], ['rejected', 'claims-unverified'], why);
      assert.equal((await rt.getState('r')).state.status, 'Idle', why);
    }
    const journal = (await rt.getJournal('r')).filter((x) => x.action === 'Request');
    assert.equal(journal.length, cases.length);
    assert.ok(journal.every((x) => x.step_kind === 'rejected' && x.reject_reason === 'claims-unverified'));
    answer = { kind: 'Person', attest: 'Verified', assurance: 2, principal: 'ann' };
    const ok = await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'req-ok', credentials: 'token' });
    assert.equal(ok.stepKind, 'accepted');
    assert.equal((await rt.getState('r')).state.requester, 'ann');
  } finally { await rt.close(); }
});

test('S155: a dispatch that supplies $claims itself is refused before any step, with an audit row', async () => {
  const { rt } = await loaded(a, { verifier: () => ({ kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' }) });
  try {
    await rt.create('refund.Refund', { id: 'r' });
    await assert.rejects(rt.dispatch('r', 'Request', { a: 2, $claims: { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'mallory' } }, { actionId: 'forged' }), (e) => e instanceof RefusedDispatch && /PL1208/.test(e.message));
    assert.deepEqual((await rt.getJournal('r')).filter((x) => x.action === 'Request'), []);
    assert.ok((await rt.audit('r')).some((x) => x.rule === 'S155'));
  } finally { await rt.close(); }
});

test('PD5-A8: the person-key adapter gives a keyring person exactly { Person, Verified, 3, owner }; an agent key or none gives no claims', async () => {
  const keyrings = a.cert.poly.keyrings;
  const verify = personKeyVerifier(keyrings);
  const ctx = { instance: 'r', action: 'Approve', data: {}, actionId: 'ap-1' };
  assert.deepEqual(verify(signed(PERSON, 'r', 'Approve', {}, 'ap-1'), ctx), { kind: 'Person', attest: 'Verified', assurance: 3, principal: PERSON.name });
  assert.equal(verify(signed(AGENT, 'r', 'Approve', {}, 'ap-1'), ctx), null);
  assert.equal(verify(undefined, ctx), null);
  // A signature over another dispatch is no signature for this one.
  assert.equal(verify(signed(PERSON, 'r', 'Approve', {}, 'ap-2'), ctx), null);
  // By default the runtime uses it: a person approves another person's request.
  const { rt } = await loaded(a);
  try {
    await rt.create('refund.Refund', { id: 'r' });
    const req = await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'q1', credentials: signed(AGENT, 'r', 'Request', { a: 2 }, 'q1') });
    assert.equal(req.rejectReason, 'claims-unverified', 'an agent key is no person signature');
    const r2 = await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'q2', credentials: signed(PERSON, 'r', 'Request', { a: 2 }, 'q2') });
    assert.equal(r2.stepKind, 'accepted');
    // The same person cannot approve their own request.
    const self = await rt.dispatch('r', 'Approve', {}, { actionId: 'ap-1', credentials: signed(PERSON, 'r', 'Approve', {}, 'ap-1') });
    assert.deepEqual([self.stepKind, self.rejectReason], ['rejected', 'self-approval']);
  } finally { await rt.close(); }
});

// PD5.1.2c: the claims are in the journal row's data, so replay folds the run through poly-ref with the same label,
// claims-unverified rows included, and polygraph replays its accepted windows.
test('PD5.1.2c: a run with claims, rejected and accepted, replays', async () => {
  const { replayRuntime } = await import('@poly/check');
  let answer = null;
  const { rt } = await loaded(a, { verifier: () => answer });
  try {
    await rt.create('refund.Refund', { id: 'r' });
    await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'q0', credentials: 'x' });
    answer = { kind: 'Person', attest: 'Verified', assurance: 2, principal: 'ann' };
    await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'q1', credentials: 'x' });
    answer = { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' };
    await rt.dispatch('r', 'Approve', {}, { actionId: 'a0', credentials: 'x' });
    answer = { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'bob' };
    await rt.dispatch('r', 'Approve', {}, { actionId: 'a1', credentials: 'x' });
    assert.equal((await rt.getState('r')).state.approver, 'bob');
    const [run] = (await replayRuntime(rt, { runs: ['r'] }));
    assert.deepEqual(run.diagnostics.map((d) => d.message), []);
    assert.equal(run.folded, run.rows);
  } finally { await rt.close(); }
});

// Review of M5b, B1: rt.create with a creation action is a dispatch from outside too. Caller-supplied $claims are
// refused (S155), and a creation action with claims gets them from the verifier, with the creation's credentials.
test('S155: a creation action takes its claims from the verifier, never from the caller\'s data', async () => {
  const k = await admitted('claims-create', ['conformance/m5/kids.poly']);
  const { rt } = await loaded(k, { verifier: (c) => (c === 'ann' ? { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' } : null) });
  try {
    const forged = { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'mallory' };
    await assert.rejects(rt.create('kids.Shipment', { id: 's1', creation: { action: 'Start', data: { $claims: forged } } }), (e) => e instanceof RefusedDispatch && /S155/.test(e.message));
    assert.ok((await rt.audit('s1')).some((x) => x.rule === 'S155'));
    await rt.create('kids.Shipment', { id: 's2', creation: { action: 'Start', data: {} }, credentials: 'ann' });
    assert.equal((await rt.getState('s2')).state.owner, 'ann');
    assert.equal(rt.lineageOf('s2', 1).origin.principal, 'ann');
  } finally { await rt.close(); }
});

// Review of M5b, B3: K11 is kept by a machine whose actions take claims, whatever other stage sets its assumptions.
test('PD5-A10: a machine with claims that spawns children still lists K11', async () => {
  const { checkFile } = await import('@poly/check');
  const { join } = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const r = await checkFile(join(ROOT, 'conformance/m5/kids.poly'), { root: join(ROOT, '.poly', 'test-kids-k11') });
  const order = r.machines.find((m) => m.machine === 'Order');
  assert.ok(order.instance.kernelAssumptions.includes('K11'), JSON.stringify(order.instance.kernelAssumptions));
});

// Review of M5b, B2: an exported witness of a machine with claims walks through the runtime with its claims given to
// the verifier, so the walk reproduces the finding instead of stopping at a refusal.
test('S139: an exported witness test of a machine with claims fails while the defect is there', async () => {
  const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const { checkFile, findWitness, witnessSpec } = await import('@poly/check');
  const { runWitness } = await import('../packages/poly-check/dist/src/witness-runtime.js');
  const dir = join(ROOT, '.poly', 'test-claims-witness');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'refund.poly');
  writeFileSync(file, readFileSync(join(ROOT, 'conformance/m5/refund.poly'), 'utf8').replace('    require caller.principal != requester else reject "self-approval"\n', ''));
  const r = await checkFile(file, { root: dir });
  const d = r.machines.flatMap((m) => m.diagnostics).find((x) => x.code === 'PL3001');
  const spec = witnessSpec(findWitness(r, d.witness.id), dir);
  const log = console.log;
  console.log = () => {};
  try { await assert.rejects(runWitness(spec), /not-self-approved/); } finally { console.log = log; }
});
