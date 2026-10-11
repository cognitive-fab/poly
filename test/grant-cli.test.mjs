// PT10g, PS16.4, PT12.5: the grant-request and grant-revoke command-line binaries.
// (a) grant-request writes { kind: "grant-request", credential, holder, record } to a file,
// signed by a person's key (PT12.5), over the subject of the credential and holder (PT10g).
// (b) The central case of PS16.4: a Granted grant stays Granted and its effect is allowed until
// the owner signs a grant-revoke, then the Grant is Revoked in its own step, and the intent is
// denied credential-unavailable; the provider's revocation request (RFC 7009) is an intent like
// any other, retried within its effect's bound, and its failure never undoes the local revocation.
// (c) grant-revoke reads one live grant's current instance (no --grant, with --db and --credential),
// and with several live grants it prints the instance ids, signs nothing, exits non-zero, and
// writes no --out file; the store is not written.
// (d) A key that is not of the people ring signs a record that takeApprovals refuses wrong-key.
// (e) Missing --by, --key, or --grant/--credential is a usage error (exit 64) with nothing written.
// (f) poly --help-style usage text lists poly grant-request and poly grant-revoke.
// Written from PS16.4 and PT10g (ruled 2026-10-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { handleWith, PERSON, AGENT } from './runtime-helpers.mjs';
import { GENERIC, desk, verdicts } from './grants-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');

function run(args, { cwd = ROOT, env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

test('(a) PS16.4, PT10g: grant-request writes a signed request to a file', { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-grant-cli-'));
  const { rt, dir } = await desk('grant-cli-request');
  try {
    const keyFile = join(tmp, 'person.pem');
    writeFileSync(keyFile, PERSON.privateKeyPem);
    const outFile = join(tmp, 'request.json');
    const holder = 'alice-' + Math.random().toString(36).slice(2);
    const r = run(['grant-request', '--credential', 'payments', '--for', holder, '--by', PERSON.keyId, '--key', keyFile, '--out', outFile], { cwd: dir });
    assert.equal(r.code, 0, `stdout: ${r.out}, stderr: ${r.err}`);
    assert.ok(statSync(outFile).isFile(), 'output file was written');
    const written = JSON.parse(readFileSync(outFile, 'utf8'));
    assert.equal(written.kind, 'grant-request');
    assert.equal(written.credential, 'payments');
    assert.equal(written.holder, holder);
    assert.ok(written.record, 'record is present');
    assert.equal(written.record.kind, 'grant-request');
    assert.equal(written.record.by, PERSON.keyId);
  } finally {
    await rt.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** A person's or an agent's private key, written to a file outside the repository, for the commands, which read a file. */
const keyFileOf = (tmp, who) => { const f = join(tmp, `${who.keyId}.pem`); writeFileSync(f, who.privateKeyPem); return f; };

test('(b) PS16.4: a revocation in the provider\'s settings is not seen; the owner\'s signed revocation, taken from the approvals folder, is, local first', { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-grant-revoke-'));
  const { rt, dir, grant, sent, answers } = await desk('grant-cli-revoke');
  try {
    const approvals = join(dir, 'approvals');
    mkdirSync(approvals, { recursive: true });
    handleWith(rt, 'payments.refund', async () => ({}));
    await grant('payments', 'm-1', ['refunds.write']);
    const id = rt.grantOf('payments', 'm-1');
    const refund = async (instance) => { await rt.create('creds.Desk', { id: instance }); await rt.dispatch(instance, 'Refund', { merchant: 'm-1', amount: 1 }); await rt.advance(); return (await verdicts(rt, instance))[0]; };
    assert.equal((await refund('d-before'))[0], 'allowed');
    // The owner revokes in the provider's account settings. Nothing reaches the runtime: the Grant is Granted, and an
    // intent that uses it is still allowed, which is the gap the command closes.
    assert.equal((await rt.store.getInstance(id)).state.g, 'Granted');
    assert.equal((await refund('d-unseen'))[0], 'allowed');
    // The owner signs the revocation from poly and puts it in the approvals folder.
    const r = run(['grant-revoke', '--grant', id, '--by', PERSON.keyId, '--key', keyFileOf(tmp, PERSON), '--out', join(approvals, 'revoke.json')], { cwd: dir });
    assert.equal(r.code, 0, `stdout: ${r.out}, stderr: ${r.err}`);
    sent.length = 0;
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => x.outcome), ['applied']);
    // Local first: the Grant is Revoked in its own step, before any request to the provider is made.
    assert.equal((await rt.store.getInstance(id)).state.g, 'Revoked');
    assert.deepEqual(sent, [], 'no request to the provider has been made yet');
    assert.equal((await refund('d-after'))[1], 'credential-unavailable');
    // Then the provider's revocation follows as an effect.
    await rt.advance();
    assert.ok(sent.some((q) => q.url.startsWith(GENERIC.revocation)), JSON.stringify(sent.map((q) => q.url)));
    const events = (await rt.chain('runtime:ingress')).map((e) => e.body).filter((b) => b?.stage === 'revocation');
    assert.deepEqual(events.map((b) => [b.credential, b.source]), [['payments', 'person']]);
  } finally { await rt.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('(c) PT10g: with --credential and --db, grant-revoke signs the one live grant; with a grant for each holder it prints their ids and signs nothing', { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-grant-db-'));
  const db = join(tmp, 'run.db');
  const { rt, dir, grant } = await desk('grant-cli-db', {}, undefined, { store: { sqlite: db } });
  try {
    const key = keyFileOf(tmp, PERSON);
    await grant('payments', 'm-1', ['refunds.write']);
    const only = rt.grantOf('payments', 'm-1');
    const rows = () => rt.store.db.prepare('SELECT count(*) AS n FROM poly_ledger').get().n;
    const before = rows();
    const out = join(tmp, 'one.json');
    const r = run(['grant-revoke', '--credential', 'payments', '--db', db, '--by', PERSON.keyId, '--key', key, '--out', out], { cwd: dir });
    assert.equal(r.code, 0, `stdout: ${r.out}, stderr: ${r.err}`);
    const named = join(tmp, 'named.json');
    assert.equal(run(['grant-revoke', '--grant', only, '--by', PERSON.keyId, '--key', key, '--out', named], { cwd: dir }).code, 0);
    const [a, b] = [out, named].map((f) => JSON.parse(readFileSync(f, 'utf8')));
    assert.deepEqual([a.kind, a.subject, a.by], [b.kind, b.subject, b.by], 'the same subject: the digest of the live instance');
    assert.equal(a.subject, rt.revocationSubject('payments', 'm-1'));
    // A second holder: the credential now has two live grants, and the command names neither.
    await grant('payments', 'm-2', ['refunds.write']);
    const second = rt.grantOf('payments', 'm-2');
    const many = join(tmp, 'many.json');
    const m = run(['grant-revoke', '--credential', 'payments', '--db', db, '--by', PERSON.keyId, '--key', key, '--out', many], { cwd: dir });
    assert.notEqual(m.code, 0);
    assert.ok(m.err.includes(only) && m.err.includes(second), m.err);
    assert.equal(existsSync(many), false, 'nothing is signed');
    // Neither run wrote to the store.
    assert.equal(rows() - before > 0, true, 'the second grant wrote its own events');
    const after = rows();
    run(['grant-revoke', '--credential', 'payments', '--db', db, '--by', PERSON.keyId, '--key', key], { cwd: dir });
    assert.equal(rows(), after);
    // A credential with no live grant has nothing to revoke.
    const none = run(['grant-revoke', '--credential', 'reports', '--db', db, '--by', PERSON.keyId, '--key', key], { cwd: dir });
    assert.notEqual(none.code, 0);
    assert.match(none.err, /no live grant/);
  } finally { await rt.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('(d) PS16.4, PT12.5: a revocation signed with an agent\'s key is refused wrong-key, and the grant stays Granted', { timeout: 300_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-grant-agent-'));
  const { rt, dir, grant } = await desk('grant-cli-agent');
  try {
    const approvals = join(dir, 'approvals');
    mkdirSync(approvals, { recursive: true });
    await grant('payments', 'm-1', ['refunds.write']);
    const id = rt.grantOf('payments', 'm-1');
    const r = run(['grant-revoke', '--grant', id, '--by', AGENT.keyId, '--key', keyFileOf(tmp, AGENT), '--out', join(approvals, 'revoke.json')], { cwd: dir });
    assert.equal(r.code, 0, 'the command signs; the runtime decides whose key counts');
    const [taken] = await rt.takeApprovals(approvals);
    assert.deepEqual([taken.outcome, taken.reason], ['refused', 'wrong-key']);
    assert.equal((await rt.store.getInstance(id)).state.g, 'Granted');
  } finally { await rt.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('(e) PT12.5: missing --by, --key, or --grant/--credential is usage error (exit 64)', { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-grant-usage-'));
  const keyFile = join(tmp, 'person.pem');
  writeFileSync(keyFile, 'dummy');
  const outFile = join(tmp, 'out.json');
  try {
    // Missing --by.
    let r = run(['grant-revoke', '--credential', 'payments', '--key', keyFile, '--out', outFile]);
    assert.equal(r.code, 64, 'missing --by: exit 64');
    // Missing --key.
    r = run(['grant-revoke', '--credential', 'payments', '--by', 'key-1', '--out', outFile]);
    assert.equal(r.code, 64, 'missing --key: exit 64');
    // Missing --credential and --grant.
    r = run(['grant-revoke', '--by', 'key-1', '--key', keyFile, '--out', outFile]);
    assert.equal(r.code, 64, 'missing --credential/--grant: exit 64');
    // grant-request: missing --out.
    r = run(['grant-request', '--credential', 'payments', '--by', 'key-1', '--key', keyFile]);
    assert.equal(r.code, 64, 'grant-request missing --out: exit 64');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('(f) PT10g: poly usage text lists grant-request and grant-revoke', { timeout: 60_000 }, () => {
  const r = run([]);
  assert.notEqual(r.code, 0, 'no args prints usage');
  assert.match(r.err + r.out, /grant-request/, 'grant-request is listed');
  assert.match(r.err + r.out, /grant-revoke/, 'grant-revoke is listed');
});
