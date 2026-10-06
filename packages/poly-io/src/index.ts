// poly-io (S182): ingress and the runtime channel adapters of PT20.2, the one package where network code lives.
export { whatsapp, type WhatsAppConfig } from './adapters/whatsapp.js';
export { sms, keywordOf, twilioSignature, OPT_OUT, OPT_IN, HELP, type TwilioConfig } from './adapters/sms.js';
export { email, unsubscribeUrl, type EmailConfig } from './adapters/email.js';
export { slack, type SlackConfig } from './adapters/slack.js';
export { webhook, type WebhookConfig } from './adapters/webhook.js';
export { submit, dotStuff, type Submission } from './smtp.js';
export { ingress, type IngressAnswer } from './ingress.js';
export { ADAPTER_FAULTS, type AdapterFault } from './util.js';
export { httpsTransport, smtpsTransport, serveIngress, publicUrl } from './net.js';
