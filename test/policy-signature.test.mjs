// S194 (Q8, M9, as ruled): a person signs every policy, over the scope, its lowered document, its source and the
// engine pin; admission and load refuse a scope with no valid signature, PL6409 POLICY_NOT_SIGNED (PT12.5). Each test
// failed on the tree before the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { admit, AdmitError, commandNamed, policySubjects } from '@poly/check';
import { certificateDigest, keyringDigest, keyringSubject, policySubject, signDigest, signRecord, verifyRecord } from '@poly/core';
import { load, LoadError, polyaxionPeer } from '@poly/runtime';
import { AGENT, ANCHORS, PERSON, makeKey, makePerson, project, signPolicies } from './runtime-helpers.mjs';

const SOURCES = ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly'];
const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const notSigned = (e) => e instanceof AdmitError && /PL6409/.test(e.message);
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const sigFile = (dir) => join(dir, 'policies', 'orders.sig.json');

test('S194: a policy signed by a person over its document, source and engine is admitted, bound in the certificate, and loads', { skip, timeout: 300_000 }, async () => {
  const key = makeKey('ps-ok');
  const dir = project('ps-ok', SOURCES, key, 'test-policy-signature');
  await signPolicies(dir);
  const r = await admit(dir);
  const scope = r.certificate.poly.policies.find((p) => p.scope === 'orders');
  const [s] = await policySubjects(dir);
  assert.equal(s.scope, 'orders');
  // S210, D7: the certificate binds the sequence signed, the first; the next signature would take the second.
  assert.deepEqual([scope.sequence, s.parts.sequence], [1, 2]);
  assert.deepEqual(verifyRecord(scope.signature, r.certificate.poly.keyrings, { kind: 'policy', subject: policySubject({ ...s.parts, sequence: 1 }) }).ok, true);
  const { rt } = { rt: await load(join(dir, '.poly', 'build'), { certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }) };
  await rt.close();
});

test('S194: an unsigned scope, one signed by an agent key, and one signed over another subject are refused PL6409', { skip, timeout: 300_000 }, async () => {
  const dir = project('ps-refused', SOURCES, makeKey('ps-refused'), 'test-policy-signature');
  await assert.rejects(admit(dir), notSigned, 'unsigned');
  await signPolicies(dir, AGENT);
  await assert.rejects(admit(dir), notSigned, 'an agent key');
  const [s] = await policySubjects(dir);
  // Over the same document and source with another engine: the engine is part of what is signed.
  const other = policySubject({ ...s.parts, engine: { name: 'polyaxion', commit: '0000000' } });
  writeFileSync(sigFile(dir), JSON.stringify({ v: 2, sequence: s.parts.sequence, record: signRecord({ kind: 'policy', subject: other, by: PERSON.keyId, at: '2026-10-06T00:00:00.000Z' }, PERSON.privateKeyPem) }));
  await assert.rejects(admit(dir), notSigned, 'another engine');
});

test('S194: a policy changed after it was signed is refused PL6409 until it is signed again', { skip, timeout: 300_000 }, async () => {
  const dir = project('ps-changed', SOURCES, makeKey('ps-changed'), 'test-policy-signature');
  await signPolicies(dir);
  const file = join(dir, 'src', 'orders.policy.poly');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"Charge only after stock has been reserved."', '"Charge only once stock is reserved."'));
  await assert.rejects(admit(dir), notSigned, 'changed after signing');
  await signPolicies(dir);
  await admit(dir);
});

test('S194, as ruled: a policy signed by a key added to people without a keyring record is refused', { skip, timeout: 300_000 }, async () => {
  const dir = project('ps-added-key', SOURCES, makeKey('ps-added-key'), 'test-policy-signature');
  const intruder = makePerson('intruder');
  const pj = join(dir, 'poly.json');
  const m = readJson(pj);
  writeFileSync(pj, JSON.stringify({ ...m, people: [...m.people, { name: intruder.name, keyId: intruder.keyId, publicKey: intruder.publicKey }] }, null, 2));
  await signPolicies(dir, intruder);
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6410/.test(e.message));
  // Signed into the history by the intruder itself, the ring is still refused, so the policy never is admitted.
  const first = { people: [PERSON], agents: [AGENT] };
  const widened = { people: [PERSON, intruder], agents: [AGENT] };
  mkdirSync(join(dir, 'keyrings'), { recursive: true });
  writeFileSync(join(dir, 'keyrings', 'history.json'), JSON.stringify([{ rings: first }, { rings: widened, record: signRecord({ kind: 'keyring', subject: keyringSubject(readJson(readJson(join(ANCHORS, 'anchors.json')).anchors['ps-added-key'].slice(5)).id, keyringDigest(first), keyringDigest(widened)), by: intruder.keyId, at: '2026-10-06T00:00:00.000Z' }, intruder.privateKeyPem) }]));
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6410/.test(e.message));
});

test('S194: load refuses a certificate whose policy signature does not verify, PL6409, though the certificate itself is signed', { skip, timeout: 300_000 }, async () => {
  const key = makeKey('ps-load');
  const dir = project('ps-load', SOURCES, key, 'test-policy-signature');
  await signPolicies(dir);
  const r = await admit(dir);
  const cert = readJson(r.certificatePath);
  const scope = cert.poly.policies.find((p) => p.scope === 'orders');
  scope.signature = { ...scope.signature, subject: `sha256:${'0'.repeat(64)}` };
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, key.id, readFileSync(key.file, 'utf8'))];
  writeFileSync(r.certificatePath, JSON.stringify(cert));
  await assert.rejects(load(join(dir, '.poly', 'build'), { certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }), (e) => e instanceof LoadError && /PL6409/.test(e.message));
});

test('S194: poly sign policy is the owner\'s command, never over MCP, and its signature admits', { skip, timeout: 300_000 }, async () => {
  assert.equal(commandNamed('sign-policy').mcp, null);
  const key = makeKey('ps-cli');
  const dir = project('ps-cli', SOURCES, key, 'test-policy-signature');
  const personFile = join(join(key.file, '..'), 'ps-cli-person.pem');
  writeFileSync(personFile, PERSON.privateKeyPem);
  const { rmSync } = await import('node:fs');
  try { await commandNamed('sign-policy').run({ scope: 'orders', by: PERSON.keyId, key: personFile, project: dir }); } finally { rmSync(personFile); }
  const sig = readJson(sigFile(dir));
  assert.deepEqual([sig.v, sig.sequence, sig.record.kind], [2, 1, 'policy']);
  await admit(dir);
});
