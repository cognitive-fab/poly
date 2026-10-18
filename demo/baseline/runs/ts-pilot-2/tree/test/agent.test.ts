import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Store } from "../src/store.ts";
import { StripeError } from "../src/stripe.ts";
import { ADA, BEN, STRANGER, setup } from "./helpers.ts";

describe("SupportAgent", () => {
  it("greets known customers and lists only their own orders", async () => {
    const { agent } = await setup();
    assert.match(await agent.handle(ADA, "hello"), /Hi Ada/);
    const list = await agent.handle(ADA, "orders");
    assert.match(list, /ORD-1001/);
    assert.doesNotMatch(list, /ORD-1002/);
  });

  it("does not help unknown numbers", async () => {
    const { agent, stripe } = await setup();
    assert.match(await agent.handle(STRANGER, "refund ORD-1001"), /couldn't find any orders/);
    assert.equal(stripe.calls.length, 0);
  });

  it("refuses to refund someone else's order", async () => {
    const { agent, stripe, store } = await setup();
    const reply = await agent.handle(BEN, "refund ORD-1001");
    assert.match(reply, /couldn't find order ORD-1001/);
    assert.match(await agent.handle(BEN, "yes"), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
    assert.deepEqual(store.state.refunds, []);
  });

  it("refunds a full order only after confirmation", async () => {
    const { agent, stripe, store } = await setup();
    const ask = await agent.handle(ADA, "Please refund ORD-1001");
    assert.match(ask, /\$100\.00/);
    assert.match(ask, /Reply YES/);
    assert.equal(stripe.calls.length, 0, "nothing issued before confirmation");

    const done = await agent.handle(ADA, "yes");
    assert.match(done, /Done! \$100\.00 has been refunded/);
    assert.equal(stripe.calls.length, 1);
    assert.deepEqual(
      { charge: stripe.calls[0].charge, amount: stripe.calls[0].amount },
      { charge: "ch_demo_1001", amount: 10000 },
    );
    assert.equal(store.state.refunds.length, 1);
    assert.deepEqual(store.state.pending, {});

    // Second YES does nothing; a new request is refused.
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /already been fully refunded/);
    assert.equal(stripe.calls.length, 1);
  });

  it("persists refunds across restarts", async () => {
    const { agent, store } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    await agent.handle(ADA, "yes");
    const reloaded = new Store(store.file);
    await reloaded.load();
    assert.equal(reloaded.state.refunds[0].stripeRefundId, "re_1");
  });

  it("refunds individual items and then the remaining balance", async () => {
    const { agent, stripe } = await setup();
    assert.match(await agent.handle(ADA, "refund ORD-1001 blender-1"), /\$60\.00/);
    await agent.handle(ADA, "YES");
    assert.match(await agent.handle(ADA, "refund ORD-1001 BLENDER-1"), /already been refunded/);
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /\$40\.00 .*CUPS-4/);
    await agent.handle(ADA, "yes");
    assert.deepEqual(stripe.created.map((r) => r.amount), [6000, 4000]);
    assert.match(await agent.handle(ADA, "orders"), /fully refunded/);
  });

  it("rejects unknown SKUs", async () => {
    const { agent } = await setup();
    assert.match(await agent.handle(ADA, "refund ORD-1001 TOASTER"), /no item "TOASTER"/);
  });

  it("infers the order when the customer has exactly one refundable order", async () => {
    const { agent } = await setup();
    assert.match(await agent.handle(BEN, "I want a refund"), /\$25\.00 for ORD-1002/);
  });

  it("enforces the refund window", async () => {
    const { agent, stripe } = await setup({ now: "2026-11-01T00:00:00Z" });
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /outside our 30-day refund window/);
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it("allows refunds on the last day of the window", async () => {
    const { agent } = await setup({ now: "2026-10-30T23:59:00Z" });
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /Reply YES/);
  });

  it("cancels on NO", async () => {
    const { agent, stripe } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    assert.match(await agent.handle(ADA, "no"), /Cancelled/);
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it("expires unconfirmed requests", async () => {
    const { agent, stripe, clock } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    clock.now = new Date(clock.now.getTime() + 16 * 60 * 1000);
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it("a confirmation from one customer cannot trigger another's pending refund", async () => {
    const { agent, stripe } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    assert.match(await agent.handle(BEN, "yes"), /no refund waiting/);
    assert.equal(stripe.calls.length, 0);
  });

  it("retries transient Stripe errors with the same idempotency key without double refunding", async () => {
    const { agent, stripe, store } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    stripe.failNext = new StripeError("timeout", true);
    assert.match(await agent.handle(ADA, "yes"), /Reply YES to try again/);
    assert.equal(store.state.refunds.length, 0);
    assert.match(await agent.handle(ADA, "yes"), /Done!/);
    assert.equal(stripe.calls.length, 2);
    assert.equal(stripe.calls[0].idempotencyKey, stripe.calls[1].idempotencyKey);
    assert.equal(stripe.created.length, 1);
  });

  it("escalates permanent Stripe errors", async () => {
    const { agent, stripe, store, logs } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    stripe.failNext = new StripeError("charge_already_refunded", false, "charge_already_refunded");
    assert.match(await agent.handle(ADA, "yes"), /team member will follow up/);
    assert.equal(store.state.refunds.length, 0);
    assert.deepEqual(store.state.pending, {});
    assert.ok(logs.some((l) => l.event === "refund_error"));
  });

  it("does not record failed refunds", async () => {
    const { agent, stripe, store } = await setup();
    stripe.status = "failed";
    await agent.handle(ADA, "refund ORD-1001");
    assert.match(await agent.handle(ADA, "yes"), /could not be completed/);
    assert.equal(store.state.refunds.length, 0);
  });

  it("re-validates the pending refund at confirmation time", async () => {
    const { agent, stripe, store } = await setup();
    await agent.handle(ADA, "refund ORD-1001");
    // Meanwhile an item was refunded through another path.
    store.state.refunds.push({
      order: "ORD-1001", customer: ADA, skus: ["CUPS-4"], amount: 4000, currency: "usd",
      stripeRefundId: "re_x", status: "succeeded", createdAt: "",
    });
    assert.match(await agent.handle(ADA, "yes"), /no longer valid/);
    assert.equal(stripe.calls.length, 0);
  });

  it("asks for text when a non-text message arrives", async () => {
    const { agent } = await setup();
    assert.match(await agent.handle(ADA, undefined), /only read text/);
  });
});
