// PD6 (M9, S195 to S198, PS8.8, PS8.9): the age of a step's claims, read by policies and recorded in the verdict, and
// mandates that only narrow (K12), checked before the module and against every proposal. PD6-A1 to A6, each written
// before the code. The refresh of stale claims (PS8.8, S198) is not here: it needs a transition of the OutboxIntent
// model, a measured file, and waits for the owner (decisions-m9.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { RefusedDispatch, polyaxionPeer, withEvidence } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, handleWith, loaded } from './runtime-helpers.mjs';

const SOURCES = ['test/fixtures/m9/pd6.poly', 'test/fixtures/m9/pd6.policy.poly'];
const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const MIN = 60_000;

let once = null;
const build = () => (once ??= admitted('pd6', SOURCES));

/** A verifier that gives the caller's claims with the evidence the test sets, as an adapter would. */
function verifierWith(evidenceOf) {
  return (credentials) => (credentials ? withEvidence({ kind: 'Person', principal: 'alice' }, evidenceOf(credentials)) : null);
}
async function desk(name, evidenceOf) {
  const a = await build();
  const { rt, clock } = await loaded(a, { verifier: verifierWith(evidenceOf) });
  handleWith(rt, 'payments.refund', async () => ({ ok: true }));
  await rt.create('pd6.Desk', { id: name });
  return { rt, clock };
}
const verdicts = async (rt, run) => (await rt.chain(run)).filter((e) => e.kind === 'verdict').map((e) => e.body);

test('PD6-A1: a presentation whose status is older than the policy allows is denied; a fresh one is allowed; one with no times is unknown and follows on unknown (escalate)', { skip, timeout: 300_000 }, async () => {
  for (const [label, times, outcome] of [['stale', (now) => ({ verifiedAt: now, statusAt: now - 20 * MIN }), 'denied'], ['fresh', (now) => ({ verifiedAt: now, statusAt: now - MIN }), 'allowed'], ['no times', () => ({}), 'escalated']]) {
    let clockNow = 0;
    const { rt, clock } = await desk(`a1-${label}`, () => times(clockNow));
    try {
      clockNow = clock.now();
      await rt.dispatch(`a1-${label}`, 'Ask', { amount: 10 }, { credentials: 'present' });
      await rt.advance();
      const v = (await verdicts(rt, `a1-${label}`)).find((b) => b.outcome === 'allowed' || b.outcome === 'escalated' || b.outcome === 'denied');
      assert.equal(v?.outcome, outcome, label);
    } finally { await rt.close(); }
  }
});

test('PD6-A2: the ages a decision read are recorded in its verdict event, and session replay reproduces every decision', { skip, timeout: 300_000 }, async () => {
  let clockNow = 0;
  const { rt, clock } = await desk('a2', () => ({ verifiedAt: clockNow - 2 * MIN, statusAt: clockNow - 3 * MIN }));
  try {
    clockNow = clock.now();
    await rt.dispatch('a2', 'Ask', { amount: 10 }, { credentials: 'present' });
    await rt.advance();
    const v = (await verdicts(rt, 'a2')).find((b) => b.outcome === 'allowed');
    const action = await rt.store.body(v.action);
    assert.deepEqual([action.step.age, action.step.statusAge], [2 * MIN, 3 * MIN]);
    const replay = await rt.replaySessions();
    assert.ok(replay.length > 0 && replay.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(replay));
  } finally { await rt.close(); }
});

test('PD6-A3: the decision-table check proves a never over ages, and a policy without the age rule gives a finding with a witness', { skip, timeout: 300_000 }, async () => {
  const dir = join(ROOT, '.poly', 'test-pd6', 'a3');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const s of SOURCES) writeFileSync(join(dir, s.split('/').pop()), readFileSync(join(ROOT, s), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: 'a3', modules: ['*.poly'] }));
  // The policies are checked in the project, so the decision table holds every proposal the desk can make.
  const policiesOf = (r) => r.files.flatMap((f) => f.policies ?? []);
  const never = (r) => policiesOf(r).flatMap((p) => p.diagnostics ?? []).filter((d) => d.code === 'PL6503');
  const good = await checkProject(dir);
  assert.deepEqual(never(good), []);
  const stage = policiesOf(good).find((p) => p.scope === 'pd6')?.stages.find((s) => s.stage === 'never');
  assert.equal(stage?.verdict, 'CLEAN', JSON.stringify(stage));
  assert.match(stage.note, /^[1-9]\d* proposals/, 'the table is not empty');
  // The seeded policy: the rule's age threshold so high it never fires, so a stale presentation is allowed.
  const policy = readFileSync(join(dir, 'pd6.policy.poly'), 'utf8').replace('&& statusAge(step.claims) > 600000\n', '&& statusAge(step.claims) > 600000000000\n');
  assert.ok(policy.includes('600000000000'));
  writeFileSync(join(dir, 'pd6.policy.poly'), policy);
  const bad = never(await checkProject(dir));
  assert.equal(bad.length, 1);
  assert.ok(bad[0].witness, JSON.stringify(bad[0]));
});

const mandate = (id, delegator, delegate, scope, expires) => ({ id, delegator, delegate, scope, expires });

test('PD6-A4: a two-hop chain whose second mandate raises the bound, adds an action, or extends the expiry is refused mandate-widened before the module', { skip, timeout: 300_000 }, async () => {
  let clockNow = 0;
  let chain = [];
  const { rt, clock } = await desk('a4', () => ({ mandates: chain }));
  try {
    clockNow = clock.now();
    const parent = mandate('m1', 'alice', 'agent-1', { actions: ['payments.refund'], max: { amount: 100 } }, clockNow + 60 * MIN);
    for (const [label, child] of [
      ['raised bound', mandate('m2', 'agent-1', 'agent-2', { actions: ['payments.refund'], max: { amount: 200 } }, clockNow + 30 * MIN)],
      ['added action', mandate('m2', 'agent-1', 'agent-2', { actions: ['payments.refund', 'payments.charge'], max: { amount: 50 } }, clockNow + 30 * MIN)],
      ['later expiry', mandate('m2', 'agent-1', 'agent-2', { actions: ['payments.refund'], max: { amount: 50 } }, clockNow + 90 * MIN)],
    ]) {
      chain = [parent, child];
      await assert.rejects(rt.dispatch('a4', 'Ask', { amount: 10 }, { credentials: 'present' }), (e) => e instanceof RefusedDispatch && /mandate-widened/.test(e.message), label);
    }
    assert.deepEqual((await rt.getJournal('a4')).filter((j) => j.action === 'Ask'), [], 'no step was taken');
    assert.equal((await rt.audit('a4')).filter((r) => /mandate-widened/.test(r.reason)).length, 3);
  } finally { await rt.close(); }
});

test('PD6-A5: an agent within its mandate is allowed, and outside the innermost scope is denied outside-mandate, on its tenth action as on its first', { skip, timeout: 300_000 }, async () => {
  let clockNow = 0;
  let chain = [];
  const { rt, clock } = await desk('a5', () => ({ verifiedAt: clockNow, statusAt: clockNow, mandates: chain }));
  try {
    clockNow = clock.now();
    chain = [mandate('m1', 'alice', 'agent-1', { actions: ['payments.refund'], max: { amount: 300 } }, clockNow + 60 * MIN), mandate('m2', 'agent-1', 'agent-2', { actions: ['payments.refund'], max: { amount: 100 } }, clockNow + 30 * MIN)];
    const outcomes = [];
    for (let i = 0; i < 10; i++) {
      await rt.dispatch('a5', 'Ask', { amount: i === 0 || i === 9 ? 200 : 50 }, { credentials: 'present', actionId: `a5-${i}` });
      await rt.advance();
    }
    for (const v of await verdicts(rt, 'a5')) if (v.outcome === 'allowed' || v.outcome === 'denied') outcomes.push([v.outcome, v.reason ?? null]);
    assert.deepEqual(outcomes.filter(([o]) => o === 'denied'), [['denied', 'outside-mandate'], ['denied', 'outside-mandate']]);
    assert.equal(outcomes.filter(([o]) => o === 'allowed').length, 8);
  } finally { await rt.close(); }
});

test('PD6-A6: revoking a parent mandate stops every action under its sub-mandates', { skip, timeout: 300_000 }, async () => {
  let clockNow = 0;
  let chain = [];
  const { rt, clock } = await desk('a6', () => ({ verifiedAt: clockNow, statusAt: clockNow, mandates: chain }));
  try {
    clockNow = clock.now();
    chain = [mandate('p1', 'alice', 'agent-1', { actions: ['payments.refund'] }, clockNow + 60 * MIN), mandate('c1', 'agent-1', 'agent-2', { actions: ['payments.refund'] }, clockNow + 30 * MIN)];
    // A step taken before the revocation, whose refund is proposed after it, is denied.
    await rt.dispatch('a6', 'Ask', { amount: 10 }, { credentials: 'present', actionId: 'a6-before' });
    await rt.revokeMandate('p1');
    await rt.advance();
    assert.deepEqual((await verdicts(rt, 'a6')).filter((v) => v.outcome === 'denied').map((v) => v.reason), ['outside-mandate']);
    await assert.rejects(rt.dispatch('a6', 'Ask', { amount: 10 }, { credentials: 'present', actionId: 'a6-after' }), (e) => e instanceof RefusedDispatch && /mandate-revoked/.test(e.message));
  } finally { await rt.close(); }
});
