// PT20.2, S182: the runtime adapter interface for channels. It is types only, the one thing poly-io may import from
// poly-runtime: an adapter turns a provider's webhook into what poly reads (verify, with the provider's receipts) and a
// send into the provider's request (send). It never receives a policy, a snapshot or a ledger key (PT20.2).

/** A webhook as ingress received it: the raw body, so a signature can be checked over the bytes signed. */
export interface Webhook {
  method: string;
  /** The full public URL the provider called, query included (Twilio signs it). */
  url: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
}

/** K11: what the adapter says about the sender. poly trusts it and checks every use of it. */
export interface SenderClaims {
  /** Whether the provider authenticated the sender (a WhatsApp or Slack account, a signed source), or not (an SMS
   * number, an email address without an aligned DKIM pass). */
  verified: boolean;
  sender: string;
}

/** One inbound message: the conversation's Inbound fields, the body for the content store, and the sender claims. */
export interface InboundMessage {
  /** The provider's id for the message; the action id is `<channel>:<providerMessageId>` (PT21.4). */
  providerMessageId: string;
  /** The Inbound fields other than the body: the thread fields and the kind's own (a keyword, an event). */
  fields: Record<string, string>;
  /** The body, stored in the content store; the conversation receives its Content (PT21.4). */
  body: string;
  claims: SenderClaims;
}

/** A provider's report on a send it accepted earlier. */
export interface ProviderReceipt {
  providerId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered';
  error?: string;
}

/**
 * What a verified webhook carries. `answer` is the reply a handshake expects (a challenge), when there is one. `nonce`
 * is a value the provider signs that may be taken once, within ttlMs of `at`; ingress claims it in the store.
 */
export interface Verified {
  messages: InboundMessage[];
  receipts: ProviderReceipt[];
  answer?: { status: number; contentType: string; body: string };
  nonce?: { key: string; at: number; ttlMs: number };
}

/** A webhook the adapter refuses: nothing in it is dispatched (PT21.4). */
export interface Refusal {
  refused: string;
}

/** One send: the recipient's address, the body, and the conversation's kind of message where it has one. */
export interface OutboundSend {
  to: string;
  body: string;
  /** whatsapp: FreeForm or Templated; email: Direct or Bulk. */
  kind?: string;
  /** The outbox intent's idempotency key (PT15), passed to a provider that takes one. */
  idempotencyKey: string;
  /** The time of the send (ms), from the runtime's clock, for a provider that signs a timestamp. */
  now: number;
}

/** PS15.4: a provider event a send's failure reports, for the conversation: its Inbound fields other than the body. */
export interface ProviderEvent { providerId: string; fields: Record<string, string> }

/**
 * A send's result: the provider's id, or a failure, permanent when a retry would fail the same way, with the provider
 * events it reports that a rule of the conversation reads (PS15.4).
 */
export type SendResult = { ok: true; providerId: string } | { ok: false; permanent: boolean; error: string; events?: ProviderEvent[] };

/** An HTTP exchange, given to an adapter so that a test replays recorded traffic and only poly-io opens a socket. */
export interface HttpRequest { method: string; url: string; headers: Record<string, string>; body: string }
export interface HttpResponse { status: number; headers: Record<string, string>; body: string }
export interface HttpTransport { request(r: HttpRequest): Promise<HttpResponse> }

/** An SMTP session (RFC 5321): one reply read, or one line written, at a time. */
export interface SmtpSession { read(): Promise<string>; write(line: string): Promise<void>; close(): Promise<void> }
export interface SmtpTransport { open(): Promise<SmtpSession> }

export interface ChannelTransports { http?: HttpTransport; smtp?: SmtpTransport }

/** PT20.2: a channel adapter. `kind` is the std channel kind whose Inbound fields it produces. */
export interface ChannelAdapter {
  kind: string;
  provider: string;
  verify(webhook: Webhook, now: number): Verified | Refusal;
  send(out: OutboundSend, transports: ChannelTransports): Promise<SendResult>;
}

/** What ingress needs of the runtime (PT21.4): the content store, inbound dispatch, and its journal. */
export interface IngressHost {
  putContent(body: string): Promise<string>;
  inbound(channel: string, fields: Record<string, unknown>, opts: { messageId: string }): Promise<{ outcome: 'delivered' | 'refused'; reason?: string }>;
  /** Takes a nonce once: true the first time, false for a nonce taken before, across restarts (the store keeps it). */
  claimNonce(channel: string, key: string, at: number, ttlMs: number): Promise<boolean>;
  ingressRecord(channel: string, record: { stage: 'verify' | 'receipt' | 'claims'; outcome: string; provider: string; reason?: string; providerId?: string; status?: string; claims?: SenderClaims; messageId?: string }): Promise<void>;
}
