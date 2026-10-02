// PT12.5, S150: approvals and acceptances are signed by people. The `people` and `agents` keyrings are certified at
// admission, and load refuses a keyring that differs from the certificate's. A signed approval names the escalated
// verdict event it lifts; an unsigned, agent-signed, unknown-key, mismatched or replayed record is refused with an
// audit row, and the intent stays Escalated. Keys are generated per run, never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { admit, AdmitError, checkProject } from '@poly/check';
import { load, LoadError } from '@poly/runtime';
import { signRecord } from '@poly/core';
import { admitted, loaded, handleWith, PERSON, AGENT, makePerson, makeKey, project, approvalFor } from './runtime-helpers.mjs';

const escalating = { propose: (p) => (p.approved ? { decision: 'allow' } : { decision: 'escalate', reason: 'ask a person' }), settle: () => 'ok' };
const a = await admitted('person-keys', ['conformance/m4/outbox.poly']);

async function escalated(id) {
  const { rt, clock } = await loaded(a, { gate: { gate: escalating, escalationTimeoutMs: 600_000 } });
  handleWith(rt, 'w.work', () => 'done');
  await rt.create('outbox.Job', { id });
  await rt.dispatch(id, 'Go');
  await rt.worker.tick();
  const [row] = await rt.outbox(id);
  assert.equal((await rt.worker.intentState(row)).intent, 'Escalated');
  return { rt, clock, row };
}

test('PT12.5: the certificate binds the people and agents keyrings, and no longer states the unsigned-approval limit', () => {
  assert.deepEqual(a.cert.poly.keyrings.people.map((p) => [p.name, p.keyId]), [[PERSON.name, PERSON.keyId]]);
  assert.deepEqual(a.cert.poly.keyrings.agents.map((p) => [p.name, p.keyId]), [[AGENT.name, AGENT.keyId]]);
  assert.ok(!a.cert.poly.limits.some((l) => /without a person-key signature/.test(l)));
});

test('PT12.5: an approval signed by a person lifts the escalation, and the verdict records the key and the record', async () => {
  const { rt, row } = await escalated('job-signed');
  try {
    await rt.approve(await approvalFor(rt, row.intent_id));
    await rt.worker.tick();
    assert.equal((await rt.getState('job-signed')).state.phase, 'Done');
    const approved = (await rt.chain('job-signed')).find((e) => e.kind === 'verdict' && e.body.outcome === 'approved');
    assert.equal(approved.body.by, PERSON.keyId);
    assert.equal(approved.body.person, PERSON.name);
    assert.equal(approved.body.signed, true);
    assert.match(approved.body.record, /^sha256:/);
  } finally { await rt.close(); }
});

test('PT12.5, S150: unsigned, agent-signed, unknown-key, wrong-kind, other-escalation, forged and replayed records are refused with an audit row', async () => {
  const { rt, row } = await escalated('job-refused');
  try {
    const stranger = makePerson('stranger');
    const good = await approvalFor(rt, row.intent_id);
    const cases = [
      ['unsigned', { by: 'ops', ref: 'esc-1' }, /unsigned approval has no effect/],
      ['agent', await approvalFor(rt, row.intent_id, AGENT), /agent key/],
      ['unknown key', await approvalFor(rt, row.intent_id, stranger), /not a key in the certified people keyring/],
      ['wrong kind', signRecord({ kind: 'acceptance', subject: good.subject, by: PERSON.keyId, at: good.at }, PERSON.privateKeyPem), /acceptance record/],
      ['other escalation', await approvalFor(rt, row.intent_id, PERSON, 'sha256:' + '0'.repeat(64)), /names no escalation/],
      ['forged', { ...good, subject: good.subject, at: '2030-01-01T00:00:00.000Z' }, /does not verify/],
    ];
    for (const [name, record, why] of cases) {
      await assert.rejects(rt.approve(record), (e) => e.name === 'ApprovalRefused' && why.test(e.message), name);
      assert.equal((await rt.worker.intentState(row)).intent, 'Escalated', name);
    }
    // A record that names no escalation is audited without an instance; all six are in the audit log.
    assert.equal((await rt.audit()).filter((r) => r.rule === 'PT12.5').length, cases.length);
    await rt.approve(good);
    await assert.rejects(rt.approve(good), (e) => e.name === 'ApprovalRefused' && /already used/.test(e.message), 'replayed');
  } finally { await rt.close(); }
});

test('S150: load refuses a keyring that differs from the certificate\'s', async () => {
  const b = await admitted('person-keys-ring', ['conformance/m4/outbox.poly']);
  const pj = join(b.dir, 'poly.json');
  const manifest = JSON.parse(readFileSync(pj, 'utf8'));
  manifest.people.push({ name: 'late', keyId: 'key-late', publicKey: makePerson('late').publicKey });
  writeFileSync(pj, JSON.stringify(manifest, null, 2));
  await assert.rejects(load(b.build, { certificate: b.certificate, trust: b.trust }), (e) => e instanceof LoadError && /PL6405/.test(e.message));
});

test('PT12.5: a finding accepted by a person is admitted and bound in the certificate; an agent\'s acceptance is not', async () => {
  const key = makeKey('accept');
  const dir = project('accepted-finding', ['conformance/m2/seeded/invariant/unfixed.poly'], key);
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /FINDINGS/.test(e.message));
  const report = await checkProject(dir, { root: dir });
  const f = report.files[0];
  const d = f.machines.flatMap((m) => m.diagnostics).find((x) => x.code === 'PL3001');
  const subject = `${f.moduleDigest}:${d.witness.id}`;
  mkdirSync(join(dir, 'accepted'), { recursive: true });
  writeFileSync(join(dir, 'accepted', 'a.json'), JSON.stringify(signRecord({ kind: 'acceptance', subject, by: AGENT.keyId, at: '2026-10-02T00:00:00.000Z' }, AGENT.privateKeyPem)));
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /agent key/.test(e.message));
  writeFileSync(join(dir, 'accepted', 'a.json'), JSON.stringify(signRecord({ kind: 'acceptance', subject, by: PERSON.keyId, at: '2026-10-02T00:00:00.000Z' }, PERSON.privateKeyPem)));
  const r = await admit(dir);
  assert.deepEqual(r.certificate.boundAccepted.map((x) => [x.code, x.witness, x.by]), [['PL3001', d.witness.id, PERSON.keyId]]);
  assert.ok(!r.certificate.guarantees.some((g) => g.endsWith(`:${d.property}`)), 'the accepted property is not claimed');
  assert.deepEqual(readdirSync(join(dir, 'accepted')), ['a.json']);
});

test('PT12.5: poly approve signs an approval of the stored escalation; poly accept writes an acceptance admission reads', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { ROOT } = await import('./helpers.mjs');
  const cli = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
  const keys = mkdtempSync(join(tmpdir(), 'poly-person-'));
  const keyFile = join(keys, 'ops.pem');
  writeFileSync(keyFile, PERSON.privateKeyPem);
  const db = join(keys, 'run.db');
  try {
    const { loaded: load2 } = await import('./runtime-helpers.mjs');
    let { rt } = await load2(a, { store: { sqlite: db }, gate: { gate: escalating, escalationTimeoutMs: 600_000 } });
    handleWith(rt, 'w.work', () => 'done');
    await rt.create('outbox.Job', { id: 'job-cli' });
    await rt.dispatch('job-cli', 'Go');
    await rt.worker.tick();
    const [row] = await rt.outbox('job-cli');
    const out = join(keys, 'approval.json');
    const r = spawnSync(process.execPath, [cli, 'approve', row.intent_id, '--by', PERSON.keyId, '--key', keyFile, '--db', db, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    await rt.approve(JSON.parse(readFileSync(out, 'utf8')));
    await rt.worker.tick();
    assert.equal((await rt.getState('job-cli')).state.phase, 'Done');
    await rt.close();
    // A key inside the repository is refused (S126).
    const inside = join(a.dir, 'ops.pem');
    writeFileSync(inside, PERSON.privateKeyPem);
    const bad = spawnSync(process.execPath, [cli, 'approve', row.intent_id, '--by', PERSON.keyId, '--key', inside, '--db', db], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /version control/);
    rmSync(inside, { force: true });
    // poly accept, after poly check wrote the report.
    const dir = project('accepted-cli', ['conformance/m2/seeded/invariant/unfixed.poly'], makeKey('accept-cli'));
    spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    const report = JSON.parse(readFileSync(join(dir, '.poly', 'report.json'), 'utf8'));
    const d = report.files[0].machines.flatMap((m) => m.diagnostics).find((x) => x.code === 'PL3001');
    const acc = spawnSync(process.execPath, [cli, 'accept', d.witness.id.slice(7, 19), '--by', PERSON.keyId, '--key', keyFile, '--root', dir], { encoding: 'utf8' });
    assert.equal(acc.status, 0, acc.stderr);
    assert.equal((await admit(dir)).certificate.boundAccepted.length, 1);
  } finally { try { rmSync(keys, { recursive: true, force: true }); } catch { /* the store file may still be held on Windows */ } }
});

// Review A1 and C3: a record lifts the escalation it names, once. After a Recheck the intent escalates again, and the
// first record, which names the first escalation, is refused for the second.
test('S150: an approval of an earlier escalation of the same intent does not lift a later one', async () => {
  let stale = 0;
  const { rt } = await loaded(a, { gate: { gate: escalating, escalationTimeoutMs: 600_000 }, worker: { isStale: () => stale++ === 0 } });
  try {
    let runs = 0;
    handleWith(rt, 'w.work', () => { runs++; return 'done'; });
    await rt.create('outbox.Job', { id: 'job-twice' });
    await rt.dispatch('job-twice', 'Go');
    await rt.worker.tick();
    const [row] = await rt.outbox('job-twice');
    const r1 = await approvalFor(rt, row.intent_id);
    await rt.approve(r1);
    await rt.worker.tick(); // allowed, found stale, rechecked, escalated again
    assert.equal((await rt.worker.intentState(row)).intent, 'Escalated');
    assert.equal(runs, 0);
    await assert.rejects(rt.approve(r1), /current escalation|already/);
    assert.equal((await rt.worker.intentState(row)).intent, 'Escalated');
    await rt.approve(await approvalFor(rt, row.intent_id));
    await rt.worker.tick();
    assert.equal(runs, 1);
  } finally { await rt.close(); }
});

// Review C2: PT9.2, an escalation not approved within its timeout is denied, even when the approval reaches the
// runtime before the worker's next pass.
test('PT9.2: an approval that arrives after the escalation timeout is refused, and the intent is denied', async () => {
  const { rt, clock } = await escalated('job-late');
  try {
    const [row] = await rt.outbox('job-late');
    const record = await approvalFor(rt, row.intent_id);
    clock.advance(60 * 60_000);
    await assert.rejects(rt.approve(record), /timed out/);
    await rt.worker.tick();
    assert.equal((await rt.worker.intentState(row)).intent, 'Denied');
  } finally { await rt.close(); }
});

// Review A3, A4: a keyring holds public keys only, and one key is one holder. A key pair, private key first, passed
// the PEM test and was certified whole; an agent's key listed again under a person's id signed as that person.
test('PT12.5: a private key in a keyring is refused, and one key listed in both rings is refused', async () => {
  const { keyringsOf, ManifestError } = await import('@poly/core');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const ring = (people, agents = []) => keyringsOf('.', { poly: '1', name: 'x', modules: [], people, agents });
  assert.throws(() => ring([{ name: 'ops', keyId: 'k1', publicKey: priv + pub }]), (e) => e instanceof ManifestError && /private key/.test(e.message));
  assert.throws(() => ring([{ name: 'ops', keyId: 'k1', publicKey: `${priv}\n# -----BEGIN PUBLIC KEY-----` }]), (e) => e instanceof ManifestError);
  const ok = ring([{ name: 'ops', keyId: 'k1', publicKey: pub }]);
  assert.match(ok.people[0].publicKey, /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(!/PRIVATE/.test(ok.people[0].publicKey));
  assert.throws(() => ring([{ name: 'ops', keyId: 'k1', publicKey: pub }], [{ name: 'ci', keyId: 'k2', publicKey: pub }]), (e) => e instanceof ManifestError && /same key/.test(e.message));
});
