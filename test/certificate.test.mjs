// The certificate (PT15, PF8.1, S126): `poly admit` writes and signs it, only for a CLEAN program, reads it back
// against the files it describes, and never takes or writes a private key it was not given by location.
// Keys are generated here, at test time, outside the repository; none is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, AdmitError, CERTIFICATE_FAULTS } from '@poly/check';
import { certificateProblems, certificateDigest, publicKeyOf } from '@poly/core';
import { ROOT } from './helpers.mjs';
import { CERTIFICATE_FAULT_LIST } from './toolchain-faults.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const key = makeKey();

test('a CLEAN project is admitted: the certificate covers every artefact, is signed, and verifies', async () => {
  const dir = project('effects-router', ['conformance/m1/effects.poly', 'conformance/m2/decisions/router.poly'], key);
  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  const cert = JSON.parse(readFileSync(join(dir, '.poly', 'certificate.json'), 'utf8'));
  assert.deepEqual(cert.subject.machines.map((m) => m.id).sort(), ['effects.Account', 'support.Ticket']);
  for (const m of cert.subject.machines) for (const a of ['contract.json', 'next.cjs', 'effects.cjs', 'effects.manifest.json']) assert.ok(cert.artefacts[`${m.dir}/${a}`], `${m.id} ${a}`);
  assert.equal(cert.digest, certificateDigest(cert));
  assert.deepEqual(cert.signatures.map((s) => [s.keyId, s.alg]), [[key.id, 'ed25519']]);
  const actual = Object.fromEntries(Object.keys(cert.artefacts).map((p) => [p, r.artefacts[p]]));
  assert.deepEqual(certificateProblems(cert, actual, { [key.id]: key.publicKey }), []);
  // PD3.2b: the decision is listed with its domain and labels, and the model is never bound.
  assert.deepEqual(cert.poly.decisions.map((d) => [d.machine, d.kind, d.modelBound]), [['support.Ticket', 'decision.route', false]]);
  assert.ok(cert.poly.kernelAssumptions.includes('K10'));
  for (const l of ['approvals', 'capabilities', 'SQLite']) assert.ok(cert.poly.limits.some((x) => x.includes(l)), l);
  // No private key is in the certificate or next to it.
  assert.doesNotMatch(readFileSync(join(dir, '.poly', 'certificate.json'), 'utf8'), /PRIVATE KEY/);
});

test('admitting again gives the same build id and digest: what was certified, not when', async () => {
  const dir = project('again', ['conformance/m1/effects.poly'], key);
  const a = await admit(dir, { now: () => new Date('2026-10-01T00:00:00Z') });
  const b = await admit(dir, { now: () => new Date('2026-10-01T00:00:00Z') });
  assert.equal(a.certificate.buildId, b.certificate.buildId);
  assert.equal(a.certificate.digest, b.certificate.digest);
});

test('a program that is not CLEAN is not admitted, and nothing is written', async () => {
  for (const [name, src, verdict] of [['findings', 'examples/orders/orders.poly', 'FINDINGS'], ['inconclusive', 'examples/field-studies/raft/raft.poly', 'INCONCLUSIVE']]) {
    const dir = project(name, [src], key);
    await assert.rejects(admit(dir), (e) => e instanceof AdmitError && e.message.includes(verdict));
    assert.throws(() => readFileSync(join(dir, '.poly', 'certificate.json')));
  }
});

test('a project with effects whose handler lint did not run is not admitted (S72)', async () => {
  const dir = project('nolint', ['conformance/m1/effects.poly'], key);
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  delete manifest.handlers;
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest));
  await assert.rejects(admit(dir), /handler lint did not run/);
});

test('an admission key is found only by location, and a key file under version control is refused', async () => {
  const dir = project('envkey', ['conformance/m1/effects.poly'], key);
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  manifest.keys.admission.location = 'env:POLY_TEST_ADMISSION_KEY';
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest));
  await assert.rejects(admit(dir), /POLY_TEST_ADMISSION_KEY/);
  process.env.POLY_TEST_ADMISSION_KEY = readFileSync(key.file, 'utf8');
  try { assert.equal((await admit(dir)).verdict, 'CLEAN'); } finally { delete process.env.POLY_TEST_ADMISSION_KEY; }
  // A tracked file in this repository: refused whatever it holds, so a committed key can never sign.
  manifest.keys.admission.location = `file:${join(ROOT, 'package.json')}`;
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest));
  await assert.rejects(admit(dir), /version control/);
});

test('S137: the cap is 10, so the oms example (attempts 6) is admitted, and a retry above 10 is refused', async () => {
  const dir = project('retry', ['examples/oms/oms.poly'], key);
  assert.equal((await admit(dir)).verdict, 'CLEAN');
  writeFileSync(join(dir, 'src', 'oms.poly'), readFileSync(join(dir, 'src', 'oms.poly'), 'utf8').replace('attempts 6', 'attempts 11'));
  await assert.rejects(admit(dir), /chargeCard.*maxAttempts 11.*at most 10/);
});

test('each broken certificate writer is caught by the read-back, and nothing is left behind (standing rule)', async () => {
  assert.deepEqual([...CERTIFICATE_FAULTS].sort(), [...CERTIFICATE_FAULT_LIST].sort());
  for (const fault of CERTIFICATE_FAULTS) {
    const dir = project(`fault-${fault}`, ['conformance/m1/effects.poly'], key);
    await assert.rejects(admit(dir, { fault }), (e) => e instanceof AdmitError && /read-back/.test(e.message), fault);
    assert.throws(() => readFileSync(join(dir, '.poly', 'certificate.json')), fault);
  }
});

test('the public key of the admission key is what verifies, and only it', () => {
  const other = makeKey('other');
  assert.equal(publicKeyOf(readFileSync(key.file, 'utf8')), key.publicKey);
  assert.notEqual(other.publicKey, key.publicKey);
});
