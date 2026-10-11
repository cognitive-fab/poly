// Promotion admission (PS20.7, PT30.6): `poly admit` reads promotions/ in file order and checks each entry
// against the sources. The inserted text must be in the file, the record must verify, the corpus must not be
// synthetic unless the certificate is a test one, and consistency (PS8.6) is checked with the promoted rule.
// All tests are independent: each starts with a fresh project and a hand-built promotion (PT30.9 text),
// since `poly promote` is NOT BUILT yet (M7.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { admit, AdmitError, policySubjects, policySignaturePath } from '@poly/check';
import { keyringDigest, newAnchor, recordDigest, signRecord, writeAnchorFile, canonicalize } from '@poly/core';
import { polyaxionPeer } from '@poly/runtime';
import { ANCHORS, AGENT, PERSON, makePerson, makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { CANDIDATES } from './fixtures/m7/candidates.mjs';

// Sign an adjudication with a person's key.
function signAdjudication(candidate, verdict, who, anchor) {
  const subject = `sha256:${createHash('sha256').update(canonicalize({ anchor, candidate: candidate.digest, verdict }), 'utf8').digest('hex')}`;
  return {
    v: 1,
    kind: 'poly.adjudication',
    candidate: candidate.digest,
    id: candidate.id,
    verdict,
    record: signRecord({ kind: 'adjudication', subject, by: who.keyId, at: '2026-10-06T00:00:00.000Z' }, who.privateKeyPem)
  };
}

// Write a promotion entry to promotions/NNNN-id.json
// inserted.text = marker line + newline + property/obligation lines, all indented as in file
// inserted.digest = sha256 of that text
function writePromotion(dir, seq, id, adjudication, candidate, tool, corpus, inserted) {
  mkdirSync(join(dir, 'promotions'), { recursive: true });
  const filename = `${String(seq).padStart(4, '0')}-${id}.json`;
  const entry = { id, candidate: candidate.digest, adjudication, tool, corpus, inserted };
  writeFileSync(join(dir, 'promotions', filename), JSON.stringify(entry, null, 2));
}

// Get anchor from test configuration
function getAnchor(projectName) {
  const config = JSON.parse(readFileSync(join(ANCHORS, 'anchors.json'), 'utf8'));
  const anchorFile = config.anchors[projectName].slice('file:'.length);
  return JSON.parse(readFileSync(anchorFile, 'utf8'));
}

test('D1: a project with no promotions/ has no promotions field in certificate', async () => {
  const key = makeKey('d1-none');
  const dir = project('d1-none', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  await signPolicies(dir);

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.ok(!('promotions' in r.certificate.poly), 'certificate.poly.promotions is absent');
});

test('D1: a valid promotion is admitted and listed in certificate.poly.promotions', async () => {
  const key = makeKey('d1-valid');
  const dir = project('d1-valid', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d1-valid');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.ok(Array.isArray(r.certificate.poly.promotions), 'certificate.poly.promotions is an array');
  assert.equal(r.certificate.poly.promotions.length, 1);
  assert.equal(r.certificate.poly.promotions[0].candidate, cand.digest);
  assert.equal(r.certificate.poly.promotions[0].id, cand.id);
  assert.equal(r.certificate.poly.promotions[0].corpus.kind, 'recorded');
});

test('D1: two valid promotions in file order are listed in promotion order', async () => {
  const key = makeKey('d1-two');
  const dir = project('d1-two', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d1-two');
  await signPolicies(dir);

  const cand1 = CANDIDATES.atMostFee;
  const cand2 = CANDIDATES.atMostCharge;

  const adjud1 = signAdjudication(cand1, 'real', PERSON, anchor.id);
  const adjud2 = signAdjudication(cand2, 'real', PERSON, anchor.id);

  const marker1 = `// promoted: ${cand1.id} ${recordDigest(adjud1.record)}`;
  const property1 = `  path property mined-${cand1.id}: count("payment.fee") <= 1`;
  const insertedText1 = marker1 + '\n' + property1;

  const marker2 = `// promoted: ${cand2.id} ${recordDigest(adjud2.record)}`;
  const property2 = `  path property mined-${cand2.id}: count("payment.charge") <= 1`;
  const insertedText2 = marker2 + '\n' + property2;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText1 + '\n' + insertedText2 + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest1 = `sha256:${createHash('sha256').update(insertedText1, 'utf8').digest('hex')}`;
  const textDigest2 = `sha256:${createHash('sha256').update(insertedText2, 'utf8').digest('hex')}`;

  writePromotion(dir, 1, cand1.id, adjud1, cand1, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText1,
    digest: textDigest1
  });

  writePromotion(dir, 2, cand2.id, adjud2, cand2, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus2', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText2,
    digest: textDigest2
  });

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.certificate.poly.promotions.length, 2);
  assert.equal(r.certificate.poly.promotions[0].id, cand1.id);
  assert.equal(r.certificate.poly.promotions[1].id, cand2.id);
});

test('D2: PL6510 if inserted.text is removed from source', async () => {
  const key = makeKey('d2-removed');
  const dir = project('d2-removed', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d2-removed');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;
  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;

  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6510/.test(e.message));
});

test('D2: PL6510 if inserted.digest is wrong', async () => {
  const key = makeKey('d2-digest');
  const dir = project('d2-digest', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d2-digest');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: 'sha256:wrongdigest'
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6510/.test(e.message));
});

test('D2: PL6510 if inserted.file does not exist', async () => {
  const key = makeKey('d2-nofile');
  const dir = project('d2-nofile', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d2-nofile');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;
  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;

  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/nonexistent.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6510/.test(e.message));
});

test('D2: PL6510 if inserted.file escapes the project', async () => {
  const key = makeKey('d2-escape');
  const dir = project('d2-escape', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d2-escape');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;
  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;

  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: '../outside.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6510/.test(e.message));
});

test('D2: PL6510 if marker line names wrong id or wrong record digest', async () => {
  const key = makeKey('d2-marker');
  const dir = project('d2-marker', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d2-marker');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const wrongMarkerLine = `// promoted: a000000000000099 ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = wrongMarkerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6510/.test(e.message));
});

test('D3: PL6511 if record is signed by an agents-ring key (positive control)', async () => {
  const key = makeKey('d3-agent-ctl');
  const dir = project('d3-agent-ctl', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d3-agent-ctl');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.equal(r.certificate.poly.promotions.length, 1);
});

test('D3: PL6511 if record is signed by an agents-ring key', async () => {
  const key = makeKey('d3-agent');
  const dir = project('d3-agent', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d3-agent');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', AGENT, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6511/.test(e.message) && !existsSync(join(dir, '.poly', 'certificate.json')));
});

test('D3: PL6511 if record is signed by a key not in any ring (positive control)', async () => {
  const key = makeKey('d3-unknown-ctl');
  const dir = project('d3-unknown-ctl', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d3-unknown-ctl');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
});

test('D3: PL6511 if record is signed by a key not in any ring', async () => {
  const key = makeKey('d3-unknown');
  const dir = project('d3-unknown', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d3-unknown');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;

  const unknownPerson = {
    name: 'unknown',
    keyId: 'key-unknown',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ7DYvh6SEqVTm0DYrqqrVnYzF2P2MqWmKmqrqqrVnYz\n-----END PRIVATE KEY-----\n',
  };

  const adjudFile = signAdjudication(cand, 'real', unknownPerson, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6511/.test(e.message));
});

test('D5: policy re-signature is required when a rule is added to policy', async () => {
  const key = makeKey('d5-resig');
  const dir = project('d5-resig', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d5-resig');
  await signPolicies(dir);

  const cand = CANDIDATES.eligReserve;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const obligationSource = cand.source;
  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const insertedText = markerLine + '\n' + obligationSource;

  const policyFile = join(dir, 'src', 'orders.policy.poly');
  const policyContent = readFileSync(policyFile, 'utf8');
  const policyEnd = policyContent.lastIndexOf('}');
  const updatedPolicy = policyContent.slice(0, policyEnd) + insertedText + '\n' + policyContent.slice(policyEnd);
  writeFileSync(policyFile, updatedPolicy);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.policy.poly',
    text: insertedText,
    digest: textDigest
  });

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6409/.test(e.message));

  await signPolicies(dir);
  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.ok(r.certificate.poly.promotions);
  assert.equal(r.certificate.poly.promotions[0].id, cand.id);
});

test('D6: consistency is checked again at admission with the promoted rule', async () => {
  if (!polyaxionPeer().ok) this.skip();

  const key = makeKey('d6-consistency');
  const dir = project('d6-consistency', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d6-consistency');
  await signPolicies(dir);

  const cand = CANDIDATES.eligConflict;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const obligationSource = cand.source;
  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const insertedText = markerLine + '\n' + obligationSource;

  const policyFile = join(dir, 'src', 'orders.policy.poly');
  const policyContent = readFileSync(policyFile, 'utf8');
  const policyEnd = policyContent.lastIndexOf('}');
  const updatedPolicy = policyContent.slice(0, policyEnd) + insertedText + '\n' + policyContent.slice(policyEnd);
  writeFileSync(policyFile, updatedPolicy);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.policy.poly',
    text: insertedText,
    digest: textDigest
  });

  await signPolicies(dir);

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6501/.test(e.message) && new RegExp(`mined-${cand.id}`).test(e.message));
});

test('D7: promotions/ files are certified artefacts; changing one is detected', async () => {
  const key = makeKey('d7-certified');
  const dir = project('d7-certified', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly'], key);

  const anchor = getAnchor('d7-certified');
  await signPolicies(dir);

  const cand = CANDIDATES.atMostCharge;
  const adjudFile = signAdjudication(cand, 'real', PERSON, anchor.id);

  const markerLine = `// promoted: ${cand.id} ${recordDigest(adjudFile.record)}`;
  const propertyLine = `  path property mined-${cand.id}: count("payment.charge") <= 1`;
  const insertedText = markerLine + '\n' + propertyLine;

  const ordersFile = join(dir, 'src', 'orders.poly');
  const content = readFileSync(ordersFile, 'utf8');
  const insertIdx = content.lastIndexOf('}');
  const updated = content.slice(0, insertIdx) + insertedText + '\n' + content.slice(insertIdx);
  writeFileSync(ordersFile, updated);

  const textDigest = `sha256:${createHash('sha256').update(insertedText, 'utf8').digest('hex')}`;
  writePromotion(dir, 1, cand.id, adjudFile, cand, { name: 'polyx', version: '0.1.1', commit: '963b9e2ccf', manifest: 'sha256:abc' }, { digest: 'sha256:corpus1', kind: 'recorded' }, {
    file: 'src/orders.poly',
    text: insertedText,
    digest: textDigest
  });

  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');

  const promPath = join(dir, 'promotions', '0001-a000000000000001.json');
  const prom = JSON.parse(readFileSync(promPath, 'utf8'));
  prom.inserted.text = prom.inserted.text.replace('<= 1', '<= 2');
  writeFileSync(promPath, JSON.stringify(prom, null, 2));

  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6510/.test(e.message));
});
