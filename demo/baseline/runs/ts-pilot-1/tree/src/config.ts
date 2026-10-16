export interface Config {
  port: number;
  ordersPath: string;
  ledgerPath: string;
  refundWindowDays: number;
  stripeSecretKey: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappVerifyToken: string;
  whatsappAppSecret: string;
  graphApiVersion: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? '';
  };

  const config: Config = {
    port: Number(env.PORT ?? 3000),
    ordersPath: env.ORDERS_PATH ?? 'orders.json',
    ledgerPath: env.LEDGER_PATH ?? 'refunds.json',
    refundWindowDays: Number(env.REFUND_WINDOW_DAYS ?? 30),
    stripeSecretKey: required('STRIPE_SECRET_KEY'),
    whatsappAccessToken: required('WHATSAPP_ACCESS_TOKEN'),
    whatsappPhoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
    whatsappVerifyToken: required('WHATSAPP_VERIFY_TOKEN'),
    whatsappAppSecret: required('WHATSAPP_APP_SECRET'),
    graphApiVersion: env.GRAPH_API_VERSION ?? 'v21.0',
  };

  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (!Number.isInteger(config.port) || config.port < 0) throw new Error('PORT must be a non-negative integer');
  if (!(config.refundWindowDays >= 0)) throw new Error('REFUND_WINDOW_DAYS must be a non-negative number');
  return config;
}
