import { SupportAgent } from './agent.ts';
import { loadConfig } from './config.ts';
import { Ledger } from './ledger.ts';
import { loadOrders } from './orders.ts';
import { createApp } from './server.ts';
import { createStripeClient } from './stripe.ts';
import { createWhatsAppClient } from './whatsapp.ts';

const config = loadConfig(process.env);

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

// Fail fast on a bad orders file; after that it is re-read per message so edits apply without a restart.
loadOrders(config.ordersPath);

const agent = new SupportAgent({
  getOrders: () => loadOrders(config.ordersPath),
  ledger: new Ledger(config.ledgerPath),
  stripe: createStripeClient({ secretKey: config.stripeSecretKey }),
  refundWindowDays: config.refundWindowDays,
  log,
});

const { server } = createApp({
  agent,
  whatsapp: createWhatsAppClient({
    accessToken: config.whatsappAccessToken,
    phoneNumberId: config.whatsappPhoneNumberId,
    apiVersion: config.graphApiVersion,
  }),
  verifyToken: config.whatsappVerifyToken,
  appSecret: config.whatsappAppSecret,
  log,
});

server.listen(config.port, () => log('support agent listening', { port: config.port, webhook: '/webhook' }));
