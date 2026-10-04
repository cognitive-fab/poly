// PD5-A4 (S104): the gate proposal carries the claims of the step that emitted the effect, which a policy reads as
// step.claims.f. A refund emitted by a step whose caller is an agent is denied; one whose caller is a person is
// allowed; the verdict event records the claims' digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyaxionPeer } from '@poly/runtime';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;

test('PD5-A4: require step.claims.kind == Person denies an agent\'s refund and allows a person\'s, recording the claims digest', { skip }, async () => {
  const a = await admitted('policy-claims', ['conformance/m5/refund.poly', 'conformance/m5/refund-person.policy.poly']);
  assert.equal(a.cert.verdict ?? 'CLEAN', 'CLEAN');
  let caller = null;
  const { rt } = await loaded(a, { verifier: () => caller });
  try {
    handleWith(rt, 'payments.refund', () => 'refunded');
    for (const [id, kind] of [['agent', 'Agent'], ['person', 'Person']]) {
      caller = { kind, attest: 'Verified', assurance: 3, principal: `${id}-1` };
      await rt.create('refund.Refund', { id });
      const r = await rt.dispatch(id, 'Request', { a: 1 }, { actionId: `q-${id}`, credentials: 'x' });
      assert.equal(r.stepKind, 'accepted');
      await rt.worker.tick();
    }
    const verdict = async (id) => (await rt.chain(id)).find((e) => e.kind === 'verdict' && e.body.effectKind === 'payments.refund').body;
    const agent = await verdict('agent');
    const person = await verdict('person');
    assert.equal(agent.outcome, 'denied');
    assert.match(agent.reason, /person-refunds/);
    assert.equal(person.outcome, 'allowed');
    assert.match(person.claims, /^sha256:/);
    assert.notEqual(person.claims, agent.claims);
  } finally { await rt.close(); }
});
