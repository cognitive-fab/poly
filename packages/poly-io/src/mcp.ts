// The MCP client over Streamable HTTP, from the MCP specification 2025-11-25 (packages/poly-io/PROVENANCE.md). The
// handlers of a desk's effects call a remote server's tools through the access point of a gateway surface, which injects
// the server's key itself. poly holds no credential and sends none: a configuration that carries one is refused when the
// client is made (PT10g, PL6825). One client is one configured access point and the tools it was configured with, as the
// webhook adapter is one endpoint; a caller never names a URL. A call is one attempt: nothing here retries, because the
// effect's single attempt is spent when the request is sent.
import { createHash } from 'node:crypto';
import type { HttpTransport } from '@poly/runtime/adapters';
import { httpsTransport } from './net.js';

/** The revision this client asks for in initialize: the latest it speaks. The revision of 2026-07-28 drops initialize and sessions. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
/**
 * The revisions this client speaks. A server that answers one of them is talked to in it (lifecycle, version negotiation):
 * the Lab's Hello server answered 2024-11-05 through the owner's gateway (live probe, 2026-11-02, PROVENANCE.md).
 */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const OWN_HEADERS = new Set(['content-type', 'accept', 'accept-encoding', 'mcp-session-id', 'mcp-protocol-version']);

export interface McpConfig {
  /** The access point of the gateway surface (https). */
  url: string;
  /** The tools this client may call; any other is refused before a request is sent. */
  tools: string[];
  /** The transport; the https transport of this package when not given (a test gives a recorded one). */
  transport?: HttpTransport;
  /** Headers other than a credential, such as a trace header. */
  headers?: Record<string, string>;
  clientInfo?: { name: string; version: string };
}

export interface McpTool { name: string; description?: string; inputSchema?: unknown }

/** What a call came to. `answered` is false when no answer arrived (a transport error or a 5xx): the attempt is spent. */
export type McpOutcome =
  | { ok: true; text: string; digest: string; structured?: unknown }
  | { ok: false; permanent: boolean; answered: boolean; error: string; status?: number; text?: string; digest?: string };

export interface McpClient {
  readonly url: string;
  readonly sessionId: string | null;
  /** The negotiated revision; null before initialize and after one that fails. */
  readonly protocolVersion: string | null;
  initialize(): Promise<{ ok: true; serverInfo?: unknown } | { ok: false; permanent: boolean; error: string; status?: number }>;
  listTools(): Promise<{ ok: true; tools: McpTool[] } | { ok: false; permanent: boolean; error: string; status?: number }>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpOutcome>;
}

// Token shapes, as poly-check's PL6825 reads them (packages/poly-check/src/secrets.ts). poly-io imports no check package
// (S182), so the list is repeated here; a test keeps the two in step.
export const TOKEN_SHAPES: RegExp[] = [
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/,
  /\bxox[abpr]-[0-9A-Za-z-]{10,}/,
  /\bya29\.[0-9A-Za-z_-]{20,}/,
  /\bgh[pousr]_[0-9A-Za-z]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // An HTTP credential, PL6825's eighth shape (the owner's ruling of 2026-11-02, PT10g).
  /\b(?:Bearer|bearer|BEARER|Basic|basic|BASIC)[ \t]+(?![A-Za-z][a-z]*(?![A-Za-z0-9\-._~+/=]))[A-Za-z0-9\-._~+/]{12,}=*/,
];
// Any name that says it carries a credential, not a list of known ones: a short value has no shape to find.
const CREDENTIAL_NAME = /auth|token|secret|passw|api[-_]?key|cookie|credential|bearer|^key$/i;
// A value that starts with an HTTP authentication scheme carries a credential whatever its header is called (review of
// 2026-11-02, item 1): the IANA registry's schemes and four in common use outside it. poly-io's own shape, broader than
// the HTTP credential PL6825 reads, since a configuration value has a start and a file's text does not (PROVENANCE.md).
const AUTH_SCHEME = /^\s*(?:Basic|Bearer|Concealed|Digest|DPoP|GNAP|HOBA|Mutual|Negotiate|OAuth|PrivateToken|SCRAM-SHA-1|SCRAM-SHA-256|vapid|ApiKey|AWS4-HMAC-SHA256|NTLM|Token)\s+\S/i;

/** The parts of the URL as a reader of it decodes them; a malformed escape is refused, since nobody can say what it holds. */
function decodedParts(u: URL, raw: string): string[] {
  const decode = (raw: string, where: string): string => {
    try { return decodeURIComponent(raw); } catch { throw new Error(`mcp: the access point URL has a malformed percent-encoding in ${where}`); }
  };
  // The host as written, not u.hostname: the parser lowercases it, and the token shapes are case-sensitive (AKIA). A second
  // review of 2026-11-02 found %41KIA... in the host accepted that way.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/^(\[[^\]]*\]|[^:]*).*$/, '$1');
  const parts = [decode(host, 'its host')];
  for (const s of u.pathname.split('/')) parts.push(decode(s, 'its path'));
  for (const pair of u.search.replace(/^\?/, '').split('&')) {
    const i = pair.indexOf('=');
    for (const raw of i < 0 ? [pair] : [pair.slice(0, i), pair.slice(i + 1)]) {
      // A form decoder reads + as a space, so both readings are checked.
      parts.push(decode(raw, 'its query'), decode(raw.replace(/\+/g, ' '), 'its query'));
    }
  }
  parts.push(decode(u.hash.replace(/^#/, ''), 'its fragment'));
  return parts.filter((p) => p !== '');
}

function refuseCredentials(c: McpConfig): void {
  for (const name of Object.keys(c.headers ?? {})) {
    if (CREDENTIAL_NAME.test(name)) throw new Error(`mcp: the configuration carries a ${name} header; the gateway injects the key, and poly sends none`);
  }
  // A parser drops spaces and controls at the ends and removes tabs and line ends inside, so the URL it reads would not be
  // the one checked below (third review of 2026-11-02: a leading space hid an encoded AKIA in the host).
  if (/[\u0000-\u0020\u007f]/.test(c.url)) throw new Error('mcp: the access point URL holds whitespace or a control character');
  let u: URL;
  try { u = new URL(c.url); } catch { throw new Error('mcp: the access point is not a URL'); }
  // A credential is refused by its name first, then a user or password, then the scheme (review of 2026-11-02, item 1).
  for (const k of u.searchParams.keys()) if (CREDENTIAL_NAME.test(k)) throw new Error(`mcp: the access point URL carries a ${k} parameter; poly sends no credential`);
  if (u.username || u.password) throw new Error('mcp: the access point URL carries a user or password; poly sends no credential');
  if (u.protocol !== 'https:') throw new Error(`mcp: the access point is ${u.protocol}, and a call goes over https`);
  const parts = decodedParts(u, c.url);
  const headerValues = Object.values(c.headers ?? {});
  const values = [c.url, ...parts, ...headerValues, ...c.tools, ...Object.values(c.clientInfo ?? {})];
  if (values.some((v) => TOKEN_SHAPES.some((re) => re.test(v)))) throw new Error('mcp: the configuration holds a token-shaped value; poly holds no key');
  // clientInfo is sent in the initialize body, so it is checked as a header value is (the owner's ruling 1, 2026-11-02).
  if ([...headerValues, ...parts, ...Object.values(c.clientInfo ?? {})].some((v) => AUTH_SCHEME.test(v))) throw new Error('mcp: the configuration holds a value that starts with an authentication scheme; poly holds no key');
}

export const digestOf = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

interface Rpc { jsonrpc?: string; id?: number | string | null; result?: any; error?: { code: number; message: string } }

/** The JSON-RPC message with this id in an answer: a JSON body, or the events of a single SSE stream. */
function messageOf(contentType: string, body: string, id: number): Rpc | null {
  if (/text\/event-stream/i.test(contentType)) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { const m = JSON.parse(data) as Rpc; if (m.id === id) return m; } catch { /* the priming event and a broken one carry no answer */ }
    }
    return null;
  }
  try { const m = JSON.parse(body) as Rpc; return m.id === id ? m : null; } catch { return null; }
}

export function mcpClient(c: McpConfig): McpClient {
  if (!Array.isArray(c.tools) || c.tools.length === 0 || c.tools.some((t) => typeof t !== 'string' || t === '')) throw new Error('mcp: the configuration names no tools');
  refuseCredentials(c);
  // Review: what was checked is what is used. The caller's object is copied, so changing it afterwards moves neither the
  // endpoint nor the headers, and adds no credential.
  const cfg = Object.freeze({ url: c.url, headers: Object.freeze({ ...(c.headers ?? {}) }), clientInfo: Object.freeze({ ...(c.clientInfo ?? { name: 'poly', version: '0' }) }) });
  const allowed = new Set(c.tools);
  let ready = false;
  const transport = c.transport ?? httpsTransport;
  let session: string | null = null;
  let negotiated: string | null = null;
  let next = 1;

  // The headers the client sets are its own (rule 7): a configured one of the same name, in any letter case, is dropped, so
  // initialize carries no version and a later request only the negotiated one (third review of 2026-11-02). Every request
  // asks for the body as it is (rule 6): the Lab's server labels plain answers gzip (second live probe, 2026-11-02).
  const base = (): Record<string, string> => ({
    ...Object.fromEntries(Object.entries(cfg.headers).filter(([k]) => !OWN_HEADERS.has(k.toLowerCase()))),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'accept-encoding': 'identity',
  });

  type Sent = { kind: 'answer'; status: number; rpc: Rpc } | { kind: 'ack'; status: number } | { kind: 'fault'; permanent: boolean; answered: boolean; error: string; status?: number };

  async function send(message: object, id: number | null): Promise<Sent> {
    const headers = base();
    if (session) headers['mcp-session-id'] = session;
    // The negotiated revision on every request, whichever it is (rule 4): the Lab's server refuses any other value with
    // -32022, and wants it for 2024-11-05 too, which the specification gave no header (second live probe, 2026-11-02).
    if (negotiated) headers['mcp-protocol-version'] = negotiated;
    let r;
    try { r = await transport.request({ method: 'POST', url: cfg.url, headers, body: JSON.stringify(message) }); }
    catch (e) { return { kind: 'fault', permanent: false, answered: false, error: `no answer: ${e instanceof Error ? e.message : String(e)}` }; }
    if (r.status === 401 || r.status === 403) return { kind: 'fault', permanent: true, answered: true, status: r.status, error: `the gateway refused the call: ${r.status}` };
    if (r.status >= 500) return { kind: 'fault', permanent: false, answered: false, status: r.status, error: `no answer: the gateway failed with ${r.status}` };
    if (r.status < 200 || r.status >= 300) return { kind: 'fault', permanent: true, answered: true, status: r.status, error: `the gateway answered ${r.status}` };
    if (id === null) return { kind: 'ack', status: r.status };
    const rpc = messageOf(r.headers['content-type'] ?? '', r.body, id);
    if (!rpc) return { kind: 'fault', permanent: false, answered: false, status: r.status, error: 'no answer: the reply holds no JSON-RPC response to the request' };
    return { kind: 'answer', status: r.status, rpc };
  }

  const protocolFault = (rpc: Rpc) => `the server answered an error: ${rpc.error?.code} ${rpc.error?.message}`;

  return {
    url: cfg.url,
    get sessionId() { return session; },
    get protocolVersion() { return negotiated; },
    async initialize() {
      // Review of 2026-11-02, item 2: only an initialize that succeeds leaves a session; every failure below leaves none.
      ready = false;
      session = null;
      negotiated = null;
      const id = next++;
      // Not through send(): the answer's header gives the session id, and no session or version exists yet.
      const headers = base();
      const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: cfg.clientInfo } });
      let r;
      try { r = await transport.request({ method: 'POST', url: cfg.url, headers, body }); }
      catch (e) { return { ok: false, permanent: false, error: `no answer: ${e instanceof Error ? e.message : String(e)}` }; }
      if (r.status === 401 || r.status === 403) return { ok: false, permanent: true, status: r.status, error: `the gateway refused the call: ${r.status}` };
      if (r.status < 200 || r.status >= 300) return { ok: false, permanent: r.status < 500, status: r.status, error: `the gateway answered ${r.status}` };
      const rpc = messageOf(r.headers['content-type'] ?? '', r.body, id);
      if (!rpc || rpc.error || !rpc.result) return { ok: false, permanent: true, error: rpc ? protocolFault(rpc) : 'the reply holds no initialize result' };
      const sid = r.headers['mcp-session-id'];
      // A server that answers a revision this client also speaks is talked to in it; any other is not (lifecycle, version
      // negotiation). The transport stays Streamable HTTP whatever the revision, as the live probe answered.
      const answered = rpc.result.protocolVersion;
      if (typeof answered !== 'string' || !MCP_SUPPORTED_VERSIONS.includes(answered)) {
        const named = typeof answered === 'string' ? `protocol version ${JSON.stringify(answered)}` : `no protocol version (${JSON.stringify(answered) ?? 'none'})`;
        return { ok: false, permanent: true, error: `the server speaks ${named}, and this client speaks ${MCP_SUPPORTED_VERSIONS.join(', ')}` };
      }
      negotiated = answered;
      // Set only for a server that is talked to, since the notification carries it; a refused one leaves no session id behind.
      session = sid && /^[!-~]+$/.test(sid) ? sid : null;
      const ack = await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, null);
      if (ack.kind === 'fault') { session = null; negotiated = null; return { ok: false, permanent: ack.permanent, error: ack.error, status: ack.status }; }
      ready = true;
      return { ok: true, serverInfo: rpc.result.serverInfo };
    },
    async listTools() {
      if (!ready) return { ok: false, permanent: true, error: 'the session is not initialized' };
      const id = next++;
      const s = await send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }, id);
      if (s.kind === 'fault') return { ok: false, permanent: s.permanent, error: s.error, status: s.status };
      if (s.kind !== 'answer' || s.rpc.error || !Array.isArray(s.rpc.result?.tools)) return { ok: false, permanent: true, error: s.kind === 'answer' && s.rpc.error ? protocolFault(s.rpc) : 'the reply holds no tool list' };
      return { ok: true, tools: s.rpc.result.tools as McpTool[] };
    },
    async callTool(name, args) {
      // Refused before a request is sent: the client calls the tools it was configured with and no other.
      if (!allowed.has(name)) return { ok: false, permanent: true, answered: false, error: `the tool ${name} is not configured for ${cfg.url}` };
      if (!ready) return { ok: false, permanent: true, answered: false, error: 'the session is not initialized' };
      const id = next++;
      const s = await send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, id);
      if (s.kind === 'fault') return { ok: false, permanent: s.permanent, answered: s.answered, error: s.error, status: s.status };
      if (s.kind !== 'answer') return { ok: false, permanent: true, answered: true, error: 'the reply is not an answer' };
      if (s.rpc.error) return { ok: false, permanent: true, answered: true, error: protocolFault(s.rpc) };
      if (!s.rpc.result || typeof s.rpc.result !== 'object') return { ok: false, permanent: true, answered: true, error: 'the reply holds neither a result nor an error' };
      // Review of 2026-11-02, item 3: a result with no content array is no answer, whatever isError says. Whether the tool
      // ran is not known, so the attempt is spent as for a transport error. A content of [] is a result.
      if (!Array.isArray(s.rpc.result.content)) return { ok: false, permanent: false, answered: false, status: s.status, error: 'no answer: the result holds no content' };
      const content: unknown[] = s.rpc.result.content;
      const text = content.map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).filter((t) => t !== '').join('\n');
      const digest = digestOf(text);
      // The tool's text is kept for the journal by its digest; the text itself is the caller's to keep or drop.
      if (s.rpc.result?.isError === true) return { ok: false, permanent: true, answered: true, error: 'the tool reported an error', text, digest };
      return { ok: true, text, digest, structured: s.rpc.result?.structuredContent };
    },
  };
}
