// PD5.3 (S106, S107): revocation, as a mode the program is in.
//   PD5-A6  with the Trust machine and the halt policy, admission proves no compensable or irreversible effect is allowed
//           while Halted (a never statement over the decision table); without the halt rule it is a finding with a witness;
//   PD5-A7  a halt strands nothing: a mandate whose only way to finish needs an irreversible effect is PL6501 naming
//           Halted, and one that can also finish by a reversible effect is not;
//   PD5-A8  Restore succeeds with a person's signature through the person-key adapter, and is refused with an agent key
//           or none;
//   PD5-A12 the joint test: the refund example with a recorded verifier and one injected CredentialRevoked. No refund
//           handler runs after the revocation, refunds proposed while halted are denied, and after a person's Restore
//           new refunds are allowed again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { signRecord, invocationSubject } from '@poly/core';
import { polyaxionPeer, personKeyVerifier } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith, PERSON, AGENT } from './runtime-helpers.mjs';

const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
function projectOf(name, files) {
  const dir = join(ROOT, '.poly', 'test-policy', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return dir;
}
const scope = async (name, policy) => (await checkProject(projectOf(name, { 'refund.poly': read('conformance/m5/refund.poly'), 'trust.poly': read('conformance/m5/trust.poly'), 'p.policy.poly': policy }))).files.flatMap((f) => f.policies ?? []).find((s) => s.scope === 'refund');

test('PD5-A6: the halt is proved; without the halt rule the never statement is a finding with a witness', { skip }, async () => {
  const halt = read('conformance/m5/halt.policy.poly');
  const s = await scope('halt', halt);
  assert.deepEqual(s.diagnostics.map((d) => d.code), []);
  assert.equal(s.stages.find((x) => x.stage === 'never').verdict, 'CLEAN');
  const noRule = halt.replace(/  obligation halt-stops[\s\S]*?\n  }\n/, '  obligation any "A rule that does not stop the halt." rule {\n    when effect.kind == "payments.refund"\n    require true else deny\n  }\n');
  const s2 = await scope('halt-norule', noRule);
  const f = s2.diagnostics.find((d) => d.code === 'PL6503');
  assert.ok(f, JSON.stringify(s2.diagnostics.map((d) => d.message)));
  const last = f.witness.trace.at(-1);
  assert.equal(last.data.machines['security.Trust'].level, 'Halted');
  assert.equal(last.data.effect.class, 'irreversible');
});

test('PD5-A7: a mandate whose only way to finish is irreversible is PL6501 naming Halted; one with a reversible way out is not', { skip }, async () => {
  const halt = read('conformance/m5/halt.policy.poly');
  const mandate = (ways) => halt.replace('  never halted-is-stopped', `  obligation refund-ends "A refund session finishes." machine {\n    states open, done\n    initial open\n${ways.map((k) => `    from open when effect.kind == "${k}" -> done`).join('\n')}\n    end done\n  }\n  never halted-is-stopped`);
  const s = await scope('halt-strands', mandate(['payments.refund']));
  const f = s.diagnostics.filter((d) => d.code === 'PL6501');
  assert.equal(f.length, 1, JSON.stringify(s.diagnostics.map((d) => d.message)));
  assert.match(f[0].message, /^in mode security\.Trust\.level == Halted: mandate halt\.refund-ends/);
  const withWayOut = read('conformance/m5/refund.poly').replace('  effect refund(n: 0..2) {', '  effect notify(n: 0..1) {\n    kind "payments.notify"\n    labels { egress:external }\n    class reversible\n  }\n\n  effect refund(n: 0..2) {').replace('  on Withdraw {\n    require status == Awaiting else reject "not-awaiting"\n', '  on Withdraw {\n    require status == Awaiting else reject "not-awaiting"\n    emit notify(1)\n');
  const p = await checkProject(projectOf('halt-way-out', { 'refund.poly': withWayOut, 'trust.poly': read('conformance/m5/trust.poly'), 'p.policy.poly': mandate(['payments.refund', 'payments.notify']) }));
  const s2 = p.files.flatMap((x) => x.policies ?? []).find((x) => x.scope === 'refund');
  assert.deepEqual(s2.diagnostics.filter((d) => d.code === 'PL6501').map((d) => d.message), []);
});

const signed = (who, instance, action, data, actionId) => signRecord({ kind: 'invocation', subject: invocationSubject({ instance, action, data, actionId }), by: who.keyId, at: '2026-10-03T00:00:00.000Z' }, who.privateKeyPem);

test('PD5-A8: Restore succeeds with a person\'s signature, and is refused with an agent key or none', async () => {
  const a = await admitted('restore', ['conformance/m5/trust.poly']);
  const { rt } = await loaded(a);
  try {
    await rt.create('security.Trust', { id: 'trust' });
    await rt.dispatch('trust', 'CredentialRevoked', { p: 'svc-7' }, { actionId: 'rev' });
    assert.equal((await rt.getState('trust')).state.level, 'Halted');
    assert.equal((await rt.dispatch('trust', 'Restore', {}, { actionId: 'r0' })).rejectReason, 'claims-unverified');
    assert.equal((await rt.dispatch('trust', 'Restore', {}, { actionId: 'r1', credentials: signed(AGENT, 'trust', 'Restore', {}, 'r1') })).rejectReason, 'claims-unverified');
    assert.equal((await rt.getState('trust')).state.level, 'Halted');
    const ok = await rt.dispatch('trust', 'Restore', {}, { actionId: 'r2', credentials: signed(PERSON, 'trust', 'Restore', {}, 'r2') });
    assert.equal(ok.stepKind, 'accepted');
    assert.deepEqual([(await rt.getState('trust')).state.level, (await rt.getState('trust')).state.restoredBy], ['Normal', PERSON.name]);
  } finally { await rt.close(); }
});

test('PD5-A12: after an injected CredentialRevoked no refund handler runs, refunds are denied, and a person\'s Restore allows them again', { skip }, async () => {
  const a = await admitted('joint', ['conformance/m5/refund.poly', 'conformance/m5/trust.poly', 'conformance/m5/halt.policy.poly']);
  // The recorded verifier adapter: a credential names the claims it stands for; a person's signature goes to the
  // person-key adapter (S107).
  const recorded = { ann: { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' }, bob: { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'bob' } };
  const person = personKeyVerifier(a.cert.poly.keyrings);
  const { rt, clock } = await loaded(a, { verifier: (credentials, ctx) => (typeof credentials === 'string' ? recorded[credentials] ?? null : person(credentials, ctx)) });
  try {
    const calls = [];
    let failFirst = true;
    handleWith(rt, 'payments.refund', (_p, _c, ctx) => {
      calls.push(ctx.instanceId);
      if (failFirst) { failFirst = false; throw new Error('the provider is slow'); }
      return 'refunded';
    });
    await rt.create('security.Trust', { id: 'trust' });
    // A refund the gate allows before the revocation; its first attempt fails, so it waits to be retried.
    await rt.create('refund.Refund', { id: 'before' });
    await rt.dispatch('before', 'Request', { a: 1 }, { actionId: 'b1', credentials: 'ann' });
    await rt.worker.tick();
    assert.deepEqual(calls, ['before']);
    assert.ok((await rt.chain('before')).some((e) => e.kind === 'verdict' && e.body.outcome === 'allowed'));
    // The revocation: the allow the retry would act on has outlived the Trust state it read (S147).
    await rt.dispatch('trust', 'CredentialRevoked', { p: 'ann' }, { actionId: 'rev' });
    for (let k = 0; k < 4; k++) { clock.advance(60_000); await rt.worker.tick(); }
    assert.deepEqual(calls, ['before'], 'no refund handler runs after the revocation');
    const last = (await rt.chain('before')).filter((e) => e.kind === 'verdict').map((e) => e.body.outcome);
    assert.ok(last.includes('rechecked') && last.at(-1) === 'denied', JSON.stringify(last));
    // A refund proposed while halted is denied.
    await rt.create('refund.Refund', { id: 'halted' });
    await rt.dispatch('halted', 'Request', { a: 1 }, { actionId: 'h1', credentials: 'bob' });
    await rt.worker.tick();
    const halted = (await rt.chain('halted')).find((e) => e.kind === 'verdict' && e.body.effectKind === 'payments.refund').body;
    assert.equal(halted.outcome, 'denied');
    assert.match(halted.reason, /halt-stops/);
    // A person restores; a new refund is allowed and runs.
    await rt.dispatch('trust', 'Restore', {}, { actionId: 'res', credentials: signed(PERSON, 'trust', 'Restore', {}, 'res') });
    assert.equal((await rt.getState('trust')).state.level, 'Normal');
    await rt.create('refund.Refund', { id: 'after' });
    await rt.dispatch('after', 'Request', { a: 1 }, { actionId: 'a1', credentials: 'bob' });
    await rt.worker.tick();
    assert.deepEqual(calls, ['before', 'after']);
  } finally { await rt.close(); }
});
