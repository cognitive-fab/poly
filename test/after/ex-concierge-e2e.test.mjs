// plan-ex.md E1, AC27, in the serial after-suite group (its admission checks the concierge, which the group keeps
// apart from the parallel suite). The concierge example end to end over recorded traffic: two customers on WhatsApp, the
// staff on Slack, orders in Postgres and refunds through the merchant's Stripe Connect grant, every model call answered
// from test/fixtures/concierge/answers.json. A status question is answered with the customer's own orders cited; a
// refund under the limit goes through the credential; one over it is escalated, noticed to staff, and approved by a
// person's signed record. Then `poly journal replay` over the store: every post-state, gate decision and tier choice is
// reproduced, with no divergence. No test reaches a provider or calls a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admit, replayRuntime, replaySessions } from '@poly/check';
import { grantRequestSubject, signRecord } from '@poly/core';
import { whatsapp, slack, postgresSource, oauthVault, kmsStore, credentialIngress } from '@poly/io';
import { ROOT } from '../helpers.mjs';
import { PERSON, approvalFor, handleWith, loaded, makeKey, project, signPolicies } from '../runtime-helpers.mjs';
import { fakeStripe, memoryWrap, orderRows, ordersTable } from '../ex-concierge-helpers.mjs';
import { recorded, whatsappWebhook, slackWebhook } from '../concierge-helpers.mjs';

const EX = join(ROOT, 'examples', 'concierge');
const hostModule = (f) => import(pathToFileURL(join(EX, 'host', f)).href);
const { loadAnswers, recordedConcierge, provideRecorded } = await hostModule('recorded.mjs');
const { forwardEscalations } = await hostModule('notice.mjs');
const { refund, REFUNDS_URL, CHARGES_URL } = await hostModule('refund.mjs');
const FIXTURE = loadAnswers(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'));
const STRIPE = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'stripe-connect.json'), 'utf8'));
/** The fixture's two WhatsApp senders, by phone number, and the principal each is mapped to. */
const PHONES = { 'wa-1': '16505551234', 'wa-2': '16505559876' };
const MERCHANT = 'merchant-1';

async function admitted() {
  const key = makeKey('ex-concierge-e2e');
  const dir = project('ex-concierge-e2e', [], key, 'test-ex-concierge');
  for (const f of ['concierge.poly', 'concierge.policy.poly']) copyFileSync(join(EX, f), join(dir, 'src', f));
  cpSync(join(EX, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  cpSync(join(EX, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: { payments: { store: 'kms' } } }, null, 2));
  await signPolicies(dir);
  const r = await admit(dir);
  return { dir, key, build: join(dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, report: r.report };
}

/** The recorded WhatsApp message from a fixture sender, with its own message id and text, signed under the app secret. */
function waMessage(wa, from, body, k) {
  const m = JSON.parse(recorded('whatsapp/message.json'));
  const v = m.entry[0].changes[0].value;
  v.contacts[0].wa_id = from;
  Object.assign(v.messages[0], { from, id: `wamid.ex-${k}`, text: { body } });
  return whatsappWebhook(wa, JSON.stringify(m));
}
function slackMessage(sl, text, k, now) {
  const m = JSON.parse(recorded('slack/message.json'));
  Object.assign(m.event, { text, ts: `1355517523.00000${k}`, event_ts: `1355517523.00000${k}` });
  m.event_id = `Ev-ex-${k}`;
  return slackWebhook(sl, JSON.stringify(m), now);
}
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;

test('AC27: the concierge end to end over recorded traffic, CLEAN with its instance, and its journal replays every post-state, gate decision and tier choice', { timeout: 1_800_000 }, async () => {
  const a = await admitted();
  // The program is CLEAN with its instance, printed (PT12.3a).
  assert.equal(a.report.verdict, 'CLEAN');
  const machines = a.report.files.flatMap((f) => f.machines ?? []);
  console.log(`AC27 instance: ${machines.map((m) => `${m.machine} ${m.instance?.states}`).join(', ')}`);
  const { rt, clock } = await loaded(a, { verifier: (c) => (c ? { principal: c.principal } : null) });
  try {
    const secret = () => randomBytes(32).toString('hex');
    const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
    const sl = { signingSecret: secret(), botToken: `xoxb-${secret()}`, teamId: 'T123ABC456' };
    const out = { support: [], staff: [] };
    rt.connectChannel('support', whatsapp(wa), { http: { async request(q) { out.support.push(q); return { status: 200, headers: {}, body: recorded('whatsapp/send-response.json') }; } } });
    rt.connectChannel('staff', slack(sl), { http: { async request(q) { out.staff.push(q); return { status: 200, headers: {}, body: recorded('slack/post-ok.json') }; } } });
    rt.mapSenders('support', (sender) => FIXTURE.customers[Object.keys(PHONES).find((k) => sender.includes(PHONES[k]))] ?? null);
    const db = ordersTable(orderRows(FIXTURE));
    rt.connectSource('orders', postgresSource({ query: db.query, table: 'orders', id: 'order_id', owner: 'customer_id', asOf: 'updated_at', body: 'summary', keys: { charge: 'charge_id' } }));
    const p = recordedConcierge(FIXTURE);
    provideRecorded(rt, p);
    handleWith(rt, 'payments.refund', refund);
    // The merchant's Stripe Connect grant: the platform's key in the vault, the account from the token endpoint (S208);
    // a person's signed grant request fixes its holder (S457).
    const { http: stripeHttp, sent: stripe } = fakeStripe(FIXTURE, STRIPE);
    const vault = oauthVault(STRIPE, { clientId: 'ca_concierge', redirectUri: 'https://concierge.example/credentials/payments', clientSecret: `sk_test_${secret()}` }, kmsStore(memoryWrap()), { http: stripeHttp });
    rt.connectVault('payments', vault);
    const callback = credentialIngress(rt, { payments: vault }, () => rt.now());
    const approvals = join(a.dir, 'approvals');
    mkdirSync(approvals, { recursive: true });
    const request = signRecord({ kind: 'grant-request', subject: grantRequestSubject('payments', MERCHANT), by: PERSON.keyId, at: '2026-10-10T00:00:00.000Z' }, PERSON.privateKeyPem);
    writeFileSync(join(approvals, '00-grant.json'), JSON.stringify({ kind: 'grant-request', credential: 'payments', holder: MERCHANT, record: request }));
    assert.deepEqual((await rt.takeApprovals(approvals)).map((x) => x.outcome), ['applied']);
    const url = rt.takeAuthorizations().find((x) => x.credential === 'payments').url;
    assert.equal((await callback('payments', { method: 'GET', url: `https://concierge.example/credentials/payments?code=ac_${secret()}&state=${new URL(url).searchParams.get('state')}`, headers: {}, body: '' })).status, 200);

    const settle = async (n = 40) => { for (let k = 0; k < n; k++) { await rt.advance(); await rt.worker.tick(); } };
    let k = 0;
    const say = async (who, id) => { await rt.receive('support', waMessage(wa, PHONES[who], textOf(id), ++k)); clock.advance(1000); await settle(); };
    const deskA = await rt.threadId('support', PHONES['wa-1']);
    const deskB = await rt.threadId('support', PHONES['wa-2']);
    const sendsTo = (to) => out.support.filter((q) => q.url.endsWith('/messages') && JSON.parse(q.body).to === to).map((q) => JSON.parse(q.body).text?.body);

    // 1. A status question: the customer's own orders, cited, and the answer sent to that customer.
    await say('wa-1', 'status');
    assert.equal(await rt.threadPrincipal(deskA), 'cust-a');
    assert.deepEqual(sendsTo(PHONES['wa-1']), [FIXTURE.messages[0].answer.text]);
    const cited = (await rt.chain(deskA)).filter((e) => e.kind === 'decision' && e.body.cites).map((e) => e.body.cites);
    assert.ok(cited.length === 1 && cited[0].count === 1, JSON.stringify(cited));
    assert.deepEqual(db.seen.filter((s) => s.text.startsWith('SELECT "order_id"')).map((s) => s.params[0]), ['cust-a']);

    // 2. A refund under the limit: unsure on the small tier, answered on the large, refunded through the grant.
    await say('wa-1', 'refund-small');
    // S462: the refund read the order's charge (cust-a's lamp, o-1001) and refunded that charge, through the grant.
    assert.deepEqual(stripe.map((q) => [q.method, q.url, q.account]), [['GET', `${CHARGES_URL}ch_ex1001`, 'acct_1Merchant'], ['POST', REFUNDS_URL, 'acct_1Merchant']]);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(stripe[1].body)), { charge: 'ch_ex1001', amount: '4000', reason: 'requested_by_customer' });
    assert.match(sendsTo(PHONES['wa-1']).at(-1), /40 euros is on its way/);
    assert.deepEqual(p.asked.filter((x) => x.message === 'refund-small' && x.decision === 'classify').map((x) => x.tier), ['small', 'large']);

    // 3. A refund over the limit: escalated, nothing sent to Stripe, noticed to the staff's Slack thread.
    await rt.receive('staff', slackMessage(sl, 'Morning, the concierge is on.', 1, clock.now()));
    await settle();
    const notice = await rt.threadId('staff', 'C123ABC456');
    await say('wa-2', 'refund-large');
    assert.equal(await rt.threadPrincipal(deskB), 'cust-b');
    assert.equal(stripe.length, 2, 'the large refund waits: nothing more reached Stripe');
    const [esc] = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'payments.refund'").all(deskB).map((r) => r.intent_id);
    assert.ok(esc);
    const noticed = new Set();
    assert.deepEqual(await forwardEscalations(rt, { desks: [deskA, deskB], notice, noticed }), [esc]);
    await settle();
    const staffPosts = out.staff.filter((q) => q.url.endsWith('chat.postMessage')).map((q) => JSON.parse(q.body).text);
    assert.ok(staffPosts.some((t) => t.includes(esc)) && !staffPosts.some((t) => /sofa|250|cust-b/.test(t.replaceAll(esc, ''))), JSON.stringify(staffPosts));
    // A person approves it with a signed record; the refund goes through, and the customer is told.
    await rt.approve(await approvalFor(rt, esc));
    await settle();
    assert.deepEqual(stripe.slice(2).map((q) => [q.method, q.url]), [['GET', `${CHARGES_URL}ch_ex2001`], ['POST', REFUNDS_URL]]);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(stripe[3].body)), { charge: 'ch_ex2001', amount: '25000', reason: 'requested_by_customer' });
    assert.match(sendsTo(PHONES['wa-2']).at(-1), /refund/i);

    // Replay: every run folds through poly-ref's δ with no divergence, the routes' tier choices among them, and every
    // gate session replays its decisions.
    const replays = await replayRuntime(rt);
    for (const x of replays) assert.deepEqual([x.run, x.diagnostics, x.notRun ?? null, x.gateNotRun], [x.run, [], null, 0], JSON.stringify(x));
    const kinds = new Set(replays.map((x) => x.machine));
    for (const m of ['concierge.Desk', 'concierge.Notice', 'concierge.triage.Route', 'concierge.support.Conversation', 'concierge.staff.Conversation']) assert.ok(kinds.has(m), `${m} in ${[...kinds].join(', ')}`);
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0 && sessions.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0), JSON.stringify(sessions.filter((s) => s.diagnostics.length || s.notRun.length)));
    const grant = replays.filter((x) => x.machine === 'concierge.payments.Grant');
    console.log(`AC27 replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows, ${grant.length} grant run(s); ${sessions.length} gate sessions, ${sessions.reduce((n, s) => n + s.proposals, 0)} proposals; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally { await rt.close(); }
});
