// M9 step 5 (PT10e, S203): `credential` and `uses` on both surfaces, PL6821 to PL6823, the provider profile, the
// credential's descriptor and the manifest's `uses` entry, read back by poly-ref. The provider test-oauth is the tests'
// own, under the test-only std; the Stripe example is checked against std's own profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { parse, format } from '@poly/lang';
import { digest } from '@poly/core';
import { printModule, readEmbedded } from '@poly/embed';
import { ROOT, TEST_STD } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const SRC = readFileSync(join(ROOT, 'test', 'fixtures', 'm9', 'credentials.poly'), 'utf8');
const STRIPE = readFileSync(join(ROOT, 'test', 'fixtures', 'm9', 'stripe-refund.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-credentials');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
let n = 0;
async function check(src, opts = { std: TEST_STD }) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return { r: await checkFile(join(d, 'm.poly'), { root: d, ...opts }), build: join(d, '.poly', 'build') };
}
const sha = (file) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');

test('PT10e: a credential and uses format and print on both surfaces to the same digest', () => {
  for (const src of [SRC, STRIPE]) {
    const a = parse(src);
    assert.ok(a.module, JSON.stringify(a.diagnostics));
    const formatted = format(a.module);
    assert.equal(digest(parse(formatted).module), digest(a.module));
    assert.equal(format(parse(formatted).module), formatted);
    const back = readEmbedded(printModule(a.module));
    assert.ok(back.module, JSON.stringify(back.diagnostics));
    assert.equal(digest(back.module), digest(a.module));
  }
  const f = format(parse(SRC).module);
  for (const line of ['credential payments: oauth2 {', '  grant authorization_code pkce', '  scopes { refunds.write, charges.read }', '  holder Principal', '  grant client_credentials', '    uses payments { refunds.write } for merchant', '    uses reports { reports.read }']) assert.ok(f.includes(line + '\n'), line);
});

test('PT10e: each item of a credential is written once, and the declaration names its provider, grant and scopes', () => {
  for (const [from, to] of [['  holder Principal\n', '  holder Principal\n  holder Principal\n'], ['  grant client_credentials\n', '  grant client_credentials\n  grant client_credentials\n'], ['  provider "test-oauth"\n  grant authorization_code pkce', '  grant authorization_code pkce']]) {
    const r = parse(swap(SRC, from, to));
    assert.equal(r.module, null, from);
    assert.ok(r.diagnostics.length);
  }
});

test('PT10e: the desk checks CLEAN, and each credential it uses has its descriptor and its manifest entry, read back', { timeout: 180_000 }, async () => {
  const { r, build } = await check(SRC);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const tv = r.machines[0].stages.find((s) => s.stage === 'translation-validation');
  assert.equal(tv.verdict, 'CLEAN');
  const profile = join(TEST_STD, 'credentials', 'providers', 'test-oauth.json');
  assert.deepEqual(JSON.parse(readFileSync(join(build, 'credentials', 'payments.json'), 'utf8')), { v: 1, credential: 'payments', kind: 'oauth2', provider: 'test-oauth', profile: sha(profile), grant: 'authorization_code', pkce: true, scopes: ['refunds.write', 'charges.read'], holder: true, bases: ['https://api.test-oauth.example/v1/'] });
  assert.deepEqual(JSON.parse(readFileSync(join(build, 'credentials', 'reports.json'), 'utf8')).holder, false);
  const manifest = JSON.parse(readFileSync(join(build, 'creds.Desk', 'effects.manifest.json'), 'utf8'));
  assert.deepEqual(manifest.effects['payments.refund'].uses, { credential: 'payments', scopes: ['refunds.write'], holder: 'merchant' });
  assert.deepEqual(manifest.effects['reports.fetch'].uses, { credential: 'reports', scopes: ['reports.read'], holder: null });
  assert.ok(r.machines[0].artefactDigests['../credentials/payments.json']);
});

test('PT10e: the example checks against std\'s Stripe Connect profile', { timeout: 180_000 }, async () => {
  const { r, build } = await check(STRIPE, {});
  assert.equal(r.verdict, 'CLEAN', text(r));
  const d = JSON.parse(readFileSync(join(build, 'credentials', 'payments.json'), 'utf8'));
  assert.equal(d.profile, sha(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json')));
  assert.deepEqual([d.grant, d.pkce, d.scopes, d.bases], ['authorization_code', false, ['read_write'], ['https://api.stripe.com/']]);
  // As Stripe documents it: no PKCE, no client credentials grant, and two scopes only.
  for (const [from, to, code] of [['grant authorization_code\n', 'grant authorization_code pkce\n', 'PL1201'], ['scopes { read_write }', 'scopes { read_write, refunds.write }', 'PL1001']]) {
    const x = await check(swap(STRIPE, from, to), {});
    assert.equal(x.r.verdict, 'REFUSED');
    assert.ok(codes(x.r).includes(code), text(x.r));
  }
});

test('PL6821: a scope an effect uses is one its credential declares', { timeout: 120_000 }, async () => {
  const { r } = await check(swap(SRC, 'uses payments { refunds.write } for merchant', 'uses payments { refunds.write, reports.read } for merchant'));
  assert.equal(r.verdict, 'REFUSED');
  assert.deepEqual(codes(r), ['PL6821'], text(r));
});

test('PL6822: a credential granted by a person is used for a named holder', { timeout: 120_000 }, async () => {
  const { r } = await check(swap(SRC, 'uses payments { refunds.write } for merchant', 'uses payments { refunds.write }'));
  assert.equal(r.verdict, 'REFUSED');
  assert.deepEqual(codes(r), ['PL6822'], text(r));
});

test('PL6823: every egress target of an effect that uses a credential lies under the provider\'s base addresses', { timeout: 120_000 }, async () => {
  for (const target of ['https://api.other.example/v1/refunds', 'https://api.test-oauth.example/v2/refunds', 'http://api.test-oauth.example/v1/refunds']) {
    const { r } = await check(swap(SRC, '"https://api.test-oauth.example/v1/refunds"', JSON.stringify(target)));
    assert.equal(r.verdict, 'REFUSED', target);
    assert.deepEqual(codes(r), ['PL6823'], text(r));
  }
});

test('PT10e: a provider with no profile, an undefined scope and an unknown credential are PL1001', { timeout: 120_000 }, async () => {
  for (const [from, to] of [
    ['  provider "test-oauth"\n  grant client_credentials', '  provider "nowhere"\n  grant client_credentials'],
    ['scopes { refunds.write, charges.read }', 'scopes { refunds.write, charges.read, admin.all }'],
    ['uses reports { reports.read }', 'uses report { reports.read }'],
    ['uses payments { refunds.write } for merchant', 'uses payments { refunds.write } for buyer'],
  ]) {
    const { r } = await check(swap(SRC, from, to));
    assert.equal(r.verdict, 'REFUSED', to);
    assert.deepEqual(codes(r), ['PL1001'], text(r));
  }
});

test('PT10e: a holder that is not a Principal parameter, a holder on the service\'s credential, and an effect with no egress target are PL1201', { timeout: 120_000 }, async () => {
  for (const [from, to] of [
    ['uses payments { refunds.write } for merchant', 'uses payments { refunds.write } for amount'],
    ['uses payments { refunds.write } for merchant', 'uses reports { reports.read } for merchant'],
    ['    targets { egress: "https://api.test-oauth.example/v1/reports" }\n', ''],
    ['  scopes { refunds.write, charges.read }\n  holder Principal\n', '  scopes { refunds.write, charges.read }\n'],
    ['  scopes { reports.read }\n', '  scopes { reports.read }\n  holder Principal\n'],
    ['  scopes { reports.read }\n', '  scopes { }\n'],
    ['  scopes { reports.read }\n', '  scopes { reports.read, reports.read }\n'],
  ]) {
    const { r } = await check(swap(SRC, from, to));
    assert.equal(r.verdict, 'REFUSED', to);
    const c = codes(r);
    assert.ok(c.length && c.every((x) => x === 'PL1201' || x === 'PL1002'), `${to}: ${text(r)}`);
  }
});

test('PT10e: admission certifies each credential\'s descriptor, and load refuses one changed after admission', { timeout: 300_000 }, async () => {
  const a = await admitted('credentials-stripe', ['test/fixtures/m9/stripe-refund.poly']);
  const descriptor = '.poly/build/credentials/payments.json';
  assert.deepEqual(a.cert.poly.credentials, [{ name: 'payments', descriptor }]);
  assert.equal(a.cert.artefacts[descriptor], sha(join(a.dir, descriptor)));
  const { rt } = await loaded(a);
  await rt.close();
  const file = join(a.dir, descriptor);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"https://api.stripe.com/"', '"https://api.stripe.com/", "http://api.stripe.com/"'));
  await assert.rejects(loaded(a), /payments\.json/);
});
