// A Gate serves one scope: the composite of the scope's servable policies,
// compiled to a triple on disk, loaded by polyman's loader and driven by the
// polyman kernel (two-phase mediation, availability semantics) with
// polyaxion's labeler, SQLite session store and journal behind the seams.
//
//   Gate.open(...)              compile composite → write triple → createPolyman
//   gate.propose(session, …)    canonical actions (+ patch, end) → Decision → verdict with witnesses
//   gate.settle(session, …)     observed effects → settle
//   gate.endCheck(session)      would END be accepted now? (no commit)
//   gate.recall(session)        obligations + machine states + coverage
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { compilePolicy } from '../core/policy.mjs';
import { buildPlan } from '../compile/plan.mjs';
import { emitTriple } from '../compile/emit.mjs';
import { writeTriple } from '../compile/index.mjs';
import { digest } from '../core/canon.mjs';
import { makeLabeler, HISTORY, RUN, ACTIONS_TOOL } from './labeler.mjs';
import { SqliteSessionStore, SqliteJournal } from './stores.mjs';
import { buildWitness, warnings as warnRules, parseReason } from './witness.mjs';
import { renderVerdict } from '../core/witness.mjs';
import { stepPlan } from '../core/step.mjs';
import { openNative, nativeWitness } from './native.mjs';
import { dischargeOf } from '../compile/discharge.mjs';
import { polyman as loadPolyman } from './deps.mjs';

export const polyman = () => loadPolyman();

export const SEP = '::';
export const DEFAULT_HISTORY_WINDOW = 500;

/** One composite authoring document for a scope's servable policies. */
export function compositeDoc(scope, docs) {
  const vars = {};
  const obligations = [];
  for (const d of docs) {
    for (const [name, spec] of Object.entries(d.vars ?? {})) {
      if (vars[name] && JSON.stringify(vars[name]) !== JSON.stringify(spec)) throw new Error(`policies '${d.id}' and another in scope '${scope}' declare var '${name}' with different domains`);
      vars[name] = spec;
    }
    for (const o of d.obligations) { if (o.kind === 'native') continue; obligations.push({ ...o, id: `${d.id}${SEP}${o.id}`, source: { ...(o.source ?? {}), policy: d.id, obligation: o.id } }); }
  }
  return { polyaxion: '2', id: `scope/${scope.replace(/[^A-Za-z0-9._:/-]/g, '-')}`, scope: '**', vars, obligations };
}

export class Gate {
  /**
   * @param {object} o { scope, policies: [admitted rows], store, dir, historyWindow, catalogue, knownTools, log }
   */
  static async open(o) {
    const g = new Gate();
    g.scope = o.scope; g.store = o.store; g.log = o.log ?? (() => {}); g.failClosed = o.failClosed ?? null; g.open = !!o.open;
    g.policies = o.policies;
    g.policySet = digest(o.policies.map((p) => p.policy_digest ?? p.hash).sort());
    g.historyWindow = o.historyWindow ?? DEFAULT_HISTORY_WINDOW;
    const docs = o.policies.map((p) => p.doc);
    g.doc = compositeDoc(o.scope, docs);
    g.dir = join(o.dir, o.scope.replace(/[^A-Za-z0-9._-]/g, '_'), g.policySet.slice(7, 23));
    mkdirSync(g.dir, { recursive: true });
    const w = g.doc.obligations.length ? writeTriple(g.doc, g.dir) : null;
    g.plan = w ? annotate(w.plan) : emptyPlan(o.scope);
    g.tripleDigest = w ? w.tripleDigest : null;
    const pm = await polyman();
    // native obligations: one kernel each, consulted before the composite (04 §2.1, doctrine 29)
    g.natives = [];
    for (const p of o.policies) for (const ob of p.doc.obligations) if (ob.kind === 'native') g.natives.push(await openNative(pm, { policy: p.id, obligation: ob, dir: join(g.dir, 'native', p.id.replace(/[^A-Za-z0-9._-]/g, '_')), store: o.store, scope: o.scope, policySet: g.policySet }));
    g.obligations = g.plan.obligations.concat(g.natives.map((n) => ({ id: n.id, policy: n.policy, short: n.short, kind: 'native', text: n.text, severity: 'deny', hint: n.hint, tags: [], coverage: 'checked' })));
    g.labeler = makeLabeler(g.plan, { catalogue: o.catalogue ?? null, knownTools: o.knownTools, allowUnknown: o.allowUnknown });
    if (w) {
      g.engine = pm.loadEngine(w.files.module);
      g.sessions = new SqliteSessionStore(o.store, { scope: o.scope, init: () => g.engine.init(), policySet: g.policySet, historyWindow: g.historyWindow });
      g.kernel = await pm.createPolyman({ engine: g.engine, security: w.files.security, labeler: g.labeler, store: g.sessions, journal: new SqliteJournal(o.store, { discharge: (post) => dischargeOf(g.plan, post), witness: (e) => g.witnessOf(e) }) });
    } else {
      g.engine = null; g.sessions = new SqliteSessionStore(o.store, { scope: o.scope, init: () => ({}), policySet: g.policySet }); g.kernel = null;
    }
    return g;
  }

  /** Begin (idempotent); `reactivate` reopens an ended session (a resumed host session keeps its id). */
  begin(session, { reactivate = false } = {}) {
    this.sessions.get(session);
    let meta = this.sessions.meta(session);
    if (meta.migrated) { const from = meta.migrated; this.sessions.update(session, (row) => { delete row.migrated; }); this.store.appendWindow(session, { session, ts: Date.now(), pre: {}, action: [], data: { tool: 'polyaxion:policy-change', args: { from, to: this.policySet } }, post: meta.state, decision: 'settle', note: 'policy set changed: Σ migrated (shared keys carried, new keys initial)' }); }
    if (reactivate && meta.status === 'ended') { meta = this.sessions.update(session, (row) => { row.status = 'active'; }); this.store.appendWindow(session, { session, ts: Date.now(), pre: meta.state, action: [], data: { tool: 'polyaxion:resume', args: {} }, post: meta.state, decision: 'settle', note: 'resumed an ended session' }); }
    return meta;
  }

  #callFor(session, actions, extra = {}) {
    const meta = this.sessions.meta(session);
    const args = { actions, ...extra };
    Object.defineProperty(args, HISTORY, { value: meta.history, enumerable: false });
    Object.defineProperty(args, RUN, { value: { id: session, scope: this.scope, step: meta.step + 1 }, enumerable: false });
    return { tool: ACTIONS_TOOL, args };
  }

  /**
   * @param {string} session
   * @param {object} p { actions: canonical[], patch?, end?: boolean, meta? }
   */
  async propose(session, p) {
    const meta = this.begin(session);
    if (meta.status !== 'active') return this.#verdict(session, { ok: false, reason: `no-procedure:polyaxion:session-ended`, actions: [], post: meta.state }, p, meta);
    if (p.approved && !this.escalated(session, p.approved.ref)) {
      // an approval lifts a recorded escalation and nothing else (02 §2.6): a ref this session never escalated is refused before any obligation is consulted
      const reason = 'wrong-participant:polyaxion:approval-unmatched';
      const d = { ok: false, reason, actions: [], post: meta.state };
      const witness = this.#witness(session, d, p.actions ?? [], null, meta, null);
      this.store.appendWindow(session, { session, ts: Date.now(), pre: meta.state, action: (p.actions ?? []).map(() => 'PROPOSE'), data: { tool: ACTIONS_TOOL, args: { actions: p.actions ?? [], approved: p.approved, ...(p.meta && p.meta.tool_use_id ? { meta: { tool_use_id: p.meta.tool_use_id, tool: p.meta.tool ?? null } } : {}) } }, post: meta.state, decision: 'reject', reason, witness, note: `approved.ref '${p.approved.ref}' names no escalation of this session` });
      return this.#verdict(session, d, p, meta, null, witness);
    }
    if (!this.kernel && this.failClosed) {
      const reason = 'unavailable:policy: ' + this.failClosed;
      this.store.appendWindow(session, { session, ts: Date.now(), pre: {}, action: [], data: { tool: ACTIONS_TOOL, args: { actions: p.actions ?? [] } }, post: {}, decision: 'reject', reason, class: 'unavailable', note: 'configured policies missing or refused — refusing rather than serving nothing' });
      return this.#verdict(session, { ok: false, reason, class: 'unavailable', actions: [], post: {} }, p, meta);
    }
    // native kernels first: they may over-record taint for a call the composite then refuses, never under-record progress
    const nat = await this.#consultNatives(session, p.actions ?? []);
    if (nat) return this.#nativeVerdict(session, nat, p, meta);
    if (!this.kernel && !this.natives.length && !this.open) {
      // no policy at all in this scope and nobody opened it: refuse (04 §2.2, doctrine 3)
      const reason = 'no-procedure:polyaxion:no-policy-in-scope';
      const d = { ok: false, reason, actions: [], post: meta.state };
      const witness = this.#witness(session, d, p.actions ?? [], null, meta, null);
      this.store.appendWindow(session, { session, ts: Date.now(), pre: {}, action: (p.actions ?? []).map(() => 'PROPOSE'), data: { tool: ACTIONS_TOOL, args: { actions: p.actions ?? [] } }, post: {}, decision: 'reject', reason, witness, note: `no policy in scope '${this.scope}' and the scope is not open` });
      return this.#verdict(session, d, p, meta, null, witness);
    }
    if (!this.kernel) { // natives only, or an open scope: allow, journal, advance
      this.sessions.update(session, (row) => { row.step += 1; for (const a of p.actions ?? []) row.history = row.history.concat([{ step: row.step, action: a, verdict: 'allow', violated: [] }]).slice(-this.historyWindow); if (p.end) row.status = 'ended'; });
      this.store.appendWindow(session, { session, ts: Date.now(), pre: {}, action: (p.actions ?? []).map(() => 'PROPOSE'), data: { tool: ACTIONS_TOOL, args: { actions: p.actions ?? [] } }, post: {}, decision: 'allow', note: this.natives.length ? 'no PX obligation in scope; native obligations consulted' : 'open scope: no policy in scope' });
      return this.#verdict(session, { ok: true, actions: [], post: {} }, p, this.sessions.meta(session));
    }
    const pre = { ...meta.state };
    const call = this.#callFor(session, p.actions ?? [], { ...(p.patch ? { patch: p.patch } : {}), ...(p.end ? { end: true } : {}), ...(p.meta && p.meta.tool_use_id ? { meta: { tool_use_id: p.meta.tool_use_id, tool: p.meta.tool ?? null } } : {}), ...(p.approved ? { approved: p.approved } : {}) });
    const d = await this.kernel.gate(session, call);
    if (d.ok) {
      this.sessions.update(session, (row) => {
        row.step += 1;
        for (const a of p.actions ?? []) row.history = row.history.concat([{ step: row.step, action: a, verdict: 'allow', violated: [] }]).slice(-this.historyWindow);
        row.trail = trail(this.plan, row.trail ?? {}, pre, d.post, row.step, p.actions ?? []);
        if (p.end || (p.actions ?? []).some((a) => a.kind === 'run.end')) row.status = 'ended';
      });
    }
    return this.#verdict(session, d, p, this.sessions.meta(session), pre);
  }

  async settle(session, canonical, observed) {
    let settled = false;
    for (const nk of this.natives) {
      if (!canonical?.tool || !nk.kernel.mediates(canonical.tool)) continue;
      await nk.kernel.settle(session, { tool: canonical.tool, args: { kind: canonical.kind, target: canonical.target ?? null } }, observed);
      settled = true;
    }
    if (!this.kernel) return { settled };
    const args = { actions: [canonical], observed };
    await this.kernel.settle(session, { tool: ACTIONS_TOOL, args }, observed);
    return { settled: true };
  }

  /** Consult every native kernel for every action whose host tool it labels; the first refusal is the refusal. */
  async #consultNatives(session, actions) {
    for (const nk of this.natives) {
      for (const a of actions) {
        if (!a || !a.tool || a.kind === 'run.end' || !nk.kernel.mediates(a.tool)) continue;
        const d = await nk.kernel.gate(session, { tool: a.tool, args: { kind: a.kind, target: a.target ?? null } });
        if (!d.ok) return { nk, d, action: a };
      }
    }
    return null;
  }

  #nativeVerdict(session, { nk, d, action }, p, meta) {
    const w = nativeWitness(nk, d, action);
    const verdict = {
      decision: 'deny', step: meta.step, run_id: session, scope: this.scope,
      reason: d.reason, misfire: w.misfire, class: d.class ?? null, record: d.record ?? null,
      checked: this.obligations.filter((o) => o.kind !== 'recalled').length,
      witnesses: [w], warnings: [],
      state_before: digest(meta.state), state_after: digest(meta.state),
      policies: this.policies.map((x) => x.policy_digest ?? x.hash), policy_set: this.policySet, triple: this.tripleDigest,
      native: { policy: nk.policy, state: d.post ?? null },
    };
    verdict.explanation = renderVerdict(verdict);
    return verdict;
  }

  /** Dry-run END against the current Σ: no commit, no kernel call, journaled by the caller. */
  endCheck(session) {
    const meta = this.begin(session);
    if (meta.status !== 'active') return { ok: true, ended: true, witnesses: [] };
    if (!this.kernel) return { ok: true, ended: false, witnesses: [] };
    const r = stepPlan(this.plan, meta.state, 'END', { reason: 'end', history: meta.history, run: { id: session, scope: this.scope, step: meta.step + 1 } });
    if (!r.reject) return { ok: true, ended: false, witnesses: [] };
    const w = buildWitness(this.plan, { ok: false, reason: r.reject, actions: [], post: meta.state }, { model: meta.state, action: { kind: 'run.end' }, history: meta.history, trail: (meta.trail ?? {})[parseReason(r.reject, this.#ids()).obligation] ?? [] });
    return { ok: false, ended: false, witnesses: [w], explanation: renderVerdict({ decision: 'deny', step: meta.step + 1, witnesses: [w], warnings: [] }) };
  }

  recall(session) {
    const meta = session ? this.begin(session) : null;
    const items = [];
    for (const ob of this.obligations) {
      if (ob.kind === 'native') continue; // listed below with its machine state
      const item = { id: ob.short, policy: ob.policy, kind: ob.kind, severity: ob.severity, enforced: ob.kind !== 'recalled', coverage: ob.coverage, text: ob.text };
      if (ob.hint) item.hint = ob.hint;
      if (ob.kind === 'machine') {
        const m = this.plan.machines.find((x) => x.id === ob.id);
        item.machine = { state: meta ? meta.state[m.key] : m.initial, discharge: m.discharge, vars: Object.fromEntries(Object.entries(m.vars).map(([k, s]) => [k, meta ? meta.state[s.key] : s.initial])) };
      }
      items.push(item);
    }
    for (const nk of this.natives) items.push({ id: nk.short, policy: nk.policy, kind: 'native', severity: 'deny', enforced: true, coverage: 'checked', text: nk.text, ...(nk.hint ? { hint: nk.hint } : {}), native: { tools: nk.tools, regions: nk.regions, state: session ? nk.state(session) : nk.engine.init() } });
    return { scope: this.scope, session: session ?? null, step: meta ? meta.step : null, policy_set: this.policySet, triple: this.tripleDigest, count: items.length, obligations: items };
  }

  /** m4: per machine with discharge states, where the session stands. */
  discharge(session) { return dischargeOf(this.plan, this.sessions.meta(session).state); }

  #ids() { return this.obligations.map((o) => o.id); }

  /** The witness for a refusal: which action was refused (replaying the pre-actions from `pre`), with the obligation's expression, bindings, sequence and machine path. */
  #witness(session, d, actions, pre, meta, approved) {
    const history = meta.history;
    const run = { id: session, scope: this.scope, step: meta.step };
    let refused = actions[actions.length - 1] ?? null; let model = pre ?? meta.state;
    if (this.plan && pre) {
      for (const a of actions) {
        const act = a.kind === 'run.end' ? 'END' : this.labeler.pre({ tool: ACTIONS_TOOL, args: { actions: [a] } })[0].action;
        const r = stepPlan(this.plan, model, act, { action: a, reason: 'end', history, run, approved: approved ?? null });
        if (r.reject) { refused = a; break; }
        model = { ...model, ...r.next };
      }
    }
    return buildWitness(this.plan, d, { model, action: refused, history, run, trail: (meta.trail ?? {})[parseReason(d.reason, this.#ids()).obligation] ?? [] });
  }

  /** The witness the journal seam stores in a reject window (05 §3): computed at append time, bounded, never a reason to fail the append. */
  witnessOf(e) {
    if (e.decision !== 'reject' || !this.plan) return null;
    try {
      const meta = this.sessions.meta(e.session);
      const w = this.#witness(e.session, { ok: false, reason: e.reason, class: e.class ?? null, post: e.post }, e.data?.args?.actions ?? [], e.pre ?? null, meta, e.data?.args?.approved ?? null);
      return bounded(w);
    } catch { return null; }
  }

  #verdict(session, d, p, meta, pre = null, witness = null) {
    const step = meta.step;
    const lastAction = (p.actions ?? [])[(p.actions ?? []).length - 1] ?? null;
    const history = meta.history;
    const run = { id: session, scope: this.scope, step };
    let witnesses = []; let warnings = [];
    if (!d.ok) {
      witnesses = [witness ?? this.#witness(session, d, p.actions ?? [], pre, meta, p.approved ?? null)];
    } else if (this.plan && lastAction) {
      warnings = warnRules(this.plan, meta.state, lastAction, history, run);
    }
    const escalated = !d.ok && parseReason(d.reason, this.#ids()).detail === 'escalate';
    const verdict = {
      decision: d.ok ? 'allow' : escalated ? 'escalate' : 'deny', step, run_id: session, scope: this.scope,
      reason: d.ok ? null : d.reason, misfire: d.ok ? null : parseReason(d.reason, this.#ids()).misfire, class: d.class ?? null, record: d.record ?? null,
      checked: this.obligations.filter((o) => o.kind !== 'recalled').length,
      witnesses, warnings,
      state_before: pre ? digest(pre) : null, state_after: digest(d.post ?? meta.state),
      policies: this.policies.map((x) => x.policy_digest ?? x.hash), policy_set: this.policySet, triple: this.tripleDigest,
      ...(p.approved ? { approved: p.approved } : {}),
    };
    verdict.explanation = renderVerdict(verdict);
    return verdict;
  }

  /** Was a call escalated in this session? Read from the journal (works for a fresh process too): the reject window whose meta names the host's reference. */
  escalated(session, ref) {
    if (!ref) return false;
    const rows = this.store.readWindows({ session_id: session, limit: 10_000 });
    return rows.some((w) => w.decision === 'reject' && /:escalate$/.test(String(w.reason ?? '')) && w.data?.args?.meta?.tool_use_id === ref);
  }
}

/** A witness bounded for the record: the last fifty sequence entries and path steps. */
function bounded(w) {
  if (!w) return null;
  const out = { ...w };
  if (Array.isArray(out.sequence) && out.sequence.length > 50) out.sequence = out.sequence.slice(-50);
  if (out.machine && Array.isArray(out.machine.path) && out.machine.path.length > 50) out.machine = { ...out.machine, path: out.machine.path.slice(-50) };
  return out;
}

/** Annotate composite obligations with their policy and short id. */
function annotate(plan) {
  plan.obligations = plan.obligations.map((o) => { const i = o.id.indexOf(SEP); return { ...o, policy: i >= 0 ? o.id.slice(0, i) : null, short: i >= 0 ? o.id.slice(i + SEP.length) : o.id }; });
  return plan;
}
function emptyPlan(scope) {
  return { polyaxion: '2', policy: { id: `scope/${scope}`, scope, authoringDigest: null }, keys: [], vars: {}, varSpecs: {}, machines: [], rules: [], invariants: [], recalled: [], obligations: [], actions: [], gates: [], regions: [], rejections: [], endedKey: null, samples: [], coverage: [], findings: [] };
}
/** Record machine transitions (from → to) per machine so a witness can show how it got here. */
function trail(plan, prev, pre, post, step, actions) {
  const out = { ...prev };
  const a = actions[actions.length - 1] ?? null;
  for (const m of plan.machines) {
    if (pre[m.key] !== post[m.key]) out[m.id] = (out[m.id] ?? []).concat([{ step, action: a ? { kind: a.kind, target: a.target ?? null } : null, from: pre[m.key], to: post[m.key] }]).slice(-32);
  }
  return out;
}

export { compilePolicy, buildPlan, emitTriple };
