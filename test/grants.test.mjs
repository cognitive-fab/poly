// M9 step 8 (PS16.3, PS16.4; PT22.4 to PT22.6; S199, S201): the runtime's grant check before the policy, the proposal
// field `credential`, the `api` capability over the vault's withToken, revocation from its three sources, the lint's
// PL6824 and PL6401 for the vault, PL6825, and `poly grant`. The provider is the tests' test-oauth, with recorded
// traffic only; every token is generated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, lintHandlerText } from '@poly/check';
import { signRecord } from '@poly/core';
import { handleWith, makeKey, project, PERSON, AGENT } from './runtime-helpers.mjs';
import { polyaxionPeer } from '@poly/runtime';
import { GENERIC, desk, secret, verdicts } from './grants-helpers.mjs';

test('PS16.3: a delegated effect with no grant is denied credential-unavailable before any policy, journaled', { timeout: 300_000 }, async () => {
  const { rt } = await desk('grant-none');
  try {
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.deepEqual(await verdicts(rt, 'd-1'), [['denied', 'credential-unavailable']]);
  } finally { await rt.close(); }
});

test('PS16.3, PT22.5: with the merchant\'s grant, the refund is allowed, the handler calls api, and the vault attaches the token the handler never sees', { timeout: 300_000 }, async () => {
  const { rt, sent, answers, grant } = await desk('grant-ok');
  try {
    const tokens = await grant('payments', 'm-1', ['refunds.write']);
    let seen = null;
    handleWith(rt, 'payments.refund', async (payload, caps) => { seen = Object.keys(caps).sort(); const r = await caps.api.post('https://api.test-oauth.example/v1/refunds', 'amount=1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }); return { status: r.status }; });
    answers.push(() => ({ status: 200, headers: { 'set-cookie': 's=1' }, body: '{"id":"re_1"}' }));
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.deepEqual(seen, ['api']);
    const call = sent.at(-1);
    assert.deepEqual([call.url, call.headers.authorization], ['https://api.test-oauth.example/v1/refunds', `Bearer ${tokens.access}`]);
    assert.deepEqual((await verdicts(rt, 'd-1')).map((v) => v[0]), ['allowed']);
    assert.deepEqual((await rt.outbox('d-1')).map((r) => r.status), ['done']);
    // The grant's state and scopes are proposed with the effect; the holder is not.
    const allowed = (await rt.chain('d-1')).find((e) => e.kind === 'verdict' && e.body.outcome === 'allowed');
    const proposal = await rt.store.body(allowed.body.proposal);
    assert.deepEqual(proposal.credential, { name: 'payments', grantState: 'Granted', scopes: ['refunds.write'] });
    // Nothing the runtime keeps holds the token (AC18, the scan's full form is step 11's).
    const rows = rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap(({ name }) => rt.store.db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)));
    assert.ok(!rows.some((r) => r.includes(tokens.access) || r.includes(tokens.refresh)));
  } finally { await rt.close(); }
});

test('PS16.3, AC19: a grant with fewer scopes than the effect uses is insufficient-scope; one holder\'s grant and another credential\'s scope never satisfy it', { timeout: 300_000 }, async () => {
  const { rt, grant, answers } = await desk('grant-scope');
  try {
    await grant('payments', 'm-1', ['charges.read']);
    await grant('payments', 'm-2', ['refunds.write']);
    await grant('reports', null, ['reports.read']);
    handleWith(rt, 'reports.fetch', async () => ({}));
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.deepEqual(await verdicts(rt, 'd-1'), [['denied', 'insufficient-scope']]);
    await rt.create('creds.Desk', { id: 'd-2' });
    await rt.dispatch('d-2', 'Refund', { merchant: 'm-3', amount: 1 });
    await rt.advance();
    assert.deepEqual(await verdicts(rt, 'd-2'), [['denied', 'credential-unavailable']]);
    // The service's own credential, granted with its scope, serves the report.
    await rt.dispatch('d-2', 'Report');
    answers.length = 0;
    await rt.advance();
    assert.deepEqual((await verdicts(rt, 'd-2')).slice(1).map((v) => v[0]), ['allowed']);
    assert.ok((await rt.outbox('d-2')).some((r) => r.kind === 'reports.fetch' && r.status === 'done'));
  } finally { await rt.close(); }
});

test('PS16.4, AC19: a revocation, from the provider or by a person\'s signed record, denies every later intent, and an agent\'s record is refused', { timeout: 300_000 }, async () => {
  const { rt, grant, answers, sent } = await desk('grant-revoke');
  try {
    const tokens = await grant('payments', 'm-1', ['refunds.write']);
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', 'm-1', { source: 'provider' });
    await rt.advance();
    // The Grant's revoke effect revoked the refresh token at the provider (RFC 7009).
    assert.equal(new URLSearchParams(sent.at(-1).body).get('token'), tokens.refresh);
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.deepEqual(await verdicts(rt, 'd-1'), [['denied', 'credential-unavailable']]);
    await grant('payments', 'm-2', ['refunds.write']);
    const subject = rt.revocationSubject('payments', 'm-2');
    const by = (who) => signRecord({ kind: 'revocation', subject, by: who.keyId, at: '2026-10-07T00:00:00.000Z' }, who.privateKeyPem);
    await assert.rejects(rt.revokeGrant('payments', 'm-2', { source: 'person', record: by(AGENT) }), /agent key/);
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', 'm-2', { source: 'person', record: by(PERSON) });
    await rt.advance();
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-2', amount: 1 });
    await rt.advance();
    assert.deepEqual((await verdicts(rt, 'd-1')).at(-1), ['denied', 'credential-unavailable']);
  } finally { await rt.close(); }
});

test('PS16.3, S147: an intent allowed before the grant was revoked, waiting to be tried again, is proposed again and denied', { timeout: 300_000 }, async () => {
  const { rt, clock, grant, answers } = await desk('grant-stale');
  try {
    await grant('payments', 'm-1', ['refunds.write']);
    // The first attempt fails, so the allowed intent waits for its retry; the revocation lands before the retry starts.
    let calls = 0;
    handleWith(rt, 'payments.refund', async () => { calls++; if (calls === 1) throw new Error('the provider did not answer'); return {}; });
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.equal(calls, 1);
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('payments', 'm-1', { source: 'security' });
    await rt.advance();
    clock.advance(60_000);
    await rt.advance();
    assert.equal(calls, 1, 'the retry never starts');
    const v = await verdicts(rt, 'd-1');
    assert.deepEqual(v.at(-1), ['denied', 'credential-unavailable'], JSON.stringify(v));
    assert.ok(v.some(([o, r]) => o === 'rechecked' && r === 'stale-allow'), JSON.stringify(v));
  } finally { await rt.close(); }
});

test('PT22.5: the handler lint refuses an import of the vault module (PL6401) and a read of a token-bearing header (PL6824)', () => {
  assert.deepEqual(lintHandlerText("import { oauthVault } from '@poly/io';\nexport const h = oauthVault;\n", 'h.ts').map((d) => d.code), ['PL6401']);
  for (const read of ["r.headers['set-cookie']", 'r.headers.authorization', "r.headers.get('Authorization')", "res.headers['proxy-authorization']"]) {
    assert.deepEqual(lintHandlerText(`export async function h(p, { api }) { const r = await api.get('https://x.example/'); return ${read}; }\n`, 'h.ts').map((d) => d.code), ['PL6824'], read);
  }
  assert.deepEqual(lintHandlerText("export async function h(p, { api }) { const r = await api.get('https://x.example/'); return r.headers['content-type']; }\n", 'h.ts'), []);
});

test('PL6825: admission refuses a token-shaped string in poly.json', { timeout: 300_000 }, async () => {
  const key = makeKey('grant-secret');
  const dir = project('grant-secret', ['conformance/m1/effects.poly'], key, 'test-grants');
  const shaped = `xoxb-${randomBytes(12).toString('hex')}`;
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), name: shaped }, null, 2));
  await assert.rejects(admit(dir), (e) => /PL6825/.test(e.message) && !e.message.includes(shaped));
});

test('PS16.4, AC19: an intent already running when its grant is revoked finishes, and is recorded as started first', { timeout: 300_000 }, async () => {
  const { rt, grant, answers } = await desk('grant-running');
  try {
    await grant('payments', 'm-1', ['refunds.write']);
    answers.push(() => ({ status: 200, headers: {}, body: '{}' }));
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    // The revocation arrives while the handler is running: the provider has already taken the request.
    handleWith(rt, 'payments.refund', async (payload, caps) => { const r = await caps.api.post('https://api.test-oauth.example/v1/refunds', 'amount=1'); await rt.revokeGrant('payments', 'm-1', { source: 'provider' }); return { status: r.status }; });
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.deepEqual((await rt.outbox('d-1')).map((r) => r.status), ['done']);
    const ledger = rt.store.db.prepare('SELECT seq, run, kind, event FROM poly_ledger ORDER BY rowid').all().map((r) => ({ run: r.run, body: JSON.parse(r.event).body }));
    const started = ledger.findIndex((e) => e.run.startsWith('intent:') && e.body?.action === 'Start');
    const revoked = ledger.findIndex((e) => e.body?.stage === 'revocation');
    assert.ok(started >= 0 && revoked > started, JSON.stringify({ started, revoked }));
  } finally { await rt.close(); }
});

test('PT10g: poly grant-request and grant-revoke are the owner\'s commands, never over MCP, and the runtime takes both from its approvals folder', { timeout: 300_000 }, async () => {
  const { COMMANDS } = await import('@poly/check');
  const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const request = COMMANDS.find((c) => c.name === 'grant-request');
  const revoke = COMMANDS.find((c) => c.name === 'grant-revoke');
  assert.deepEqual([request?.mcp, revoke?.mcp], [null, null]);
  const { rt, dir, answers } = await desk('grant-cli');
  const tmp = mkdtempSync(join(tmpdir(), 'poly-grant-'));
  try {
    const approvals = join(dir, 'approvals');
    mkdirSync(approvals, { recursive: true });
    // The person's key is written outside the repository for the commands, which read a file, and deleted (as ruled).
    const keyFile = join(tmp, 'person.pem');
    writeFileSync(keyFile, PERSON.privateKeyPem);
    // S210: the request is signed by a person, as the revocation is.
    await request.run({ credential: 'payments', for: 'm-1', by: PERSON.keyId, key: keyFile, out: join(approvals, 'request.json') });
    assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => x.outcome), ['applied']);
    const [auth] = rt.takeAuthorizations();
    assert.equal(auth.credential, 'payments');
    assert.equal(new URL(auth.url).origin + new URL(auth.url).pathname, GENERIC.authorization);
    // The request named its holder; the journal does not.
    const journal = JSON.stringify((await rt.chain('runtime:approvals')).map((e) => e.body));
    assert.ok(!journal.includes('m-1'), journal);
    const grantId = rt.grantOf('payments', 'm-1');
    await revoke.run({ grant: grantId, by: PERSON.keyId, key: keyFile, out: join(approvals, 'revoke.json') });
    answers.push(() => ({ status: 200, headers: {}, body: '' }));
    assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => x.outcome), ['applied']);
    assert.equal((await rt.store.getInstance(grantId)).state.g, 'Revoked');
  } finally { rmSync(tmp, { recursive: true, force: true }); await rt.close(); }
});

// S199: E11 settled by test, as E10 was, on the pinned Polyaxion: the policy reads effect.credential, and a proposal
// without it is denied.
const skipGate = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
test('S199, E11: a policy over effect.credential allows the granted refund on the pinned engine, and denies a proposal without the field', { skip: skipGate, timeout: 300_000 }, async () => {
  const { rt, grant } = await desk('grant-policy', {}, ['test/fixtures/m9/credentials.poly', 'test/fixtures/m9/credentials.policy.poly']);
  try {
    await grant('payments', 'm-1', ['refunds.write']);
    handleWith(rt, 'payments.refund', async () => ({}));
    await rt.create('creds.Desk', { id: 'd-1' });
    await rt.dispatch('d-1', 'Refund', { merchant: 'm-1', amount: 1 });
    await rt.advance();
    assert.equal((await verdicts(rt, 'd-1'))[0][0], 'allowed');
    // The note uses no credential, so it is proposed without the field, and the rule denies it (fail closed).
    await rt.create('creds.Desk', { id: 'd-2' });
    await rt.dispatch('d-2', 'Note');
    await rt.advance();
    const [denied] = await verdicts(rt, 'd-2');
    assert.ok(denied?.[0] === 'denied' && /granted-credential/.test(denied[1]), JSON.stringify(await verdicts(rt, 'd-2')));
  } finally { await rt.close(); }
});

// As ruled (2026-10-07): PL6825 covers every file the certificate binds. An adapter's configuration is host code the
// handlers import, certified with them, and it holds no secret value; the adapter takes its secrets at run time.
test('PL6825: admission refuses a token-shaped string in an adapter configuration file the handlers import, naming the file and never the value', { timeout: 300_000 }, async () => {
  const key = makeKey('grant-adapter-secret');
  const dir = project('grant-adapter-secret', ['conformance/m1/effects.poly'], key, 'test-grants');
  const shaped = `xoxb-${randomBytes(12).toString('hex')}`;
  writeFileSync(join(dir, 'src', 'adapter-config.ts'), `export const slackConfig = { botToken: '${shaped}', teamId: 'T123ABC456' };\n`);
  writeFileSync(join(dir, 'src', 'handlers.ts'), `import { slackConfig } from './adapter-config.ts';\nexport const team = slackConfig.teamId;\n${readFileSync(join(dir, 'src', 'handlers.ts'), 'utf8')}`);
  await assert.rejects(admit(dir), (e) => /PL6825/.test(e.message) && /adapter-config\.ts/.test(e.message) && /Slack token/.test(e.message) && !e.message.includes(shaped));
  // The control: the same configuration naming its secret by reference is admitted.
  writeFileSync(join(dir, 'src', 'adapter-config.ts'), "export const slackConfig = { botToken: 'vault:slack-bot', teamId: 'T123ABC456' };\n");
  assert.equal((await admit(dir)).verdict, 'CLEAN');
});
