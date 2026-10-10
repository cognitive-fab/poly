// PT6.5, S134, S151: the capabilities a handler receives. Each is a wrapper over a function the host gives at load
// (`load(…, { transports })`), bound to the targets the effect declares in its manifest entry, which translation
// validation compared with the source. poly-runtime imports no network module: the host's transport performs the
// request, and only after the wrapper has checked it. A call outside the bounds throws CapabilityRefused before the
// transport is called, and is audited (PL6406).

/** One HTTP request, made by the host. It follows no redirect: the capability checks each hop itself (S151). */
export interface EgressRequest { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: unknown }
export interface EgressResponse { status: number; headers?: Record<string, string>; body?: unknown }

/** The host functions capabilities are built over. A capability whose transport is absent throws when called. */
export interface Transports {
  egress?: (req: EgressRequest) => Promise<EgressResponse> | EgressResponse;
  secrets?: (name: string) => Promise<string | undefined> | string | undefined;
  exec?: (command: string, args: string[]) => unknown;
  store?: { read(table: string, key: string): unknown; write(table: string, key: string, value: unknown): unknown };
}

/** S151: a capability call outside the targets its effect declares, refused before the transport. */
export class CapabilityRefused extends Error {
  constructor(message: string) { super(message); this.name = 'CapabilityRefused'; }
}

/** One declared target: a string, or an exact egress URL written { exact } among the kind's strings (S455). */
export type Target = string | { exact: string };

/** The manifest entry's labels and targets, as the lowering wrote them (PT6.1, S151), and the credential it uses (PT10e). */
export interface CapabilityDecl { labels?: string[]; targets?: Record<string, Target[]>; uses?: { credential: string; scopes: string[]; holder: string | null } }

/** PT22.5, S201: the vault's transport for the intent's grant: the credential is attached inside the vault adapter. */
export interface ApiTransport { request(r: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body: string }): Promise<{ status: number; headers: Record<string, string>; body: string }> }

/**
 * PS17.4a (S459): what content.read is bound to for one intent: the Content values of its own payload, the store's read
 * of a body (null when there is none, or it was erased), and the record of a read, by digest and intent.
 */
export interface ContentAccess { digests: readonly string[]; body(d: string): Promise<string | null>; recorded(d: string): Promise<void> }

/**
 * PS17.4a, PS17.7: a body erased since the intent was emitted; it is never stored again (S205), so a retry reads
 * nothing more and the refusal is permanent.
 */
export class ContentMissing extends Error {
  readonly permanent = true;
  readonly reason = 'content-missing';
  constructor(message: string) { super(message); this.name = 'ContentMissing'; }
}

/**
 * PS17.0, PT10j (S460): a source's credential handle refuses a request while the credential's one grant is not Granted
 * (or no vault is connected). A retrieval that meets it fails permanently: retrying reads the same grant, and only a new
 * grant, by a person's request, makes it Granted again.
 */
export class CredentialUnavailable extends Error {
  readonly permanent = true;
  readonly reason = 'credential-unavailable';
  constructor(message: string) { super(message); this.name = 'CredentialUnavailable'; }
}

/**
 * PS17.0, PT10j (S461): an owner's credential handle refuses a request made inside a retrieval for another owner, so one
 * account's grant never reaches another's items. Permanent: the same request in the same retrieval meets the same owner.
 */
export class OwnerMismatch extends Error {
  readonly permanent = true;
  readonly reason = 'owner-mismatch';
  constructor(message: string) { super(message); this.name = 'OwnerMismatch'; }
}

/**
 * S460: the brand a source's credential handle carries, set by the runtime that made it. poly-io records an adapter's
 * transport when it carries this brand, so the runtime can ask which handle an adapter was built with; the brand alone
 * proves nothing, and the runtime looks the handle up among the ones it made.
 */
export const CREDENTIAL_HANDLE = Symbol.for('poly.credential-handle');

/** Redirects followed before a request is given up; each hop is checked against the prefixes. */
export const MAX_REDIRECTS = 5;

const has = (decl: CapabilityDecl, ...labels: string[]) => labels.some((l) => decl.labels?.includes(l));

/**
 * S151: the normalised URL when it lies under one of the prefixes, else null. Both are parsed by the WHATWG URL
 * parser, which lowercases the host, drops a default port and resolves `.`, `..` and their encoded forms. The scheme
 * and host (with port) must be equal, and the path must equal the prefix's or continue it past a `/`, so
 * `/v1/charges` does not admit `/v1/charges-evil`. A URL with a user or password is refused outright. S455: an exact
 * target admits the URL whose scheme, host, path and query equal its own after the same normalisation, and nothing
 * under it.
 */
export function withinPrefix(url: string, prefixes: readonly Target[]): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return null;
  // Review D4: an encoded slash or backslash, or a `..;` segment, survive WHATWG parsing, and some servers resolve them
  // as separators or as `..`, outside the prefix. They are refused.
  if (/%2f|%5c/i.test(u.pathname) || u.pathname.split('/').some((s) => /^\.\.?;/.test(s) || /^%2e%2e?;/i.test(s))) return null;
  for (const p of prefixes) {
    const q = new URL(typeof p === 'string' ? p : p.exact);
    if (q.protocol !== u.protocol || q.host !== u.host) continue;
    if (typeof p !== 'string') { if (u.pathname === q.pathname && u.search === q.search) return u.href; continue; }
    const base = q.pathname;
    if (u.pathname === base || u.pathname.startsWith(base.endsWith('/') ? base : `${base}/`)) return u.href;
  }
  return null;
}

/**
 * The frozen capability object for one effect kind, for one call of its handler. `audit` writes the PL6406 row; it
 * is awaited before the refusal is thrown, so a refusal is in the ledger whatever the handler does with the error.
 */
export function capabilitiesFor(decl: CapabilityDecl, transports: Transports, audit: (reason: string) => Promise<void>, api?: ApiTransport, content?: ContentAccess): Readonly<Record<string, unknown>> {
  const targets = decl.targets ?? {};
  const refuse = async (reason: string): Promise<never> => { await audit(reason); throw new CapabilityRefused(`PL6406 CAPABILITY_REFUSED: ${reason}`); };
  const need = <K extends keyof Transports>(k: K): NonNullable<Transports[K]> => {
    const t = transports[k];
    if (!t) throw new Error(`no ${k} transport was given at load, so the ${k} capability cannot act (S151)`);
    return t as NonNullable<Transports[K]>;
  };
  const caps: Record<string, unknown> = {};
  // PT22.5, S201: an effect that uses a credential gets api in place of egress, bound to its declared targets, its
  // requests sent through the vault for the intent's grant. It follows no redirect. With no vault it cannot act.
  if (decl.uses) {
    const prefixes = targets.egress ?? [];
    const call = async (method: 'GET' | 'POST', url: string, body: unknown, headers: Record<string, string> = {}) => {
      const at = withinPrefix(url, prefixes);
      if (at === null) return refuse(`${method} ${url} is outside the declared egress targets ${JSON.stringify(prefixes)}`);
      if (!api) throw new Error(`no vault is connected for credential ${decl.uses!.credential}, so api cannot act (PT22.5)`);
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      const h = typeof body === 'object' && body !== null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type') ? { ...headers, 'content-type': 'application/json' } : headers;
      return api.request({ method, url: at, headers: h, body: text });
    };
    caps.api = Object.freeze({
      get: (url: string, opts?: { headers?: Record<string, string> }) => call('GET', url, undefined, opts?.headers),
      post: (url: string, body: unknown, opts?: { headers?: Record<string, string> }) => call('POST', url, body, opts?.headers),
    });
  } else if (has(decl, 'egress:external', 'egress:public')) {
    const prefixes = targets.egress ?? [];
    const request = async (method: 'GET' | 'POST', url: string, body: unknown, headers: Record<string, string> | undefined): Promise<EgressResponse> => {
      let at = withinPrefix(url, prefixes);
      if (at === null) return refuse(`${method} ${url} is outside the declared egress prefixes ${JSON.stringify(prefixes)}`);
      let req: EgressRequest = { method, url: at, ...(headers ? { headers } : {}), ...(method === 'POST' ? { body } : {}) };
      for (let hop = 0; ; hop++) {
        const res = await need('egress')(req);
        const location = res.status >= 300 && res.status < 400 ? Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'location')?.[1] : undefined;
        if (location === undefined) return res;
        if (hop === MAX_REDIRECTS) throw new Error(`${method} ${url}: more than ${MAX_REDIRECTS} redirects`);
        let next: string;
        try { next = new URL(location, at).href; } catch { return refuse(`${method} ${url}: redirect ${hop + 1} to ${location}, which is not a URL`); }
        const checked = withinPrefix(next, prefixes);
        if (checked === null) return refuse(`${method} ${url}: redirect ${hop + 1} to ${next} is outside the declared egress prefixes ${JSON.stringify(prefixes)}`);
        // 303, and 301 or 302 after a POST, continue as a GET with no body, as fetch does; 307 and 308 keep both.
        const keep = res.status === 307 || res.status === 308;
        at = checked;
        // The body's own headers go with the body (review D4).
        const rest = headers ? Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length|encoding|language|location)$/i.test(k))) : undefined;
        req = keep ? { ...req, url: at } : { method: 'GET', url: at, ...(rest ? { headers: rest } : {}) };
      }
    };
    caps.egress = Object.freeze({
      get: (url: string, opts?: { headers?: Record<string, string> }) => request('GET', url, undefined, opts?.headers),
      post: (url: string, body: unknown, opts?: { headers?: Record<string, string> }) => request('POST', url, body, opts?.headers),
    });
  }
  if (has(decl, 'read:private')) {
    const names = targets.secrets ?? [];
    caps.secrets = Object.freeze({ get: async (name: string) => (names.includes(name) ? need('secrets')(name) : refuse(`secret ${name} is not among the declared secrets ${JSON.stringify(names)}`)) });
  }
  if (has(decl, 'exec')) {
    const commands = targets.exec ?? [];
    caps.exec = Object.freeze({ run: async (command: string, args: string[] = []) => (commands.includes(command) ? need('exec')(command, [...args]) : refuse(`command ${command} is not among the declared commands ${JSON.stringify(commands)}`)) });
  }
  if (has(decl, 'read:store', 'write:store')) {
    const tables = targets.store ?? [];
    const store: Record<string, unknown> = {};
    const check = (op: string, table: string) => (tables.includes(table) ? null : `${op} of table ${table}, which is not among the declared tables ${JSON.stringify(tables)}`);
    if (has(decl, 'read:store')) store.read = async (table: string, key: string) => { const bad = check('read', table); return bad ? refuse(bad) : need('store').read(table, key); };
    if (has(decl, 'write:store')) store.write = async (table: string, key: string, value: unknown) => { const bad = check('write', table); return bad ? refuse(bad) : need('store').write(table, key, value); };
    caps.store = Object.freeze(store);
  }
  // PS17.4a (S459): a handler reads the bodies of its own intent's payload and of nothing else. Any other digest is
  // refused before the store is read, and audited; an erased body is refused content-missing; a read is recorded.
  if (content && content.digests.length) {
    const allowed = new Set(content.digests);
    caps.content = Object.freeze({
      read: async (d: string): Promise<string> => {
        if (typeof d !== 'string' || !allowed.has(d)) return refuse(`content.read of ${String(d)}, which is not a Content of the intent's own payload`);
        const b = await content.body(d);
        if (b === null) throw new ContentMissing(`content-missing: the body of ${d} was erased (PS17.7)`);
        await content.recorded(d);
        return b;
      },
    });
  }
  return Object.freeze(caps);
}
