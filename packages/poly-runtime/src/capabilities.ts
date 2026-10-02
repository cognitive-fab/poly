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

/** The manifest entry's labels and targets, as the lowering wrote them (PT6.1, S151). */
export interface CapabilityDecl { labels?: string[]; targets?: Record<string, string[]> }

/** Redirects followed before a request is given up; each hop is checked against the prefixes. */
export const MAX_REDIRECTS = 5;

const has = (decl: CapabilityDecl, ...labels: string[]) => labels.some((l) => decl.labels?.includes(l));

/**
 * S151: the normalised URL when it lies under one of the prefixes, else null. Both are parsed by the WHATWG URL
 * parser, which lowercases the host, drops a default port and resolves `.`, `..` and their encoded forms. The scheme
 * and host (with port) must be equal, and the path must equal the prefix's or continue it past a `/`, so
 * `/v1/charges` does not admit `/v1/charges-evil`. A URL with a user or password is refused outright.
 */
export function withinPrefix(url: string, prefixes: readonly string[]): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return null;
  for (const p of prefixes) {
    const q = new URL(p);
    if (q.protocol !== u.protocol || q.host !== u.host) continue;
    const base = q.pathname;
    if (u.pathname === base || u.pathname.startsWith(base.endsWith('/') ? base : `${base}/`)) return u.href;
  }
  return null;
}

/**
 * The frozen capability object for one effect kind, for one call of its handler. `audit` writes the PL6406 row; it
 * is awaited before the refusal is thrown, so a refusal is in the ledger whatever the handler does with the error.
 */
export function capabilitiesFor(decl: CapabilityDecl, transports: Transports, audit: (reason: string) => Promise<void>): Readonly<Record<string, unknown>> {
  const targets = decl.targets ?? {};
  const refuse = async (reason: string): Promise<never> => { await audit(reason); throw new CapabilityRefused(`PL6406 CAPABILITY_REFUSED: ${reason}`); };
  const need = <K extends keyof Transports>(k: K): NonNullable<Transports[K]> => {
    const t = transports[k];
    if (!t) throw new Error(`no ${k} transport was given at load, so the ${k} capability cannot act (S151)`);
    return t as NonNullable<Transports[K]>;
  };
  const caps: Record<string, unknown> = {};
  if (has(decl, 'egress:external', 'egress:public')) {
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
        req = keep ? { ...req, url: at } : { method: 'GET', url: at, ...(headers ? { headers } : {}) };
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
  return Object.freeze(caps);
}
