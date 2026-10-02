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
  private engine: any;

  private constructor(private readonly pxPackage: any, engine: any, private readonly view: ProgramView, private readonly reads: Map<string, string[]>, private readonly opts: PolicyGateOptions) {
    this.engine = engine;
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
    return new PolicyGate(pxPackage, engine, view, reads, opts);
  }

  /** One session at a time, in arrival order (PS11.0). */
  private serial<T>(session: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(session) ?? Promise.resolve();
    const next = prev.then(f, f);
    this.locks.set(session, next.catch(() => undefined));
    return next;
  }

  private timed<T>(p: Promise<T>): Promise<T> {
    const ms = this.opts.proposeTimeoutMs ?? 5_000;
    let t: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new GateUnavailable(`the gate engine did not answer in ${ms}ms (PT9.5)`)), ms); t.unref?.(); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  }

  /** The engine action for a proposal: its fields, and the reserved fields its scope's policies read (S147). */
  action(proposal: Proposal, snapshot: Record<string, unknown>): { action: Record<string, unknown>; reads: Record<string, number>; singletons: Record<string, unknown> } {
    const machines: Record<string, unknown> = {};
    const reads: Record<string, number> = {};
    const singletons: Record<string, unknown> = {};
    for (const m of this.reads.get(moduleOf(proposal.machine)) ?? []) {
      if (m === proposal.machine) { machines[m] = snapshot; continue; }
      const s = this.view.singleton(m);
      if (s) { machines[m] = s.state; reads[s.instance] = s.seq; singletons[m] = s.state; }
    }
    const row = { proposal: proposal.kind, effect: { kind: proposal.effectKind, class: proposal.class, machine: proposal.machine }, effects: proposal.labels, machines, decisions: this.view.decisions(proposal.instance) };
    return { action: actionOf(row), reads, singletons };
  }

  /**
   * PS8.7, PT9.9: a send between two trust scopes, proposed in the sender's session. The sender's latest snapshot is
   * the emitter's; a singleton it reads is recorded as for an effect.
   */
  async proposeSend(m: { id: string; from: string; fromMachine: string; toMachine: string; action: string; senderState: Record<string, unknown> }): Promise<GateDecision> {
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
      const action = actionOf({ proposal: 'send', send: { to: m.toMachine, action: m.action, scope: moduleOf(m.toMachine) }, machines, decisions: this.view.decisions(m.from) });
      const { v, decision, reason } = await this.decideAction(session, moduleOf(m.fromMachine), action, m.id);
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
  async decideAction(session: string, scope: string, action: Record<string, unknown>, intent: string, approved?: { by: string }): Promise<{ v: any; decision: 'allow' | 'deny' | 'escalate'; reason: string | null }> {
    const v: any = await this.timed<any>(this.engine.merge({ run_id: session, scope, action, meta: { tool_use_id: intent, tool: (action.effect as { kind?: string } | undefined)?.kind ?? 'poly' }, ...(approved ? { approved: { by: approved.by, ref: intent } } : {}) }));
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
      const { action, reads, singletons } = this.action(proposal, snapshot);
      // An engine that throws or does not answer took no decision, and so no sequence number (PT9.5).
      const { v, decision, reason } = await this.decideAction(session, moduleOf(proposal.machine), action, proposal.idempotencyKey, proposal.approved);
      const sseq = this.view.nextSseq(session);
      // PT9.5: an answer the engine could not stand behind is no answer: the intent is held, and the answer is recorded
      // with its sequence number, so the session still replays (an `unavailable` answer moved nothing; a degraded
      // allow moved Σ).
      const held = v.class === 'unavailable' ? `the gate engine is unavailable: ${v.reason}` : v.record === 'degraded' ? 'the gate engine could not journal its decision (degraded)' : null;
      if (held) throw new GateUnavailable(held, { session, sseq, action, engineDecision: v.decision, engineClass: v.class ?? null, engineRecord: v.record ?? null, stateBefore: v.state_before ?? null, ...approvedOf(proposal) });
      // PD4-A1: the singletons the decision read (a mode, say), in the verdict event itself.
      const record = { session, sseq, action, singletons, stateBefore: v.state_before ?? null, stateAfter: v.state_after ?? null, engineDecision: v.decision, engineReason: v.reason ?? null, policySet: v.policy_set ?? null, ...(approvedOf(proposal)), ...(v.witnesses?.length ? { witnesses: digest(v.witnesses) } : {}) };
      if (decision === 'allow') return { decision, reads, record };
      if (decision === 'deny') return { decision, reason: reason ?? 'denied', witnessDigest: v.witnesses?.length ? digest(v.witnesses) : undefined, reads, record };
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
      await this.timed(this.engine.settle({ run_id: session, scope: moduleOf(proposal.machine), action, observed: seen }));
      // A settle the engine did not take has no sequence number (PT9.5).
      const sseq = this.view.nextSseq(session);
      return { result: 'ok' as const, record: { session, sseq, action, observed: seen } };
    });
  }

  /**
   * S118, S146: each session's recorded events, re-applied in sseq order on a fresh engine with the certified
   * policies; every decision and every Σ digest must be reproduced. A gap in the sequence stops that session's
   * replay, listed as not run, since Σ after it cannot be known.
   */
  static async replaySessions(pxPackage: any, policies: { scope: string; doc: Record<string, unknown>; reads: string[] }[], modules: string[], events: SessionEvent[]): Promise<SessionReplay[]> {
    const none: ProgramView = { singleton: () => null, decisions: () => ({}), nextSseq: () => 0 };
    const fresh = await PolicyGate.open(pxPackage, policies, modules, none, { store: ':memory:' });
    const sessions = [...new Set(events.map((e) => e.session))].sort();
    const out: SessionReplay[] = [];
    for (const session of sessions) {
      const r: SessionReplay = { session, proposals: 0, settles: 0, diagnostics: [], notRun: [] };
      out.push(r);
      const list = events.filter((e) => e.session === session).sort((x, y) => x.sseq - y.sseq);
      let expected = 1;
      for (const e of list) {
        if (e.sseq !== expected) { r.notRun.push(`${session}: sseq ${expected} is missing from the ledger, so the session is not replayed past it (${list.length - r.proposals - r.settles} event(s) not run)`); break; }
        expected++;
        const scope = session.slice('scope:'.length);
        if (e.kind === 'settle') { await fresh.engine.settle({ run_id: session, scope, action: e.action, observed: e.observed ?? {} }); r.settles++; continue; }
        // An `unavailable` answer moved nothing, so it is not re-applied (PT9.5).
        if (e.engineClass === 'unavailable') { r.proposals++; continue; }
        const { v, decision } = await fresh.decideAction(session, scope, e.action, e.intent, e.approvedBy ? { by: e.approvedBy } : undefined);
        r.proposals++;
        if (e.gateDecision === 'held') {
          if (v.decision !== e.engineDecision) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): the engine answered ${e.engineDecision} when the intent was held, and the session's replay answers ${v.decision}` });
        } else if (decision !== e.gateDecision) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): the gate decided ${e.gateDecision}, and the session's replay decides ${decision}` });
        if ((v.state_before ?? null) !== (e.stateBefore ?? null)) r.diagnostics.push({ code: 'PL9001', message: `${session} sseq ${e.sseq} (run ${e.run}, ledger seq ${e.ledgerSeq}): Σ before the decision was ${e.stateBefore}, and the session's replay has ${v.state_before}` });
      }
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
