// Persistence: policies (with their admitted triple), sessions, windows, receipts, and the policy declaration log.
//
// SQLite via node:sqlite (Node ≥ 22.13, no native dependency). One process
// owns a store file at a time (WAL, busy_timeout); the daemon is that process
// and every other participant is a client of it.
//
// Journal integrity is a hash chain per run: each entry's `hash` covers its
// body and the previous entry's hash. Tampering with, reordering, or deleting
// an entry breaks the chain from that point on, and `verifyChain` says where.
// There is no UPDATE and no DELETE on px_journal anywhere in this codebase.
import { DatabaseSync } from 'node:sqlite';
import { canon, sha256 } from '../core/canon.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS px_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS px_policy (
  id          TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  doc         TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  declared_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS px_journal (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL,
  step      INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  decision  TEXT,
  at        INTEGER NOT NULL,
  body      TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS px_journal_run ON px_journal (run_id, seq);
CREATE INDEX IF NOT EXISTS px_journal_decision ON px_journal (decision, seq);
CREATE TABLE IF NOT EXISTS px_session (
  session_id TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active','ended')),
  step       INTEGER NOT NULL DEFAULT 0,
  state      TEXT NOT NULL,
  history    TEXT NOT NULL DEFAULT '[]',
  policy_set TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS px_window (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  decision   TEXT NOT NULL,
  reason     TEXT,
  body       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  spilled    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS px_window_session ON px_window (session_id, seq);
CREATE INDEX IF NOT EXISTS px_session_status ON px_session (status, updated_at);
CREATE TABLE IF NOT EXISTS px_receipt (
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  receipt    TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, seq)
);
`;

export const GENESIS = 'sha256:' + '0'.repeat(64);

export class Store {
  /** @param {string} path  file path or ':memory:' */
  constructor(path = ':memory:', opts = {}) {
    this.path = path;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.now = opts.now ?? (() => Date.now());
    this.#migrate();
    this.#prepare();
    const v = this.getMeta('schema_version');
    if (!v || Number(v) < 2) this.setMeta('schema_version', '2');
  }

  /** Additive migrations: CREATE TABLE IF NOT EXISTS never alters an existing file. */
  #migrate() {
    const cols = new Set(this.db.prepare('PRAGMA table_info(px_policy)').all().map((c) => c.name));
    const add = (name, ddl) => { if (!cols.has(name)) this.db.exec(`ALTER TABLE px_policy ADD COLUMN ${name} ${ddl}`); };
    add('module', 'TEXT'); add('contract', 'TEXT'); add('security', 'TEXT'); add('policy_digest', 'TEXT'); add('verdict_digest', 'TEXT');
    add('report', 'TEXT'); add('coverage', 'TEXT'); add('servable', 'INTEGER NOT NULL DEFAULT 0');
  }

  #prepare() {
    const d = this.db;
    this.q = {
      getMeta: d.prepare('SELECT v FROM px_meta WHERE k = ?'),
      setMeta: d.prepare('INSERT INTO px_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      policyGet: d.prepare('SELECT id, hash, doc, active, declared_at, updated_at, module, contract, security, policy_digest, verdict_digest, report, coverage, servable FROM px_policy WHERE id = ?'),
      policyAll: d.prepare('SELECT id, hash, doc, active, declared_at, updated_at, module, contract, security, policy_digest, verdict_digest, report, coverage, servable FROM px_policy WHERE active = 1 ORDER BY id'),
      policyPut: d.prepare(`INSERT INTO px_policy (id, hash, doc, active, declared_at, updated_at, module, contract, security, policy_digest, verdict_digest, report, coverage, servable) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, doc = excluded.doc, active = 1, updated_at = excluded.updated_at, module = excluded.module, contract = excluded.contract, security = excluded.security, policy_digest = excluded.policy_digest, verdict_digest = excluded.verdict_digest, report = excluded.report, coverage = excluded.coverage, servable = excluded.servable`),
      policyDeactivate: d.prepare('UPDATE px_policy SET active = 0, updated_at = ? WHERE id = ?'),
      journalLast: d.prepare('SELECT hash FROM px_journal WHERE run_id = ? ORDER BY seq DESC LIMIT 1'),
      journalAppend: d.prepare('INSERT INTO px_journal (run_id, step, kind, decision, at, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      journalByRun: d.prepare('SELECT seq, run_id, step, kind, decision, at, body, prev_hash, hash FROM px_journal WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      journalAll: d.prepare('SELECT seq, run_id, step, kind, decision, at, body, prev_hash, hash FROM px_journal WHERE seq > ? ORDER BY seq LIMIT ?'),
      journalByDecision: d.prepare('SELECT seq, run_id, step, kind, decision, at, body, prev_hash, hash FROM px_journal WHERE decision = ? AND seq > ? ORDER BY seq LIMIT ?'),
      journalCount: d.prepare('SELECT COUNT(*) AS n FROM px_journal'),
      sessionGet: d.prepare('SELECT session_id, scope, status, step, state, history, policy_set, created_at, updated_at FROM px_session WHERE session_id = ?'),
      sessionPut: d.prepare(`INSERT INTO px_session (session_id, scope, status, step, state, history, policy_set, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET scope = excluded.scope, status = excluded.status, step = excluded.step, state = excluded.state, history = excluded.history, policy_set = excluded.policy_set, updated_at = excluded.updated_at`),
      sessionList: d.prepare('SELECT session_id, scope, status, step, policy_set, created_at, updated_at FROM px_session ORDER BY updated_at DESC LIMIT ?'),
      sessionActive: d.prepare("SELECT session_id, scope, status, step, policy_set, created_at, updated_at FROM px_session WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?"),
      sessionScope: d.prepare('SELECT scope FROM px_session WHERE session_id = ?'),
      windowAppend: d.prepare('INSERT INTO px_window (session_id, decision, reason, body, at, spilled) VALUES (?, ?, ?, ?, ?, ?)'),
      windowsBySession: d.prepare('SELECT seq, session_id, decision, reason, body, at, spilled FROM px_window WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      windowsAll: d.prepare('SELECT seq, session_id, decision, reason, body, at, spilled FROM px_window WHERE seq > ? ORDER BY seq LIMIT ?'),
      windowCount: d.prepare('SELECT COUNT(*) AS n FROM px_window'),
      windowsTail: d.prepare("SELECT seq, session_id, decision, reason, body, at, spilled FROM px_window WHERE session_id = ? AND decision = 'allow' ORDER BY seq DESC LIMIT ?"),
      receiptsGet: d.prepare('SELECT receipt FROM px_receipt WHERE session_id = ? AND generation = (SELECT MAX(generation) FROM px_receipt WHERE session_id = ?) ORDER BY seq'),
      receiptGen: d.prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM px_receipt WHERE session_id = ?'),
      receiptPut: d.prepare('INSERT INTO px_receipt (session_id, generation, seq, receipt) VALUES (?, ?, ?, ?)'),
      receiptCount: d.prepare('SELECT COUNT(*) AS n FROM px_receipt'),
    };
  }

  getMeta(k) { const r = this.q.getMeta.get(k); return r ? r.v : null; }
  setMeta(k, v) { this.q.setMeta.run(k, String(v)); }

  // ------------------------------------------------------------ policies
  /** @param {object} adm  { module, contract, security, policyDigest, verdictDigest, report, coverage, servable } (all optional) */
  putPolicy(id, hash, doc, adm = {}) {
    const t = this.now();
    this.q.policyPut.run(id, hash, canon(doc), t, t, adm.module ?? null, adm.contract ?? null, adm.security ?? null, adm.policyDigest ?? null, adm.verdictDigest ?? null, adm.report ? canon(adm.report) : null, adm.coverage ? canon(adm.coverage) : null, adm.servable ? 1 : 0);
  }
  #policyRow(r) { return { ...r, doc: JSON.parse(r.doc), active: !!r.active, servable: !!r.servable, report: r.report ? JSON.parse(r.report) : null, coverage: r.coverage ? JSON.parse(r.coverage) : null }; }
  getPolicy(id) { const r = this.q.policyGet.get(id); return r ? this.#policyRow(r) : null; }
  listPolicies() { return this.q.policyAll.all().map((r) => this.#policyRow(r)); }
  deactivatePolicy(id) { this.q.policyDeactivate.run(this.now(), id); }


  // ------------------------------------------------------------- journal
  /** Append one entry; returns the stored entry with seq/hash. */
  append(runId, step, kind, body, decision = null) {
    const last = this.q.journalLast.get(runId);
    const prev = last ? last.hash : GENESIS;
    const at = this.now();
    const hash = entryHash({ run_id: runId, step, kind, decision, at, body, prev_hash: prev });
    const r = this.q.journalAppend.run(runId, step, kind, decision, at, canon(body), prev, hash);
    return { seq: Number(r.lastInsertRowid), run_id: runId, step, kind, decision, at, body, prev_hash: prev, hash };
  }
  /** Read entries; opts: {run_id, since (seq), limit, decision}. */
  read(opts = {}) {
    const since = opts.since ?? 0; const limit = Math.min(opts.limit ?? 200, 10_000);
    let rows;
    if (opts.run_id) rows = this.q.journalByRun.all(opts.run_id, since, limit);
    else if (opts.decision) rows = this.q.journalByDecision.all(opts.decision, since, limit);
    else rows = this.q.journalAll.all(since, limit);
    return rows.map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }
  count() { return this.q.journalCount.get().n; }

  /** Walk a run's chain and verify every link. */
  verifyChain(runId) {
    let prev = GENESIS; let n = 0; let since = 0;
    for (;;) {
      const rows = this.q.journalByRun.all(runId, since, 1000);
      if (!rows.length) break;
      for (const r of rows) {
        n++;
        if (r.prev_hash !== prev) return { ok: false, entries: n, broken_at: r.seq, reason: 'prev_hash mismatch' };
        const h = entryHash({ run_id: r.run_id, step: r.step, kind: r.kind, decision: r.decision, at: r.at, body: JSON.parse(r.body), prev_hash: r.prev_hash });
        if (h !== r.hash) return { ok: false, entries: n, broken_at: r.seq, reason: 'hash mismatch' };
        prev = r.hash; since = r.seq;
      }
    }
    return { ok: true, entries: n, head: prev };
  }

  // ------------------------------------------------------------ sessions (v0.2)
  /** The row holds Σ and the machine trails; the history window is rebuilt from the session's allowed kernel windows (serializing 500 actions per step is what breaks the latency budget). */
  getSession(id, historyWindow = 500) {
    const r = this.q.sessionGet.get(id);
    if (!r) return null;
    const extra = JSON.parse(r.history);
    // the newest allowed kernel windows, numbered as the live gate numbered them (r.step counts allowed proposals)
    const rows = this.q.windowsTail.all(id, historyWindow).map((x) => ({ ...x, ...JSON.parse(x.body) })).filter((w) => w.data && w.data.tool === 'polyaxion:actions').reverse();
    const history = [];
    let step = r.step - rows.length;
    for (const w of rows) { step++; for (const a of w.data.args?.actions ?? []) history.push({ step, action: a, verdict: 'allow', violated: [] }); }
    return { ...r, state: JSON.parse(r.state), history: history.slice(-historyWindow), trail: extra.trail ?? {} };
  }
  putSession(s) {
    const t = this.now();
    const existing = this.q.sessionGet.get(s.session_id);
    this.q.sessionPut.run(s.session_id, s.scope, s.status, s.step, canon(s.state), canon({ trail: s.trail ?? {} }), s.policy_set ?? null, existing ? existing.created_at : t, t);
  }
  listSessions(limit = 100) { return this.q.sessionList.all(limit); }
  /** Active sessions only, newest first, through the status index; `limit + 1` rows are asked for so a caller can tell the cap was hit. */
  activeSessions(limit = 1000) { return this.q.sessionActive.all(limit); }
  /** A session's scope without loading its state or history. */
  sessionScope(id) { return this.q.sessionScope.get(id)?.scope ?? null; }
  appendWindow(sessionId, e, spilled = false) {
    const r = this.q.windowAppend.run(sessionId, e.decision, e.reason ?? null, canon(e), this.now(), spilled ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
  readWindows(opts = {}) {
    const since = opts.since ?? 0; const limit = Math.min(opts.limit ?? 500, 10_000);
    const rows = opts.session_id ? this.q.windowsBySession.all(opts.session_id, since, limit) : this.q.windowsAll.all(since, limit);
    return rows.map((r) => ({ seq: r.seq, at: r.at, spilled: !!r.spilled, ...JSON.parse(r.body) }));
  }
  windowCount() { return this.q.windowCount.get().n; }
  /** Every window of a session, in order, however many. */
  readAllWindows(sessionId) { const out = []; let since = 0; for (;;) { const page = this.readWindows({ session_id: sessionId, since, limit: 10_000 }); if (!page.length) break; out.push(...page); since = page[page.length - 1].seq; if (page.length < 10_000) break; } return out; }
  /** Receipts are append-only: every signing writes a new generation of the session's chain; readers take the latest. Nothing is updated or deleted. */
  putReceipts(sessionId, receipts) { this.transaction(() => { const g = this.q.receiptGen.get(sessionId).g + 1; receipts.forEach((r, i) => this.q.receiptPut.run(sessionId, g, i, canon(r))); }); }
  getReceipts(sessionId) { return this.q.receiptsGet.all(sessionId, sessionId).map((r) => JSON.parse(r.receipt)); }
  receiptCount() { return this.q.receiptCount.get().n; }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  close() { this.db.close(); }
}

export function entryHash(e) {
  return 'sha256:' + sha256(canon({ run_id: e.run_id, step: e.step, kind: e.kind, decision: e.decision, at: e.at, body: e.body, prev_hash: e.prev_hash }));
}
