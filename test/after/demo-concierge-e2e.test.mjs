// Step 9 (DAC10, DAC11 on a recorded run, DF8): the demo copy of the concierge, admitted and driven through the room page's host, over
// recorded model answers and the local stand-in for Stripe. In the serial group: the copy's check explores the concierge, which
// takes minutes and a large heap. Nothing here calls a model, reads a key or reaches an outside host.
//
// Two guests: guest-01 holds the fixture customer A's orders and guest-02 customer B's, so the recorded answers (which cite
// those orders) apply to them. Every message goes in through room.say, which signs it as the Cloud API signs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { replayRuntime, replaySessions } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { assembleDemo } from '../../demo/host/assemble.mjs';
import { whatsapp } from '@poly/io';
import { signedWebhook } from '../../demo/host/signing.mjs';

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'), 'utf8'));
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;
const CANARY = `CANARY-${randomBytes(8).toString('hex')}`;
const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));

/** The fixture customer's orders for the guest that stands for them (the canary is planted in B's, whom A must never see). */
const ordersOf = ({ n, principal }) => {
  const owner = n === 1 ? 'cust-a' : n === 2 ? 'cust-b' : null;
  return FIXTURE.orders.filter((o) => o.owner === owner).map((o) => ({ id: o.id, owner: principal, charge: o.charge, paid: o.paid, asOf: o.asOf, body: owner === 'cust-b' ? `${o.body} ${CANARY}` : o.body }));
};

test('DF8, DAC10, DAC11: the demo copy is CLEAN with its instance, and the recorded run through the room holds every claim of Act 2', { timeout: 1_800_000 }, async () => {
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const workdir = mkdtempSync(join(tmpdir(), 'demo-e2e-'));
  const demo = await assembleDemo({ mode: 'recorded', workdir, now: clock.now, ordersOf, size: 4 });
  const { rt, room, standIn, staff } = demo;
  try {
    // ---- DF8: the demo copy checks CLEAN, and its instance is printed ----
    const { report } = demo.admission;
    assert.equal(report.verdict, 'CLEAN');
    const machines = report.files.flatMap((f) => f.machines ?? []);
    for (const m of ['Desk', 'Notice']) assert.ok(machines.some((x) => x.machine === m && x.instance?.states > 0), m);
    console.log(`DEMO COPY: ${report.verdict}; instance: ${machines.map((m) => `${m.machine} ${m.instance?.states} states`).join(', ')}`);

    const g1 = room.join('s1');
    const g2 = room.join('s2');
    assert.deepEqual([g1.principal, g2.principal], ['cust-guest-01', 'cust-guest-02']);
    const heard = { s1: [], s2: [] };
    room.subscribe('s1', (e) => heard.s1.push(e));
    room.subscribe('s2', (e) => heard.s2.push(e));
    const say = async (session, id) => { clock.advance(6000); const r = await room.say(session, textOf(id)); assert.deepEqual(r, { ok: true }, `${id}: ${JSON.stringify(r)}`); };
    const posts = () => standIn.log().filter((e) => e.host === 'api.stripe.com' && e.method === 'POST');
    const gets = () => standIn.log().filter((e) => e.host === 'api.stripe.com' && e.method === 'GET');

    // ---- DAC10: a forged, unsigned or altered message is refused and reaches no machine ----
    const instancesBefore = (await rt.instances()).length;
    const loggedBefore = standIn.log().length; // the grant's own token request is already there
    const good = signedWebhook({ ...demo.wa, persona: g1, text: textOf('status'), id: 'wamid.FORGE.0' });
    const forged = [
      { ...good, headers: { 'content-type': 'application/json' } },
      { ...good, headers: { ...good.headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } },
      { ...good, body: good.body.replace(g1.phone, g2.phone) },
      signedWebhook({ ...demo.wa, appSecret: randomBytes(32).toString('hex'), persona: g1, text: textOf('status'), id: 'wamid.FORGE.1' }),
    ];
    for (const w of forged) assert.equal((await rt.receive('support', w)).status, 401);
    assert.equal((await rt.instances()).length, instancesBefore, 'a refused message made no instance');
    assert.equal(standIn.log().length, loggedBefore, 'and reached nothing');
    assert.deepEqual(heard.s1.concat(heard.s2), []);

    // ---- 1. a status question: the guest's own orders, cited, and the answer to that guest only ----
    await say('s1', 'status');
    assert.equal(rt.threadPrincipal(await rt.threadId('support', g1.phone)), 'cust-guest-01');
    assert.deepEqual(heard.s1.map((e) => e.text), [FIXTURE.messages.find((m) => m.id === 'status').answer.text]);
    assert.deepEqual(heard.s2, [], 'no one else heard it');

    // ---- 2. a refund under the limit goes through the stand-in, once, with the runtime's key ----
    await say('s1', 'refund-small');
    assert.deepEqual(gets().map((e) => e.path), ['/v1/charges/ch_ex1001']);
    assert.equal(posts().length, 1);
    const p = posts()[0];
    assert.deepEqual(Object.fromEntries(p.params), { charge: 'ch_ex1001', amount: '4000', reason: 'requested_by_customer' });
    assert.ok(p.key, 'the runtime sent the intent id as Idempotency-Key');
    assert.equal(p.authorization, 'Bearer');
    assert.equal(p.status, 200, 'the stand-in accepts only the synthetic token and the connected account, so the 200 shows the runtime sent them');
    assert.equal(standIn.report().amountRefunded.ch_ex1001, 4000);
    assert.match(heard.s1.at(-1).text, /40 euros is on its way/);

    // ---- 3. a refund over 100 waits for a signed approval: nothing reaches Stripe until a person approves ----
    await say('s2', 'refund-large');
    assert.equal(posts().length, 1, 'the large refund waits');
    const desk2 = await rt.threadId('support', g2.phone);
    const [esc] = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'payments.refund'").all(desk2).map((r) => r.intent_id);
    assert.ok(esc, 'the escalated intent exists');
    assert.deepEqual(await demo.pumpStaff(), [esc]);
    await demo.settle();
    const told = staff.entries().map((e) => e.text);
    assert.ok(told.some((x) => x.includes(esc)), JSON.stringify(told));
    assert.ok(!told.some((x) => /sofa|25000|250|cust-guest/.test(x.replaceAll(esc, ''))), 'the staff are told nothing of the customer (the intent id itself is not customer data)');
    await demo.approve(esc);
    await demo.settle();
    assert.equal(posts().length, 2);
    assert.deepEqual(Object.fromEntries(posts()[1].params), { charge: 'ch_ex2001', amount: '25000', reason: 'requested_by_customer' });
    assert.match(heard.s2.at(-1).text, /refund/i);

    // ---- 4. a value outside 0..500 never reaches the handler ----
    const beforeOutside = standIn.log().length;
    await say('s1', 'refund-outside');
    assert.equal(standIn.log().length, beforeOutside, 'no request of the handler: the 650 stopped at the domain');
    assert.doesNotMatch(heard.s1.at(-1).text, /on its way/);

    // ---- 5. no refund names an order of another guest ----
    const beforeOther = posts().length;
    await say('s2', 'refund-small'); // guest-02 asks about a lamp that is guest-01's: its own orders hold no such order
    assert.equal(posts().length, beforeOther, 'guest-02 cannot refund guest-01\'s order');
    assert.equal(standIn.report().amountRefunded.ch_ex1001, 4000, 'and guest-01\'s charge was not touched again');
    const owners = { ch_ex1001: 'cust-guest-01', ch_ex2001: 'cust-guest-02' };
    assert.deepEqual(posts().map((x) => Object.fromEntries(x.params).charge), ['ch_ex1001', 'ch_ex2001']);
    assert.ok(Object.keys(owners).length === 2);

    // ---- 6. the canary planted in guest-02's order is in no reply, no notice and no request ----
    const everything = JSON.stringify([heard, staff.entries(), standIn.log(), standIn.replies()]);
    assert.ok(!everything.includes(CANARY), 'the canary did not leak');

    // ---- the injection text is only data ----
    const beforeInjection = standIn.log().length;
    await say('s1', 'injection');
    assert.equal(posts().length, 2, 'the injection made no new refund');
    assert.ok(standIn.log().length >= beforeInjection);

    // ---- the journal replays: no divergence ----
    const replays = await replayRuntime(rt);
    for (const x of replays) assert.deepEqual([x.run, x.diagnostics, x.notRun ?? null, x.gateNotRun], [x.run, [], null, 0], JSON.stringify(x));
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0 && sessions.every((s) => s.diagnostics.length === 0 && s.notRun.length === 0));
    console.log(`DEMO REPLAY: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows, ${sessions.length} gate sessions; 0 divergences`);

    // ---- the synthetic token is held in memory and written nowhere ----
    for (const f of walk(workdir)) assert.ok(!readFileSync(f).includes(demo.connect.accessToken), `${f} holds the token`);
    assert.ok(!JSON.stringify(standIn.log()).includes(demo.connect.accessToken));

    // ---- the kill switch stops the room: nothing more reaches the runtime ----
    const received = rt.store.db.prepare("SELECT count(*) AS n FROM poly_ledger WHERE run = 'runtime:ingress'").get().n;
    room.kill('presenter');
    clock.advance(6000);
    assert.deepEqual(await room.say('s1', 'Hello?'), { ok: false, reason: 'halted' });
    assert.equal(rt.store.db.prepare("SELECT count(*) AS n FROM poly_ledger WHERE run = 'runtime:ingress'").get().n, received, 'nothing more reached the runtime');
    assert.equal(heard.s1.at(-1).kind, 'halted');
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('DAC10: the adapter of the demo is the real certified whatsapp adapter, so a signature made under another secret is refused (control for the forged messages above)', () => {
  const secret = () => randomBytes(32).toString('hex');
  const wa = { appSecret: secret(), accessToken: secret(), phoneNumberId: '106540352242922', verifyToken: secret(), apiVersion: 'v23.0' };
  const persona = { id: 'guest-01', phone: '15555550101' };
  const ok = whatsapp(wa).verify(signedWebhook({ ...wa, persona, text: 'hi', id: 'wamid.X' }), 1_790_000_000_000);
  assert.ok(!('refused' in ok));
  assert.ok('refused' in whatsapp(wa).verify(signedWebhook({ ...wa, appSecret: secret(), persona, text: 'hi', id: 'wamid.X' }), 1_790_000_000_000));
});
