import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { RefundAgent } from "../src/agent.ts";
import { loadOrders } from "../src/orders.ts";
import { StateStore } from "../src/state.ts";
import type { RefundGateway, RefundRequest, RefundResult } from "../src/stripe.ts";

const ADA = "15550100001";
const BEN = "15550100002";
const NOW = Date.parse("2026-10-18T12:00:00Z");

class FakeGateway implements RefundGateway {
  calls: RefundRequest[] = [];
  next: RefundResult[] = [];
  async createRefund(req: RefundRequest): Promise<RefundResult> {
    this.calls.push(req);
    return this.next.shift() ?? { kind: "ok", id: `re_${this.calls.length}`, status: "succeeded" };
  }
}

let gw: FakeGateway;
let state: StateStore;
let now: number;
let agent: RefundAgent;

beforeEach(() => {
  gw = new FakeGateway();
  state = new StateStore(null);
  now = NOW;
  agent = new RefundAgent({
    orders: loadOrders("orders.json"),
    state,
    refunds: gw,
    refundWindowDays: 30,
    now: () => now,
    log: () => {},
  });
});

describe("RefundAgent", () => {
  test("greets known customers with only their own orders", async () => {
    const reply = await agent.handle(ADA, "hi");
    assert.match(reply, /Hi Ada/);
    assert.match(reply, /ORD-1001/);
    assert.doesNotMatch(reply, /ORD-1002/);
  });

  test("unknown numbers get no order information", async () => {
    const reply = await agent.handle("19990000000", "refund ORD-1001");
    assert.match(reply, /couldn't find any orders/);
    assert.equal(gw.calls.length, 0);
  });

  test("full refund requires confirmation, then refunds the original charge", async () => {
    const quote = await agent.handle(ADA, "refund ORD-1001 please");
    assert.match(quote, /\$100\.00/);
    assert.match(quote, /YES/);
    assert.equal(gw.calls.length, 0, "nothing issued before confirmation");

    const done = await agent.handle(`+${ADA}`, "yes");
    assert.match(done, /re_1/);
    assert.equal(gw.calls.length, 1);
    assert.equal(gw.calls[0]!.charge, "ch_demo_1001");
    assert.equal(gw.calls[0]!.amount, 10000);
    assert.ok(gw.calls[0]!.idempotencyKey);
    assert.equal(state.refunds[0]!.status, "succeeded");
  });

  test("cannot refund another customer's order", async () => {
    const reply = await agent.handle(BEN, "refund ORD-1001");
    assert.match(reply, /couldn't find order ORD-1001/);
    assert.equal(await agent.handle(BEN, "yes").then((r) => /no refund waiting/.test(r)), true);
    assert.equal(gw.calls.length, 0);
  });

  test("item refund, then the item can't be refunded again, then the rest", async () => {
    assert.match(await agent.handle(ADA, "refund ORD-1001 blender-1"), /\$60\.00 for BLENDER-1/);
    await agent.handle(ADA, "YES");
    assert.equal(gw.calls[0]!.amount, 6000);

    assert.match(await agent.handle(ADA, "refund ORD-1001 BLENDER-1"), /already been refunded/);
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /\$40\.00 for CUPS-4/);
    await agent.handle(ADA, "yes");
    assert.equal(gw.calls[1]!.amount, 4000);
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /already been fully refunded/);
    assert.equal(gw.calls.length, 2);
  });

  test("saying YES twice does not refund twice", async () => {
    await agent.handle(ADA, "refund ORD-1001");
    await agent.handle(ADA, "yes");
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.equal(gw.calls.length, 1);
  });

  test("a second quote for the same items is refused after the first is confirmed", async () => {
    await agent.handle(ADA, "refund ORD-1001");
    await agent.handle(ADA, "yes");
    assert.match(await agent.handle(ADA, "refund ORD-1001 CUPS-4"), /already been fully refunded/);
    assert.equal(gw.calls.length, 1);
  });

  test("NO cancels and an expired quote can't be confirmed", async () => {
    await agent.handle(ADA, "refund ORD-1001");
    assert.match(await agent.handle(ADA, "no"), /cancelled/);
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);

    await agent.handle(ADA, "refund ORD-1001");
    now += 16 * 60_000;
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.equal(gw.calls.length, 0);
  });

  test("unknown item codes are rejected", async () => {
    assert.match(await agent.handle(ADA, "refund ORD-1001 TOASTER-9"), /no item TOASTER-9/);
  });

  test("orders outside the refund window are not refunded", async () => {
    now = Date.parse("2026-11-15T00:00:00Z");
    assert.match(await agent.handle(ADA, "refund ORD-1001"), /outside our 30-day refund window/);
    assert.match(await agent.handle(ADA, "yes"), /no refund waiting/);
    assert.equal(gw.calls.length, 0);
  });

  test("a Stripe rejection releases the items for a later attempt", async () => {
    gw.next.push({ kind: "rejected", message: "charge disputed" });
    await agent.handle(BEN, "refund ORD-1002");
    assert.match(await agent.handle(BEN, "yes"), /couldn't issue that refund/);
    assert.equal(state.refunds.length, 0);
    assert.match(await agent.handle(BEN, "refund ORD-1002"), /\$25\.00/);
  });

  test("an uncertain outcome keeps the items reserved and reconcile retries with the same key", async () => {
    gw.next.push({ kind: "uncertain", message: "timeout" });
    await agent.handle(BEN, "refund ORD-1002");
    assert.match(await agent.handle(BEN, "yes"), /won't be issued twice/);
    assert.equal(state.refunds[0]!.status, "uncertain");
    assert.match(await agent.handle(BEN, "refund ORD-1002"), /already been fully refunded/);

    const sent: [string, string][] = [];
    await agent.reconcile(false, async (to, text) => void sent.push([to, text]));
    assert.equal(gw.calls.length, 2);
    assert.equal(gw.calls[1]!.idempotencyKey, gw.calls[0]!.idempotencyKey);
    assert.equal(state.refunds[0]!.status, "succeeded");
    assert.equal(sent[0]![0], BEN);
    assert.match(sent[0]![1], /now been issued/);
  });

  test("non-text messages get a polite answer", async () => {
    assert.match(await agent.handle(ADA, null), /only read text/);
  });
});
