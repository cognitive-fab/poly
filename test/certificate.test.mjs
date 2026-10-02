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

// Review A1, A2: admission certifies what the check checked, never what is on disk after it.
test('review A1: an artefact rewritten after the check ran is refused, not certified', async () => {
  const dir = project('race-artefact', ['conformance/m1/effects.poly'], key);
  const tamper = () => {
    const f = join(dir, '.poly', 'build', 'effects.Account', 'next.cjs');
    writeFileSync(f, readFileSync(f, 'utf8').replace('"not-open"', '"tampered"'));
  };
  await assert.rejects(admit(dir, { afterCheck: tamper }), (e) => e instanceof AdmitError && /next\.cjs.*not the bytes the check checked/.test(e.message));
  assert.throws(() => readFileSync(join(dir, '.poly', 'certificate.json')));
});

test('review A2: a source edited after the check ran is refused, so no unchecked guarantee is certified', async () => {
  const dir = project('race-source', ['conformance/m1/effects.poly'], key);
  const edit = () => {
    const f = join(dir, 'src', 'effects.poly');
    writeFileSync(f, readFileSync(f, 'utf8').replace('  path property few-notices', '  path property no-invoice: count("billing.invoice") < 1\n  path property few-notices'));
  };
  await assert.rejects(admit(dir, { afterCheck: edit }), (e) => e instanceof AdmitError && /effects\.poly.*not the source the check checked/.test(e.message));
});

// Review A3, A4: a private key under version control is refused however it is named (S126, S139).
test('review A3: poly admit --witness refuses a key file inside a tree under version control', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync, copyFileSync, rmSync } = await import('node:fs');
  const dir = project('witness-key-in-repo', ['conformance/m1/effects.poly'], key);
  const inside = join(dir, 'k.pem');
  copyFileSync(key.file, inside);
  try {
    const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'admit', '--witness', join(dir, 'src', 'effects.poly'), '--key', inside, '--root', dir], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /inside a tree under version control/);
    assert.throws(() => readFileSync(join(dir, '.poly', 'witness.certificate.json')));
  } finally { rmSync(inside, { force: true }); }
});

test('review A4: a key reached through a junction from outside the repository is refused', async (t) => {
  const { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const real = join(ROOT, '.poly', 'test-cert', 'junction-target');
  rmSync(real, { recursive: true, force: true });
  mkdirSync(real, { recursive: true });
  copyFileSync(key.file, join(real, 'k.pem'));
  const via = join(mkdtempSync(join(tmpdir(), 'poly-junction-')), 'link');
  try {
    try { symlinkSync(real, via, 'junction'); } catch (e) { t.skip(`no junction or symbolic link here: ${e.code}`); return; }
    const dir = project('key-via-junction', ['conformance/m1/effects.poly'], { ...key, file: join(via, 'k.pem') });
    await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /inside a tree under version control/.test(e.message));
  } finally { rmSync(real, { recursive: true, force: true }); rmSync(via, { force: true, recursive: false }); }
});

// Polywatch on review A1: a checked artefact removed after the check is refused, never left out of the certificate.
test('polywatch: an artefact the check checked and that is gone at admission is refused, not omitted', async () => {
  const { rmSync } = await import('node:fs');
  const dir = project('race-artefact-gone', ['conformance/m1/effects.poly'], key);
  const remove = () => rmSync(join(dir, '.poly', 'build', 'effects.Account', 'invariants.mjs'));
  await assert.rejects(admit(dir, { afterCheck: remove }), (e) => e instanceof AdmitError && /invariants\.mjs.*not the bytes the check checked/.test(e.message));
});
