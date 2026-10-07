// The policy gate (PT9, S146, S147): Polyaxion, in process, behind M4's gate interface.
//
// A trust scope is a module of the program (PS8.7): an instance's scope is its machine's module, and the policies
// whose scope selector matches that module govern it. A module no policy matches is an open scope, said so at load,
// so a governed scope whose policy is missing refuses (Polyaxion's closed scopes) and an ungoverned one does not.
// Each scope has one gate session, `scope:<module>`, which this host serialises: it assigns the session sequence
// `sseq` on every proposal and every settle, durably, and records it with Polyaxion's Σ digests (S146).
//
// A proposal reaches the engine as a `custom.poly.effect` action whose reserved fields hold what the policies read
// (S147): the emitting step's snapshot for its own machine, the latest snapshot of a service machine (a singleton),
// with the `seq` read, and the run's latest decision events (PD4.3). The singletons read are returned as `reads`, so
// the worker rechecks an allow that one of them has outlived.
//
// The engine refusing, hanging, answering `unavailable` or failing to journal is an outage: the host throws, and the
// worker holds the intent (PT9.5, review C6). Nothing here ever allows on its own.
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import { actionOf, decisionOfReject } from './policy-engine.js';
import type { Gate, GateDecision, Proposal } from './worker.js';

export interface ProgramView {
  /** The latest snapshot of the one instance of a machine, or null when it has none or more than one (S147). */
  singleton(machineId: string): { instance: string; seq: number; state: Record<string, unknown> } | null;
  /** The latest `decision` event body of each decision on a run, by decision name (PD4.3). */
  decisions(run: string): Record<string, unknown>;
  /** Assigns the next session sequence of a session, durably (S146). */
  nextSseq(session: string): number;
  /** PD5.1.2d, S104: the claims of a run's step at a seq (its journal row's $claims), or null. */
  stepClaims?(run: string, seq: number): Record<string, unknown> | null;
  /** PS8.8, PS8.9: the evidence kept with a run's step (its times and mandate chain), or null. */
  stepEvidence?(run: string, seq: number): { verifiedAt?: number; statusAt?: number; mandates?: { delegate: string; delegator: string }[] } | null;
  /** PS8.8: the runtime's clock, by which the gate computes ages at the decision. */
  now?(): number;
  /** PD5.2.2c: the lineage of a run's step at a seq, as a policy reads it: its origin and intent. */
  lineage?(run: string, seq: number): { origin: Record<string, unknown> | null; intent: string } | null;
  /**
   * Review C1, PT9.5: records an engine answer that came after the host's timeout, with its sseq, on the run that
   * proposed it. The intent was held; the engine still decided, so the session's Σ moved and replay needs the event.
   */
  recordLate?(run: string, record: Record<string, unknown>): Promise<unknown> | void;
}

export interface PolicyGateOptions {
  /** Where Polyaxion keeps its sessions: a SQLite file, or memory. */
  store?: string;
  /** Where Polyaxion keeps its notary key (generated, never committed). */
  stateDir?: string;
  /** PT9.5: a proposal the engine has not answered in this time is an outage. */
  proposeTimeoutMs?: number;
  /** For the outage test only: wraps the engine's calls, to inject faults at the host's seams. */
  wrap?: (px: any) => any;
}

/**
 * PT9.5: the engine could not decide, or answered in a way the host cannot act on. With `record`, the engine did
 * answer, so the answer took a session sequence, and the worker records it as `held` (S146).
 */
export class GateUnavailable extends Error {
  constructor(message: string, readonly record?: Record<string, unknown>) { super(message); this.name = 'GateUnavailable'; }
}

const approvedOf = (p: Proposal) => (p.approved ? { approvedBy: p.approved.by } : {});

/** One recorded event of a session, for its replay (S118, S146). */
export interface SessionEvent {
  session: string;
  sseq: number;
  kind: 'propose' | 'settle';
  action: Record<string, unknown>;
  intent: string;
  approvedBy?: string;
  observed?: Record<string, unknown>;
  /** What the run recorded: the gate's decision (or `held`) and Σ before it, for a proposal. */
  gateDecision?: string;
  engineDecision?: string;
  engineClass?: string | null;
  stateBefore?: string | null;
  /** Σ after it, where recorded (review C4). */
  stateAfter?: string | null;
  /** Where it was recorded, for the report. */
  run: string;
  ledgerSeq: number;
}

export interface SessionReplay {
  session: string;
  proposals: number;
  settles: number;
  diagnostics: { code: string; message: string }[];
  notRun: string[];
}

const sessionOf = (machine: string) => `scope:${machine.slice(0, machine.lastIndexOf('.'))}`;
const moduleOf = (machine: string) => machine.slice(0, machine.lastIndexOf('.'));

export class PolicyGate implements Gate {
  private locks = new Map<string, Promise<unknown>>();
  /** Review C1: an engine call of a session that outlived the host's timeout, until it answers. */
  private inflight = new Map<string, Promise<unknown>>();
  private engine: any;

  private constructor(private readonly pxPackage: any, engine: any, private readonly view: ProgramView, private readonly reads: Map<string, string[]>, private readonly opts: PolicyGateOptions, private readonly attributed: Set<string> = new Set(), private readonly ageRules: Set<string> = new Set()) {
    this.engine = engine;
  }

  /** PS8.8, as ruled: a denial by a rule over a claim's age is reported as stale-claims. */
  private staleReason(reason: string | null): string | null {
    const id = reason?.split('::').pop();
    return id && this.ageRules.has(id) ? 'stale-claims' : reason;
  }

  /**
   * Declares each scope's certified document (refusing one Polyaxion does not serve) and opens the modules no policy
   * governs. `modules` are the program's modules; `policies` the certificate's.
   */
  static async open(pxPackage: any, policies: { scope: string; doc: Record<string, unknown>; reads: string[] }[], modules: string[], view: ProgramView, opts: PolicyGateOptions = {}): Promise<PolicyGate> {
    const core = pxPackage.core;
    const open = modules.filter((m) => !policies.some((p) => core.scopeMatches(p.scope, m)));
    const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'poly-gate-'));
    const raw = new pxPackage.Polyaxion({ store: opts.store ?? ':memory:', openScopes: open, stateDir, compiledDir: join(stateDir, 'compiled') });
    const engine = opts.wrap ? opts.wrap(raw) : raw;
    for (const p of policies) {
      const d = await engine.declare({ policy: p.doc });
      if (!d.servable) throw new Error(`the gate engine does not serve the policies of scope ${p.scope}`);
    }
    const reads = new Map<string, string[]>();
    for (const m of modules) reads.set(m, [...new Set(policies.filter((p) => core.scopeMatches(p.scope, m)).flatMap((p) => p.reads))].sort());
    // S162: the modules whose scope requires attribution: their certified document holds the scope's attribution rule.
    const attributed = new Set(modules.filter((m) => policies.some((p) => core.scopeMatches(p.scope, m) && ((p.doc.obligations ?? []) as { source?: { obligation?: string } }[]).some((o) => o.source?.obligation === '$attribution'))));
    // PS8.8: the obligations whose rule reads a claim's age, from each certified document.
    const ageRules = new Set(policies.flatMap((p) => ((p.doc.obligations ?? []) as { id?: string; when?: string; require?: string }[]).filter((o) => /action\.step\.(age|statusAge)\b/.test(`${o.when ?? ''} ${o.require ?? ''}`)).map((o) => o.id!)));
    return new PolicyGate(pxPackage, engine, view, reads, opts, attributed, ageRules);
  }

  /** S162: whether a module's trust scope requires attribution. */
  requiresAttribution(module: string): boolean {
    return this.attributed.has(module);
  }

  /**
   * One session at a time, in arrival order (PS11.0). While an engine call of the session that timed out is still
   * outstanding, the session takes nothing: the call may yet decide, and nothing may be decided against a Σ that its
   * answer moves without a record (review C1). Such a call is held with no sequence number, as an engine that does not
   * answer is (PT9.5).
   */
  private serial<T>(session: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(session) ?? Promise.resolve();
    const guarded = async () => {
      if (this.inflight.has(session)) throw new GateUnavailable(`the gate engine has not answered an earlier call of session ${session}, so the session takes nothing until it does (PT9.5)`);
      return f();
    };
    const next = prev.then(guarded, guarded);
    this.locks.set(session, next.catch(() => undefined));
    return next;
  }

  /**
   * An engine call, raced against the host's timeout. When the timeout wins the call is not cancelled (the engine has
   * no cancel): it is kept as the session's outstanding call, and `late` records its answer when it comes.
   */
  private timed<T>(session: string, p: Promise<T>, late?: (v: T) => Promise<unknown> | void): Promise<T> {
    const ms = this.opts.proposeTimeoutMs ?? 5_000;
    let t: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => { timedOut = true; reject(new GateUnavailable(`the gate engine did not answer in ${ms}ms (PT9.5)`)); }, ms); t.unref?.(); });
    return Promise.race([p, timeout]).finally(() => {
      clearTimeout(t);
      if (!timedOut) return;
      const done = p.then(async (v) => { try { await late?.(v); } catch { /* not recorded: replay lists the sseq as a gap */ } }, () => undefined).finally(() => this.inflight.delete(session));
      this.inflight.set(session, done);
    });
  }

  /** The digest of a session's Σ as the engine holds it, or null when the session has no policy (S146, review C4). */
  private sigma(session: string): string | null {
    const raw = (this.engine.__raw ?? this.engine) as any;
    for (const g of (raw._gates as Map<string, any> | undefined)?.values() ?? []) {
      if (`scope:${g.scope}` === session && g.sessions) return digest(g.sessions.meta(session).state ?? null);
    }
    return null;
  }

  /** The engine action for a proposal: its fields, and the reserved fields its scope's policies read (S147). */
  action(proposal: Proposal, snapshot: Record<string, unknown>): { action: Record<string, unknown>; reads: Record<string, number>; singletons: Record<string, unknown>; claims: Record<string, unknown> | null } {
    const machines: Record<string, unknown> = {};
    const reads: Record<string, number> = {};
    const singletons: Record<string, unknown> = {};
    for (const m of this.reads.get(moduleOf(proposal.machine)) ?? []) {
      if (m === proposal.machine) { machines[m] = snapshot; continue; }
      const s = this.view.singleton(m);
      if (s) { machines[m] = s.state; reads[s.instance] = s.seq; singletons[m] = s.state; }
    }
    // PD5.1.2d, S104: the claims of the step that emitted the effect travel beside the snapshot.
    const claims = this.view.stepClaims?.(proposal.instance, proposal.seq) ?? null;
    // PD5.2.2c: the emitting step's lineage, its origin and intent.
    const lineage = this.view.lineage?.(proposal.instance, proposal.seq) ?? null;
    // PS8.8: the ages of the claims at the decision, by the runtime's clock, recorded with the action; a time missing,
    // or after the decision, gives no age (unknown). PS8.9: the innermost mandate's agent and the person it acts for.
    const ev = claims ? this.view.stepEvidence?.(proposal.instance, proposal.seq) ?? null : null;
    const now = this.view.now?.() ?? Date.now();
    const ageOf = (t: number | undefined) => (typeof t === 'number' && t <= now ? { v: now - t } : null);
    const age = ageOf(ev?.verifiedAt);
    const statusAge = ageOf(ev?.statusAt);
    const inner = ev?.mandates?.length ? ev.mandates[ev.mandates.length - 1] : null;
    const step = claims ? { claims, ...(age ? { age: age.v } : {}), ...(statusAge ? { statusAge: statusAge.v } : {}), ...(inner ? { mandate: { delegate: inner.delegate, delegator: inner.delegator } } : {}) } : null;
    const row = { proposal: proposal.kind, effect: { kind: proposal.effectKind, class: proposal.class, machine: proposal.machine, ...(proposal.channel ? { channel: proposal.channel } : {}), ...(proposal.credential ? { credential: { name: proposal.credential.name, grantState: proposal.credential.grantState } } : {}) }, effects: proposal.labels, machines, decisions: this.view.decisions(proposal.instance), ...(step ? { step } : {}), ...(lineage ? { lineage } : {}) };
    return { action: actionOf(row), reads, singletons, claims };
  }

  /**
   * PS8.7, PT9.9: a send between two trust scopes, proposed in the sender's session. The sender's latest snapshot is
   * the emitter's; a singleton it reads is recorded as for an effect.
   */
  async proposeSend(m: { id: string; from: string; to: string; fromMachine: string; toMachine: string; action: string; data: unknown; senderState: Record<string, unknown>; lineage?: { origin: Record<string, unknown> | null; intent: string } | null }): Promise<GateDecision> {
    const session = sessionOf(m.fromMachine);
    return this.serial(session, async () => {
      const machines: Record<string, unknown> = {};
      const reads: Record<string, number> = {};
      const singletons: Record<string, unknown> = {};
      for (const r of this.reads.get(moduleOf(m.fromMachine)) ?? []) {
        if (r === m.fromMachine) { machines[r] = m.senderState; continue; }
        const s = this.view.singleton(r);
        if (s) { machines[r] = s.state; reads[s.instance] = s.seq; singletons[r] = s.state; }
      }
      const action = actionOf({ proposal: 'send', send: { to: m.toMachine, action: m.action, scope: moduleOf(m.toMachine), instance: m.to, payloadDigest: digest(m.data ?? {}) }, machines, decisions: this.view.decisions(m.from), ...(m.lineage ? { lineage: m.lineage } : {}) });
      const { v, decision, reason } = await this.decideAction(session, moduleOf(m.fromMachine), action, m.id, undefined, m.from);
      const sseq = this.view.nextSseq(session);
      const held = v.class === 'unavailable' ? `the gate engine is unavailable: ${v.reason}` : v.record === 'degraded' ? 'the gate engine could not journal its decision (degraded)' : null;
      if (held) throw new GateUnavailable(held, { session, sseq, action, engineDecision: v.decision, engineClass: v.class ?? null, engineRecord: v.record ?? null, stateBefore: v.state_before ?? null });
      // PD4-A1: the singletons the decision read (a mode, say), in the verdict event itself.
      const record = { session, sseq, action, singletons, stateBefore: v.state_before ?? null, stateAfter: v.state_after ?? null, engineDecision: v.decision, engineReason: v.reason ?? null, policySet: v.policy_set ?? null };
      if (decision === 'allow') return { decision, reads, record };
      if (decision === 'deny') return { decision, reason: reason ?? 'denied', reads, record };
      return { decision, reason: reason ?? undefined, reads, record };
    });
  }

  /** One decision of the engine on an action, with PS8.3's precedence (S158); shared by the gate and session replay. */
  async decideAction(session: string, scope: string, action: Record<string, unknown>, intent: string, approved?: { by: string }, run?: string): Promise<{ v: any; decision: 'allow' | 'deny' | 'escalate'; reason: string | null }> {
    const late = (v: any) => {
      if (!run || !this.view.recordLate) return;
      return this.view.recordLate(run, { stage: 'gate', intent, outcome: 'late', late: 'propose', gateDecision: 'late', session, sseq: this.view.nextSseq(session), action, engineDecision: v.decision, engineClass: v.class ?? null, stateBefore: v.state_before ?? null, stateAfter: v.state_after ?? null, ...(approved ? { approvedBy: approved.by } : {}) });
    };
    const v: any = await this.timed<any>(session, this.engine.merge({ run_id: session, scope, action, meta: { tool_use_id: intent, tool: (action.effect as { kind?: string } | undefined)?.kind ?? 'poly' }, ...(approved ? { approved: { by: approved.by, ref: intent } } : {}) }), late);
    let decision = v.decision as 'allow' | 'deny' | 'escalate';
    let reason: string | null = v.reason ?? null;
    if (decision === 'escalate') {
      // S158: a deny behind the escalation decides (PS8.3).
      const behind = this.denyBehind(session, action);
      if (behind) { decision = 'deny'; reason = behind; }
    }
    return { v, decision, reason };
  }

  async propose(proposal: Proposal, snapshot: Record<string, unknown>): Promise<GateDecision> {
    const session = sessionOf(proposal.machine);
    return this.serial(session, async () => {
      const { action, reads, singletons, claims } = this.action(proposal, snapshot);
      // An engine that throws or does not answer took no decision, and so no sequence number (PT9.5).
      const { v, decision, reason } = await this.decideAction(session, moduleOf(proposal.machine), action, proposal.idempotencyKey, proposal.approved, proposal.instance);
      const sseq = this.view.nextSseq(session);
      // PT9.5: an answer the engine could not stand behind is no answer: the intent is held, and the answer is recorded
      // with its sequence number, so the session still replays (an `unavailable` answer moved nothing; a degraded
      // allow moved Σ).
      const held = v.class === 'unavailable' ? `the gate engine is unavailable: ${v.reason}` : v.record === 'degraded' ? 'the gate engine could not journal its decision (degraded)' : null;
      if (held) throw new GateUnavailable(held, { session, sseq, action, engineDecision: v.decision, engineClass: v.class ?? null, engineRecord: v.record ?? null, stateBefore: v.state_before ?? null, ...approvedOf(proposal) });
      // PD4-A1: the singletons the decision read (a mode, say), in the verdict event itself.
      // PD5-A4: the verdict records the digest of the claims the decision read.
      const record = { session, sseq, action, singletons, ...(claims ? { claims: digest(claims) } : {}), stateBefore: v.state_before ?? null, stateAfter: v.state_after ?? null, engineDecision: v.decision, engineReason: v.reason ?? null, policySet: v.policy_set ?? null, ...(approvedOf(proposal)), ...(v.witnesses?.length ? { witnesses: digest(v.witnesses) } : {}) };
      if (decision === 'allow') return { decision, reads, record };
      if (decision === 'deny') return { decision, reason: this.staleReason(reason) ?? 'denied', witnessDigest: v.witnesses?.length ? digest(v.witnesses) : undefined, reads, record };
      return { decision, reason: reason ?? undefined, reads, record };
    });
  }

  /** S158: whether a deny stands behind an escalation, by the engine's own interpreter with the escalations lifted. */
  private denyBehind(session: string, action: Record<string, unknown>): string | null {
    const raw = (this.engine.__raw ?? this.engine) as any;
    const gates: Map<string, any> | undefined = raw._gates;
    if (!gates) return null;
    const core = this.pxPackage.core;
    for (const g of gates.values()) {
      if (`scope:${g.scope}` !== session || !g.plan) continue;
      const meta = g.sessions.meta(session);
      const canonical = core.normalizeAction(action);
      const r = core.stepPlan(g.plan, meta.state, core.routeAction(g.plan, canonical), { action: canonical, history: meta.history, run: { id: session, scope: g.scope, step: meta.step + 1 }, approved: { by: 'poly', ref: 'precedence' } });
      return decisionOfReject(r.reject) === 'deny' ? r.reject : null;
    }
    return null;
  }

  async settle(observed: { ok: boolean; output: string }, proposal: Proposal): Promise<{ result: 'ok' | 'failed'; record: Record<string, unknown> }> {
    const session = sessionOf(proposal.machine);
    return this.serial(session, async () => {
      const { action } = this.action(proposal, {});
      const seen = { ok: observed.ok, effects: proposal.labels, output: observed.output };
      const stateBefore = this.sigma(session);
      const late = () => this.view.recordLate?.(proposal.instance, { stage: 'gate', intent: proposal.idempotencyKey, outcome: 'late', late: 'settle', gateDecision: 'late', session, sseq: this.view.nextSseq(session), action, observed: seen, stateBefore, stateAfter: this.sigma(session) });
      await this.timed(session, this.engine.settle({ run_id: session, scope: moduleOf(proposal.machine), action, observed: seen }), late);
      // A settle the engine did not take has no sequence number (PT9.5). Review C4: Σ before and after it, as PS11.1 asks.
      const sseq = this.view.nextSseq(session);
      return { result: 'ok' as const, record: { session, sseq, action, observed: seen, stateBefore, stateAfter: this.sigma(session) } };
    });
  }

  /**
   * S118, S146: each session's recorded events, re-applied in sseq order on a fresh engine with the certified
   * policies; every decision and every Σ digest must be reproduced. A gap in the sequence stops that session's
   * replay, listed as not run, since Σ after it cannot be known.
   */
  static async replaySessions(pxPackage: any, policies: { scope: string; doc: Record<string, unknown>; reads: string[] }[], modules: string[], events: SessionEvent[], counters: Record<string, number> = {}): Promise<SessionReplay[]> {
    const none: ProgramView = { singleton: () => null, decisions: () => ({}), nextSseq: () => 0 };
    const fresh = await PolicyGate.open(pxPackage, policies, modules, none, { store: ':memory:' });
    const sessions = [...new Set([...events.map((e) => e.session), ...Object.keys(counters)])].sort();
    const out: SessionReplay[] = [];
    for (const session of sessions) {
      const r: SessionReplay = { session, proposals: 0, settles: 0, diagnostics: [], notRun: [] };
      out.push(r);
      const list = events.filter((e) => e.session === session).sort((x, y) => x.sseq - y.sseq);
      let expected = 1;
      let gap = false;
      for (const e of list) {
        if (e.sseq !== expected) { gap = true; r.notRun.push(`${session}: sseq ${expected} is missing from the ledger, so the session is not replayed past it (${list.length - r.proposals - r.settles} event(s) not run)`); break; }
        expected++;
        const scope = session.slice('scope:'.length);
        if (e.kind === 'settle') {
          const before = fresh.sigma(session);
          await fresh.engine.settle({ run_id: session, scope, action: e.action, observed: e.observed ?? {} });
          r.settles++;
          // Review C4: a settle's Σ before and after, when recorded.
          if (e.stateBefore !== undefined && e.stateBefore !== before) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): Σ before the settle was ${e.stateBefore}, and the session's replay has ${before}` });
          if (e.stateAfter !== undefined && e.stateAfter !== fresh.sigma(session)) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): Σ after the settle was ${e.stateAfter}, and the session's replay has ${fresh.sigma(session)}` });
          continue;
        }
        // An `unavailable` answer moved nothing, so it is not re-applied (PT9.5).
        if (e.engineClass === 'unavailable') { r.proposals++; continue; }
        const { v, decision } = await fresh.decideAction(session, scope, e.action, e.intent, e.approvedBy ? { by: e.approvedBy } : undefined);
        r.proposals++;
        if (e.gateDecision === 'held' || e.gateDecision === 'late') {
          if (v.decision !== e.engineDecision) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): the engine answered ${e.engineDecision} when the intent was held, and the session's replay answers ${v.decision}` });
        } else if (decision !== e.gateDecision) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): the gate decided ${e.gateDecision}, and the session's replay decides ${decision}` });
        if ((v.state_before ?? null) !== (e.stateBefore ?? null)) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): Σ before the decision was ${e.stateBefore}, and the session's replay has ${v.state_before}` });
        if (e.stateAfter !== undefined && (v.state_after ?? null) !== (e.stateAfter ?? null)) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): Σ after the decision was ${e.stateAfter}, and the session's replay has ${v.state_after}` });
      }
      // Review C4: sequence numbers the session assigned past its last recorded event (a decision whose event was never
      // written) are a gap too, found against the session's counter.
      const last = expected - 1;
      if (!gap && (counters[session] ?? 0) > last) r.notRun.push(`${session}: sseq ${last + 1}${counters[session] > last + 1 ? ` to ${counters[session]}` : ''} has no event in the ledger, so the session's Σ after sseq ${last} is not known`);
    }
    return out;
  }

  /** AC4: the session's notary receipts, signed by the engine, and their verification. */
  async receipts(scope: string): Promise<{ signed: any; verified: any }> {
    const session = `scope:${scope}`;
    const signed = await this.engine.sign({ run_id: session });
    const verified = await this.engine.verifyChain(session);
    return { signed, verified };
  }
}
