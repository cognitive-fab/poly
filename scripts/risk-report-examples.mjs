// PT34.5, S586: makes the kept stores of the risk report's examples, under docs/examples/risk-report/<example>/, and
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
//        --env-file=test/fixtures/serial-heap.env scripts/risk-report-examples.mjs [airline-desk] [concierge] [pii-guard]
// pii-guard (S587, A5) keeps two certificates in one store: the program's and the defect's, admitted with its finding accepted.
// The concierge's admission checks the whole program, which takes minutes and a large heap; run nothing heavy beside it.
// With --reports it writes report.md and report.json again from the kept files alone, and runs no program.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { admit } from '@poly/check';
import { grantRequestSubject, signRecord } from '@poly/core';
import { load } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from '../test/helpers.mjs';
import { PERSON, approvalFor, approveAs, handleWith, makeKey, project, signPolicies } from '../test/runtime-helpers.mjs';
import { acceptFindings } from '../test/ex-kit.mjs';

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

/**
 * Keeps what the report reads, then writes the report in both formats from the kept files. `more` names further
 * certificates of the same store, each kept as its own file (pii-guard's defect, A5); their policy documents go into the
 * one build folder, since the report takes one --build, and a document that differs from one already kept stops the
 * script (A5's stop).
 */
function keep(example, { dir, db, certificate, signer, key, more = [] }) {
  const out = join(KEPT, example);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(db, join(out, 'store.db'));
  if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, join(out, 'store.db-wal'));
  // One file: the log is folded into the kept store, whose content it does not change.
  const kept = new DatabaseSync(join(out, 'store.db'));
  kept.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  kept.exec('PRAGMA journal_mode=DELETE');
  // A deleted row's bytes stay in its page until the page is rewritten: pii-guard's erased bodies (S205) were still in
  // the file, unreachable by any query (measured, A5). VACUUM rewrites the file from its live rows alone.
  kept.exec('VACUUM');
  kept.close();
  for (const x of ['-wal', '-shm']) rmSync(join(out, `store.db${x}`), { force: true });
  // Of the build, only what the report reads: the policy documents the certificate names, checked by their digests.
  for (const c of [{ dir, certificate, as: 'certificate.json' }, ...more]) {
    copyFileSync(c.certificate, join(out, c.as));
    for (const p of JSON.parse(readFileSync(c.certificate, 'utf8')).poly.policies) {
      const to = join(out, 'build', p.path.replace(/^\.poly\/build\//, ''));
      mkdirSync(join(to, '..'), { recursive: true });
      const from = readFileSync(join(c.dir, p.path));
      if (existsSync(to) && !readFileSync(to).equals(from)) throw new Error(`${c.as} names ${p.path}, which differs from the one kept: stop for a ruling (A5)`);
      writeFileSync(to, from);
    }
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
  // Every certificate the folder keeps: certificate.json alone for the first two examples, and the defect's after it for
  // pii-guard, in the order A5 names them, so the report is made from the same arguments its test gives.
  const certificates = readdirSync(out).filter((f) => /^certificate.*\.json$/.test(f)).sort((a, b) => (a === 'certificate.json' ? -1 : b === 'certificate.json' ? 1 : a.localeCompare(b)));
  for (const [format, file] of [['json', 'report.json'], ['md', 'report.md']]) {
    const args = ['report', 'risks', '--db', slashed(join(out, 'store.db')), '--build', slashed(join(out, 'build')), ...certificates.flatMap((c) => ['--certificate', slashed(join(out, c))]),
      ...Object.entries(trust).flatMap(([id, f]) => ['--trust', `${id}=${slashed(join(out, f))}`]), '--format', format, '--out', join(out, file)];
    // The old report is removed first, so a failed run under --reports cannot leave it in place and pass for a new one.
    rmSync(join(out, file), { force: true });
    const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
    // A kept example counts every run (RT27): an exit other than CLEAN is a failure to keep, not a report.
    if (r.status !== 0 || !existsSync(join(out, file))) throw new Error(`poly report risks exited ${r.status} for ${file}: ${r.stdout}${r.stderr}`);
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

// ── pii-guard (A5): the program's day, then the defect's early mail on the same store, refused by sensitive-redacted. ──

async function piiGuard() {
  const EX = join(ROOT, 'examples', 'pii-guard');
  const hostModule = (f) => import(pathToFileURL(join(EX, 'host', f)).href);
  const facts = await hostModule('facts.mjs');
  const { provideGuard } = await hostModule('providers.mjs');
  const { loadRecorded, recordedAdapter } = await hostModule('recorded.mjs');
  const { recipientTable } = await hostModule('recipients.mjs');
  const table = facts.loadTable(join(EX, 'host', 'facts.json'));
  const fixture = loadRecorded(join(EX, 'recorded', 'answers.json'));
  const sample = (f) => readFileSync(join(EX, 'samples', f), 'utf8');
  const name = 'risk-report-pii-guard';
  const key = makeKey(name);
  // One project per build, both admitted with the same key and the example's exposure; the defect's PL3002 accepted (PT12.5).
  const admitBuild = async (tag, program) => {
    const dir = project(`${name}${tag}`, [], key, 'risk-report-examples');
    for (const f of [program, 'pii-guard.policy.poly']) copyFileSync(join(EX, f), join(dir, 'src', f));
    copyFileSync(join(EX, 'host', 'handlers.ts'), join(dir, 'src', 'handlers.ts'));
    withExposure(dir, 'pii-guard');
    await signPolicies(dir);
    if (tag) await acceptFindings(dir);
    return { dir, certificate: (await admit(dir)).certificatePath };
  };
  const program = await admitBuild('', 'pii-guard.poly');
  const defect = await admitBuild('-defect', 'pii-guard-defect.poly');
  const signer = ledgerSigner(name);
  const db = join(program.dir, 'store.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  // One clock for both runtimes, so the store's time only moves forward. No wall clock reaches the store (A5).
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const TIMEOUT = 600_000;
  // Synthetic addresses, none of them in a sample; the store keeps none of them (S205 erasure below).
  const KNOWN = 'known.reader@mail.example';
  const recipients = recipientTable(randomBytes(32).toString('hex'));
  recipients.add(KNOWN);
  const start = async (a, { hold = false } = {}) => {
    const rt = await load(join(a.dir, '.poly', 'build'), {
      certificate: a.certificate, trust: { [key.id]: key.publicKey }, now: clock.now,
      store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') },
      gate: { escalationTimeoutMs: TIMEOUT },
      transports: { egress: async () => ({ status: 201, headers: {}, body: { ok: true } }) },
    });
    const client = recordedAdapter(fixture, { samplesDir: join(EX, 'samples'), hold });
    provideGuard(rt, { client, table, recipients });
    const handlers = rt.handlerExports('src/handlers.ts');
    rt.handle('model.call', handlers.callModel);
    rt.handle('mail.send', handlers.sendMail);
    return { rt, client };
  };
  const settle = async (rt, n = 20) => { for (let k = 0; k < n; k++) { clock.advance(1_000); await rt.advance(); await rt.worker.tick(); } };
  const draft = async (rt, id, action, file, address) => {
    await rt.create('pii.Outbound', { id });
    const data = { body: await rt.putContent(sample(file)) };
    if (address !== undefined) data.address = await rt.putContent(address);
    await rt.dispatch(id, action, data);
    await settle(rt);
  };
  const state = async (rt, id) => (await rt.getState(id)).state;
  const send = async (rt, id) => { await rt.dispatch(id, 'Send', {}); await settle(rt); };
  const outboxOf = (rt, id) => rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'mail.send'").all(id)[0].intent_id;
  const expect = (what, ok) => { if (!ok) throw new Error(`pii-guard's scripted day: ${what}`); };

  // 1. The program: a model call and a known mail allowed; three new recipients escalated, approved, timed out and open.
  let run = await start(program);
  try {
    const { rt } = run;
    await draft(rt, 'model-call', 'DraftModel', 'en-model.txt');
    await send(rt, 'model-call');
    expect('the model call is Sent', (await state(rt, 'model-call')).phase === 'Sent');
    await draft(rt, 'mail-known', 'DraftMail', 'en-mail.txt', KNOWN);
    await send(rt, 'mail-known');
    expect('the known mail is Sent', (await state(rt, 'mail-known')).phase === 'Sent');
    await draft(rt, 'mail-new-approved', 'DraftMail', 'en-mail.txt', 'first.new@mail.example');
    await send(rt, 'mail-new-approved');
    await approveAs(rt, outboxOf(rt, 'mail-new-approved'));
    await settle(rt);
    expect('the approved mail is Sent', (await state(rt, 'mail-new-approved')).phase === 'Sent');
    await draft(rt, 'mail-new-timed-out', 'DraftMail', 'en-mail.txt', 'second.new@mail.example');
    await send(rt, 'mail-new-timed-out');
    clock.advance(TIMEOUT + 60_000);
    await settle(rt);
    // The escalation ended at its timeout, not some other way: the gate's record of it names escalation-timeout (PT34.4).
    const timedOut = (await rt.chain('mail-new-timed-out')).some((e) => e.kind === 'verdict' && JSON.stringify(e.body).includes('escalation-timeout'));
    expect('the escalated mail times out', timedOut && (await state(rt, 'mail-new-timed-out')).phase !== 'Sent');
    await draft(rt, 'mail-new-open', 'DraftMail', 'en-mail.txt', 'third.new@mail.example');
    await send(rt, 'mail-new-open');
    const escalated = (await rt.chain('mail-new-open')).some((e) => e.kind === 'verdict' && e.body.effectKind === 'mail.send' && e.body.outcome === 'escalated');
    expect('the third mail is escalated and left open', escalated && (await state(rt, 'mail-new-open')).phase !== 'Sent');
    await rt.signHeads();
  } finally { await run.rt.close(); }

  // 2. The defect: its Send while Redacting emits sendMail, and the gate denies it (the end-to-end test's run, A2: the
  // pass that runs the held redaction is not awaited until release()).
  run = await start(defect, { hold: true });
  const passes = [];
  const pass = () => { const p = (async () => { await run.rt.advance(); await run.rt.worker.tick(); })(); p.catch(() => {}); passes.push(p); };
  const poll = async (cond) => {
    pass();
    for (let k = 1; k <= 400; k++) {
      if (await cond()) return true;
      if (k % 20 === 0 && passes.length < 8) pass();
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  };
  try {
    const { rt, client } = run;
    const id = 'defect-mail';
    await rt.create('pii.Outbound', { id });
    await rt.dispatch(id, 'DraftMail', { body: await rt.putContent(sample('en-mail.txt')), address: await rt.putContent(KNOWN) });
    expect('the defect is Redacting with a redaction held', await poll(async () => {
      const s = await state(rt, id);
      return s.scan === 'Done' && s.redaction === 'Redacting' && s.recipient !== 'Unchecked' && client.calls.some((c) => c.op === 'redact');
    }));
    await rt.dispatch(id, 'Send', {});
    const denied = async () => (await rt.chain(id)).some((e) => e.kind === 'verdict' && e.body.effectKind === 'mail.send' && e.body.outcome === 'denied');
    expect('the gate denies the defect\'s early mail', await poll(async () => (await denied()) && (await state(rt, id)).phase === 'Open'));
    client.release();
    await Promise.all(passes.splice(0));
    await settle(rt);
    expect('the redaction is Verified once released', (await state(rt, id)).redaction === 'Verified');
    await send(rt, id);
    expect('the defect\'s mail is Sent once redacted', (await state(rt, id)).phase === 'Sent');
    // 3. S205: every body and address is erased, so the kept store holds digests only.
    for (const { digest } of rt.store.db.prepare('SELECT digest FROM poly_erasable ORDER BY digest').all()) await rt.erase(digest);
    await rt.signHeads();
    await rt.publishAnchor({ from: 0, to: clock.now() + 1 });
  } finally { run.client.release(); await Promise.allSettled(passes); await run.rt.close(); }
  keep('pii-guard', { dir: program.dir, db, certificate: program.certificate, signer, key, more: [{ dir: defect.dir, certificate: defect.certificate, as: 'certificate-defect.json' }] });
}

const only = process.argv.includes('--reports');
const which = process.argv.slice(2).filter((a) => a !== '--reports');
for (const [example, make] of [['airline-desk', airlineDesk], ['concierge', concierge], ['pii-guard', piiGuard]]) {
  if (which.length && !which.includes(example)) continue;
  if (only) { reports(example); console.log(`the reports of ${example} written again from its kept files`); } else await make();
}
