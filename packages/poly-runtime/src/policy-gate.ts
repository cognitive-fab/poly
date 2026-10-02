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

export class GateUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'GateUnavailable'; }
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
  action(proposal: Proposal, snapshot: Record<string, unknown>): { action: Record<string, unknown>; reads: Record<string, number> } {
    const machines: Record<string, unknown> = {};
    const reads: Record<string, number> = {};
    for (const m of this.reads.get(moduleOf(proposal.machine)) ?? []) {
      if (m === proposal.machine) { machines[m] = snapshot; continue; }
      const s = this.view.singleton(m);
      if (s) { machines[m] = s.state; reads[s.instance] = s.seq; }
    }
    const row = { proposal: proposal.kind, effect: { kind: proposal.effectKind, class: proposal.class, machine: proposal.machine }, effects: proposal.labels, machines, decisions: this.view.decisions(proposal.instance) };
    return { action: actionOf(row), reads };
  }

  async propose(proposal: Proposal, snapshot: Record<string, unknown>): Promise<GateDecision> {
    const session = sessionOf(proposal.machine);
    return this.serial(session, async () => {
      const { action, reads } = this.action(proposal, snapshot);
      const sseq = this.view.nextSseq(session);
      const v: any = await this.timed<any>(this.engine.merge({ run_id: session, scope: moduleOf(proposal.machine), action, meta: { tool_use_id: proposal.idempotencyKey, tool: proposal.effectKind }, ...(proposal.approved ? { approved: { by: proposal.approved.by, ref: proposal.idempotencyKey } } : {}) }));
      // PT9.5: an answer the engine could not stand behind is no answer.
      if (v.class === 'unavailable') throw new GateUnavailable(`the gate engine is unavailable: ${v.reason}`);
      if (v.record === 'degraded') throw new GateUnavailable('the gate engine could not journal its decision (degraded)');
      let decision = v.decision as 'allow' | 'deny' | 'escalate';
      let reason: string | null = v.reason ?? null;
      if (decision === 'escalate') {
        // S158: a deny behind the escalation decides (PS8.3).
        const behind = this.denyBehind(session, action);
        if (behind) { decision = 'deny'; reason = behind; }
      }
      const record = { session, sseq, stateBefore: v.state_before ?? null, stateAfter: v.state_after ?? null, engineDecision: v.decision, engineReason: v.reason ?? null, policySet: v.policy_set ?? null, ...(v.witnesses?.length ? { witnesses: digest(v.witnesses) } : {}) };
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
      const sseq = this.view.nextSseq(session);
      await this.timed(this.engine.settle({ run_id: session, scope: moduleOf(proposal.machine), action, observed: { ok: observed.ok, effects: proposal.labels, output: observed.output } }));
      return { result: 'ok' as const, record: { session, sseq } };
    });
  }

  /** AC4: the session's notary receipts, signed by the engine, and their verification. */
  async receipts(scope: string): Promise<{ signed: any; verified: any }> {
    const session = `scope:${scope}`;
    const signed = await this.engine.sign({ run_id: session });
    const verified = await this.engine.verifyChain(session);
    return { signed, verified };
  }
}
