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
 * is a value the provider signs that may be taken once; ingress claims it in the store, which keeps it until `until`
 * (ms, by the runtime's clock): the time after which the adapter refuses the signature as stale. Review D-F6 (M8b): the
 * window is the provider's timestamp's, not the time of the claim, so a provider clock ahead of ours cannot outlive it.
 */
export interface Verified {
  messages: InboundMessage[];
  receipts: ProviderReceipt[];
  answer?: { status: number; contentType: string; body: string };
  nonce?: { key: string; until: number };
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
  /** The identity the provider sends as (a number, a mail domain, a bot), to which it ties per-address state. */
  sender: string;
  verify(webhook: Webhook, now: number): Verified | Refusal;
  send(out: OutboundSend, transports: ChannelTransports): Promise<SendResult>;
}

/** An HTTP answer to a provider's webhook. */
export interface IngressAnswer { status: number; contentType: string; body: string }

/**
 * What ingress needs of its host (PT21.4): the content store, inbound dispatch, and its journal. Review D-F4 (M8b): a
 * message's sender claims reach a step only from a certified adapter's verify, so a host that is a poly runtime
 * receives the webhook itself (`receive`), with an adapter it checks is certified; ingress then hands it over whole.
 */
export interface IngressHost {
  putContent(body: string): Promise<string>;
  inbound(channel: string, fields: Record<string, unknown>, opts: { messageId: string; claims?: SenderClaims }): Promise<{ outcome: 'delivered' | 'refused'; reason?: string }>;
  /** Takes a nonce once: true the first time, false for a nonce taken before and kept until `until`, across restarts. */
  claimNonce(channel: string, key: string, until: number, now: number): Promise<boolean>;
  ingressRecord(channel: string, record: { stage: 'verify' | 'receipt' | 'claims'; outcome: string; provider: string; reason?: string; providerId?: string; status?: string; claims?: SenderClaims; messageId?: string }): Promise<void>;
  /** The whole of ingress for one webhook, run by the host with the adapter given, which it checks is certified. */
  receive?(channel: string, webhook: Webhook, adapter: ChannelAdapter): Promise<IngressAnswer>;
}

// ── Vault adapters (PT10f, PT22.3, PT22.5, S200, S202) ──────────────────────────────────────────────────────────────

/** The host's wrapping pair for the KMS-wrapped store (S200): a cloud KMS is the host's code, never poly's. */
export interface WrapPair {
  wrap(plain: Uint8Array): Promise<Uint8Array> | Uint8Array;
  unwrap(blob: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/** A vault store: each grant's record kept encrypted by id, outside the project and the content store (S200). */
export interface VaultStore {
  readonly kind: 'dev-keychain' | 'kms';
  put(id: string, record: Record<string, unknown>): Promise<void>;
  get(id: string): Promise<Record<string, unknown> | null>;
  remove(id: string): Promise<void>;
}

/** The host's OAuth client, given at load as runtime configuration; its secret is never journaled (PT10f). */
export interface OAuthClient {
  clientId: string;
  redirectUri: string;
  clientSecret?: string;
}

/** What a vault's verify of the provider's redirect gives: the grant, the scopes granted, and the state as a nonce. */
export type VaultCallback = { grantId: string; scopes: string[]; nonce: { key: string; until: number } } | { refused: string; grantId?: string };

/**
 * PT22.3, PT22.5: a vault adapter. It holds the tokens of the grants it made, attaches them inside `withToken`, and never
 * returns one: no method's result holds a token, and `withToken` removes the headers that could carry one back.
 */
export interface VaultAdapter {
  readonly kind: 'vault';
  readonly provider: string;
  readonly store: VaultStore['kind'];
  authorize(r: { grantId: string; scopes: string[]; now: number }): Promise<{ url: string; state: string; until: number }>;
  verify(webhook: Webhook, now: number): Promise<VaultCallback>;
  refresh(grantId: string): Promise<{ valid: boolean }>;
  revoke(grantId: string): Promise<void>;
  withToken(grantId: string, request: HttpRequest): Promise<HttpResponse>;
}

/** PT10f, S202: what the callback route of ingress needs of its host: the nonce store, its journal, and the grant. */
export interface CredentialHost {
  /** Takes the state once, as a channel's nonce is taken (the scope is `credential:<name>`). */
  claimNonce(scope: string, key: string, until: number, now: number): Promise<boolean>;
  /** Records the callback's refusal or acceptance on runtime:ingress; never a code, a state or a token. */
  credentialRecord(credential: string, record: { stage: 'callback'; outcome: 'refused' | 'granted'; provider: string; reason?: string }): Promise<void>;
  /**
   * Dispatches Callback(scopes) to the grant's Grant instance (PT22.3, step 3), and answers whether the grant took it;
   * one revoked, or not Requested, does not (review C2, M9), and the vault then revokes what it received.
   */
  grantCallback(credential: string, grantId: string, scopes: string[]): Promise<boolean>;
}

// ── Source adapters (PT20.2, PS17.2, S308) ──────────────────────────────────────────────────────────────────────────

/** One item a source holds, by reference: its id, its owner when the source is owned, and when it was true (ms). */
/** S451: `keys` holds the item's value of each key its source declares, as the adapter supplies it. */
export interface ItemRef { id: string; owner: string | null; asOf: number; keys?: Record<string, string> }

/**
 * A retrieval's query: `owner == p` is a typed parameter, never text, and the limit bounds what comes back. S451:
 * `key` is the key predicate `k == x`, its name and the value of x, which the adapter filters by as a parameter.
 */
export interface SourceQuery { owner?: string; key?: { name: string; value: string }; limit: number }

/**
 * PT20.2, K14: a source adapter. It returns items with their true owner and `asOf`, resolves an item to its body when a
 * decision reads it, and removes every body it holds about a subject. It never receives a policy, a snapshot or a key.
 */
export interface SourceAdapter {
  readonly kind: 'postgres' | 'opensearch';
  retrieve(q: SourceQuery): Promise<ItemRef[]>;
  resolve(id: string): Promise<string | null>;
  forget(subject: string): Promise<{ removed: number }>;
  /**
   * PS17.0, PS17.2, PT10j (S459): the envelope of a reply to the newest item whose key `key.name` is `key.value` (and,
   * when given, whose owner is `owner`), each a parameter, never text; null when there is none. Only a source that
   * declares `envelope k` is asked, and an adapter without this method is refused permanently.
   */
  envelope?(q: EnvelopeQuery): Promise<EnvelopeAnswer | null>;
}

/** S459: an envelope retrieval's query: the owner predicate's value, when there is one, and the key's. */
export interface EnvelopeQuery { owner?: string; key: { name: string; value: string } }

/** S459: a reply's recipient, subject and threading headers (In-Reply-To, References), as the source gives them. */
export interface Envelope { to: string; subject: string; inReplyTo: string | null; references: string[] }

/** S459: the item the envelope replies to, with its owner and asOf (K14), and the envelope itself. */
export interface EnvelopeAnswer { id: string; owner: string | null; asOf: number; envelope: Envelope }

/** The host's query function for Postgres (S308): parameterized text and its values; no driver enters poly. */
export type PgQuery = (text: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
