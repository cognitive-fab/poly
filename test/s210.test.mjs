// S210, as ruled (2026-10-07): what a person decides is anchored outside the project and only moves forward (PT12.5,
// PT10g). Each test is a finding of M9's review, reproduced: load verifies the chain from the anchor (D1), neither the
// rings nor a policy can be rolled back (D2, D7), a keyring record names its project (D3), production is the anchor's
// (D9), a grant request is signed and taken once (B3, D6), and LoadOptions.fault is refused in production. Each test
// failed on the tree before the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, AdmitError, commandNamed } from '@poly/check';
import { certificateDigest, grantRequestSubject, keyringDigest, keyringSubject, signDigest, signRecord } from '@poly/core';
import { devKeychain, oauthVault } from '@poly/io';
import { load, LoadError, polyaxionPeer } from '@poly/runtime';
import { AGENT, ANCHORS, PERSON, anchorProject, makeKey, makePerson, project, signPolicies } from './runtime-helpers.mjs';
import { GENERIC, desk, secret } from './grants-helpers.mjs';
import { TEST_STD } from './helpers.mjs';

const SOURCES = ['conformance/m4/outbox.poly'];
const POLICY = ['conformance/m5/orders.poly', 'conformance/m5/orders.policy.poly'];
const skipGate = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const pub = (p) => ({ name: p.name, keyId: p.keyId, publicKey: p.publicKey });
const rings = (people, agents = [AGENT]) => ({ people: people.map(pub), agents: agents.map(pub) });
const anchorFileOf = (name) => readJson(join(ANCHORS, 'anchors.json')).anchors[name].slice('file:'.length);
const setRings = (dir, r) => { const pj = join(dir, 'poly.json'); writeFileSync(pj, JSON.stringify({ ...readJson(pj), ...r }, null, 2)); };
const writeHistory = (dir, entries) => { mkdirSync(join(dir, 'keyrings'), { recursive: true }); writeFileSync(join(dir, 'keyrings', 'history.json'), JSON.stringify(entries, null, 2)); };
const entry = (name, prev, next, signer) => ({ rings: next, record: signRecord({ kind: 'keyring', subject: keyringSubject(readJson(anchorFileOf(name)).id, keyringDigest(prev), keyringDigest(next)), by: signer.keyId, at: '2026-10-07T00:00:00.000Z' }, signer.privateKeyPem) });
const refused = (code) => (e) => (e instanceof AdmitError || e instanceof LoadError) && new RegExp(code).test(e.message);
const loadOf = (dir, key, certificate, extra = {}) => load(join(dir, '.poly', 'build'), { certificate, trust: { [key.id]: key.publicKey }, ...extra });

test('S210, D1: a certificate re-signed with the admission key to widen the people ring is refused at load, PL6410', async () => {
  const key = makeKey('s210-forge');
  const dir = project('s210-forge', SOURCES, key, 'test-s210');
  const r = await admit(dir);
  // The agent holds the admission key: it adds its own key under people, in poly.json and the certificate, and signs.
  const intruder = makePerson('intruder');
  const widened = rings([PERSON, intruder]);
  setRings(dir, widened);
  const cert = readJson(r.certificatePath);
  cert.poly.keyrings = widened;
  cert.poly.keyringChain = { ...cert.poly.keyringChain, head: keyringDigest(widened) };
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, key.id, readFileSync(key.file, 'utf8'))];
  writeFileSync(r.certificatePath, JSON.stringify(cert));
  await assert.rejects(loadOf(dir, key, r.certificatePath), refused('PL6410'));
});

test('S210, D2: a history cut back to rings a person has since removed is refused, and so is a certificate of those rings', async () => {
  const key = makeKey('s210-cut');
  const dir = project('s210-cut', SOURCES, key, 'test-s210');
  const former = makePerson('former');
  const first = rings([PERSON, former]);
  const second = rings([PERSON]);
  anchorProject('s210-cut', first);
  setRings(dir, first);
  const r1 = await admit(dir);
  const old = join(dir, '.poly', 'certificate-first.json');
  copyFileSync(r1.certificatePath, old);
  // A person removes the former colleague, and the change is admitted: the anchor's head moves to it.
  setRings(dir, second);
  writeHistory(dir, [{ rings: first }, entry('s210-cut', first, second, PERSON)]);
  await admit(dir);
  assert.equal(readJson(anchorFileOf('s210-cut')).head, keyringDigest(second));
  // The history cut back to the first rings verifies from the anchor's first rings, and is refused for its head.
  writeHistory(dir, [{ rings: first }]);
  setRings(dir, first);
  await assert.rejects(admit(dir), (e) => refused('PL6410')(e) && /never cut back/.test(e.message));
  await assert.rejects(loadOf(dir, key, old), refused('PL6410'));
});

test('S210, D3: a keyring change signed for one project is refused in another whose rings were the same', async () => {
  const a = project('s210-a', SOURCES, makeKey('s210-a'), 'test-s210');
  const b = project('s210-b', SOURCES, makeKey('s210-b'), 'test-s210');
  const first = rings([PERSON]);
  const next = rings([PERSON, makePerson('contractor')]);
  setRings(a, next);
  writeHistory(a, [{ rings: first }, entry('s210-a', first, next, PERSON)]);
  assert.equal((await admit(a)).verdict, 'CLEAN');
  mkdirSync(join(b, 'keyrings'), { recursive: true });
  copyFileSync(join(a, 'keyrings', 'history.json'), join(b, 'keyrings', 'history.json'));
  setRings(b, next);
  await assert.rejects(admit(b), refused('PL6410'));
});

test('S210, D7: an older signed policy is refused once a newer one was admitted, at admission and at load', { skip: skipGate, timeout: 300_000 }, async () => {
  const key = makeKey('s210-policy');
  const dir = project('s210-policy', POLICY, key, 'test-s210');
  const sig = join(dir, 'policies', 'orders.sig.json');
  await signPolicies(dir);
  const r1 = await admit(dir);
  const old = join(dir, '.poly', 'certificate-first.json');
  copyFileSync(r1.certificatePath, old);
  const oldSig = readFileSync(sig, 'utf8');
  assert.equal(readJson(sig).sequence, 1);
  // Signed again (the same document, a later sequence) and admitted: the anchor keeps 2.
  await signPolicies(dir);
  await admit(dir);
  assert.deepEqual(readJson(anchorFileOf('s210-policy')).policies, { orders: 2 });
  writeFileSync(sig, oldSig);
  await assert.rejects(admit(dir), (e) => refused('PL6409')(e) && /lower than the 2/.test(e.message));
  await assert.rejects(loadOf(dir, key, old), (e) => refused('PL6409')(e) && /lower than the 2/.test(e.message));
});

test('S210, D9: production is the anchor\'s: poly.json cannot name it, and a fault or a development keychain is refused in production', { timeout: 300_000 }, async () => {
  const key = makeKey('s210-prod');
  const dir = project('s210-prod', ['test/fixtures/m9/credentials.poly'], key, 'test-s210');
  const pj = join(dir, 'poly.json');
  writeFileSync(pj, JSON.stringify({ ...readJson(pj), credentials: { payments: { store: 'dev-keychain' }, reports: { store: 'dev-keychain' } }, production: false }, null, 2));
  await assert.rejects(admit(dir, { std: TEST_STD }), /production.*anchor/);
  const { production: _p, ...m } = readJson(pj);
  writeFileSync(pj, JSON.stringify(m, null, 2));
  const r = await admit(dir, { std: TEST_STD });
  // The owner sets production on the anchor; the certificate admitted before it is the same, and loads only clean.
  await commandNamed('anchor-production').run({ on: true, project: dir });
  assert.equal(readJson(anchorFileOf('s210-prod')).production, true);
  await assert.rejects(loadOf(dir, key, r.certificatePath, { std: TEST_STD, fault: 'address-in-clear' }), /test hook/);
  const rt = await loadOf(dir, key, r.certificatePath, { std: TEST_STD });
  const tmp = mkdtempSync(join(tmpdir(), 'poly-s210-'));
  try {
    writeFileSync(join(tmp, 'dev.key'), randomBytes(32).toString('hex'));
    const vault = oauthVault(GENERIC, { clientId: 'client-1', redirectUri: 'https://app.example/credentials/payments', clientSecret: secret() }, devKeychain({ key: `file:${join(tmp, 'dev.key')}` }), {});
    assert.throws(() => rt.connectVault('payments', vault), /PL6826/);
  } finally { await rt.close(); rmSync(tmp, { recursive: true, force: true }); }
  // And admission refuses the development keychain from now on, with nothing in poly.json about production.
  await assert.rejects(admit(dir, { std: TEST_STD }), /PL6826/);
});

test('S210, B3, D6: a grant request is a person\'s signed record, taken once; an unsigned one cannot push a granted grant back to Requested', { timeout: 300_000 }, async () => {
  const { rt, dir, grant } = await desk('s210-request');
  try {
    await grant('payments', 'm-1', ['refunds.write']);
    const id = rt.grantOf('payments', 'm-1');
    const approvals = join(dir, 'approvals');
    mkdirSync(approvals, { recursive: true });
    const signed = (who) => signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', 'm-1'), by: who.keyId, at: '2026-10-07T00:00:00.000Z' }, who.privateKeyPem);
    const write = (file, body) => writeFileSync(join(approvals, file), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder: 'm-1', ...body }));
    write('1-unsigned.json', {});
    write('2-agent.json', { record: signed(AGENT) });
    write('3-other.json', { record: signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', 'm-2'), by: PERSON.keyId, at: '2026-10-07T00:00:00.000Z' }, PERSON.privateKeyPem) });
    const out = await rt.takeApprovals(approvals);
    assert.deepEqual(out.map((x) => [x.file, x.outcome, x.reason ?? null]), [['1-unsigned.json', 'refused', 'not-a-record'], ['2-agent.json', 'refused', 'wrong-key'], ['3-other.json', 'refused', 'wrong-key']]);
    assert.equal((await rt.store.getInstance(id)).state.g, 'Granted', 'no refused request moved the grant');
    assert.equal(rt.takeAuthorizations().length, 0);
    const person = signed(PERSON);
    write('4-person.json', { record: person });
    assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => [x.outcome, x.reason ?? null]), [['applied', null]]);
    assert.equal((await rt.store.getInstance(id)).state.g, 'Requested', 'the person\'s request asks again');
    assert.equal(rt.takeAuthorizations().length, 1);
    // The same record presented again is refused, and journaled.
    write('5-replay.json', { record: person });
    assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => [x.outcome, x.reason]), [['refused', 'replayed']]);
    const journal = (await rt.chain('runtime:approvals')).map((e) => e.body).filter((b) => b.stage === 'grant-request').map((b) => [b.file, b.outcome, b.reason ?? null]);
    assert.equal(journal.length, 5);
  } finally { await rt.close(); }
});

test('S210, polywatch: poly sign keyrings refuses to extend a history cut back past the head last admitted, and writes nothing', async () => {
  const dir = project('s210-sign-cut', SOURCES, makeKey('s210-sign-cut'), 'test-s210');
  const first = rings([PERSON]);
  const second = rings([PERSON, makePerson('second')]);
  setRings(dir, second);
  writeHistory(dir, [{ rings: first }, entry('s210-sign-cut', first, second, PERSON)]);
  await admit(dir);
  writeHistory(dir, [{ rings: first }]);
  setRings(dir, rings([PERSON, makePerson('third')]));
  const keyFile = join(mkdtempSync(join(tmpdir(), 'poly-s210-key-')), 'person.pem');
  writeFileSync(keyFile, PERSON.privateKeyPem);
  try {
    await assert.rejects(commandNamed('sign-keyrings').run({ by: PERSON.keyId, key: keyFile, project: dir }), /never cut back/);
  } finally { rmSync(keyFile); }
  assert.deepEqual(readJson(join(dir, 'keyrings', 'history.json')), [{ rings: first }], 'nothing is written');
});

test('S210, polywatch: a change of the anchor waits for its lock, refuses one held by a live process, and takes over a dead one\'s', { timeout: 60_000 }, async () => {
  const dir = project('s210-lock', SOURCES, makeKey('s210-lock'), 'test-s210');
  const file = anchorFileOf('s210-lock');
  const { utimesSync } = await import('node:fs');
  writeFileSync(`${file}.lock`, '');
  await assert.rejects(commandNamed('anchor-production').run({ on: true, project: dir }), /being changed by another process/);
  assert.equal(readJson(file).production, false, 'nothing was written');
  const old = new Date(Date.now() - 120_000);
  utimesSync(`${file}.lock`, old, old);
  await commandNamed('anchor-production').run({ on: true, project: dir });
  assert.equal(readJson(file).production, true);
  assert.throws(() => readFileSync(`${file}.lock`), 'the lock is released');
});
