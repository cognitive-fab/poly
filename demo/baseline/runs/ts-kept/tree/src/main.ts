import { RefundAgent } from "./agent.ts";
import { loadOrders } from "./orders.ts";
import { createWebhookServer } from "./server.ts";
import { StateStore } from "./state.ts";
import { StripeClient } from "./stripe.ts";
import { WhatsAppClient } from "./whatsapp.ts";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const stripeKey = env("STRIPE_SECRET_KEY");
if (stripeKey.startsWith("sk_live_") && process.env.ALLOW_LIVE_REFUNDS !== "1") {
  console.error("STRIPE_SECRET_KEY is a live key. Set ALLOW_LIVE_REFUNDS=1 to issue real refunds.");
  process.exit(1);
}

const orders = loadOrders(env("ORDERS_FILE", "orders.json"));
const state = new StateStore(env("STATE_FILE", "state.json"));
const agent = new RefundAgent({
  orders,
  state,
  refunds: new StripeClient(stripeKey, process.env.STRIPE_API_BASE),
  refundWindowDays: Number(env("REFUND_WINDOW_DAYS", "30")),
});
const sender = new WhatsAppClient(env("WHATSAPP_ACCESS_TOKEN"), env("WHATSAPP_PHONE_NUMBER_ID"), process.env.WHATSAPP_API_BASE);

const { server } = createWebhookServer({
  agent,
  state,
  sender,
  appSecret: env("WHATSAPP_APP_SECRET"),
  verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
});

// Finish any refunds interrupted by a crash or Stripe outage, then keep retrying unknown outcomes.
const notify = (to: string, text: string) => sender.sendText(to, text);
await agent.reconcile(true, notify);
setInterval(() => void agent.reconcile(false, notify), 5 * 60_000).unref();

const port = Number(env("PORT", "3000"));
server.listen(port, () => console.log(`Refund agent listening on http://localhost:${port}/webhook (${orders.length} orders loaded)`));
