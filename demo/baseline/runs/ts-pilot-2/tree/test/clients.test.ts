import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMoney, loadOrders } from "../src/orders.ts";
import { StripeClient, StripeError } from "../src/stripe.ts";
import { WhatsAppClient } from "../src/whatsapp.ts";
import { ORDERS_FILE } from "./helpers.ts";

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("StripeClient", () => {
  it("posts a form-encoded refund with an idempotency key", async () => {
    const f = fakeFetch(200, { id: "re_123", status: "succeeded", amount: 6000 });
    const stripe = new StripeClient({ secretKey: "sk_test_x", fetch: f.fn });
    const r = await stripe.createRefund({ charge: "ch_1", amount: 6000, idempotencyKey: "k1", metadata: { order: "ORD-1" } });
    assert.deepEqual(r, { id: "re_123", status: "succeeded", amount: 6000 });
    assert.equal(f.calls[0].url, "https://api.stripe.com/v1/refunds");
    const headers = f.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test_x");
    assert.equal(headers["Idempotency-Key"], "k1");
    const body = f.calls[0].init.body as URLSearchParams;
    assert.equal(body.get("charge"), "ch_1");
    assert.equal(body.get("amount"), "6000");
    assert.equal(body.get("metadata[order]"), "ORD-1");
  });

  it("classifies errors as transient or permanent", async () => {
    const perm = new StripeClient({ secretKey: "k", fetch: fakeFetch(400, { error: { code: "charge_already_refunded", message: "x" } }).fn });
    await assert.rejects(perm.createRefund({ charge: "c", amount: 1, idempotencyKey: "k", metadata: {} }), (e: StripeError) => !e.transient && e.code === "charge_already_refunded");
    const temp = new StripeClient({ secretKey: "k", fetch: fakeFetch(503, {}).fn });
    await assert.rejects(temp.createRefund({ charge: "c", amount: 1, idempotencyKey: "k", metadata: {} }), (e: StripeError) => e.transient);
    const net = new StripeClient({ secretKey: "k", fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    await assert.rejects(net.createRefund({ charge: "c", amount: 1, idempotencyKey: "k", metadata: {} }), (e: StripeError) => e.transient);
  });
});

describe("WhatsAppClient", () => {
  it("sends a text message through the Cloud API", async () => {
    const f = fakeFetch(200, { messages: [{ id: "wamid.x" }] });
    const wa = new WhatsAppClient({ accessToken: "tok", phoneNumberId: "PNID", fetch: f.fn });
    await wa.sendText("15550100001", "hi");
    assert.equal(f.calls[0].url, "https://graph.facebook.com/v21.0/PNID/messages");
    assert.deepEqual(JSON.parse(f.calls[0].init.body as string), {
      messaging_product: "whatsapp", recipient_type: "individual", to: "15550100001", type: "text",
      text: { preview_url: false, body: "hi" },
    });
  });

  it("throws on API errors", async () => {
    const wa = new WhatsAppClient({ accessToken: "tok", phoneNumberId: "PNID", fetch: fakeFetch(401, {}).fn });
    await assert.rejects(wa.sendText("1", "hi"));
  });
});

describe("orders", () => {
  it("loads and validates orders.json", async () => {
    const orders = await loadOrders(ORDERS_FILE);
    assert.equal(orders.length, 2);
    assert.equal(orders[0].customer, "15550100001");
  });

  it("formats money in minor units", () => {
    assert.equal(formatMoney(10000, "usd"), "$100.00");
    assert.equal(formatMoney(500, "jpy"), "¥500");
  });
});
