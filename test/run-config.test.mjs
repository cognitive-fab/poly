// S188 (M8a step 2): `poly run --mcp` loads the project's runtime from the `run` field of poly.json: the certificate, the
// store, trust as admission public keys only, an optional ledger signer, and the approvals folder (S189). The signer is
// `file:` only and must resolve outside the project, and its contents never appear in output, logs or the journal. The
// field has a published schema, and an unknown field under it is refused. One process owns a store at a time. No model
// runs, and no key is read from the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { admit } from '@poly/check';
import { parseManifest, RUN_SCHEMA } from '@poly/core';
import { loadRun, RunConfigError, polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { makeKey, project, PERSON } from './runtime-helpers.mjs';
import { mcpClient } from './mcp-client.mjs';
import { schemaProblems as validate } from './json-schema.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const BRIEF = 'conformance/m6/customer-brief.poly';
const OUTSIDE = mkdtempSync(join(tmpdir(), 'poly-run-keys-'));
const MARKER = 'SIGNER-CONTENTS-MUST-NOT-APPEAR';

/** A ledger signing key, written where the test says. */
function signerAt(path) {
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return path;
}

/** An admitted project whose poly.json carries a run field. */
async function runProject(name, sources, run = {}) {
  const key = makeKey(name);
  const dir = project(name, sources, key, 'test-run-config');
  writeFileSync(join(dir, 'admission.pub.pem'), key.publicKey);
  const manifest = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  manifest.run = { trust: { [key.id]: 'file:admission.pub.pem' }, ...run };
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(manifest, null, 2));
  await admit(dir);
  return { dir, key };
}

test('S188: a ledger signer inside the project is refused at load, by its path, never its contents', async () => {
  const { dir } = await runProject('run-signer-inside', [BRIEF]);
  signerAt(join(dir, 'keys', 'ledger.pem'));
  const m = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  m.run.ledger = { keyId: 'ops-ledger', signer: 'file:keys/ledger.pem' };
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(m, null, 2));
  const pem = readFileSync(join(dir, 'keys', 'ledger.pem'), 'utf8');
  await assert.rejects(loadRun(dir), (e) => e instanceof RunConfigError && /outside the project/.test(e.message) && /ledger\.pem/.test(e.message) && !e.message.includes(pem.split('\n')[1]));
  // An absolute path into the project is inside it too.
  m.run.ledger.signer = `file:${join(dir, 'keys', 'ledger.pem')}`;
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(m, null, 2));
  await assert.rejects(loadRun(dir), /outside the project/);
});

test('S188: a signer that is not a key is refused without echoing what the file holds', async () => {
  const { dir } = await runProject('run-signer-garbage', [BRIEF]);
  const bad = join(OUTSIDE, 'not-a-key.pem');
  writeFileSync(bad, `${MARKER}\n`);
  const m = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  m.run.ledger = { keyId: 'ops-ledger', signer: `file:${bad}` };
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(m, null, 2));
  await assert.rejects(loadRun(dir), (e) => e instanceof RunConfigError && !e.message.includes(MARKER) && /not-a-key\.pem/.test(e.message));
});

test('S188: the signer is file: only; env: and any other form are refused, and so is an unknown field under run', () => {
  const base = { poly: '1', name: 'x', modules: ['src/*.poly'], run: { trust: { k: 'file:k.pem' } } };
  const parse = (run) => parseManifest(JSON.stringify({ ...base, run: { ...base.run, ...run } }));
  assert.doesNotThrow(() => parse({ ledger: { keyId: 'l', signer: 'file:/keys/l.pem' } }));
  assert.throws(() => parse({ ledger: { keyId: 'l', signer: 'env:LEDGER_KEY' } }), /file:/);
  assert.throws(() => parse({ ledger: { keyId: 'l', signer: '-----BEGIN PRIVATE KEY-----' } }), /file:/);
  assert.throws(() => parse({ bogus: true }), /unknown field "bogus" under "run"/);
  assert.throws(() => parse({ ledger: { keyId: 'l', signer: 'file:x', extra: 1 } }), /ledger/);
  assert.throws(() => parseManifest(JSON.stringify({ ...base, run: {} })), /trust/);
});

test('S188: run has a published schema, the one the parser enforces', () => {
  const published = JSON.parse(readFileSync(join(ROOT, 'schemas', 'manifest', 'run.json'), 'utf8'));
  assert.deepEqual(published, RUN_SCHEMA);
  assert.equal(published.additionalProperties, false);
  const ok = { trust: { k: 'file:k.pem' }, certificate: '.poly/certificate.json', store: '.poly/run/store.sqlite', approvals: 'approvals', ledger: { keyId: 'l', signer: 'file:/k.pem' } };
  assert.deepEqual(validate(published, ok), []);
  assert.notDeepEqual(validate(published, { ...ok, bogus: 1 }), []);
});

test('S188: trust takes admission public keys only; a private key there is refused at load', async () => {
  const { dir, key } = await runProject('run-trust-private', [BRIEF]);
  writeFileSync(join(dir, 'admission.pub.pem'), readFileSync(key.file, 'utf8'));
  await assert.rejects(loadRun(dir), (e) => e instanceof RunConfigError && /public key/.test(e.message) && !/BEGIN PRIVATE KEY/.test(e.message));
});

test('S174: one process owns a store at a time; a second is refused until the first closes', async () => {
  const { dir } = await runProject('run-lock', [BRIEF]);
  const first = await loadRun(dir);
  try {
    await assert.rejects(loadRun(dir), (e) => e instanceof RunConfigError && /owned by process/.test(e.message));
  } finally { await first.close(); }
  const again = await loadRun(dir);
  await again.close();
});

test('S174, S188: poly run --mcp serves the workflow tools from poly.json, with a ledger signer outside the project', { timeout: 300_000 }, async () => {
  const signer = signerAt(join(OUTSIDE, 'run-cli', 'ledger.pem'));
  const { dir } = await runProject('run-cli', [BRIEF], { ledger: { keyId: 'ops-ledger', signer: `file:${signer}` } });
  const c = mcpClient(process.execPath, [CLI, 'run', '--mcp'], { cwd: dir });
  let out = '';
  try {
    await c.initialize();
    let v = await c.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-10-04' } });
    for (let k = 0; k < 6 && !v.done; k++) {
      const [o] = v.next;
      v = await c.call('workflow_report', { order_id: o.order_id, ok: true, result: o.tool === 'github_search_issues' ? { count: 2 } : {} });
    }
    assert.equal(v.state.briefState, 'posted');
    out = c.stderr();
  } finally { await c.close(); }
  const pem = readFileSync(signer, 'utf8').split('\n')[1];
  assert.ok(!out.includes(pem), 'the signer\'s contents never appear in the server\'s output');
  const db = new DatabaseSync(join(dir, '.poly', 'run', 'store.sqlite'), { readOnly: true });
  try {
    const ledger = db.prepare('SELECT event FROM poly_ledger').all().map((r) => r.event).join('\n');
    assert.ok(!ledger.includes(pem), 'nor in the journal');
  } finally { db.close(); }
});

const peer = polyaxionPeer();
test('S189: a person\'s approval dropped in the approvals folder reaches a running poly run --mcp, and the order is issued', { skip: peer.ok ? false : `not run: ${peer.reason}`, timeout: 300_000 }, async () => {
  const { dir } = await runProject('run-cli-approve', [BRIEF, 'conformance/m8/brief-escalate.policy.poly']);
  const person = join(OUTSIDE, 'person.pem');
  writeFileSync(person, PERSON.privateKeyPem);
  const c = mcpClient(process.execPath, [CLI, 'run', '--mcp'], { cwd: dir });
  try {
    await c.initialize();
    let v = await c.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-10-04' } });
    for (let k = 0; k < 3; k++) { const [o] = v.next; v = await c.call('workflow_report', { order_id: o.order_id, ok: true, result: o.tool === 'github_search_issues' ? { count: 2 } : {} }); }
    assert.equal(v.state.briefState, 'posting');
    assert.deepEqual(v.next ?? [], []);
    const store = join(dir, '.poly', 'run', 'store.sqlite');
    const db = new DatabaseSync(store, { readOnly: true });
    const intent = db.prepare("SELECT intent_id FROM pr_outbox WHERE kind = 'post_brief'").get().intent_id;
    db.close();
    const r = spawnSync(process.execPath, [CLI, 'approve', intent, '--by', PERSON.keyId, '--key', person, '--db', store, '--out', join(dir, 'approvals', '001.json')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    let next = [];
    for (let k = 0; k < 40 && !next.length; k++) {
      await new Promise((res) => setTimeout(res, 250));
      next = (await c.call('workflow_state', { instance: v.instance })).next ?? [];
    }
    assert.equal(next[0]?.tool, 'slack_send');
    assert.ok(existsSync(join(dir, 'approvals', 'applied', '001.json')));
  } finally { await c.close(); }
});
