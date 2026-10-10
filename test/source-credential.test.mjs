// S460 (PS17.0, PT10j, ruled 2026-10-09): a source names its credential. `credential c` in a `records` or `documents`
// source names a credential of the module with no holder; the build certifies c's vault as it does an effect's (PT10f);
// the adapter is built with the runtime's handle for c, which sends each request through the vault, only under the
// provider's base addresses, and only while c's grant is Granted. So revoking the grant (PS16.4) stops the source's
// requests. Written from the specification text alone, before the code. The provider is the tests' test-oauth, with
// recorded traffic only; every token is generated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '@poly/core';
import { parse } from '@poly/lang';
import { printModule, readEmbedded } from '@poly/embed';
import { admit, checkFile } from '@poly/check';
import { openSearchSource } from '@poly/io';
import { ROOT, TEST_STD } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';
import { desk } from './grants-helpers.mjs';
import { FAULT_SOURCES } from './toolchain-faults.mjs';

const FIX = 'test/fixtures/source-credential/desk.poly';
const DESK = readFileSync(join(ROOT, FIX), 'utf8');
const OUT = join(ROOT, '.poly', 'test-source-credential');
// The provider profile's one base is https://api.test-oauth.example/v1/, and an OpenSearch base is an origin with no
// path, so the index named v1 puts every request of the adapter under the provider's base.
const ORIGIN = 'https://api.test-oauth.example';
const INDEX = 'v1';

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.split(from).join(to); };
const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics)];
const codes = (r) => all(r).map((d) => d.code);
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const BARE = swap(swap(DESK, '  credential reports\n', ''), '  credential payments\n', '');
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return { r: await checkFile(join(d, 'm.poly'), { root: d, std: TEST_STD }), build: join(d, '.poly', 'build') };
}

/** Every row of every table the runtime keeps, as text, for a scan. */
const rows = (rt) => rt.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap(({ name }) => rt.store.db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)));

/**
 * PT10j: the handle refuses before sending. The text does not say whether a refusal rejects or resolves to a refusal,
 * so either is taken, provided it names the reason and nothing reached the transport.
 */
async function refused(d, call, reason) {
  const before = d.sent.length;
  let out;
  try { out = await call(); } catch (e) { assert.match(String(e?.message ?? e), reason); assert.equal(d.sent.length, before, 'nothing was sent'); return; }
  assert.match(JSON.stringify(out), reason);
  assert.ok(!(out?.status >= 200 && out?.status < 300), JSON.stringify(out));
  assert.equal(d.sent.length, before, 'nothing was sent');
}

/** The desk of this fixture, admitted with both credentials in the KMS store and a vault per credential (grants-helpers). */
const scDesk = (name) => desk(name, {}, [FIX]);
/** The service's own grant of reports, made through the provider's recorded answers. */
const grantReports = (d) => d.grant('reports', null, ['reports.read']);

/** One recorded search and one recorded document, as the cluster answers them, with an asOf the clock calls now. */
function searchAnswers(d) {
  const asof = new Date(d.clock.now()).toISOString();
  d.answers.push((q) => { assert.equal(q.url, `${ORIGIN}/${INDEX}/_search`); return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: { hits: [{ _id: 'h-1', _source: { asof } }] } }) }; });
  d.answers.push((q) => { assert.equal(q.url, `${ORIGIN}/${INDEX}/_doc/h-1`); return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ found: true, _source: { asof, body: 'Reset it from the settings page.' } }) }; });
}
async function search(rt, id) {
  await rt.dispatch(id, 'Search');
  for (let k = 0; k < 6; k++) { await rt.advance(); await rt.worker.tick(); }
  return (await rt.getState(id)).state;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The checker (PS17.0, PT10j).
// ---------------------------------------------------------------------------------------------------------------------

test('S460 control: the fixture without its credential lines checks CLEAN on the checker as it is', { timeout: 300_000 }, async () => {
  const { r } = await check(BARE);
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S460, PS17.0: a documents source naming a client_credentials credential, and one naming an authorization_code credential with no holder, check CLEAN', { timeout: 300_000 }, async () => {
  const { r } = await check(DESK);
  assert.ok(!codes(r).includes('PL1001') && !codes(r).includes('PL1201'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S460, PS17.0: credential naming no credential of the module is PL1001', { timeout: 300_000 }, async () => {
  const { r } = await check(swap(DESK, '  credential reports\n', '  credential nothing\n'));
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1001'), text(r));
});

test('S460, PS17.0: credential naming a credential with holder Principal is PL1201', { timeout: 300_000 }, async () => {
  const { r } = await check(swap(DESK, '  scopes { charges.read }\n', '  scopes { charges.read }\n  holder Principal\n'));
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
});

test('S460, PS17.0: credential in a memory source is PL1201', { timeout: 300_000 }, async () => {
  const src = swap(DESK, 'enum Phase', 'source mem: memory {\n  audience staff owned\n  credential reports\n}\n\nenum Phase');
  const { r } = await check(src);
  assert.equal(r.verdict, 'REFUSED', text(r));
  assert.ok(codes(r).includes('PL1201'), text(r));
});

test('S460, PS17.0: a source names at most one credential', { timeout: 300_000 }, async () => {
  // The control first, so the refusal below is the second credential's and not the item's.
  assert.equal((await check(DESK)).r.verdict, 'CLEAN');
  const { r } = await check(swap(DESK, '  credential reports\n', '  credential reports\n  credential payments\n'));
  assert.equal(r.verdict, 'REFUSED', text(r));
});

test('S460, PT10j: the embedded option credential: \'c\' reads back to the same module as the text', () => {
  const a = parse(DESK);
  assert.ok(a.module, JSON.stringify(a.diagnostics));
  const printed = printModule(a.module);
  assert.ok(printed.includes("credential: 'reports'"), printed);
  const back = readEmbedded(printed);
  assert.ok(back.module, JSON.stringify(back.diagnostics));
  assert.equal(digest(back.module), digest(a.module));
  // The credential is part of the module: without it the digest differs.
  assert.notEqual(digest(parse(BARE).module), digest(a.module));
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. The build and admission (PT10j, PT10f).
// ---------------------------------------------------------------------------------------------------------------------

test('S460, PT10j: sources/<s>.json records credential, and credentials/<c>.json is written though no effect uses c', { timeout: 300_000 }, async () => {
  const { r, build } = await check(DESK);
  assert.equal(r.verdict, 'CLEAN', text(r));
  assert.equal(JSON.parse(readFileSync(join(build, 'sources', 'help.json'), 'utf8')).credential, 'reports');
  assert.equal(JSON.parse(readFileSync(join(build, 'sources', 'files.json'), 'utf8')).credential, 'payments');
  assert.equal(JSON.parse(readFileSync(join(build, 'sources', 'notes.json'), 'utf8')).credential ?? null, null);
  for (const [c, grant] of [['reports', 'client_credentials'], ['payments', 'authorization_code']]) {
    const file = join(build, 'credentials', `${c}.json`);
    assert.ok(existsSync(file), `${c}'s descriptor is written`);
    const descriptor = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual([descriptor.credential, descriptor.grant, descriptor.holder], [c, grant, false]);
    assert.deepEqual(descriptor.bases, ['https://api.test-oauth.example/v1/']);
  }
});

test('S460, PT10f: admission binds the source credential\'s vault in poly.vaults', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-admit');
  try {
    const vaults = d.cert.poly.vaults.map((v) => [v.credential, v.store]).sort();
    assert.deepEqual(vaults, [['payments', 'kms'], ['reports', 'kms']]);
  } finally { await d.rt.close(); }
});

test('S460, PT10f: admission refuses a source credential that poly.json names no store for', { timeout: 300_000 }, async () => {
  const key = makeKey('sc-nostore');
  const dir = project('sc-nostore', [FIX], key, 'test-grants');
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
  await assert.rejects(admit(dir, { std: TEST_STD }), /credential reports names no store/);
});

test('S460, PT10j: the broken lowering source-credential-dropped is in the explicit list of toolchain faults', () => {
  assert.ok(Object.hasOwn(FAULT_SOURCES, 'source-credential-dropped'), Object.keys(FAULT_SOURCES).join(', '));
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. The handle (PT10j, PS16.4).
// ---------------------------------------------------------------------------------------------------------------------

test('S460, PT10j: with the grant Granted, the handle sends a request under the provider\'s base through the vault, and no token reaches what it returns or the journal', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-handle');
  const { rt } = d;
  try {
    const tokens = await grantReports(d);
    const handle = rt.credentialHandle('reports');
    assert.equal(typeof handle?.request, 'function');
    d.answers.push(() => ({ status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 's=1' }, body: '{"ok":true}' }));
    const before = d.sent.length;
    const res = await handle.request({ method: 'GET', url: 'https://api.test-oauth.example/v1/reports', headers: {}, body: '' });
    assert.equal(res.status, 200);
    assert.equal(d.sent.length, before + 1, 'one request reached the transport');
    // The vault's withToken attached the grant's token: the request carries it, and the handle's answer does not.
    const call = d.sent.at(-1);
    assert.deepEqual([call.method, call.url, call.headers.authorization], ['GET', 'https://api.test-oauth.example/v1/reports', `Bearer ${tokens.access}`]);
    const out = JSON.stringify(res);
    assert.ok(!out.includes(tokens.access) && !out.includes(tokens.refresh), 'no token in what the handle returns');
    assert.ok(!rows(rt).some((r) => r.includes(tokens.access) || r.includes(tokens.refresh)), 'no token in what the runtime keeps');
  } finally { await d.rt.close(); }
});

test('S460, PT10j: the handle refuses a URL outside the provider\'s base addresses before sending, PL6406, audited', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-outside');
  const { rt } = d;
  try {
    await grantReports(d);
    const handle = rt.credentialHandle('reports');
    for (const url of ['https://elsewhere.example/v1/reports', 'https://api.test-oauth.example/v2/reports', 'http://api.test-oauth.example/v1/reports']) {
      await refused(d, () => handle.request({ method: 'GET', url, headers: {}, body: '' }), /PL6406/);
    }
    assert.ok(rows(rt).some((r) => r.includes('PL6406')), 'the refusal is recorded');
  } finally { await d.rt.close(); }
});

test('S460, PS16.4: while the grant is not Granted (none, Requested, Revoked) every request is refused credential-unavailable and nothing is sent', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-unavailable');
  const { rt } = d;
  const req = { method: 'GET', url: 'https://api.test-oauth.example/v1/reports', headers: {}, body: '' };
  try {
    const handle = rt.credentialHandle('reports');
    // No grant yet.
    await refused(d, () => handle.request(req), /credential-unavailable/);
    // Requested: the authorization URL is made, the provider has not answered.
    await rt.requestGrant('reports', null);
    await refused(d, () => handle.request(req), /credential-unavailable/);
    // The consent completes (a new request) and the handle sends.
    const url = await rt.requestGrant('reports', null);
    d.tokenAnswer(['reports.read']);
    assert.equal((await d.redirect('reports', new URL(url).searchParams.get('state'))).status, 200);
    d.answers.push(() => ({ status: 200, headers: {}, body: '{}' }));
    assert.equal((await handle.request(req)).status, 200);
    // Revoked: from the step that records Revoked, nothing is sent.
    d.answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('reports', null, { source: 'provider' });
    await rt.advance();
    await refused(d, () => handle.request(req), /credential-unavailable/);
  } finally { await d.rt.close(); }
});

test('S460 control: with no source credential, the fixture\'s retrieval runs over a plain transport at the index v1', { timeout: 300_000 }, async () => {
  const key = makeKey('sc-bare');
  const dir = project('sc-bare', [FIX], key, 'test-grants');
  writeFileSync(join(dir, 'src', 'desk.poly'), BARE);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' }, reports: { store: 'kms' } } }, null, 2));
  const r = await admit(dir, { std: TEST_STD });
  const { rt, clock } = await loaded({ build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey } }, { std: TEST_STD });
  try {
    const d = { sent: [], answers: [], clock };
    const plain = { async request(q) { d.sent.push(q); const a = d.answers.shift(); if (!a) throw new Error(`no recorded answer for ${q.method} ${q.url}`); return a(q); } };
    rt.connectSource('help', openSearchSource({ base: ORIGIN, index: INDEX, transport: plain, asOf: 'asof', body: 'body' }));
    await rt.create('srccred.Desk', { id: 'd-1' });
    searchAnswers(d);
    const st = await search(rt, 'd-1');
    assert.deepEqual([st.phase, st.found], ['Idle', 1], JSON.stringify(st));
    assert.ok(d.sent.length >= 1);
  } finally { await rt.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. The adapter built with the handle (PT10j, PL6408).
// ---------------------------------------------------------------------------------------------------------------------

test('S460, PT10j: connectSource takes an openSearchSource built with the credential\'s handle, and refuses (PL6408) one built with a plain transport or another credential\'s handle', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-connect');
  const { rt } = d;
  const plain = { async request() { throw new Error('the plain transport is never called'); } };
  const os = (transport, index = INDEX) => openSearchSource({ base: ORIGIN, index, transport, asOf: 'asof', body: 'body' });
  try {
    assert.throws(() => rt.connectSource('help', os(plain)), /PL6408/);
    assert.throws(() => rt.connectSource('help', os(rt.credentialHandle('payments'))), /PL6408/);
    rt.connectSource('help', os(rt.credentialHandle('reports')));
    rt.connectSource('files', os(rt.credentialHandle('payments')));
  } finally { await d.rt.close(); }
});

test('S460, PT10j: for a source that names no credential, connectSource refuses an adapter built with a handle and takes one built with a plain transport', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-connect-none');
  const { rt } = d;
  const plain = { async request() { throw new Error('the plain transport is never called'); } };
  const os = (transport) => openSearchSource({ base: ORIGIN, index: INDEX, transport, asOf: 'asof', body: 'body' });
  try {
    // PT10j names PL6408 for the first refusal; the text gives no code for this one, so only the refusal is asserted.
    assert.throws(() => rt.connectSource('notes', os(rt.credentialHandle('reports'))));
    rt.connectSource('notes', os(plain));
  } finally { await d.rt.close(); }
});

test('S460, PS16.4: a retrieval from the source works while the grant is Granted, and after the revocation fails with no request reaching the transport', { timeout: 300_000 }, async () => {
  const d = await scDesk('sc-sync');
  const { rt } = d;
  try {
    const tokens = await grantReports(d);
    rt.connectSource('help', openSearchSource({ base: ORIGIN, index: INDEX, transport: rt.credentialHandle('reports'), asOf: 'asof', body: 'body' }));
    await rt.create('srccred.Desk', { id: 'd-1' });
    const before = d.sent.length;
    searchAnswers(d);
    const st = await search(rt, 'd-1');
    assert.deepEqual([st.phase, st.found], ['Idle', 1], JSON.stringify(st));
    const reached = d.sent.slice(before);
    assert.ok(reached.length >= 1, 'the retrieval reached the cluster');
    assert.ok(reached.every((q) => q.url.startsWith(`${ORIGIN}/${INDEX}/`) && q.headers.authorization === `Bearer ${tokens.access}`), JSON.stringify(reached.map((q) => q.url)));
    // PS16.4: revoking the grant stops every request of the source.
    d.answers.length = 0;
    d.answers.push(() => ({ status: 200, headers: {}, body: '' }));
    await rt.revokeGrant('reports', null, { source: 'provider' });
    await rt.advance();
    const after = d.sent.length;
    searchAnswers(d);
    const st2 = await search(rt, 'd-1');
    assert.deepEqual([st2.phase, st2.found], ['Idle', 2], JSON.stringify(st2));
    assert.equal(d.sent.length, after, 'no request reached the transport after the revocation');
    assert.ok(!rows(rt).some((r) => r.includes(tokens.access) || r.includes(tokens.refresh)), 'no token in what the runtime keeps');
  } finally { await d.rt.close(); }
});
