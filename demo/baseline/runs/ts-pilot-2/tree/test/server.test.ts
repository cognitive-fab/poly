import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createWebhookServer, type WebhookServer } from "../src/server.ts";
import { ADA, setup } from "./helpers.ts";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";

function payload(from: string, id: string, body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "PNID" },
          contacts: [{ wa_id: from }],
          messages: [{ from, id, timestamp: "1760000000", type: "text", text: { body } }],
        },
      }],
    }],
  };
}

describe("webhook server", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let ws: WebhookServer;
  let base: string;
  const sent: Array<{ to: string; body: string }> = [];

  before(async () => {
    ctx = await setup();
    ws = createWebhookServer({
      agent: ctx.agent,
      store: ctx.store,
      whatsapp: { sendText: async (to, body) => void sent.push({ to, body }) },
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      log: () => {},
    });
    await new Promise<void>((r) => ws.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(ws.server.address() as AddressInfo).port}`;
  });
  after(() => ws.server.close());

  async function post(body: unknown, secret = APP_SECRET) {
    const raw = JSON.stringify(body);
    const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
      body: raw,
    });
    await ws.drain();
    return res.status;
  }

  it("answers Meta's verification handshake", async () => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "12345");
    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
    assert.equal(bad.status, 403);
  });

  it("rejects payloads with a bad signature", async () => {
    sent.length = 0;
    assert.equal(await post(payload(ADA, "wamid.forged", "refund ORD-1001"), "wrong-secret"), 401);
    const unsigned = await fetch(`${base}/webhook`, { method: "POST", body: "{}" });
    assert.equal(unsigned.status, 401);
    assert.equal(sent.length, 0);
  });

  it("runs a full refund conversation over WhatsApp", async () => {
    sent.length = 0;
    assert.equal(await post(payload(ADA, "wamid.1", "refund ORD-1001")), 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, ADA);
    assert.match(sent[0].body, /Reply YES/);

    assert.equal(await post(payload(ADA, "wamid.2", "YES")), 200);
    assert.match(sent[1].body, /Done!/);
    assert.equal(ctx.stripe.created.length, 1);
  });

  it("ignores redelivered messages", async () => {
    sent.length = 0;
    await post(payload(ADA, "wamid.2", "YES"));
    assert.equal(sent.length, 0);
    assert.equal(ctx.stripe.calls.length, 1);
  });

  it("ignores status updates", async () => {
    sent.length = 0;
    const status = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "read" }] } }] }],
    };
    assert.equal(await post(status), 200);
    assert.equal(sent.length, 0);
  });

  it("handles concurrent confirmations without double refunding", async () => {
    sent.length = 0;
    await post(payload("15550100002", "wamid.b1", "refund ORD-1002"));
    await Promise.all([
      post(payload("15550100002", "wamid.b2", "yes")),
      post(payload("15550100002", "wamid.b3", "yes")),
    ]);
    const refunds = ctx.store.state.refunds.filter((r) => r.order === "ORD-1002");
    assert.equal(refunds.length, 1);
    assert.equal(sent.filter((s) => /Done!/.test(s.body)).length, 1);
  });
});
