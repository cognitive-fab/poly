// PT34.5, S586: makes the kept stores of the risk report's two examples, under docs/examples/risk-report/<example>/, and
// the report of each. For each example it admits the program with its policy signed by a test person, drives its runtime
// with a fixed clock over a scripted set of proposals, on a store file with a ledger signer, signs every head and
// publishes an anchor; then it keeps the store, the certificate, the build it certifies and the public keys that verify
// them (trust.json names each key's file), and writes report.md and report.json with `poly report risks`, run from the
// repository's root with the paths written from there, as test/s586-examples.test.mjs runs it.
//
// The store is kept, not made again: its key is random by design, so every recipient digest and every signature would
// change with each run. Run this only to replace a kept example, and commit what it writes.
//
// It uses the test suite's helpers (a test person, a test keyring anchor and test keys), so it runs as a test file does:
//   node --import ./test/fixtures/home-guard.mjs --import ./test/fixtures/accept-test-anchors.mjs \
//        --env-file=test/fixtures/serial-heap.env scripts/risk-report-examples.mjs [airline-desk] [concierge]
// The concierge's admission checks the whole program, which takes minutes and a large heap; run nothing heavy beside it.
// With --reports it writes report.md and report.json again from the kept files alone, and runs no program.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { admit } from '@poly/check';
import { grantRequestSubject, signRecord } from '@poly/core';
import { load } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from '../test/helpers.mjs';
import { PERSON, approvalFor, approveAs, handleWith, makeKey, project, signPolicies } from '../test/runtime-helpers.mjs';

const KEPT = join(ROOT, 'docs', 'examples', 'risk-report');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const slashed = (p) => relative(ROOT, p).split(sep).join('/');
const T0 = 1_790_000_000_000; // 2026-09-21T14:13:20Z

/** The project's poly.json with the example's exposure, read from the example's own poly.json. */
function withExposure(dir, example) {
  const exposure = JSON.parse(readFileSync(join(ROOT, 'examples', example, 'poly.json'), 'utf8')).exposure;
  const pj = join(dir, 'poly.json');
  writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), exposure }, null, 2));
}

/** Keeps what the report reads, then writes the report in both formats from the kept files. */
function keep(example, { dir, db, certificate, signer, key }) {
  const out = join(KEPT, example);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(db, join(out, 'store.db'));
  if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, join(out, 'store.db-wal'));
  // One file: the log is folded into the kept store, whose content it does not change.
  const kept = new DatabaseSync(join(out, 'store.db'));
  kept.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  kept.exec('PRAGMA journal_mode=DELETE');
  kept.close();
  for (const x of ['-wal', '-shm']) rmSync(join(out, `store.db${x}`), { force: true });
  copyFileSync(certificate, join(out, 'certificate.json'));
  // Of the build, only what the report reads: the policy documents the certificate names, checked by their digests.
  for (const p of JSON.parse(readFileSync(certificate, 'utf8')).poly.policies) {
    const to = join(out, 'build', p.path.replace(/^\.poly\/build\//, ''));
    mkdirSync(join(to, '..'), { recursive: true });
    copyFileSync(join(dir, p.path), to);
  }
  writeFileSync(join(out, 'ledger.pub.pem'), signer.publicKey);
  writeFileSync(join(out, 'admission.pub.pem'), key.publicKey);
  const trust = { [signer.id]: 'ledger.pub.pem', [key.id]: 'admission.pub.pem' };
  writeFileSync(join(out, 'trust.json'), JSON.stringify(trust, null, 2) + '\n');
  reports(example);
  console.log(`kept ${slashed(out)}`);
}

/** report.md and report.json of a kept example, written from its kept files alone. */
function reports(example) {
  const out = join(KEPT, example);
  const trust = JSON.parse(readFileSync(join(out, 'trust.json'), 'utf8'));
  for (const [format, file] of [['json', 'report.json'], ['md', 'report.md']]) {
    const args = ['report', 'risks', '--db', slashed(join(out, 'store.db')), '--build', slashed(join(out, 'build')), '--certificate', slashed(join(out, 'certificate.json')),
      ...Object.entries(trust).flatMap(([id, f]) => ['--trust', `${id}=${slashed(join(out, f))}`]), '--format', format, '--out', join(out, file)];
    const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
    if (!existsSync(join(out, file))) throw new Error(`poly report risks wrote no ${file} (exit ${r.status}): ${r.stdout}${r.stderr}`);
  }
}

/** A ledger signer whose public key is kept; its private key is a test key, never kept. */
const ledgerSigner = (name) => makeKey(`${name}-ledger`);

// ── The airline desk: a refusal, a decision on unknown input, an escalation approved, one timed out, one open, and
// two unknown outcomes (an allowed certificate and an approved one whose handlers are exhausted). ────────────────────

async function airlineDesk() {
  const name = 'risk-report-airline-desk';
  const key = makeKey(name);
  const dir = project(name, ['examples/airline-desk/airline-desk.poly', 'examples/airline-desk/airline-desk.policy.poly'], key, 'risk-report-examples');
  withExposure(dir, 'airline-desk');
  await signPolicies(dir);
  const admitted = await admit(dir);
  const signer = ledgerSigner(name);
  const db = join(dir, 'store.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const TIMEOUT = 600_000;
  const rt = await load(join(dir, '.poly', 'build'), {
    certificate: admitted.certificatePath, trust: { [key.id]: key.publicKey }, now: clock.now,
    store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') },
    gate: { escalationTimeoutMs: TIMEOUT },
    // The desk's verifier: a customer's credentials, as the airline's login asserted them.
    verifier: (c) => (c ? { check: c.check, principal: c.principal } : null),
  });
  const failing = new Set(['cert-small', 'cert-approved-failing']);
  try {
    for (const kind of ['airline.change', 'airline.cancel', 'airline.certificate']) handleWith(rt, kind, (_p, _c, ctx) => { if (failing.has(ctx.instanceId)) throw new Error('the certificate service did not answer'); return `${ctx.instanceId}|ok`; });
    const customer = (principal, check = 'Verified') => ({ credentials: { principal, check } });
    const settle = async (n = 8) => { for (let k = 0; k < n; k++) { clock.advance(1_000); await rt.worker.tick(); } };
    const intentOf = async (id) => (await rt.outbox(id))[0].intent_id;
    const booking = async (id) => rt.create('airline_desk.Booking', { id });
    // Day 1: changes, cancellations and a disruption.
    await booking('change-confirmed');
    await rt.dispatch('change-confirmed', 'Confirm', {}, customer('cust-1'));
    await rt.dispatch('change-confirmed', 'Change', {}, customer('cust-1'));
    await booking('change-unconfirmed');
    await rt.dispatch('change-unconfirmed', 'Change', {}, customer('cust-2'));
    await booking('cancel-illness');
    await rt.dispatch('cancel-illness', 'Cancel', { r: 'Illness' }, customer('cust-3'));
    await booking('cancel-no-reason');
    await rt.dispatch('cancel-no-reason', 'Cancel', { r: 'None' }, customer('cust-4'));
    await booking('cancel-unchecked');
    await rt.dispatch('cancel-unchecked', 'Cancel', { r: 'Plans' }, customer('cust-5', 'Unverified'));
    await booking('disruption');
    await rt.dispatch('disruption', 'Disrupt');
    await settle(12);
    // Day 2: compensation certificates.
    clock.advance(86_400_000);
    const certificate = async (id, big) => { await rt.create('airline_desk.Compensation', { id }); await rt.dispatch(id, 'Issue', { big }); };
    await certificate('cert-small', false);
    await settle(12);
    for (const id of ['cert-approved', 'cert-approved-failing']) {
      await certificate(id, true);
      await settle(2);
      await approveAs(rt, await intentOf(id));
      await settle(12);
    }
    await certificate('cert-timed-out', true);
    await settle(2);
    clock.advance(TIMEOUT + 60_000);
    await settle(2);
    await certificate('cert-open', true);
    await settle(2);
    await rt.signHeads();
    await rt.publishAnchor({ from: 0, to: clock.now() + 1 });
  } finally { await rt.close(); }
  keep('airline-desk', { dir, db, certificate: admitted.certificatePath, signer, key });
}

// ── The concierge: AC27's day on recorded traffic, a status question, a small refund and a large one a person approves. ─

async function concierge() {
  const EX = join(ROOT, 'examples', 'concierge');
  const hostModule = (f) => import(pathToFileURL(join(EX, 'host', f)).href);
  const { loadAnswers, recordedConcierge, provideRecorded } = await hostModule('recorded.mjs');
  const { forwardEscalations } = await hostModule('notice.mjs');
  const { refund } = await hostModule('refund.mjs');
  const { whatsapp, slack, postgresSource, oauthVault, kmsStore, credentialIngress } = await import('@poly/io');
  const { fakeStripe, memoryWrap, orderRows, ordersTable } = await import('../test/ex-concierge-helpers.mjs');
  const { recorded, whatsappWebhook, slackWebhook } = await import('../test/concierge-helpers.mjs');
  const FIXTURE = loadAnswers(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'));
  const STRIPE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json'), 'utf8'));
  const PHONES = { 'wa-1': '16505551234', 'wa-2': '16505559876' };
  const name = 'risk-report-concierge';
  const key = makeKey(name);
  const dir = project(name, [], key, 'risk-report-examples');
  for (const f of ['concierge.poly', 'concierge.policy.poly']) copyFileSync(join(EX, f), join(dir, 'src', f));
  cpSync(join(EX, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  cpSync(join(EX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  const pj = join(dir, 'poly.json');
  writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
  withExposure(dir, 'concierge');
  await signPolicies(dir);
  const admitted = await admit(dir);
  const signer = ledgerSigner(name);
  const db = join(dir, 'store.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const rt = await load(join(dir, '.poly', 'build'), {
    certificate: admitted.certificatePath, trust: { [key.id]: key.publicKey }, now: clock.now,
    store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') },
    verifier: (c) => (c ? { principal: c.principal } : null),
  });
  try {
    const secret = () => randomBytes(32).toString('hex');
    const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
    const sl = { signingSecret: secret(), botToken: `xoxb-${secret()}`, teamId: 'T123ABC456' };
    rt.connectChannel('support', whatsapp(wa), { http: { async request() { return { status: 200, headers: {}, body: recorded('whatsapp/send-response.json') }; } } });
    rt.connectChannel('staff', slack(sl), { http: { async request() { return { status: 200, headers: {}, body: recorded('slack/post-ok.json') }; } } });
    rt.mapSenders('support', (sender) => FIXTURE.customers[Object.keys(PHONES).find((k) => sender.includes(PHONES[k]))] ?? null);
    const orders = ordersTable(orderRows(FIXTURE));
    rt.connectSource('orders', postgresSource({ query: orders.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary', keys: { charge: 'charge_id' } }));
    provideRecorded(rt, recordedConcierge(FIXTURE));
    handleWith(rt, 'payments.refund', refund);
    const { http: stripeHttp } = fakeStripe(FIXTURE, STRIPE);
    const vault = oauthVault(STRIPE, { clientId: 'ca_concierge', redirectUri: 'https://concierge.example/credentials/payments', clientSecret: `sk_test_${secret()}` }, kmsStore(memoryWrap()), { http: stripeHttp });
    rt.connectVault('payments', vault);
    const callback = credentialIngress(rt, { payments: vault }, () => rt.now());
    const approvals = join(dir, 'approvals');
    mkdirSync(approvals, { recursive: true });
    const request = signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', 'merchant-1'), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);
    writeFileSync(join(approvals, '00-grant.json'), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder: 'merchant-1', record: request }));
    await rt.takeApprovals(approvals);
    const url = rt.takeAuthorizations().find((x) => x.credential === 'payments').url;
    await callback('payments', { method: 'GET', url: `https://concierge.example/credentials/payments?code=ac_${secret()}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' });
    const settle = async (n = 40) => { for (let k = 0; k < n; k++) { await rt.advance(); await rt.worker.tick(); } };
    let k = 0;
    const waMessage = (from, body) => {
      const m = JSON.parse(recorded('whatsapp/message.json'));
      const v = m.entry[0].changes[0].value;
      v.contacts[0].wa_id = from;
      Object.assign(v.messages[0], { from, id: `wamid.risk-${++k}`, text: { body } });
      return whatsappWebhook(wa, JSON.stringify(m));
    };
    const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;
    const say = async (who, id) => { await rt.receive('support', waMessage(PHONES[who], textOf(id))); clock.advance(1000); await settle(); };
    const deskA = await rt.threadId('support', PHONES['wa-1']);
    const deskB = await rt.threadId('support', PHONES['wa-2']);
    await say('wa-1', 'status');
    await say('wa-1', 'refund-small');
    const staff = JSON.parse(recorded('slack/message.json'));
    Object.assign(staff.event, { text: 'Morning, the concierge is on.', ts: '1355517523.000001', event_ts: '1355517523.000001' });
    staff.event_id = 'Ev-risk-1';
    await rt.receive('staff', slackWebhook(sl, JSON.stringify(staff), clock.now()));
    await settle();
    const notice = await rt.threadId('staff', 'C123ABC456');
    await say('wa-2', 'refund-large');
    const [esc] = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'payments.refund'").all(deskB).map((r) => r.intent_id);
    await forwardEscalations(rt, { desks: [deskA, deskB], notice, noticed: new Set() });
    await settle();
    await rt.approve(await approvalFor(rt, esc));
    await settle();
    await rt.signHeads();
    await rt.publishAnchor({ from: 0, to: clock.now() + 1 });
  } finally { await rt.close(); }
  keep('concierge', { dir, db, certificate: admitted.certificatePath, signer, key });
}

const only = process.argv.includes('--reports');
const which = process.argv.slice(2).filter((a) => a !== '--reports');
for (const [example, make] of [['airline-desk', airlineDesk], ['concierge', concierge]]) {
  if (which.length && !which.includes(example)) continue;
  if (only) { reports(example); console.log(`the reports of ${example} written again from its kept files`); } else await make();
}
