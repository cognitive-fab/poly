import { resolve } from "node:path";
import { SupportAgent } from "./agent.ts";
import { loadOrders } from "./orders.ts";
import { createWebhookServer } from "./server.ts";
import { Store } from "./store.ts";
import { StripeClient } from "./stripe.ts";
import { WhatsAppClient } from "./whatsapp.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name} (see README.md)`);
    process.exit(1);
  }
  return v;
}

const config = {
  port: Number(process.env.PORT ?? 3000),
  ordersFile: resolve(process.env.ORDERS_FILE ?? "orders.json"),
  stateFile: resolve(process.env.STATE_FILE ?? "data/state.json"),
  refundWindowDays: Number(process.env.REFUND_WINDOW_DAYS ?? 30),
  stripeSecretKey: required("STRIPE_SECRET_KEY"),
  whatsappToken: required("WHATSAPP_ACCESS_TOKEN"),
  whatsappPhoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
  whatsappAppSecret: required("WHATSAPP_APP_SECRET"),
  whatsappVerifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  graphApiVersion: process.env.GRAPH_API_VERSION ?? "v21.0",
};

if (!Number.isFinite(config.refundWindowDays) || config.refundWindowDays < 0) {
  console.error("REFUND_WINDOW_DAYS must be a non-negative number");
  process.exit(1);
}

// Fail fast if orders.json is malformed.
await loadOrders(config.ordersFile);

const store = new Store(config.stateFile);
await store.load();

const agent = new SupportAgent({
  store,
  stripe: new StripeClient({ secretKey: config.stripeSecretKey }),
  loadOrders: () => loadOrders(config.ordersFile),
  refundWindowDays: config.refundWindowDays,
});

const { server } = createWebhookServer({
  agent,
  store,
  whatsapp: new WhatsAppClient({
    accessToken: config.whatsappToken,
    phoneNumberId: config.whatsappPhoneNumberId,
    apiVersion: config.graphApiVersion,
  }),
  appSecret: config.whatsappAppSecret,
  verifyToken: config.whatsappVerifyToken,
});

server.listen(config.port, () => {
  console.log(`Support agent listening on http://localhost:${config.port}/webhook`);
});
