import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { formatMoney } from '../src/agent.ts';
import { Ledger } from '../src/ledger.ts';
import { ADA, BEN, STRANGER, TODAY, fakeStripe, makeAgent } from './helpers.ts';

describe('SupportAgent', () => {
  it('quotes a full refund and issues it on YES', async () => {
    const { agent, stripe, ledger } = makeAgent();

    const quote = await agent.handle(ADA, 'Hi, I want a refund for ORD-1001 please');
    assert.match(quote, /\$100\.00/);
    assert.match(quote, /BLENDER-1, CUPS-4/);
    assert.match(quote, /Reply YES/);
    assert.equal(stripe.calls.length, 0, 'nothing is refunded before confirmation');

    const done = await agent.handle(ADA, 'yes');
    assert.match(done, /Done!/);
    assert.match(done, /re_test_1/);
    assert.equal(stripe.calls.length, 1);
    assert.equal(stripe.calls[0].charge, 'ch_demo_1001');
    assert.equal(stripe.calls[0].amount, 10000);
    assert.equal(stripe.calls[0].metadata?.order, 'ORD-1001');
    assert.ok(stripe.calls[0].idempotencyKey.length > 0);
    assert.deepEqual(
      ledger.all().map((r) => [r.order, r.amount, r.refundId]),
      [['ORD-1001', 10000, 're_test_1']],
    );
  });

  it('accepts phone numbers with formatting', async () => {
    const { agent } = makeAgent();
    assert.match(await agent.handle('+1 (555) 010-0001', 'refund ord-1001'), /\$100\.00/);
  });

  it('refuses to refund an order that belongs to another customer', async () => {
    const { agent, stripe } = makeAgent();
    const reply = await agent.handle(BEN, 'refund ORD-1001');
    assert.match(reply, /couldn't find order ORD-1001/);
    assert.match(await agent.handle(BEN, 'YES'), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it('gives the same answer for unknown orders as for other people\'s orders', async () => {
    const { agent } = makeAgent();
    const other = await agent.handle(STRANGER, 'refund ORD-1001');
    const unknown = await agent.handle(STRANGER, 'refund ORD-9999');
    assert.equal(other.replace('ORD-1001', 'X'), unknown.replace('ORD-9999', 'X'));
  });

  it('tells unknown numbers it has no orders for them', async () => {
    const { agent } = makeAgent();
    assert.match(await agent.handle(STRANGER, 'I want a refund'), /couldn't find any orders/);
  });

  it('asks which order when none is given, listing only the customer\'s own orders', async () => {
    const { agent } = makeAgent();
    const reply = await agent.handle(ADA, 'can I get my money back?');
    assert.match(reply, /ORD-1001/);
    assert.doesNotMatch(reply, /ORD-1002/);
  });

  it('shows help for unrelated messages', async () => {
    const { agent } = makeAgent();
    const reply = await agent.handle(ADA, 'hello');
    assert.match(reply, /Hi Ada!/);
    assert.match(reply, /refund ORD-1234/);
  });

  it('refunds individual items, then only the remainder', async () => {
    const { agent, stripe } = makeAgent();

    assert.match(await agent.handle(ADA, 'refund ORD-1001 CUPS-4'), /\$40\.00 for ORD-1001 \(CUPS-4\)/);
    await agent.handle(ADA, 'YES');
    assert.equal(stripe.calls[0].amount, 4000);

    assert.match(await agent.handle(ADA, 'refund ORD-1001 cups-4'), /already been refunded/);

    assert.match(await agent.handle(ADA, 'refund ORD-1001'), /\$60\.00 for ORD-1001 \(BLENDER-1\)/);
    await agent.handle(ADA, 'y');
    assert.equal(stripe.calls[1].amount, 6000);
    assert.notEqual(stripe.calls[0].idempotencyKey, stripe.calls[1].idempotencyKey);

    assert.match(await agent.handle(ADA, 'refund ORD-1001'), /already been fully refunded/);
    assert.equal(stripe.calls.length, 2);
  });

  it('never refunds twice, even if YES is sent again', async () => {
    const { agent, stripe } = makeAgent();
    await agent.handle(ADA, 'refund ORD-1001');
    const [a, b] = await Promise.all([agent.handle(ADA, 'YES'), agent.handle(ADA, 'YES')]);
    assert.equal(stripe.calls.length, 1);
    assert.ok([a, b].some((r) => /no refund waiting/.test(r)));
    assert.match(await agent.handle(ADA, 'refund ORD-1001'), /already been fully refunded/);
  });

  it('cancels on NO', async () => {
    const { agent, stripe } = makeAgent();
    await agent.handle(ADA, 'refund ORD-1001');
    assert.match(await agent.handle(ADA, 'no'), /cancelled/);
    assert.match(await agent.handle(ADA, 'yes'), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it('expires an unconfirmed quote', async () => {
    let now = TODAY;
    const { agent, stripe } = makeAgent({ now: () => now });
    await agent.handle(ADA, 'refund ORD-1001');
    now = new Date(TODAY.getTime() + 11 * 60 * 1000);
    assert.match(await agent.handle(ADA, 'yes'), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it('declines orders outside the refund window', async () => {
    const { agent, stripe } = makeAgent({ now: () => new Date('2026-12-01T00:00:00Z') });
    assert.match(await agent.handle(ADA, 'refund ORD-1001'), /outside our 30-day refund window/);
    assert.match(await agent.handle(ADA, 'yes'), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it('keeps the quote after a Stripe error and retries with the same idempotency key', async () => {
    const { agent, stripe, ledger } = makeAgent();
    await agent.handle(ADA, 'refund ORD-1001');

    stripe.fail = new Error('network down');
    assert.match(await agent.handle(ADA, 'yes'), /couldn't complete the refund/);
    assert.equal(ledger.all().length, 0);

    stripe.fail = null;
    assert.match(await agent.handle(ADA, 'yes'), /Done!/);
    assert.equal(stripe.calls.length, 2);
    assert.equal(stripe.calls[0].idempotencyKey, stripe.calls[1].idempotencyKey);
    assert.equal(ledger.all().length, 1);
  });

  it('does not record a refund Stripe reports as failed', async () => {
    const { agent, stripe, ledger } = makeAgent();
    stripe.status = 'failed';
    await agent.handle(ADA, 'refund ORD-1001');
    assert.match(await agent.handle(ADA, 'yes'), /could not be completed/);
    assert.equal(ledger.all().length, 0);
  });

  it('remembers refunds across restarts via the ledger file', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'refunds.json');
    const first = makeAgent({ ledger: new Ledger(path) });
    await first.agent.handle(BEN, 'refund ORD-1002');
    await first.agent.handle(BEN, 'yes');

    const second = makeAgent({ ledger: new Ledger(path), stripe: fakeStripe() });
    assert.match(await second.agent.handle(BEN, 'refund ORD-1002'), /already been fully refunded/);
    assert.equal(second.stripe.calls.length, 0);
  });
});

describe('formatMoney', () => {
  it('formats minor units', () => {
    assert.equal(formatMoney(2500, 'usd'), '$25.00');
    assert.equal(formatMoney(500, 'jpy'), '¥500');
  });
});
