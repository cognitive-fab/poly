// The engine: the four verbs over the polyman kernel (v0.2).
//
//   declare  compile → triple → admission (harden + check + examples) → store (servable or not)
//   merge    propose canonical actions / a patch / end for a session → allow | deny + witnesses
//   recall   the active obligations for a scope, with machine states and coverage grades
//   journal  the windows; verify and replay arrive with the evidence layer (step 4)
//
// One Gate per scope serves the composite of the scope's servable policies.
// Everything stochastic stays outside this class. Nothing in here calls a model.
import { compilePolicy, PolicyError, enforcementOf, gradeWords } from './core/policy.mjs';
import { admitPolicy } from './admission.mjs';
import { scopeMatches, scopePathValid } from './core/scope.mjs';
import { normalizeProposal } from './core/action.mjs';
import { Store } from './store/store.mjs';
import { digest } from './core/canon.mjs';
import { compileToTriple } from './compile/index.mjs';
import { Gate } from './runtime/gate.mjs';
import { checkReplacement } from './runtime/compat.mjs';
import { loadKey, signSession, verifySession, replaySession } from './runtime/evidence.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe as depsProbe } from './runtime/deps.mjs';

export class EngineError extends Error {
  constructor(m, code = 'engine') { super(m); this.name = 'EngineError'; this.code = code; }
}

export class Polyaxion {
  /**
   * @param {object} opts
   * @param {Store|string} [opts.store]     a Store or a path (':memory:' default)
   * @param {string} [opts.defaultScope]    scope for sessions that begin implicitly
   * @param {string} [opts.compiledDir]     where scope composites are written (default: a temp dir)
   * @param {number} [opts.historyWindow]
   * @param {object} [opts.catalogue]       { labelFor(tool) } from polysec's label catalogue
   * @param {boolean} [opts.allowUnknownTools]
   * @param {string[]} [opts.openScopes]     scope patterns that may run with no policy in scope (04 §2.2); every other empty scope refuses
   * @param {string} [opts.stateDir]        where the notary key lives (default: beside the store, or the compiled dir for :memory:)
   */
  constructor(opts = {}) {
    this.store = opts.store instanceof Store ? opts.store : new Store(opts.store ?? ':memory:');
    this.defaultScope = opts.defaultScope ?? 'default';
    this.historyWindow = opts.historyWindow ?? 500;
    this.version = opts.version ?? '0.2.0';
    this.compiledDir = opts.compiledDir ?? mkdtempSync(join(tmpdir(), 'polyaxion-compiled-'));
    this.catalogue = opts.catalogue ?? null;
    this.allowUnknownTools = !!opts.allowUnknownTools;
    this.openScopes = Array.isArray(opts.openScopes) ? opts.openScopes.map(String) : [];
    this.stateDir = opts.stateDir ?? (this.store.path === ':memory:' ? this.compiledDir : join(this.store.path, '..'));
    this._key = null;
    this.log = opts.log ?? (() => {});
    this._admitted = new Map(); // id -> stored row
    this._policies = new Map(); // id -> compiled (servable only)
    this._gates = new Map(); // scope -> Gate (keyed by policy set)
    this._sessionScope = new Map(); // session -> scope
    this.broken = [];
    this.policyFailures = opts.policyFailures ?? [];
    for (const p of this.store.listPolicies()) {
      this._admitted.set(p.id, p);
      if (!p.servable) continue;
      try { this._policies.set(p.id, compilePolicy(p.doc)); } catch (e) {
        this.broken.push({ id: p.id, error: e.message });
        process.stderr.write(`[polyaxion] stored policy '${p.id}' failed to recompile and is NOT served: ${e.message}\n`);
      }
    }
    // session scopes are resolved lazily from the row on first touch (07 §4): never list every session at construction
  }

  // ----------------------------------------------------------------- declare
  async declare(args) {
    const doc = args?.policy;
    if (!doc) throw new EngineError('declare needs {policy}', 'bad-request');
    let compiled;
    try { compiled = compilePolicy(doc); } catch (e) {
      if (e instanceof PolicyError) throw new EngineError(e.message, 'policy-invalid');
      throw e;
    }
    const existing = this._admitted.get(compiled.doc.id);
    if (existing && existing.hash === compiled.hash && existing.servable) {
      return { id: compiled.doc.id, hash: compiled.hash, tripleDigest: existing.policy_digest, verdictDigest: existing.verdict_digest, servable: true, coverage: existing.coverage, obligations: compiled.compiled.length, replaced: false, unchanged: true, findings: [] };
    }
    if (existing && args.replace === false) throw new EngineError(`policy '${compiled.doc.id}' already declared (hash ${existing.hash}); pass replace: true`, 'exists');
    const admission = await admitPolicy(doc, { maxStates: args.maxStates, historyWindow: this.historyWindow });
    const summary = { id: compiled.doc.id, hash: compiled.hash, tripleDigest: admission.tripleDigest, verdictDigest: admission.verdictDigest, servable: admission.servable, engines: admission.engines, coverage: admission.coverage, obligations: compiled.compiled.length, examples: admission.examples ? { checked: admission.examples.checked, failures: admission.examples.failures } : null, harden: admission.harden, check: admission.check ? { ok: admission.check.ok, statesExplored: admission.check.statesExplored, capHit: admission.check.capHit, violations: admission.check.violations.length } : null, findings: admission.findings, refused: admission.refused, bound: admission.bound };
    if (!admission.servable && !args.force) {
      const errs = admission.findings.filter((f) => f.level === 'error').map((f) => (f.obligation ? f.obligation + ': ' : '') + f.message).join('; ');
      const e = new EngineError(`policy refused at admission: ${errs || admission.refused?.message || 'not servable'}`, 'admission-refused');
      e.admission = summary;
      throw e;
    }
    // replacing a servable policy under live sessions: polyvers lanes over the scope composites (03 §10); breaking is refused unless migrate
    let compat = null;
    if (existing && existing.servable && admission.servable) {
      compat = await this.#compat(compiled.doc, existing);
      const bad = compat.filter((c) => c.verdict === 'breaking' || c.verdict === 'unavailable');
      summary.compat = compat;
      if (bad.length && !args.migrate && !args.force) {
        const e = new EngineError(`policy replacement refused: ${bad.map((c) => `scope '${c.scope}' (${c.sessions} live session${c.sessions === 1 ? '' : 's'}): ${c.verdict}${c.error ? ' — ' + c.error : ''}${c.failed?.length ? ' — ' + c.failed.map((g) => `${g}: ${c.gates[g].failures[0]}`).join('; ') : ''}`).join('; ')}. Pass migrate: true to store it anyway and migrate the live sessions.`, 'compat-refused');
        e.admission = summary; e.compat = compat;
        throw e;
      }
    }
    if (args.dryRun) return { ...summary, replaced: !!existing, dryRun: true };
    const triple = admission.refused ? null : admission.native ? admission.native.triple : compileToTriple(doc).triple;
    const row = { module: triple?.module ?? null, contract: triple?.contract ?? null, security: triple?.security ?? null, policyDigest: admission.tripleDigest, verdictDigest: admission.verdictDigest, report: { harden: admission.harden, check: admission.check, examples: admission.examples, findings: admission.findings, bound: admission.bound }, coverage: admission.coverage, servable: admission.servable };
    this.store.transaction(() => {
      this.store.putPolicy(compiled.doc.id, compiled.hash, compiled.doc, row);
      this.store.append('_policy', 0, 'declare', { policy: compiled.doc, hash: compiled.hash, previous: existing ? existing.hash : null, tripleDigest: admission.tripleDigest, verdictDigest: admission.verdictDigest, servable: admission.servable, forced: !admission.servable, findings: admission.findings, compat });
    });
    this._admitted.set(compiled.doc.id, this.store.getPolicy(compiled.doc.id));
    if (admission.servable) this._policies.set(compiled.doc.id, compiled); else this._policies.delete(compiled.doc.id);
    this._gates.clear();
    return { ...summary, replaced: !!existing, forced: !admission.servable, compat };
  }

  /** Every scope with live sessions the replaced policy touches: the old and new composites and the sessions' Σ. */
  async #compat(newDoc, existing) {
    const CAP = 5000;
    const rows = this.store.activeSessions(CAP + 1);
    const capped = rows.length > CAP;
    const live = rows.slice(0, CAP).filter((s) => !s.session_id.includes('@@'));
    const byScope = new Map();
    for (const s of live) {
      if (!scopeMatches(existing.doc.scope, s.scope) && !scopeMatches(newDoc.scope, s.scope)) continue;
      if (!byScope.has(s.scope)) byScope.set(s.scope, []);
      byScope.get(s.scope).push({ session_id: s.session_id, state: this.store.getSession(s.session_id, 1)?.state ?? {} });
    }
    const out = [];
    for (const [scope, sessions] of byScope) {
      const docsFor = (rows) => rows.filter((p) => p.servable && scopeMatches(p.doc.scope, scope)).map((p) => ({ ...p.doc, obligations: p.doc.obligations.filter((o) => scopeMatches(o.scope ?? p.doc.scope, scope)) })).filter((d) => d.obligations.length);
      const rows = [...this._admitted.values()].filter((p) => this._policies.has(p.id));
      const before = docsFor(rows);
      const after = docsFor(rows.filter((p) => p.id !== existing.id).concat([{ id: newDoc.id, servable: true, doc: newDoc }]));
      out.push(await checkReplacement({ scope, before, after, sessions }));
    }
    if (capped) out.push({ scope: '*', verdict: 'unavailable', lanes: [], notes: [`more than ${CAP} active sessions: not every live session was assessed, so the replacement is refused rather than assumed compatible (doctrine 24); end or archive sessions, or pass --migrate`] });
    return out;
  }

  undeclare(id) {
    const prev = this._admitted.get(id);
    if (!prev) throw new EngineError(`no policy '${id}'`, 'not-found');
    this.store.transaction(() => {
      this.store.deactivatePolicy(id);
      this.store.append('_policy', 0, 'undeclare', { id, hash: prev.hash });
    });
    this._policies.delete(id); this._admitted.delete(id); this._gates.clear();
    return { id, hash: prev.hash };
  }

  policies() {
    return [...this._admitted.values()].map((p) => ({ id: p.id, hash: p.hash, version: p.doc.version, scope: p.doc.scope, obligations: p.doc.obligations.length, enforced: p.doc.obligations.filter((o) => o.kind !== 'recalled').length, servable: p.servable, tripleDigest: p.policy_digest, verdictDigest: p.verdict_digest, coverage: p.coverage, enforcement: enforcementOf(p.coverage), obligationsByGrade: Object.fromEntries((p.coverage ?? []).map((c) => [c.id, gradeWords(c.grade)])) }));
  }
  policySetHash() { return digest([...this._policies.values()].map((p) => p.hash).sort()); }

  // ------------------------------------------------------------------ gates
  async #gate(scope) {
    if (!scopePathValid(scope)) throw new EngineError(`invalid scope path '${scope}'`, 'bad-request');
    const key = scope + '|' + this.policySetHash();
    let g = this._gates.get(key);
    if (!g) {
      const rows = [...this._admitted.values()].filter((p) => p.servable && this._policies.has(p.id) && scopeMatches(p.doc.scope, scope));
      // scope-level selectors on obligations narrow further: keep only obligations whose selector matches
      const policies = rows.map((p) => ({ ...p, doc: { ...p.doc, obligations: p.doc.obligations.filter((o) => scopeMatches(o.scope ?? p.doc.scope, scope)) } })).filter((p) => p.doc.obligations.length);
      const failClosed = !policies.length && (this.policyFailures ?? []).length ? (this.policyFailures ?? []).map((f) => `${f.file}: ${f.error}`).join('; ') : null;
      const open = this.openScopes.some((m) => scopeMatches(m, scope));
      g = await Gate.open({ scope, policies, store: this.store, dir: this.compiledDir, historyWindow: this.historyWindow, catalogue: this.catalogue, allowUnknown: this.allowUnknownTools, log: this.log, failClosed, open });
      this._gates.set(key, g);
    }
    return g;
  }
  async #gateFor(runId, scope) {
    let s = this._sessionScope.get(runId);
    const known = s !== undefined || (s = this.store.sessionScope(runId)) !== null; // a session's scope is its row's, read once
    if (!known) s = scope ?? this.defaultScope;
    const g = await this.#gate(s);
    if (!this._sessionScope.has(runId)) {
      this._sessionScope.set(runId, s);
      if (known) return g;
      const meta = g.begin(runId);
      this.store.appendWindow(runId, { session: runId, ts: Date.now(), pre: {}, action: [], data: { tool: 'polyaxion:begin', args: {} }, post: meta.state, decision: 'settle', note: 'begin', scope: g.scope, policy_set: g.policySet, policies: g.policies.map((p) => ({ id: p.id, triple: p.policy_digest, verdict: p.verdict_digest })) });
    }
    return g;
  }

  // ------------------------------------------------------------------- verbs
  async begin(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('begin needs {run_id}', 'bad-request');
    const attached = this._sessionScope.has(runId);
    const g = await this.#gateFor(runId, args.scope);
    const meta = g.begin(runId, { reactivate: !!args.reactivate });
    return { run_id: runId, scope: g.scope, status: meta.status, step: meta.step, attached, obligations: g.obligations.length, policy_set: g.policySet };
  }

  /** @param {object} args {run_id, scope?, action?|actions?, patch?, end?, meta?} */
  async merge(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('merge needs {run_id}', 'bad-request');
    let proposal;
    try { proposal = normalizeProposal(args); } catch (e) { throw new EngineError(e.message, 'bad-request'); }
    const g = await this.#gateFor(runId, args.scope);
    if (args.tool && this.catalogue) {
      const row = this.catalogue.labelFor(args.tool);
      if (row) proposal.actions = proposal.actions.map((a) => ({ ...a, effects: a.effects ?? row.effects ?? null, reversibility: a.reversibility ?? row.reversibility ?? null, sensitive: a.sensitive ?? row.sensitive ?? null, untrusted: a.untrusted ?? row.untrusted ?? (Array.isArray(row.effects) && row.effects.includes('read:store') ? true : null) }));
    }
    let approved = null;
    if (args.approved !== undefined && args.approved !== null) {
      const a = args.approved;
      if (typeof a !== 'object' || typeof a.by !== 'string' || !a.by || typeof a.ref !== 'string' || !a.ref) throw new EngineError('approved must be { by, ref }: who lifted the escalation and the host\'s reference for the call', 'bad-request');
      approved = { by: a.by.slice(0, 64), ref: a.ref.slice(0, 128) };
    }
    const v = await g.propose(runId, { actions: proposal.actions, patch: proposal.patch ?? undefined, end: !!args.end, meta: proposal.meta, approved });
    if (v.reason === 'no-procedure:polyaxion:session-ended') throw new EngineError(`run '${runId}' is ended`, 'run-ended');
    return v;
  }

  /** Was the call with this host reference escalated in this session (02 §2.6)? */
  async escalated(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('escalated needs {run_id, ref}', 'bad-request');
    const g = await this.#gateFor(runId, args.scope);
    return { run_id: runId, ref: args.ref ?? null, escalated: g.escalated(runId, args.ref) };
  }

  /** Settle observed effects after the tool ran. */
  async settle(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('settle needs {run_id}', 'bad-request');
    const g = await this.#gateFor(runId, args.scope);
    const actions = (args.actions ?? (args.action ? [args.action] : [])).map((a) => normalizeProposal({ action: a }).actions[0]);
    if (!actions.length) return { settled: false };
    return g.settle(runId, actions[actions.length - 1], args.observed ?? { effects: args.effects ?? [] });
  }

  /** Journal-only record. Never changes Σ. */
  async observe(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('observe needs {run_id}', 'bad-request');
    const g = await this.#gateFor(runId, args.scope);
    const meta = g.begin(runId);
    const kind = String(args.kind ?? 'observe');
    if (!/^[a-z][a-z0-9.-]{0,40}$/.test(kind)) throw new EngineError('bad observation kind', 'bad-request');
    const seq = this.store.appendWindow(runId, { session: runId, ts: Date.now(), pre: meta.state, action: [], data: { tool: `polyaxion:${kind}`, args: args.body ?? {} }, post: meta.state, decision: 'settle', note: kind });
    return { seq, step: meta.step };
  }

  async endCheck(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('endCheck needs {run_id}', 'bad-request');
    const g = await this.#gateFor(runId, args.scope);
    const c = g.endCheck(runId);
    const meta = g.begin(runId);
    const seq = this.store.appendWindow(runId, { session: runId, ts: Date.now(), pre: meta.state, action: ['END'], data: { tool: 'polyaxion:end-check', args: {} }, post: meta.state, decision: c.ok ? 'allow' : 'reject', reason: c.ok ? undefined : c.witnesses[0]?.detail ? `wrong-state:${c.witnesses[0].obligation}:${c.witnesses[0].detail}` : 'wrong-state', note: 'end-check (dry run, no commit)' });
    return { ...c, seq };
  }

  async end(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('end needs {run_id}', 'bad-request');
    const g = await this.#gateFor(runId, args.scope);
    const meta = g.begin(runId);
    if (meta.status !== 'active') return { run_id: runId, status: meta.status, already: true };
    const v = await g.propose(runId, { actions: [{ kind: 'run.end', target: 'end' }] });
    let out;
    if (v.decision === 'deny' && args.force) {
      g.sessions.update(runId, (row) => { row.status = 'ended'; });
      this.store.appendWindow(runId, { session: runId, ts: Date.now(), pre: meta.state, action: ['END'], data: { tool: 'polyaxion:end-forced', args: {} }, post: meta.state, decision: 'settle', discharge: g.discharge(runId), note: 'end forced with undischarged obligations: ' + v.witnesses.map((w) => w.obligation).join(', ') });
      out = { run_id: runId, status: 'ended', forced: true, verdict: v };
    } else out = { run_id: runId, status: v.decision === 'allow' ? 'ended' : 'active', verdict: v };
    if (out.status === 'ended' && args.sign !== false) { try { out.receipts = (await this.sign({ run_id: runId })).count; } catch (e) { out.receipts = null; out.signError = String(e && e.message); } }
    return out;
  }

  async recall(args = {}) {
    let scope = args.scope; let session = null;
    if (args.run_id && this._sessionScope.has(String(args.run_id))) { session = String(args.run_id); scope = this._sessionScope.get(session); }
    scope = scope ?? this.defaultScope;
    const g = await this.#gate(scope);
    const r = g.recall(session);
    const include = args.include ?? 'all';
    r.obligations = r.obligations.filter((o) => include === 'all' || (include === 'enforced' ? o.enforced : !o.enforced));
    r.count = r.obligations.length; r.run_id = session;
    r.text = renderRecall(r);
    if (session && args.journal !== false) {
      const meta = g.begin(session);
      this.store.appendWindow(session, { session, ts: Date.now(), pre: meta.state, action: [], data: { tool: 'polyaxion:recall', args: { count: r.count, policy_set: r.policy_set } }, post: meta.state, decision: 'settle', note: 'recall' });
    }
    return r;
  }

  /**
   * The misfire census (doctrine 8, diagnosis as a product surface): over one
   * session or every session, which obligation refused what, in which felicity
   * class, how often — and how many refusals were lifted, escalated, or our own
   * unavailability. Read from the journal, never from a summary.
   * @param {object} args { run_id?, scope?, since?, limit? }
   */
  census(args = {}) {
    const runId = args.run_id ? String(args.run_id) : null;
    const rows = this.store.readWindows({ session_id: runId ?? undefined, since: args.since, limit: args.limit ?? 100_000 });
    const ids = new Set();
    for (const p of this._admitted.values()) for (const o of p.doc.obligations) ids.add(`${p.id}::${o.id}`);
    const byMisfire = { 'no-procedure': 0, 'wrong-participant': 0, 'bad-execution': 0, 'wrong-state': 0 };
    const byObligation = {}; const byDecision = { allow: 0, reject: 0, settle: 0 };
    let escalated = 0, lifted = 0, unavailable = 0, settleSkipped = 0, unclassified = 0, decisions = 0;
    const sessions = new Set();
    for (const w of rows) {
      if (w.session) sessions.add(w.session);
      if (w.decision in byDecision) byDecision[w.decision]++;
      if (w.decision === 'allow' && w.data?.args?.approved) lifted++;
      if (w.decision !== 'reject') continue;
      decisions++;
      const reason = String(w.reason ?? '');
      if (w.class === 'unavailable' || reason.startsWith('unavailable:')) { unavailable++; continue; }
      if (reason.startsWith('settle-skipped:')) { settleSkipped++; continue; }
      const i = reason.indexOf(':'); const head = i > 0 ? reason.slice(0, i) : reason;
      if (Object.hasOwn(byMisfire, head)) byMisfire[head]++; else { unclassified++; continue; }
      const rest = reason.slice(i + 1);
      const ob = [...ids].sort((a, b) => b.length - a.length).find((id) => rest === id || rest.startsWith(id + ':')) ?? (w.policy ? `${w.policy}::${rest.split(':')[0]}` : rest.split(':')[0]);
      const detail = ob && rest.length > ob.length ? rest.slice(ob.length + 1) : null;
      if (detail === 'escalate') escalated++;
      const e = byObligation[ob] ?? (byObligation[ob] = { refusals: 0, escalated: 0, byMisfire: {}, details: {} });
      e.refusals++; if (detail === 'escalate') e.escalated++;
      e.byMisfire[head] = (e.byMisfire[head] ?? 0) + 1;
      if (detail) e.details[detail] = (e.details[detail] ?? 0) + 1;
    }
    const top = Object.entries(byObligation).sort((a, b) => b[1].refusals - a[1].refusals).map(([id, e]) => ({ obligation: id, ...e }));
    return { run_id: runId, sessions: sessions.size, windows: rows.length, decisions: byDecision, refusals: decisions, byMisfire, unavailable, settleSkipped, escalated, lifted, unclassified, byObligation: top, text: renderCensus({ refusals: decisions, byMisfire, unavailable, settleSkipped, escalated, lifted, unclassified, byObligation: top, sessions: sessions.size }) };
  }

  journal(args = {}) {
    const entries = this.store.readWindows({ session_id: args.run_id, since: args.since, limit: args.limit });
    const filtered = args.decision ? entries.filter((e) => e.decision === args.decision) : entries;
    return { entries: filtered, count: filtered.length, next_since: entries.length ? entries[entries.length - 1].seq : (args.since ?? 0) };
  }

  // -------------------------------------------------------------- evidence
  async key() { if (!this._key) this._key = await loadKey(this.stateDir); return this._key; }
  #verdictOf(g) { return digest(g.policies.map((p) => p.verdict_digest).sort()); }

  /** Sign a session's windows into notary receipts (whole chain). Off the decision path. */
  async sign(args) {
    const runId = String(args?.run_id ?? '');
    if (!runId) throw new EngineError('sign needs {run_id}', 'bad-request');
    const g = await this.#gateFor(runId, args.scope);
    const key = await this.key();
    return signSession({ store: this.store, session: runId, key, policy: g.tripleDigest ?? 'sha256:none', verdict: this.#verdictOf(g) });
  }

  /** The four checks over a session's receipts (signature, chain, binding) plus polyaxion's replay of the kernel windows. */
  async verifyChain(runId) {
    const g = await this.#gateFor(String(runId));
    const key = await this.key();
    const v = await verifySession({ store: this.store, session: String(runId), publicKey: key.publicKey, policy: g.tripleDigest ?? 'sha256:none', verdict: this.#verdictOf(g), plan: g.plan, labeler: g.labeler, scope: g.scope, natives: g.natives });
    // what the bound verdicts say was model-checked, in the recall block's words (03 §7)
    v.policies = g.policies.map((p) => ({ id: p.id, verdict: p.verdict_digest, enforcement: enforcementOf(p.coverage), obligations: Object.fromEntries((p.coverage ?? []).map((c) => [c.id, gradeWords(c.grade)])) }));
    v.enforcement = v.policies.some((p) => p.enforcement === 'runtime-only') ? 'runtime-only' : v.policies.some((p) => p.enforcement) ? 'model-checked' : null;
    return v;
  }

  /** Re-derive every kernel decision of a session from its windows. */
  async replay(runId) {
    const g = await this.#gateFor(String(runId));
    const windows = this.store.readAllWindows(String(runId));
    return replaySession({ windows, plan: g.plan, labeler: g.labeler, scope: g.scope, natives: g.natives });
  }

  status() {
    const evidence = [...this._gates.values()].map((g) => (g.kernel && g.kernel.__evidence ? g.kernel.__evidence() : null)).filter(Boolean).reduce((a, e) => ({ degraded: a.degraded + e.degraded, spilled: a.spilled + e.spilled, dropped: a.dropped + e.dropped }), { degraded: 0, spilled: 0, dropped: 0 });
    return { version: this.version, store: this.store.path, deps: depsProbe(), policies: this.policies(), broken: this.broken, policy_set: this.policySetHash(), gates: [...this._gates.keys()], sessions: this.store.listSessions(20), windows: this.store.windowCount(), receipts: this.store.receiptCount(), evidence, key: this._key ? this._key.keyId : null };
  }

  close() { this.store.close(); }
}

/** One screen: what the gate refused, grouped by obligation and felicity class. */
export function renderCensus(c) {
  const L = [`polyaxion census: ${c.refusals} refusal${c.refusals === 1 ? '' : 's'} over ${c.sessions} session${c.sessions === 1 ? '' : 's'}` + (c.escalated ? `, ${c.escalated} escalated` : '') + (c.lifted ? `, ${c.lifted} lifted by a human` : '') + (c.unavailable ? `, ${c.unavailable} unavailable (ours, not policy)` : '') + (c.settleSkipped ? `, ${c.settleSkipped} settle-skipped` : '')];
  const mis = Object.entries(c.byMisfire).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
  if (mis) L.push(`  by misfire class: ${mis}${c.unclassified ? ` unclassified=${c.unclassified}` : ''}`);
  for (const o of c.byObligation) L.push(`  ${o.obligation}: ${o.refusals}${o.escalated ? ` (${o.escalated} escalated)` : ''}${Object.keys(o.details).length ? ` — ${Object.entries(o.details).map(([d, n]) => `${d}×${n}`).join(', ')}` : ''}`);
  if (!c.byObligation.length) L.push('  (no policy refusals)');
  return L.join('\n');
}

/** The text that re-enters a context window on recall. Never summarized: regenerated fresh every time. */
export function renderRecall(r) {
  const L = [];
  L.push(`# Active obligations (polyaxion · scope ${r.scope}${r.step !== null && r.step !== undefined ? ` · step ${r.step}` : ''})`);
  L.push('These are enforced by a deterministic gate outside this conversation. Enforced items are checked before any effect executes; a violating action is denied with a witness. Runtime-only items are enforced but were not model-checked. Recalled items are not mechanically checkable — comply with them yourself.');
  const checked = r.obligations.filter((o) => o.enforced && o.coverage === 'checked');
  const runtime = r.obligations.filter((o) => o.enforced && o.coverage !== 'checked');
  const recalled = r.obligations.filter((o) => !o.enforced);
  const line = (o) => {
    let s = `- [${o.id}] ${o.text}`;
    if (o.machine) s += ` (state: ${o.machine.state}${o.machine.discharge ? `; must end in ${o.machine.discharge.join('/')}` : ''})`;
    if (o.severity === 'warn') s += ' (warn only)';
    return s + (o.hint ? `\n  hint: ${o.hint}` : '');
  };
  if (checked.length) { L.push('', '## Enforced (model-checked)'); for (const o of checked) L.push(line(o)); }
  if (runtime.length) { L.push('', '## Enforced (runtime-only)'); for (const o of runtime) L.push(line(o)); }
  if (recalled.length) { L.push('', '## Recalled (not mechanically enforced)'); for (const o of recalled) L.push(`- [${o.id}] ${o.text}`); }
  if (!r.obligations.length) L.push('(none declared for this scope)');
  return L.join('\n');
}
