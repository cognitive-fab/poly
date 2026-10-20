// DF19, DF21, DF22, DF24: the ledger in the room (PS23.3, PT33.11, exhaustion, escalation,
// resolution and the sixth attack). One assembly, recorded mode, size 4. Guest join order
// determines guest ids (guest-01, guest-02, guest-03). Scenarios are sequential subtests
// with a fresh ledger per guest (guest 2 first, then guest 1, then the synthetic guest 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { assembleDemo } from '../../demo/host/assemble.mjs';

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'concierge', 'answers.json'), 'utf8'));
const textOf = (id) => FIXTURE.messages.find((m) => m.id === id).text;
const replyOf = (messageId, outcome) => FIXTURE.messages.find((m) => m.id === messageId).replies[outcome];
const ackText = FIXTURE.acks?.customer ?? 'Thank you, we have your message and will answer it shortly.';

const ordersOf = ({ n, principal }) => {
  if (n === 1) return FIXTURE.orders.filter((o) => o.owner === 'cust-a').map((o) => ({ id: o.id, owner: principal, charge: o.charge, paid: o.paid, asOf: o.asOf, body: o.body }));
  if (n === 2) return FIXTURE.orders.filter((o) => o.owner === 'cust-b').map((o) => ({ id: o.id, owner: principal, charge: o.charge, paid: o.paid, asOf: o.asOf, body: o.body }));
  if (n === 3) return [{ id: 'o-9031', owner: principal, charge: 'ch_demo9031', paid: 12000, asOf: '2026-10-08T10:00:00Z', body: 'Order 9031: a desk lamp, in warehouse.' }];
  return [];
};


test('DF19, DF21, DF24: refund ledger and escalation', { timeout: 3_600_000 }, async (t) => {
  let now = 1_790_000_000_000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const workdir = mkdtempSync(join(tmpdir(), 'demo-ledger-'));
  const demo = await assembleDemo({ mode: 'recorded', workdir, now: clock.now, ordersOf, size: 4 });
  try {
    // The pool hands out guests in the order of the joins: s1 is guest-01 (cust-a), s2 is guest-02 (cust-b), s3 is guest-03.
    demo.room.join('s1');
    demo.room.join('s2');
    demo.room.join('s3');
    const heard = { s2: [], s1: [], s3: [] };
    demo.room.subscribe('s2', (e) => heard.s2.push(e));
    demo.room.subscribe('s1', (e) => heard.s1.push(e));
    demo.room.subscribe('s3', (e) => heard.s3.push(e));

    const say = async (session, id) => { clock.advance(6000); const r = await demo.room.say(session, textOf(id)); assert.deepEqual(r, { ok: true }); };
    const postCount = () => demo.standIn.log().filter((e) => e.method === 'POST' && e.host === 'api.stripe.com').length;
    const appliedCount = () => demo.standIn.log().filter((e) => e.applied === true).length;
    const logSince = (before) => demo.standIn.log().length - before;
    const retries = async () => { for (let i = 0; i < 25; i++) { clock.advance(1000); await demo.settle(); } };

    // Guest 2 (cust-b, sofa, ch_ex2001, paid 30000)

    await t.test('(1) escalation timeout: no POST until 25 hours; reply Declined; ledger clears', async () => {
      await say('s2', 'refund-large');
      await demo.settle();
      assert.equal(postCount(), 0, 'no POST sent (waiting for approval)');
      assert.ok((await demo.pumpStaff())[0], 'the escalation was noticed to the staff (and is never approved)');
      let status = await demo.status();
      assert.ok(status.unknown.includes('guest-02'), 'guest-02 is in unknown list');

      // Advance 25 hours
      for (let i = 0; i < 30; i++) { clock.advance(3_600_000); await demo.settle(); }

      assert.equal(heard.s2.at(-1).text, replyOf('refund-large', 'Declined'), 'reply is Declined after timeout');
      status = await demo.status();
      assert.ok(!status.unknown.includes('guest-02'), 'guest-02 is no longer in unknown list (ledger cleared)');
    });

    await t.test('(2) definite refusal: handler refuses (50000 > 30000), ledger clears', async () => {
      const appliedBefore = appliedCount();
      await say('s2', 'injection');
      await demo.settle();
      const [esc] = await demo.pumpStaff();
      assert.ok(esc, 'the escalation was noticed to the staff');
      await demo.settle();
      await demo.approve(esc);
      await demo.settle();

      // The handler refuses: 500 euros (50000 cents) exceed the 300 euros paid (30000 cents).
      await demo.settle();
      assert.equal(appliedCount(), appliedBefore, 'no refund applied (handler refused)');
      assert.equal(heard.s2.at(-1).text, replyOf('injection', 'Declined'), 'reply is Declined (handler refused)');
      const status = await demo.status();
      assert.ok(!status.unknown.includes('guest-02'), 'guest-02 not in unknown (definite refusal clears ledger)');
    });

    await t.test('(3) approval success: refund goes through', async () => {
      const logBefore = demo.standIn.log().length;
      await say('s2', 'refund-large');
      await demo.settle();
      const status1 = await demo.status();
      assert.ok(status1.unknown.includes('guest-02'), 'guest-02 in unknown while waiting');

      // Send another message while waiting (acknowledge, don't process)
      heard.s2 = [];
      await say('s2', 'status');
      assert.equal(heard.s2.at(-1).text, ackText, 'acknowledgement while Desk is busy');

      // Approve
      const [esc] = await demo.pumpStaff();
      await demo.settle();
      await demo.approve(esc);
      await demo.settle();

      const posts = demo.standIn.log().slice(logBefore).filter((e) => e.method === 'POST' && e.host === 'api.stripe.com' && e.status === 200);
      assert.equal(posts.length, 1, 'one refund POST after approval');
      const post = posts[0];
      assert.equal(post.params.charge, 'ch_ex2001', 'refund targets correct charge');
      assert.equal(post.params.amount, '25000', 'refund amount is 250 euros (25000 cents)');
      assert.equal(heard.s2.at(-1).text, replyOf('refund-large', 'Refunded'), 'reply is Refunded');
      const status2 = await demo.status();
      assert.ok(!status2.unknown.includes('guest-02'), 'guest-02 no longer in unknown after approval');
    });

    await t.test('(4) blocked by ledger: second refund-large gets Already', async () => {
      const logBefore = demo.standIn.log().length;
      await say('s2', 'refund-large');
      assert.equal(heard.s2.at(-1).text, replyOf('refund-large', 'Already'), 'reply is Already (ledger blocks)');
      assert.equal(logSince(logBefore), 0, 'no log entries (ledger prevented request)');
    });

    // Guest 1 (cust-a, chairs, ch_ex1002, paid 12000)

    await t.test('(5) fault lost-all: all attempts lost, reply Checking, ledger Unknown', async () => {
      await demo.standIn.reset({ fault: 'lost-all' });
      const logBefore = demo.standIn.log().length;
      await say('s1', 'refund-twice');
      await retries();

      assert.equal(heard.s1.at(-1).text, replyOf('refund-twice', 'Checking'), 'reply is Checking (Unknown outcome)');
      const logNew = demo.standIn.log().slice(logBefore);
      const posts = logNew.filter((e) => e.method === 'POST' && e.host === 'api.stripe.com');
      assert.equal(posts.length, 5, 'five attempts (5 retries)');
      const firstKey = posts[0].key;
      assert.ok(posts.every((p) => p.key === firstKey), 'all POSTs have same idempotency key');
      assert.equal(logNew.filter((e) => e.applied === true).length, 1, 'exactly one applied (the key was seen)');
      const status = await demo.status();
      assert.deepEqual(status.unknown, ['guest-01'], 'guest-01 in unknown list');
    });

    await t.test('(6) blocked while Unknown: second refund-twice hears Checking, no POST', async () => {
      const logBefore = demo.standIn.log().length;
      await say('s1', 'refund-twice');
      assert.equal(heard.s1.at(-1).text, replyOf('refund-twice', 'Checking'), 'reply is Checking (ledger blocks)');
      assert.equal(logSince(logBefore), 0, 'no log entries (ledger prevents request entirely)');
    });

    await t.test('(7) Resolve not-done clears ledger; later refund succeeds', async () => {
      await demo.resolve('guest-01', 'not-done');
      let status = await demo.status();
      assert.deepEqual(status.unknown, [], 'unknown is empty after Resolve');

      await demo.standIn.reset({ fault: 'none' });
      const logBefore = demo.standIn.log().length;
      await say('s1', 'refund-twice');

      const posts = demo.standIn.log().slice(logBefore).filter((e) => e.method === 'POST' && e.host === 'api.stripe.com');
      assert.equal(posts.length, 1, 'one POST after Resolve (ledger was cleared)');
      assert.equal(demo.standIn.report().amountRefunded['ch_ex1002'], 4000, 'amountRefunded is 4000 (40 euros)');
      assert.equal(heard.s1.at(-1).text, replyOf('refund-twice', 'Refunded'), 'reply is Refunded');
    });

    await t.test('(8) sixth attack on chairs: second refund-twice is blocked, reply Already', async () => {
      const logBefore = demo.standIn.log().length;
      await say('s1', 'refund-twice');
      assert.equal(heard.s1.at(-1).text, replyOf('refund-twice', 'Already'), 'reply is Already (ledger blocks)');
      assert.equal(logSince(logBefore), 0, 'no log entries (ledger prevents request)');
    });

    // Guest 3 (synthetic, o-9031, paid 12000, ch_demo9031)

    await t.test('(9) sixth attack live room on guest-3: first refund succeeds, second gets Already', async () => {
      const logBefore = demo.standIn.log().length;
      await say('s3', 'refund-synthetic');

      const gets = demo.standIn.log().slice(logBefore).filter((e) => e.method === 'GET' && e.host === 'api.stripe.com');
      const posts = demo.standIn.log().slice(logBefore).filter((e) => e.method === 'POST' && e.host === 'api.stripe.com');
      assert.equal(gets.length, 1, 'one GET (read charge)');
      assert.equal(posts.length, 1, 'one POST (refund)');
      assert.equal(demo.standIn.report().amountRefunded['ch_demo9031'], 4000, 'amountRefunded is 4000 (40 euros)');
      assert.equal(heard.s3.at(-1).text, replyOf('refund-synthetic', 'Refunded'), 'reply is Refunded');

      // Comment: on v1.3.0, this second request would refund again (8000 of 12000).
      const logBefore2 = demo.standIn.log().length;
      await say('s3', 'refund-synthetic');
      assert.equal(heard.s3.at(-1).text, replyOf('refund-synthetic', 'Already'), 'reply is Already (ledger blocks)');
      assert.equal(logSince(logBefore2), 0, 'no log entries (ledger prevents request)');
    });
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true });
  }
});
