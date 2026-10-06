// The gate process and its clients.
//
// One process owns a store and answers every participant over loopback HTTP:
// Claude Code hooks (type "http" — no process spawn per tool call), MCP server
// processes of other sessions, and the CLI. Ownership is decided by binding
// the port: the first process to bind is the owner and opens the store; any
// later process that finds a live polyaxion on that port for the same store
// becomes a client. When the owner exits, the next participant that fails to
// reach it binds the port and takes over — the store file is the only durable
// truth, so handover is safe.
//
// Trust boundary (v1): the local machine user. The listener binds 127.0.0.1
// only. Mutating administrative verbs (declare/undeclare) require the token
// written to <state dir>/token (mode 0600); verdict and recall calls do not,
// because Claude Code's http hooks cannot read a secret file.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Polyaxion, EngineError } from './engine.mjs';
import { catalogue } from './runtime/catalogue.mjs';
import { handleHook } from './mounts/claude-code/hook.mjs';

export const DEFAULT_HOST = '127.0.0.1';

export function portForProject(projectDir) {
  let h = 0;
  for (const c of String(projectDir).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 47000 + (h % 1000);
}

export function readToken(stateDir) {
  const p = join(stateDir, 'token');
  try { return readFileSync(p, 'utf8').trim(); } catch { return null; }
}
function ensureToken(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const p = join(stateDir, 'token');
  if (!existsSync(p)) writeFileSync(p, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(p, 'utf8').trim();
}

/**
 * Try to become the owner. Resolves to { role: 'owner', server, engine, url }
 * or { role: 'client', client, url } or throws.
 */
export async function attach(cfg, log = () => {}) {
  const port = cfg.port; const host = cfg.host ?? DEFAULT_HOST;
  const url = `http://${host}:${port}`;
  const stateDir = cfg.stateDir;
  // 1. is someone already serving this store?
  const health = await probe(url);
  if (health && health.store === cfg.storePath) {
    log(`attached as client of ${url} (pid ${health.pid})`);
    return { role: 'client', client: new GateClient(url, readToken(stateDir)), url };
  }
  if (health) throw new Error(`port ${port} is served by a polyaxion for a different store (${health.store}); set a different port`);
  // 2. become the owner
  const engine = new Polyaxion({ store: cfg.storePath, defaultScope: cfg.scope, version: cfg.version, compiledDir: join(stateDir, 'compiled'), stateDir, catalogue: await catalogue(), log, openScopes: cfg.open_scopes });
  const token = ensureToken(stateDir);
  // per-session hook tokens (spec 06 §1.6): minted at SessionStart, held in memory only, never journaled
  const sessionTokens = new Map();
  const server = createServer((req, res) => route(req, res, { engine, token, cfg, log, sessionTokens }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  }).catch(async (e) => {
    if (e.code === 'EADDRINUSE') {
      const h2 = await probe(url);
      if (h2 && h2.store === cfg.storePath) { engine.close(); return null; }
      throw new Error(`port ${port} is in use by another program; choose --port`);
    }
    throw e;
  }).then((r) => r);
  if (!server.listening) {
    log(`attached as client of ${url} (lost the bind race)`);
    return { role: 'client', client: new GateClient(url, readToken(stateDir)), url };
  }
  server.unref?.();
  log(`owner: serving ${cfg.storePath} on ${url} (pid ${process.pid})`);
  return { role: 'owner', server, engine, url, client: null };
}

export async function probe(url, timeoutMs = 400) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url + '/health', { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.polyaxion ? j : null;
  } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ADMIN = new Set(['declare', 'undeclare', 'token']);
const bearer = (req) => { const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? ''); return m ? m[1].trim() : null; };

async function route(req, res, ctx) {
  const { engine, token, cfg, log, sessionTokens } = ctx;
  const tokenMode = cfg.hook_token ?? 'require';
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/health') return send(200, { polyaxion: true, ok: true, store: engine.store.path, pid: process.pid, version: engine.version, scope: cfg.scope, policies: engine.policies().length, hook_token: tokenMode });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    const raw = await readBody(req);
    let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'invalid JSON' }); }

    // Claude Code hooks: /hooks/<EventName>
    const hm = /^\/hooks\/([A-Za-z]+)$/.exec(u.pathname);
    if (hm) {
      if (tokenMode !== 'off') {
        // a hook call is bound to the session it claims; a missing or foreign token is an integrity failure on our path, never a policy deny (04 §6)
        const sid = String(body.session_id ?? '');
        const expected = sessionTokens.get(sid);
        if (!expected || bearer(req) !== expected) {
          log(`hook ${hm[1]} refused: ${expected ? 'token does not belong to session' : 'no token minted for session'} '${sid}'`);
          if (hm[1] === 'PreToolUse') return send(200, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `polyaxion: unavailable:token — this hook call carries no valid token for session '${sid}'. The gate cannot bind the call to a session, so it refuses the effect rather than guessing. Reinstall the mount (polyaxion install) or set hook_token: "off" in .polyaxion/config.json for a host without CLAUDE_ENV_FILE.` } });
          return send(200, {});
        }
      }
      const t0 = process.hrtime.bigint();
      const out = await handleHook(engine, hm[1], body, { cwd: body.cwd, scope: cfg.scope, config: cfg, effectsOf: engine.catalogue ? (t) => engine.catalogue.labelFor(t)?.effects ?? null : null });
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      log(`hook ${hm[1]} ${body.tool_name ?? body.source ?? ''} → ${out?.hookSpecificOutput?.permissionDecision ?? out?.decision ?? 'pass'} (${us.toFixed(0)} µs)`);
      return send(200, out ?? {});
    }
    const vm = /^\/v1\/([a-zA-Z]+)$/.exec(u.pathname);
    if (!vm) return send(404, { error: 'not found' });
    const verb = vm[1];
    if (ADMIN.has(verb)) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) return send(401, { error: 'admin verb requires the store token (see <state dir>/token)' });
    }
    if (verb === 'token') {
      const sid = String(body.session_id ?? '');
      if (!sid) return send(400, { error: 'token needs {session_id}' });
      const t = randomBytes(24).toString('hex');
      sessionTokens.set(sid, t);
      return send(200, { session_id: sid, token: t, mode: tokenMode });
    }
    if (typeof engine[verb] !== 'function' || verb.startsWith('_') || verb === 'close' || verb === 'constructor') return send(404, { error: `unknown verb '${verb}'` });
    const result = await (verb === 'verifyChain' || verb === 'replay' ? engine[verb](body.run_id) : verb === 'undeclare' ? engine.undeclare(body.id) : engine[verb](body));
    if (verb === 'key') return send(404, { error: 'unknown verb' });
    return send(200, result ?? {});
  } catch (e) {
    if (e instanceof EngineError) return send(e.code === 'bad-request' || e.code === 'policy-invalid' || e.code === 'admission-refused' ? 400 : e.code === 'not-found' ? 404 : 409, { error: e.message, code: e.code });
    log(`error: ${e.stack || e}`);
    return send(500, { error: String(e.message || e) });
  }
}

/** Client of a running gate: same interface as the engine, async. */
export class GateClient {
  constructor(url, token = null) { this.url = url; this.token = token; }
  async #call(verb, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const r = await fetch(`${this.url}/v1/${verb}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new EngineError(j.error ?? `HTTP ${r.status}`, j.code ?? 'remote'); throw e; }
    return j;
  }
  declare(a) { return this.#call('declare', a); }
  undeclare(id) { return this.#call('undeclare', { id }); }
  begin(a) { return this.#call('begin', a); }
  merge(a) { return this.#call('merge', a); }
  recall(a) { return this.#call('recall', a); }
  journal(a) { return this.#call('journal', a); }
  census(a) { return this.#call('census', a); }
  observe(a) { return this.#call('observe', a); }
  endCheck(a) { return this.#call('endCheck', a); }
  escalated(a) { return this.#call('escalated', a); }
  end(a) { return this.#call('end', a); }
  policies() { return this.#call('policies', {}); }
  status() { return this.#call('status', {}); }
  verifyChain(runId) { return this.#call('verifyChain', { run_id: runId }); }
  replay(runId) { return this.#call('replay', { run_id: runId }); }
  sign(a) { return this.#call('sign', a); }
  /** Mint the per-session hook token (admin: needs the store token). */
  token(a) { return this.#call('token', a); }
  async hook(event, payload, sessionToken = null) {
    const headers = { 'content-type': 'application/json' };
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
    const r = await fetch(`${this.url}/hooks/${event}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    return r.json();
  }
  close() {}
}

/** Resolve project configuration: .polyaxion/config.json + env + defaults. */
export function loadConfig(projectDir, overrides = {}) {
  const stateDir = join(projectDir, '.polyaxion');
  let file = {};
  try { file = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')); } catch { /* none */ }
  const env = process.env;
  const cfg = {
    projectDir,
    stateDir,
    scope: overrides.scope ?? env.POLYAXION_SCOPE ?? file.scope ?? scopeFromDir(projectDir),
    storePath: overrides.store ?? env.POLYAXION_STORE ?? file.store ?? join(stateDir, 'polyaxion.sqlite'),
    port: Number(overrides.port ?? env.POLYAXION_PORT ?? file.port ?? portForProject(projectDir)),
    host: DEFAULT_HOST,
    policies: overrides.policies ?? file.policies ?? ['polyaxion.policy.json'],
    recall_on_prompt: file.recall_on_prompt ?? true,
    recall_on_compact: file.recall_on_compact ?? true,
    enforce_end_on_stop: file.enforce_end_on_stop ?? true,
    allow_passthrough: file.allow_passthrough ?? true,
    hook_token: overrides.hook_token ?? env.POLYAXION_HOOK_TOKEN_MODE ?? file.hook_token ?? 'require',
    open_scopes: Array.isArray(file.open_scopes) ? file.open_scopes.map(String) : [],
    version: overrides.version ?? '0.1.0',
  };
  if (!cfg.storePath.startsWith(':')) cfg.storePath = cfg.storePath.replace(/\\/g, '/');
  return cfg;
}

export function scopeFromDir(dir) {
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project';
  return base.replace(/[^A-Za-z0-9._:@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'project';
}

/** Load every policy file named in the config into the engine; missing files are skipped with a note. */
export async function declareConfiguredPolicies(engine, cfg, log = () => {}) {
  const out = [];
  for (const rel of cfg.policies) {
    const p = join(cfg.projectDir, rel);
    if (!existsSync(p)) { log(`policy file not found: ${rel} (skipped)`); continue; }
    try {
      const doc = JSON.parse(readFileSync(p, 'utf8'));
      const r = await engine.declare({ policy: doc });
      out.push({ file: rel, ...r });
      log(`declared ${r.id} (${r.obligations} obligations, ${r.hash.slice(0, 19)}…)${r.unchanged ? ' unchanged' : ''}${r.servable ? ' servable' : ' NOT SERVABLE'}${r.verdictDigest ? ' verdict ' + r.verdictDigest.slice(0, 19) + '…' : ''}`);
      for (const f of r.findings ?? []) if (f.level !== 'info') log(`  ${f.level}: ${f.obligation ? f.obligation + ': ' : ''}${f.message}`);
    } catch (e) { log(`policy ${rel} REFUSED: ${e.message}`); out.push({ file: rel, error: e.message }); }
  }
  engine.policyFailures = out.filter((r) => r.error || r.servable === false).map((r) => ({ file: r.file, error: r.error ?? 'not servable' })).concat(cfg.policies.filter((rel) => !existsSync(join(cfg.projectDir, rel))).map((rel) => ({ file: rel, error: 'file not found' })));
  return out;
}

export { dirname };
