import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefundAgent } from "../src/agent.ts";
import { loadOrders } from "../src/orders.ts";
import { createWebhookServer, type WebhookServer } from "../src/server.ts";
import { StateStore } from "../src/state.ts";
import { StripeClient } from "../src/stripe.ts";
import { WhatsAppClient } from "../src/whatsapp.ts";

const SECRET = "test-app-secret";
const VERIFY = "test-verify-token";
const ADA = "15550100001";

interface Captured {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  url: string;
}

function fakeApi(respond: (c: Captured) => [number, unknown]): Promise<{ server: Server; url: string; calls: Captured[] }> {
  const calls: Captured[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const c = { headers: req.headers, body, url: req.url ?? "" };
      calls.push(c);
      const [status, json] = respond(c);
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

function webhook(from: string, id: string, text: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PNID" },
              contacts: [{ wa_id: from, profile: { name: "x" } }],
              messages: [{ from, id, timestamp: "1760000000", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

describe("webhook server end to end", () => {
  let stripe: Awaited<ReturnType<typeof fakeApi>>;
  let graph: Awaited<ReturnType<typeof fakeApi>>;
  let app: WebhookServer;
  let base: string;
  let dir: string;
  let refundCount = 0;

  before(async () => {
    stripe = await fakeApi(() => [200, { id: `re_test_${++refundCount}`, object: "refund", status: "succeeded" }]);
    graph = await fakeApi(() => [200, { messages: [{ id: "wamid.out" }] }]);
    dir = mkdtempSync(join(tmpdir(), "refund-agent-"));
    const state = new StateStore(join(dir, "state.json"));
    const agent = new RefundAgent({
      orders: loadOrders("orders.json"),
      state,
      refunds: new StripeClient("sk_test_123", stripe.url, 1),
      refundWindowDays: 30,
      now: () => Date.parse("2026-10-18T12:00:00Z"),
      log: () => {},
    });
    app = createWebhookServer({
      agent,
      state,
      sender: new WhatsAppClient("wa-token", "PNID", graph.url),
      appSecret: SECRET,
      verifyToken: VERIFY,
      log: () => {},
    });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/webhook`;
  });

  after(() => {
    app.server.close();
    stripe.server.close();
    graph.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(payload: unknown, sign = true) {
    const body = JSON.stringify(payload);
    const sig = "sha256=" + createHmac("sha256", sign ? SECRET : "wrong").update(body).digest("hex");
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body });
    await app.idle();
    return res.status;
  }

  test("answers Meta's verification handshake", async () => {
    const ok = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc123`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "abc123");
    const bad = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123`);
    assert.equal(bad.status, 403);
  });

  test("rejects unsigned or badly signed webhooks", async () => {
    assert.equal(await post(webhook(ADA, "wamid.forged", "refund ORD-1001"), false), 401);
    const unsigned = await fetch(base, { method: "POST", body: "{}" });
    assert.equal(unsigned.status, 401);
    assert.equal(graph.calls.length, 0);
  });

  test("full conversation issues one Stripe refund and replies on WhatsApp", async () => {
    assert.equal(await post(webhook(ADA, "wamid.1", "refund ORD-1001")), 200);
    assert.equal(graph.calls.length, 1);
    const quote = JSON.parse(graph.calls[0]!.body);
    assert.equal(graph.calls[0]!.url, "/PNID/messages");
    assert.equal(graph.calls[0]!.headers.authorization, "Bearer wa-token");
    assert.equal(quote.to, ADA);
    assert.match(quote.text.body, /\$100\.00/);
    assert.equal(stripe.calls.length, 0);

    assert.equal(await post(webhook(ADA, "wamid.2", "YES")), 200);
    // WhatsApp redelivers webhooks; a duplicate must not trigger anything.
    assert.equal(await post(webhook(ADA, "wamid.2", "YES")), 200);

    assert.equal(stripe.calls.length, 1);
    const call = stripe.calls[0]!;
    assert.equal(call.headers.authorization, "Bearer sk_test_123");
    assert.ok(call.headers["idempotency-key"]);
    const form = new URLSearchParams(call.body);
    assert.equal(form.get("charge"), "ch_demo_1001");
    assert.equal(form.get("amount"), "10000");
    assert.equal(form.get("metadata[order]"), "ORD-1001");

    assert.equal(graph.calls.length, 2);
    assert.match(JSON.parse(graph.calls[1]!.body).text.body, /re_test_1/);
  });

  test("state survives a restart", () => {
    const reloaded = new StateStore(join(dir, "state.json"));
    assert.equal(reloaded.refunds.length, 1);
    assert.equal(reloaded.markSeen("wamid.2"), false);
  });

  test("ignores status-only webhooks", async () => {
    const before = graph.calls.length;
    const status = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "x", status: "read" }] } }] }] };
    assert.equal(await post(status), 200);
    assert.equal(graph.calls.length, before);
  });
});

describe("StripeClient", () => {
  test("classifies 4xx as rejected and 5xx as uncertain, retrying with the same key", async () => {
    const statuses = [500, 400];
    const api = await fakeApi(() => [statuses.shift()!, { error: { message: "nope" } }]);
    try {
      const res = await new StripeClient("sk_test", api.url, 3).createRefund({ charge: "ch", amount: 1, idempotencyKey: "k1", metadata: {} });
      assert.deepEqual(res, { kind: "rejected", message: "nope" });
      assert.equal(api.calls.length, 2);
      assert.equal(api.calls[0]!.headers["idempotency-key"], "k1");
      assert.equal(api.calls[1]!.headers["idempotency-key"], "k1");
    } finally {
      api.server.close();
    }
  });

  test("network failure is uncertain", async () => {
    const res = await new StripeClient("sk_test", "http://127.0.0.1:1", 1).createRefund({ charge: "ch", amount: 1, idempotencyKey: "k", metadata: {} });
    assert.equal(res.kind, "uncertain");
  });
});
