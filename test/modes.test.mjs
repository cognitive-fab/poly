// PD4 (operating modes) and PD3-A2, through the policy gate. Declare is written `by op: Caller`, so a mode is declared
// only with a person's signature, through the person-key adapter (PD4-A3, S107).
//   PD4-A1  the gate allows a refund at confidence 0.91 in Normal, escalates it in Crisis, and records the mode;
//   PD4-A2  a policy that denies the refund flow in Crisis, with no escalation, is PL6501 naming Crisis;
//   PD3-A2  a new model cannot take a gated refund until a map fitted for it is installed; then it can, and its
//           decision events record the new map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { polyaxionPeer, mapDigest } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith, PERSON, AGENT } from './runtime-helpers.mjs';
import { signRecord, invocationSubject } from '@poly/core';

/** PD4-A3, S107: a Declare signed by a key holder, for the person-key adapter. */
const declare = (who, mode, actionId) => signRecord({ kind: 'invocation', subject: invocationSubject({ instance: 'mode', action: 'Declare', data: { mode }, actionId }), by: who.keyId, at: '2026-10-03T00:00:00.000Z' }, who.privateKeyPem);

const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const REPORTED = 'jev-2026-09-18';
const TEXT = { text: 'where is my refund' };
const refund = (p) => ({ answer: 'Refund', distribution: [['Refund', p], ['Complaint', (1 - p) * 0.7], ['Other', (1 - p) * 0.3]], reported: REPORTED, latencyMs: 5 });
const map = (fittedFor, version = 1) => { const m = { decision: 'route', version, fittedFor, points: [[0, 0], [800, 800], [900, 900], [910, 910], [930, 930]] }; return { ...m, digest: mapDigest(m) }; };

async function runtime(name) {
  const a = await admitted(name, ['conformance/m4/router.poly', 'conformance/m5/ops.poly', 'conformance/m5/autonomy.policy.poly']);
  const { rt } = await loaded(a);
  handleWith(rt, 'payments.refund', () => 'refunded');
  rt.handle('support.reply', rt.handlerExports('src/handlers.ts').handle);
  await rt.create('ops.OpsMode', { id: 'mode' });
  return rt;
}
async function ticket(rt, id) {
  await rt.create('support.Ticket', { id });
  await rt.dispatch(id, 'Received', TEXT);
  await rt.worker.tick(); // the decision, its completion, then the refund's proposal
  await rt.worker.tick();
  return (await rt.chain(id)).filter((e) => e.kind === 'verdict' && e.body.effectKind === 'payments.refund').map((e) => e.body);
}

test('PD4-A1: a refund at 0.91 is allowed in Normal and escalated in Crisis, and the verdict records the mode', { skip }, async () => {
  const rt = await runtime('pd4-a1');
  try {
    rt.provide('route', { provider: () => refund(0.91), model: 'jev-latest', calibration: map(REPORTED) });
    const normal = await ticket(rt, 't-normal');
    assert.equal(normal[0].outcome, 'allowed', JSON.stringify(normal));
    assert.deepEqual(normal[0].singletons, { 'ops.OpsMode': { mode: 'Normal', declaredBy: null } });
    await rt.dispatch('mode', 'Declare', { mode: 'Crisis' }, { actionId: 'declare-1', credentials: declare(PERSON, 'Crisis', 'declare-1') });
    const crisis = await ticket(rt, 't-crisis');
    assert.equal(crisis[0].outcome, 'escalated', JSON.stringify(crisis));
    assert.deepEqual(crisis[0].singletons, { 'ops.OpsMode': { mode: 'Crisis', declaredBy: PERSON.name } });
    assert.match(crisis[0].reason, /refund-by-mode|crisis-irreversible/);
  } finally { await rt.close(); }
});

test('PD3-A2: a model whose map was fitted for another cannot take a gated refund until its own map is installed', { skip }, async () => {
  const rt = await runtime('pd3-a2');
  try {
    rt.provide('route', { provider: () => refund(0.93), model: 'jev-latest', calibration: map('jev-2026-06-01') });
    const before = await ticket(rt, 't-old-map');
    assert.equal(before[0].outcome, 'escalated');
    assert.match(before[0].reason, /calibrated-for-model/);
    const fitted = map(REPORTED, 2);
    rt.provide('route', { provider: () => refund(0.93), model: 'jev-latest', calibration: fitted });
    const after = await ticket(rt, 't-new-map');
    assert.equal(after[0].outcome, 'allowed', JSON.stringify(after));
    const d = (await rt.chain('t-new-map')).find((e) => e.kind === 'decision').body;
    assert.deepEqual([d.calibration.fittedFor, d.calibration.version, d.calibration.digest], [REPORTED, 2, fitted.digest]);
  } finally { await rt.close(); }
});

test('PD4-A2: a policy that denies the refund flow in Crisis, with no escalation, is PL6501 naming Crisis', { skip }, async () => {
  const dir = join(ROOT, '.poly', 'test-policy', 'pd4-a2');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of ['conformance/m4/router.poly', 'conformance/m5/ops.poly', 'conformance/m5/crisis.policy.poly']) writeFileSync(join(dir, 'src', f.split('/').pop()), readFileSync(join(ROOT, f), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: 'pd4a2', modules: ['src/*.poly'] }));
  const s = (await checkProject(dir)).files.flatMap((f) => f.policies).find((x) => x.scope === 'support');
  const f = s.diagnostics.filter((d) => d.code === 'PL6501');
  assert.equal(f.length, 1, JSON.stringify(s.diagnostics.map((d) => d.message)));
  assert.match(f[0].message, /^in mode ops\.OpsMode\.mode == Crisis: mandate crisis-stop\.refund-before-end cannot be discharged under the obligations crisis-stop\.refund-before-end, crisis-stop\.crisis-deny/);
});

// PD4-A3 (S107): Declare is dispatched only with a person's signature, through the person-key adapter; unsigned or
// agent-signed, it is rejected and the mode stays.
test('PD4-A3: a mode is declared only with a person\'s signature', { skip }, async () => {
  const rt = await runtime('pd4-a3');
  try {
    const unsigned = await rt.dispatch('mode', 'Declare', { mode: 'Crisis' }, { actionId: 'd0' });
    assert.deepEqual([unsigned.stepKind, unsigned.rejectReason], ['rejected', 'claims-unverified']);
    const agent = await rt.dispatch('mode', 'Declare', { mode: 'Crisis' }, { actionId: 'd1', credentials: declare(AGENT, 'Crisis', 'd1') });
    assert.equal(agent.rejectReason, 'claims-unverified');
    assert.equal((await rt.getState('mode')).state.mode, 'Normal');
    const person = await rt.dispatch('mode', 'Declare', { mode: 'Crisis' }, { actionId: 'd2', credentials: declare(PERSON, 'Crisis', 'd2') });
    assert.equal(person.stepKind, 'accepted');
    assert.equal((await rt.getState('mode')).state.mode, 'Crisis');
    assert.equal((await rt.getState('mode')).state.declaredBy, PERSON.name);
  } finally { await rt.close(); }
});
