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
// Each is a confirmation test (de66918): met by machinery that existed before it was written, so it could not fail first.
// Each has a seeded control: a mutant that breaks the property it checks, on which the same assertions must fail.
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
/** Writes a mutant source under .poly/test-controls and returns its path relative to the repository root. */
function mutantFile(name, file, text) {
  const dir = join(ROOT, '.poly', 'test-controls', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
  return `.poly/test-controls/${name}/${file}`;
}
const scope = async (name, policy) => (await checkProject(projectOf(name, { 'refund.poly': read('conformance/m5/refund.poly'), 'trust.poly': read('conformance/m5/trust.poly'), 'p.policy.poly': policy }))).files.flatMap((f) => f.policies ?? []).find((s) => s.scope === 'refund');

async function haltProved(name, policy) {
  const s = await scope(name, policy);
  assert.deepEqual(s.diagnostics.map((d) => d.code), [], 'the halt is proved');
  assert.equal(s.stages.find((x) => x.stage === 'never').verdict, 'CLEAN');
}

test('PD5-A6, seeded control: a halt rule that stops effects in Restricted instead of Halted fails the test', { skip }, async () => {
  const halt = read('conformance/m5/halt.policy.poly');
  // The first occurrence is the rule's; the never statement keeps Halted.
  const mutant = halt.replace('machine("security.Trust").level == Halted', 'machine("security.Trust").level == Restricted');
  assert.notEqual(mutant, halt);
  await assert.rejects(haltProved('halt-control', mutant), (e) => e instanceof assert.AssertionError && /the halt is proved/.test(e.message) && /PL6503/.test(e.message));
});

test('PD5-A6: the halt is proved; without the halt rule the never statement is a finding with a witness (confirmation test)', { skip }, async () => {
  const halt = read('conformance/m5/halt.policy.poly');
  await haltProved('halt', halt);
  const noRule = halt.replace(/  obligation halt-stops[\s\S]*?\n  }\n/, '  obligation any "A rule that does not stop the halt." rule {\n    when effect.kind == "payments.refund"\n    require true else deny\n  }\n');
  const s2 = await scope('halt-norule', noRule);
  const f = s2.diagnostics.find((d) => d.code === 'PL6503');
  assert.ok(f, JSON.stringify(s2.diagnostics.map((d) => d.message)));
  const last = f.witness.trace.at(-1);
  assert.equal(last.data.machines['security.Trust'].level, 'Halted');
  assert.equal(last.data.effect.class, 'irreversible');
});

const mandate = (ways) => read('conformance/m5/halt.policy.poly').replace('  never halted-is-stopped', `  obligation refund-ends "A refund session finishes." machine {\n    states open, done\n    initial open\n${ways.map((k) => `    from open when effect.kind == "${k}" -> done`).join('\n')}\n    end done\n  }\n  never halted-is-stopped`);
/** The refund example with a second way to finish, by a notification of the given class. */
const withWayOut = (cls) => read('conformance/m5/refund.poly').replace('  effect refund(n: 0..2) {', `  effect notify(n: 0..1) {\n    kind "payments.notify"\n    labels { egress:external }\n    class ${cls}\n  }\n\n  effect refund(n: 0..2) {`).replace('  on Withdraw {\n    require status == Awaiting else reject "not-awaiting"\n', '  on Withdraw {\n    require status == Awaiting else reject "not-awaiting"\n    emit notify(1)\n');
async function haltStrandsNothing(name, refund) {
  const p = await checkProject(projectOf(name, { 'refund.poly': refund, 'trust.poly': read('conformance/m5/trust.poly'), 'p.policy.poly': mandate(['payments.refund', 'payments.notify']) }));
  const s = p.files.flatMap((x) => x.policies ?? []).find((x) => x.scope === 'refund');
  assert.deepEqual(s.diagnostics.filter((d) => d.code === 'PL6501').map((d) => d.message), [], 'a halt strands nothing');
}

test('PD5-A7, seeded control: a way out that is compensable is stopped by the halt too, and fails the test', { skip }, async () => {
  await assert.rejects(haltStrandsNothing('halt-way-out-control', withWayOut('compensable')), (e) => e instanceof assert.AssertionError && /a halt strands nothing/.test(e.message) && /Halted/.test(e.message));
});

test('PD5-A7: a mandate whose only way to finish is irreversible is PL6501 naming Halted; one with a reversible way out is not (confirmation test)', { skip }, async () => {
  const s = await scope('halt-strands', mandate(['payments.refund']));
  const f = s.diagnostics.filter((d) => d.code === 'PL6501');
  assert.equal(f.length, 1, JSON.stringify(s.diagnostics.map((d) => d.message)));
  assert.match(f[0].message, /^in mode security\.Trust\.level == Halted: mandate halt\.refund-ends/);
  await haltStrandsNothing('halt-way-out', withWayOut('reversible'));
});

const signed = (who, instance, action, data, actionId) => signRecord({ kind: 'invocation', subject: invocationSubject({ instance, action, data, actionId }), by: who.keyId, at: '2026-10-03T00:00:00.000Z' }, who.privateKeyPem);

async function restoreNeedsAPerson(name, trust) {
  const a = await admitted(name, [trust]);
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
}

test('PD5-A8, seeded control: a Restore that takes no claims fails the test', async () => {
  const trust = read('conformance/m5/trust.poly');
  const mutant = trust.replace('  on Restore() by op: Caller {', '  on Restore() {').replace(/    require op\.[^\n]*\n/g, '').replace("restoredBy' = op.principal", "restoredBy' = none");
  assert.notEqual(mutant, trust);
  await assert.rejects(restoreNeedsAPerson('restore-control', mutantFile('restore', 'trust.poly', mutant)), (e) => e instanceof assert.AssertionError && /claims-unverified/.test(e.message));
});

test('PD5-A8: Restore succeeds with a person\'s signature, and is refused with an agent key or none (confirmation test)', async () => {
  await restoreNeedsAPerson('restore', 'conformance/m5/trust.poly');
});

/** The refund example with its refund retried, which the retry-safety rule allows once the refund is keyed (G2): the stale-allow recheck is made on the retry. */
const retryingRefund = (name) => mutantFile(`${name}-refund`, 'refund.poly', read('conformance/m5/refund.poly').replace('    retry { attempts 1, base 500ms, timeout 30s }', '    retry { attempts 3, base 500ms, timeout 30s }\n    idempotent header "Idempotency-Key" window 24h'));

async function revocationStops(name, trust) {
  const a = await admitted(name, [retryingRefund(name), trust, 'conformance/m5/halt.policy.poly']);
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
}

test('PD5-A12, seeded control: a revocation that only restricts fails the test', { skip }, async () => {
  const trust = read('conformance/m5/trust.poly');
  const mutant = trust.replace("  on CredentialRevoked(p) {\n    level' = Halted", "  on CredentialRevoked(p) {\n    level' = Restricted");
  assert.notEqual(mutant, trust);
  await assert.rejects(revocationStops('joint-control', mutantFile('joint', 'trust.poly', mutant)), (e) => e instanceof assert.AssertionError && /no refund handler runs after the revocation/.test(e.message));
});

test('PD5-A12: after an injected CredentialRevoked no refund handler runs, refunds are denied, and a person\'s Restore allows them again (confirmation test)', { skip }, async () => {
  await revocationStops('joint', 'conformance/m5/trust.poly');
});
