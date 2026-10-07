// PT10f, PT22.3, PT22.5 (S200, S202, S208): the vault adapter. It runs the OAuth 2.0 authorization code grant
// (RFC 6749 section 4.1) with PKCE where the profile has it (RFC 7636, S256), refreshes (RFC 6749 section 6), revokes
// (RFC 7009, or Stripe's deauthorization), and attaches a grant's credential to a request inside the adapter. It keeps
// every token in its store, encrypted, and no method returns one. Its rules and sources are in PROVENANCE.md.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CredentialHost, HttpRequest, HttpResponse, IngressAnswer, OAuthClient, VaultAdapter, VaultCallback, VaultStore, Webhook, WrapPair } from '@poly/runtime/adapters';
import { made, need, oneLine } from './util.js';

/** The profile fields the adapter reads (PT10e, PT10f); the checker has already checked the profile's shape. */
interface Profile {
  provider: string;
  bases: string[];
  authorization: string;
  token: string;
  revocation: string;
  pkce: boolean;
  scopes: string[];
  scopeValues?: Record<string, string>;
  authParams?: Record<string, string>;
  attach?: 'bearer' | 'stripe-account';
  revocationStyle?: 'rfc7009' | 'stripe-deauthorize';
}

/** How long an authorization request's state is kept: ten minutes, poly's own (RFC 6749 sets none). */
const STATE_MS = 10 * 60_000;
/** The response headers that can carry a credential back to a handler (PT22.5). */
const TOKEN_HEADERS = ['authorization', 'proxy-authorization', 'set-cookie', 'www-authenticate'];

const b64url = (b: Buffer): string => b.toString('base64url');
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── stores (S200) ───────────────────────────────────────────────────────────────────────────────────────────────

/** Where a store keeps its ciphertext: a directory named by an absolute `file:` path, or memory. */
function blobs(dir: string | undefined): { read(id: string): Buffer | null; write(id: string, b: Buffer): void; remove(id: string): void } {
  if (dir === undefined) {
    const m = new Map<string, Buffer>();
    return { read: (id) => m.get(id) ?? null, write: (id, b) => { m.set(id, b); }, remove: (id) => { m.delete(id); } };
  }
  const path = filePath(dir, 'the store directory');
  mkdirSync(path, { recursive: true });
  // A blob is named by the digest of its id, so an id never becomes a path.
  const at = (id: string) => join(path, `${sha(id)}.bin`);
  return {
    read: (id) => (existsSync(at(id)) ? readFileSync(at(id)) : null),
    write: (id, b) => writeFileSync(at(id), b),
    remove: (id) => rmSync(at(id), { force: true }),
  };
}

/** An absolute path from `file:PATH`, as the ledger signer's location is read (S188). */
function filePath(location: string, what: string): string {
  if (!location.startsWith('file:')) throw new Error(`${what} is named file:PATH, never by value or env: (S200)`);
  const p = location.slice(5);
  if (!isAbsolute(p)) throw new Error(`${what} is an absolute file: path, outside any project (S200)`);
  return p;
}

function store(kind: VaultStore['kind'], seal: (plain: Buffer) => Promise<Buffer>, open: (blob: Buffer) => Promise<Buffer>, dir: string | undefined): VaultStore {
  const b = blobs(dir);
  return made({
    kind,
    async put(id: string, record: Record<string, unknown>) { b.write(id, await seal(Buffer.from(JSON.stringify(record), 'utf8'))); },
    async get(id: string) { const blob = b.read(id); return blob ? (JSON.parse((await open(blob)).toString('utf8')) as Record<string, unknown>) : null; },
    async remove(id: string) { b.remove(id); },
  });
}

/**
 * S200: the development keychain, for development only (admission refuses it in a production build, PL6826): AES-256-GCM
 * under a 32-byte key, hex, read from an absolute `file:` path outside any project.
 */
export function devKeychain(opts: { key: string; dir?: string }): VaultStore {
  const text = readFileSync(filePath(opts.key, 'the development keychain\'s key'), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('the development keychain\'s key is 32 bytes, written as 64 hex digits (S200)');
  const key = Buffer.from(text, 'hex');
  const seal = async (plain: Buffer) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); };
  const open = async (blob: Buffer) => { const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(12, 28)); return Buffer.concat([d.update(blob.subarray(28)), d.final()]); };
  return store('dev-keychain', seal, open, opts.dir);
}

/** S200: the KMS-wrapped store, over the host's wrapping pair, so no cloud SDK enters poly. */
export function kmsStore(pair: WrapPair, opts: { dir?: string } = {}): VaultStore {
  if (typeof pair?.wrap !== 'function' || typeof pair?.unwrap !== 'function') throw new Error('the KMS-wrapped store takes the host\'s wrap and unwrap (S200)');
  return store('kms', async (p) => Buffer.from(await pair.wrap(p)), async (b) => Buffer.from(await pair.unwrap(b)), opts.dir);
}

// ── the adapter ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A form body. */
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
function parse(body: string): Record<string, unknown> {
  try { const x = JSON.parse(body) as unknown; return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {}; } catch { return {}; }
}

export function oauthVault(profile: Profile, client: OAuthClient, st: VaultStore, transports: { http?: { request(r: HttpRequest): Promise<HttpResponse> } }): VaultAdapter {
  need('vault', { clientId: client?.clientId, redirectUri: client?.redirectUri });
  oneLine('vault', { clientId: client.clientId, redirectUri: client.redirectUri, ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}) });
  const stripe = profile.attach === 'stripe-account';
  if (stripe) need('vault', { clientSecret: client.clientSecret });
  const http = () => { if (!transports.http) throw new Error('the vault has no HTTP transport'); return transports.http; };
  const wire = (s: string) => profile.scopeValues?.[s] ?? s;
  const nameOf = new Map(profile.scopes.map((s) => [wire(s), s]));
  // RFC 6749 section 2.3.1: a confidential client authenticates with HTTP Basic; Stripe takes the platform's key.
  const clientAuth = (): Record<string, string> => (stripe ? { authorization: `Bearer ${client.clientSecret}` } : client.clientSecret ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}` } : {});
  const post = (url: string, fields: Record<string, string>) => http().request({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...clientAuth() }, body: form(fields) });
  const pending = (state: string) => `pending:${state}`;
  /** The states this adapter has taken; the store's removal and the host's nonce keep them taken across restarts. */
  const taken = new Set<string>();
  const grant = (id: string) => `grant:${id}`;

  return made({
    kind: 'vault' as const,
    provider: profile.provider,
    store: st.kind,

    async authorize({ grantId, scopes, now }: { grantId: string; scopes: string[]; now: number }) {
      const state = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(32));
      const until = now + STATE_MS;
      await st.put(pending(state), { grantId, scopes, verifier, until });
      // Polywatch: the profile's fixed parameters come first, so none can replace a parameter the grant depends on.
      const q = new URLSearchParams({ ...(profile.authParams ?? {}), response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, scope: scopes.map(wire).join(' '), state });
      if (profile.pkce) { q.set('code_challenge', b64url(createHash('sha256').update(verifier).digest())); q.set('code_challenge_method', 'S256'); }
      return { url: `${profile.authorization}?${q.toString()}`, state, until };
    },

    async verify(w: Webhook, now: number): Promise<VaultCallback> {
      let q: URLSearchParams;
      try { q = new URL(w.url).searchParams; } catch { return { refused: 'malformed: the redirect URL does not parse' }; }
      const state = q.get('state') ?? '';
      // S202, polywatch: the state is taken before the first await, so two redirects with one state cannot both read
      // the pending record and both exchange the code; the second is refused here, whatever follows.
      if (!state || taken.has(state)) return { refused: 'unknown state' };
      taken.add(state);
      const p = await st.get(pending(state));
      if (!p) return { refused: 'unknown state' };
      await st.remove(pending(state));
      const grantId = String(p.grantId);
      if (q.get('error')) return { refused: `the provider answered ${q.get('error')}`, grantId };
      if (now > Number(p.until)) return { refused: 'expired state', grantId };
      const code = q.get('code');
      if (!code) return { refused: 'no code', grantId };
      const r = await post(profile.token, { grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, ...(profile.pkce ? { code_verifier: String(p.verifier) } : {}) });
      const body = parse(r.body);
      if (r.status < 200 || r.status >= 300) return { refused: `the token endpoint answered ${typeof body.error === 'string' ? body.error : r.status}`, grantId };
      const requested = p.scopes as string[];
      // RFC 6749 section 5.1: with no scope in the response, the scopes granted are those requested.
      const scopes = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean).flatMap((v) => (nameOf.has(v) ? [nameOf.get(v)!] : [])) : requested;
      if (stripe ? typeof body.stripe_user_id !== 'string' : typeof body.access_token !== 'string') return { refused: 'the token endpoint answered with no credential', grantId };
      await st.put(grant(grantId), stripe ? { account: body.stripe_user_id } : { access: body.access_token, ...(typeof body.refresh_token === 'string' ? { refresh: body.refresh_token } : {}) });
      return { grantId, scopes, nonce: { key: state, until: Number(p.until) } };
    },

    async refresh(grantId: string) {
      const g = await st.get(grant(grantId));
      if (!g) return { valid: false };
      // Stripe: the platform's key is the credential, and nothing expires to refresh (S208).
      if (stripe) return { valid: true };
      if (typeof g.refresh !== 'string') return { valid: false };
      const r = await post(profile.token, { grant_type: 'refresh_token', refresh_token: g.refresh, client_id: client.clientId });
      const body = parse(r.body);
      if (r.status === 400 && body.error === 'invalid_grant') { await st.remove(grant(grantId)); return { valid: false }; }
      if (r.status < 200 || r.status >= 300 || typeof body.access_token !== 'string') throw new Error(`the token endpoint answered ${r.status} to a refresh`);
      // RFC 6749 section 6: a new refresh token replaces the old; with none, the old one stays.
      await st.put(grant(grantId), { access: body.access_token, refresh: typeof body.refresh_token === 'string' ? body.refresh_token : g.refresh });
      return { valid: true };
    },

    async revoke(grantId: string) {
      const g = await st.get(grant(grantId));
      if (!g) return;
      const r = profile.revocationStyle === 'stripe-deauthorize'
        ? await post(profile.revocation, { client_id: client.clientId, stripe_user_id: String(g.account) })
        : await post(profile.revocation, typeof g.refresh === 'string' ? { token: g.refresh, token_type_hint: 'refresh_token' } : { token: String(g.access), token_type_hint: 'access_token' });
      if (r.status < 200 || r.status >= 300) throw new Error(`the revocation endpoint answered ${r.status}`);
      await st.remove(grant(grantId));
    },

    async withToken(grantId: string, request: HttpRequest) {
      let u: URL;
      try { u = new URL(request.url); } catch { throw new Error(`${request.url} is not a URL`); }
      const url = u.href;
      // Polywatch: compared as parsed, by origin and path, never as text, so a host that merely begins with a base's host
      // (or a user part before another host) is not under it.
      const under = (b: string) => { const base = new URL(b); const path = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`; return !u.username && !u.password && u.origin === base.origin && (u.pathname === base.pathname || u.pathname.startsWith(path)); };
      if (!profile.bases.some(under)) throw new Error(`${url} lies outside the provider's base addresses (PT22.5)`);
      const own = Object.keys(request.headers).map((h) => h.toLowerCase());
      for (const h of ['authorization', 'proxy-authorization', 'stripe-account']) if (own.includes(h)) throw new Error(`a request through the vault carries no ${h} header of its own; the vault attaches the credential (PT22.5)`);
      const g = await st.get(grant(grantId));
      if (!g) throw new Error(`no grant ${grantId} in the vault`);
      const attach: Record<string, string> = stripe ? { authorization: `Bearer ${client.clientSecret}`, 'stripe-account': String(g.account) } : { authorization: `Bearer ${String(g.access)}` };
      const res = await http().request({ ...request, url, headers: { ...request.headers, ...attach } });
      const headers = Object.fromEntries(Object.entries(res.headers).filter(([h]) => !TOKEN_HEADERS.includes(h.toLowerCase())));
      return { status: res.status, headers, body: res.body };
    },
  });
}

// ── the callback route (S202) ───────────────────────────────────────────────────────────────────────────────────

/**
 * PT10f, S202: ingress for `/credentials/<name>`. The vault reads the provider's redirect; its state is taken once by the
 * host; the grant and its scopes go to the host, which dispatches Callback(scopes) to the grant's instance. A refusal is
 * recorded, and nothing of the redirect (no code, no state) is.
 */
export function credentialIngress(host: CredentialHost, vaults: Record<string, VaultAdapter>, clock: () => number = Date.now): (credential: string, w: Webhook) => Promise<IngressAnswer> {
  return async (credential, w) => {
    const v = Object.hasOwn(vaults, credential) ? vaults[credential] : undefined;
    if (!v) return { status: 404, contentType: 'text/plain', body: 'no such credential' };
    const now = clock();
    let r: VaultCallback;
    try { r = await v.verify(w, now); } catch (e) { r = { refused: `malformed: ${e instanceof Error ? e.message : String(e)}` }; }
    if (!('refused' in r) && !(await host.claimNonce(`credential:${credential}`, r.nonce.key, r.nonce.until, now))) r = { refused: 'state-replayed', grantId: r.grantId };
    if ('refused' in r) {
      await host.credentialRecord(credential, { stage: 'callback', outcome: 'refused', provider: v.provider, reason: r.refused });
      return { status: 401, contentType: 'text/plain', body: 'refused' };
    }
    await host.grantCallback(credential, r.grantId, r.scopes);
    await host.credentialRecord(credential, { stage: 'callback', outcome: 'granted', provider: v.provider });
    return { status: 200, contentType: 'text/plain', body: 'granted' };
  };
}
