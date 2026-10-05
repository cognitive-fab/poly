// The host runtime API (PT15): polyrun's runtime with the certificate check at load, the ledger written in each
// step's transaction (S121), and, from the outbox worker on, the gate interface (S118, S119).
//
//   const rt = await load('./.poly/build', { certificate: './.poly/certificate.json', trust: { 'ops-2026': pem },
//                                           store: { sqlite: './orders.db' } })
//   const order = await rt.create('orders.Order')
//   const r = await rt.dispatch(order.id, 'Place', {}, { actionId: 'req-7781' })
//
// What M4's runtime does not do is stated in the certificate's `limits` and printed with it (S118, S134, S135).
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import { personKeyVerifier, type Verifier } from './verifier.js';
import { lineageDigest, type Lineage } from './ledger-store.js';
import { capabilitiesFor, type Transports } from './capabilities.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type Runtime, type DispatchResult, type JournalRow } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { RESERVED_MODULE, verifyRecord, type Certificate } from '@poly/core';
import { LedgerStore, openLedgerStore, InputOutsideType } from './ledger-store.js';
import { dataOutside } from './types.js';
import { verifyBuild, recheckCopy, LoadError, type VerifiedBuild, type VerifiedWorkflow, type WorkOrderTool } from './load.js';
import { deriveKey, keyFields, keyOfRun, runIdOf, WorkflowError } from './workflows.js';
import { verifyRunChain, type LedgerEvent, type ChainResult } from './ledger.js';
import { EffectWorker, ALLOW_ALL, type Gate, type EffectHandler, type WorkerDrift, type ReportOutcome, parseOrderId } from './worker.js';
import { verifiedModels, modelSource, BOUNDS } from './model.js';
import { PolicyGate, type PolicyGateOptions, type ProgramView, type SessionEvent, type SessionReplay } from './policy-gate.js';
import { polyaxionPeer, loadPolyaxion } from './peers.js';
import { decisionHandler, mapDigest, type DecisionRecord, type ProviderConfig } from './provider.js';
import { signHeads, headsOf, publishAnchor, verifyRun, type LedgerSigner, type SignedHead, type Anchor, type RunVerification , countersignHeads, type CountersignAdapter, type Countersignature } from './journal.js';

export { LoadError };

export interface LoadOptions {
  certificate: string;
  /** Trusted admission keys: key id to public key, PEM. The runtime never reads a private key at load. */
  trust: Record<string, string>;
  /** S135: SQLite only. ':memory:' when omitted. */
  store?: { sqlite: string };
  now?: () => number;
  /** S139: load a witness certificate, for an exported witness test only; refused when NODE_ENV is production. */
  allowWitness?: boolean;
  /**
   * S118: the gate interface; allow-all when omitted, and the policy gate when the build has policies (PT9). `policy`
   * configures the policy gate; a build with policies takes no other gate.
   */
  gate?: { gate?: Gate; escalationTimeoutMs?: number; policy?: PolicyGateOptions };
  worker?: { leaseMs?: number; batch?: number; drift?: WorkerDrift };
  /** S123: the head signer, and how often heads are signed and anchors published, off the step path. */
  ledger?: LedgerSigner & { headMs?: number; anchorMs?: number };
  /** PD5.1.4, K11: the verifier adapter for actions with claims; the person-key adapter over the certified keyrings by default (S107). */
  verifier?: Verifier;
  /**
   * S134, S151: the host functions handlers' capabilities are built over. poly-runtime imports no network module;
   * each capability checks a call against its effect's declared targets before calling the transport.
   */
  transports?: Transports;
}

export type Handler = EffectHandler;

/** An outside dispatch that the runtime refuses before any step, with an audit row (K9, K10). */
/** PD2.4: an adjudication with no decision event to link; a checked program cannot reach it (PL6203). */
/** S173: an open work order, as an agent takes it: the gate's decision is the intent's, once; the order id is the attempt's (PF8.5a, S173 as amended). */
export interface WorkOrder { orderId: string; intent: string; instanceId: string; workflow: string; kind: string; tool: string; target?: string; why: string; args: Record<string, unknown>; attempt: number; deadline: number }

/** S189: the runtime's own ledger run for the approvals drop folder; `runtime.*` is reserved for the runtime (S143). */
export const APPROVALS_RUN = 'runtime:approvals';

/** A name under `dir` that no file has yet: `name`, else `name.2`, `name.3`, ... so a record is never overwritten. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  for (let k = 2; ; k++) if (!existsSync(join(dir, `${name}.${k}`))) return `${name}.${k}`;
}

export class OutcomeWithoutDecision extends Error {
  constructor(message: string) { super(message); this.name = 'OutcomeWithoutDecision'; }
}

/** PT12.5: an approval that is not a person's signed record for a waiting escalation. Audited, with no effect. */
/** S189: why an approval was refused, as the drop folder names it. */
export type ApprovalRefusal = 'not-a-record' | 'wrong-key' | 'unmatched' | 'replayed' | 'expired';

export class ApprovalRefused extends Error {
  constructor(message: string, readonly reason: ApprovalRefusal = 'unmatched') { super(message); this.name = 'ApprovalRefused'; }
}

export class RefusedDispatch extends Error {
  constructor(message: string, readonly rule: string) { super(message); this.name = 'RefusedDispatch'; }
}

export class PolyRuntime {
  readonly handlers = new Map<string, Handler>();
  readonly worker: EffectWorker;
  /** Review B5: whether a gate was given at load; only then are recorded gate decisions recomputed. */
  readonly gateGiven: boolean;
  /** S173: each workflow's work-order kinds, by machine id, with the tool each maps to. */
  private readonly orderTools = new Map<string, Map<string, WorkOrderTool & { workflow: string }>>();
  /** PD2.2: each decision's record, from the provider's return to its completion's commit, by intent id. */
  private readonly records = new Map<string, DecisionRecord>();
  private readonly inputSubscribers = new Map<string, Set<(step: unknown) => void>>();
  private readonly intentSubscribers = new Map<string, Set<(intent: unknown) => void>>();
  private timers: NodeJS.Timeout[] = [];

  /** S142: the exports of each certified handler file, as the runtime imported it from its verified copy. */
  private readonly certified: Map<string, Readonly<Record<string, unknown>>>;
  private readonly certifiedFunctions: Set<unknown>;

  /** PT9: the policy gate, when the build has policies. */
  readonly policyGate: PolicyGate | null;

  /** PD5.1.4: the verifier adapter. */
  private readonly verifier: Verifier;

  constructor(readonly kernel: Runtime, readonly store: LedgerStore, readonly verified: VerifiedBuild, readonly ledger: LoadOptions['ledger'] = undefined, opts: Pick<LoadOptions, 'gate' | 'worker' | 'transports' | 'verifier'> & { certified?: Map<string, Readonly<Record<string, unknown>>>; policyGate?: PolicyGate | null } = {}) {
    this.policyGate = opts.policyGate ?? null;
    this.verifier = opts.verifier ?? personKeyVerifier(verified.certificate.poly.keyrings ?? { people: [], agents: [] });
    this.certified = opts.certified ?? new Map();
    this.certifiedFunctions = new Set([...this.certified.values()].flatMap((ns) => Object.values(ns).filter((v) => typeof v === 'function')));
    this.gateGiven = opts.gate?.gate !== undefined || this.policyGate !== null;
    store.decisionCompletions = (machineId) => this.decisionCompletions(machineId);
    store.allowWitnessCompletions = verified.certificate.purpose === 'witness';
    for (const w of verified.workflows) {
      if (!this.orderTools.has(w.machine)) this.orderTools.set(w.machine, new Map());
      for (const [kind, t] of Object.entries(w.tools)) this.orderTools.get(w.machine)!.set(kind, { ...t, workflow: w.name });
    }
    const builtins: Record<string, EffectHandler> = {};
    for (const m of verified.machines) for (const kind of Object.keys(m.manifest?.effects ?? {})) if (kind.startsWith('outcome.')) builtins[kind] = () => ({});
    this.worker = new EffectWorker(kernel, store, this.handlers, {
      gate: this.policyGate ?? opts.gate?.gate ?? ALLOW_ALL, escalationTimeoutMs: opts.gate?.escalationTimeoutMs, ...opts.worker, builtins,
      outsideType: (instanceId, action, data) => this.outsideType(instanceId, action, data),
      // PD2.2, K10: the decision event is written with the completion step, in its transaction.
      beforeCompletion: (row, decl) => {
        const record = decl?.decision ? this.records.get(row.intent_id) : undefined;
        if (record) this.store.pending.set(`${row.instance_id}\u0000${row.intent_id}:done`, { before: [{ kind: 'decision', body: record }] });
      },
      capabilities: (row, decl) => capabilitiesFor(decl ?? {}, opts.transports ?? {}, async (reason) => {
        await this.store.insertAudit({ at: this.now(), instanceId: row.instance_id, action: row.kind, actionId: row.intent_id, rule: 'PL6406', reason });
      }),
      onAllowed: (row, proposal) => { for (const f of this.intentSubscribers.get(row.kind) ?? []) f({ intent: row.intent_id, kind: row.kind, instance: row.instance_id, seq: row.seq, payload: row.payload, proposal }); },
      afterCompletion: (row) => { this.store.pending.delete(`${row.instance_id}\u0000${row.intent_id}:done`); this.records.delete(row.intent_id); },
      workOrder: (row) => {
        const t = this.orderToolOf(row.instance_id, row.kind);
        return t ? { tool: t.tool, ...(t.target !== undefined ? { target: t.target } : {}), why: t.why } : null;
      },
    });
    // PD2.4, S129: an adjudication's outcome event, linked to the run's most recent decision event for its decision.
    store.onOutbox = (instanceId, rows) => rows.filter((r) => r.kind.startsWith('outcome.')).map((r) => {
      const decision = r.kind.slice('outcome.'.length);
      const link = store.lastDecision(instanceId, decision);
      if (!link) throw new OutcomeWithoutDecision(`${instanceId} adjudicates ${decision}, and the run has no decision event for it (PD2.4, S129)`);
      return { kind: 'outcome', body: { decision, outcome: (r.payload as { outcome: string }).outcome, intent: r.intentId, decisionEvent: link } };
    });
    kernel.events.on('step', (step) => {
      for (const f of this.inputSubscribers.get(step.instanceId) ?? []) f(step);
    });
  }

  get now(): () => number { return this.kernel.now; }
  get certificate(): Certificate { return this.verified.certificate; }
  /** The project root the certificate's paths are relative to. */
  get root(): string { return this.verified.root; }
  /** The verified copy of a machine's lowered module, the bytes polyrun registered. */
  modulePath(machineId: string): string {
    const m = this.verified.machines.find((x) => x.id === machineId);
    if (!m) throw new Error(`machine ${machineId} is not in the certificate`);
    return m.module;
  }
  /** S118: each recorded gate decision of a run, recomputed from its recorded proposal and snapshot (K6). */
  /** S118, S146: every recorded event of every gate session, from every run's chain, with its bodies. */
  async sessionEvents(): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    const rows = this.store.db.prepare("SELECT run, seq, event FROM poly_ledger WHERE kind = 'verdict'").all() as { run: string; seq: number; event: string }[];
    for (const r of rows) {
      const b = JSON.parse(r.event).body as Record<string, any>;
      if (typeof b?.session !== 'string' || !b.action) continue;
      const action = await this.store.body(b.action) as Record<string, unknown>;
      // Review C1: a late answer is a proposal or a settle the engine took after the host had held the intent.
      if (b.outcome === 'settled' || b.late === 'settle') out.push({ session: b.session, sseq: b.sseq, kind: 'settle', action, intent: b.intent, observed: b.observed, stateBefore: b.stateBefore, stateAfter: b.stateAfter, run: r.run, ledgerSeq: r.seq });
      else out.push({ session: b.session, sseq: b.sseq, kind: 'propose', action, intent: b.intent, approvedBy: b.approvedBy, gateDecision: b.gateDecision, engineDecision: b.engineDecision, engineClass: b.engineClass ?? null, stateBefore: b.stateBefore, stateAfter: b.stateAfter, run: r.run, ledgerSeq: r.seq });
    }
    return out;
  }

  /** S118, S146: the sessions, replayed in sseq order on a fresh gate engine with the certified policies. */
  async replaySessions(): Promise<SessionReplay[]> {
    if (!this.policyGate) return [];
    const modules = [...new Set(this.verified.machines.map((m) => m.id.slice(0, m.id.lastIndexOf('.'))))];
    // Review C4: each session's counter, so a decision whose event was never written at the end is found.
    const counters = Object.fromEntries((this.store.db.prepare('SELECT session, sseq FROM poly_gate_session').all() as { session: string; sseq: number }[]).map((r) => [r.session, r.sseq]));
    return PolicyGate.replaySessions(await loadPolyaxion(), this.verified.policies, modules, await this.sessionEvents(), counters);
  }

  async gateReplays(instanceId: string): Promise<{ seq: number; decision: string; recompute: (() => string) | null; bySession?: boolean }[]> {
    const out: { seq: number; decision: string; recompute: (() => string) | null; bySession?: boolean }[] = [];
    for (const e of await this.chain(instanceId)) {
      const b = e.body as Record<string, any>;
      if (e.kind !== 'verdict' || b?.stage !== 'gate' || !b.proposal) continue;
      // S146: a policy gate's decisions depend on its session, so they are replayed by their session, in sseq order.
      if (this.policyGate) { out.push({ seq: e.seq, decision: b.outcome, recompute: null, bySession: true }); continue; }
      // Review B5: replay never substitutes a gate. Without the gate the runtime ran with, the decision is not replayed.
      if (!this.gateGiven) { out.push({ seq: e.seq, decision: b.outcome, recompute: null }); continue; }
      const proposal = await this.store.body(b.proposal) as any;
      const snapshot = await this.store.body(b.snapshot) as Record<string, unknown>;
      let g = await this.worker.gate.propose(proposal, snapshot);
      if (b.decision === 2 && g.decision === 'escalate') g = { decision: 'deny', reason: 'escalate-once' };
      const again = g.decision === 'allow' ? 'allowed' : g.decision === 'deny' ? 'denied' : 'escalated';
      out.push({ seq: e.seq, decision: b.outcome, recompute: () => again });
    }
    return out;
  }

  /** PT9.2: a recorded approval of an escalated intent (S118: no person-key signature until M5). */
  /** PT12.5: the latest escalation of an intent, by its verdict event's hash, which a signed approval names. */
  async escalationOf(intentId: string): Promise<{ hash: string; run: string; seq: number } | null> {
    return this.store.txn(() => {
      const rows = this.store.db.prepare(`SELECT run, seq, hash, event FROM poly_ledger WHERE kind = 'verdict' ORDER BY seq DESC`).all() as { run: string; seq: number; hash: string; event: string }[];
      for (const r of rows) {
        const b = JSON.parse(r.event).body;
        if (b?.intent === intentId && b?.outcome === 'escalated') return { hash: r.hash, run: r.run, seq: r.seq };
      }
      return null;
    });
  }

  /**
   * PT9.2, PT12.5, S150: a signed approval lifts the escalation it names, once. Its subject is the escalated verdict
   * event's hash; its key must be a person's in the certified keyring. Anything else is refused with an audit row,
   * and the intent stays Escalated until it is approved or times out.
   */
  async approve(record: unknown): Promise<void> {
    const r = record as { subject?: unknown } | null;
    const subject = typeof r?.subject === 'string' ? r.subject : '';
    const found = subject ? await this.store.txn(() => this.store.db.prepare(`SELECT run, event FROM poly_ledger WHERE hash = ? AND kind = 'verdict'`).get(subject) as { run: string; event: string } | undefined) : undefined;
    const body = found ? JSON.parse(found.event).body : null;
    const refuse = async (problem: string, reason: ApprovalRefusal): Promise<never> => {
      await this.store.insertAudit({ at: this.now(), instanceId: found?.run ?? '', action: 'Approve', actionId: body?.intent ?? subject, rule: 'PT12.5', reason: problem });
      throw new ApprovalRefused(`approval refused: ${problem}`, reason);
    };
    // O9 of the outage test: a keyring or verifier that cannot be read refuses the approval; nothing is assumed.
    let v: ReturnType<typeof verifyRecord>;
    try { v = verifyRecord(record, this.verified.certificate.poly.keyrings, { kind: 'approval' }); } catch (e) { return refuse(`the keyring cannot be read: ${(e as Error).message}`, 'wrong-key'); }
    if (!v.ok) {
      // An unverifiable record is audited against the escalation it names, when it names one.
      return refuse(v.problem, /^not a signed record/.test(v.problem) ? 'not-a-record' : 'wrong-key');
    }
    if (!found || body?.outcome !== 'escalated') return refuse(`the record names no escalation (${subject})`, 'unmatched');
    // Review A1, C3: one record lifts one escalation, once. After a Recheck an intent escalates again, and a record
    // naming the earlier escalation, or one already used, does not lift the new one.
    const current = await this.escalationOf(body.intent);
    if (current?.hash !== subject) return refuse(`the record names escalation ${subject}, and the intent's current escalation is ${current?.hash ?? 'none'}`, 'unmatched');
    const used = this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict'`).all(found.run).some((x: any) => { const b = JSON.parse(x.event).body; return b?.outcome === 'approved' && b?.record === v.digest; });
    if (used) return refuse(`the record ${v.digest} was already used`, 'replayed');
    try {
      await this.worker.approve(body.intent, { by: v.person.keyId, person: v.person.name, record: v.digest, subject, at: (record as { at: string }).at });
    } catch (e) { return refuse((e as Error).message, /timed out/.test((e as Error).message) ? 'expired' : 'unmatched'); }
  }

  /**
   * S189: one pass over the approvals drop folder. Each `*.json` record is taken in file-name order and applied through
   * rt.approve, which verifies it against the certified keyring and the open escalation it names. Every outcome is
   * journaled on the runtime's own `runtime:approvals` run, with the record kept by digest, so a replay reads the same
   * records in the same order; then the file is moved to applied/, or to refused/ with its reason in a sidecar file.
   */
  async takeApprovals(dir: string): Promise<{ file: string; outcome: 'applied' | 'refused'; reason?: ApprovalRefusal }[]> {
    const out: { file: string; outcome: 'applied' | 'refused'; reason?: ApprovalRefusal }[] = [];
    let names: string[];
    try { names = readdirSync(dir).filter((f) => f.endsWith('.json') && statSync(join(dir, f)).isFile()).sort(); } catch { return out; }
    this.store.ensureRun(APPROVALS_RUN, 'runtime', 'approvals');
    for (const file of names) {
      const text = readFileSync(join(dir, file), 'utf8');
      let reason: ApprovalRefusal | undefined;
      let message = '';
      let record: unknown = null;
      try { record = JSON.parse(text); } catch { reason = 'not-a-record'; message = 'the file is not JSON'; }
      if (!reason) {
        try { await this.approve(record); } catch (e) {
          if (!(e instanceof ApprovalRefused)) throw e;
          reason = e.reason;
          message = e.message;
        }
      }
      await this.store.txn(() => {
        this.store.appendEvent(APPROVALS_RUN, 'verdict', { stage: 'approval', file, record: this.store.keep(text), outcome: reason ? 'refused' : 'applied', ...(reason ? { reason } : {}) }, this.now());
      });
      const to = join(dir, reason ? 'refused' : 'applied');
      mkdirSync(to, { recursive: true });
      const target = freeName(to, file);
      renameSync(join(dir, file), join(to, target));
      if (reason) writeFileSync(join(to, `${target}.reason.txt`), `${reason}: ${message}\n`);
      out.push({ file, outcome: reason ? 'refused' : 'applied', ...(reason ? { reason } : {}) });
    }
    return out;
  }

  /** The outbox rows of an instance (polyrun's), for hosts and tests that watch the intents. */
  outbox(instanceId: string) { return this.store.getOutbox(instanceId); }

  /** One outbox row by its intent id (its status and attempts), or null. */
  async outboxRow(intentId: string): Promise<{ intent_id: string; instance_id: string; kind: string; status: string; attempts: number; last_error: string | null } | null> {
    return this.store.txn(() => this.store.db.prepare('SELECT intent_id, instance_id, kind, status, attempts, last_error FROM pr_outbox WHERE intent_id = ?').get(intentId) ?? null);
  }

  /** The runtime's own model behind a machine id (an OutboxIntent instance), or null for a program's machine. */
  modelOf(machineId: string): { source: string; module: string } | null {
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(machineId);
    if (!m) return null;
    const bound = m[1] ? Number(m[1]) : 3;
    return { source: modelSource(bound), module: verifiedModels([bound])[0].module };
  }

  /** S142: the exports of a certified handler file (a path poly.json names), as the runtime loaded it. */
  handlerExports(path: string): Readonly<Record<string, unknown>> {
    const ns = this.certified.get(path);
    if (!ns) throw new Error(`no certified handler file ${path}; the certificate binds ${[...this.certified.keys()].join(', ') || 'none'} (S142)`);
    return ns;
  }

  /** PT15: a handler for an effect kind. It runs only from the outbox worker, after the gate allows (PT9.2). */
  handle(kind: string, handler: Handler): void {
    // S173: a workflow's mapped kind is a work order; the agent's report is its result, and no handler runs it.
    for (const [machine, kinds] of this.orderTools) if (kinds.has(kind)) throw new Error(`${kind} is a work order of workflow ${kinds.get(kind)!.workflow} on ${machine}: the agent's report settles it through rt.reportWorkOrder, and no handler runs it (S173)`);
    // Review B2: a decision's handler is the provider host's, which keeps the record its completion commits with.
    if (kind.startsWith('decision.')) throw new Error(`${kind} is a decision: register its provider with rt.provide, never rt.handle (PD2.2, K10)`);
    if (kind.startsWith('outcome.')) throw new Error(`${kind} is an adjudication's outcome, handled by the runtime itself (PD2.4)`);
    // S142: only an export of a certified handler file, as this runtime loaded it, by identity. The same file imported
    // by the host is another module instance, and a closure is no file at all: neither is what the lint read.
    if (!this.certifiedFunctions.has(handler)) {
      const files = [...this.certified.keys()];
      throw new Error(`PL6404 HANDLER_NOT_CERTIFIED: the handler for ${kind} is not an export of a certified handler file as the runtime loaded it${files.length ? ` (take it from rt.handlerExports(${files.map((f) => JSON.stringify(f)).join(' | ')}))` : '; the certificate binds no handler file'} (S142)`);
    }
    this.handlers.set(kind, handler);
  }

  /**
   * A creation action is a dispatch from outside too (review B1): caller-supplied $claims or $lineage are refused (S155),
   * and an action with claims gets them from the verifier, with the creation's credentials (PD5.1.4).
   */
  async create(machineId: string, opts: { id?: string; creation?: { action: string; data?: unknown }; credentials?: unknown } = {}): Promise<{ id: string; state: Record<string, unknown> }> {
    let creation = opts.creation;
    if (creation) {
      const id = opts.id ?? '';
      const actionId = `$create:${creation.action}`;
      const d = creation.data;
      const reserved = d && typeof d === 'object' && !Array.isArray(d) ? ['$claims', '$lineage'].filter((k) => k in (d as object)) : [];
      if (reserved.length) {
        const reason = `PL1208 RESERVED_NAME: the creation ${creation.action} of ${id || machineId} supplies ${reserved.join(' and ')}, which only the runtime writes (S155)`;
        await this.store.insertAudit({ at: this.now(), instanceId: id, action: creation.action, actionId, rule: 'S155', reason });
        throw new RefusedDispatch(reason, 'S155');
      }
      if (this.claimed(machineId, creation.action)) {
        let claims: Record<string, unknown> | null = null;
        if (opts.credentials !== undefined) {
          try { claims = await this.verifier(opts.credentials, { instance: id, action: creation.action, data: d ?? {}, actionId }); } catch { claims = null; }
        }
        creation = { ...creation, data: { ...((d ?? {}) as object), $claims: claims ?? null } };
      }
    }
    const r = await this.kernel.create(machineId, opts.id, creation);
    return { id: r.instanceId, state: r.state };
  }

  /**
   * PT15. polyrun refuses an outside dispatch of a live child's completion (K9); this refuses one of a decision's
   * completion (K10, S130), since only the worker delivers it with its decision event, and an input outside its
   * action's type (S140). Each comes before any step, with an audit row and no journal row.
   */
  async dispatch(instanceId: string, action: string, data: unknown = {}, opts: { actionId?: string; credentials?: unknown } = {}): Promise<DispatchResult> {
    const actionId = opts.actionId ?? `${action}:${randomUUID()}`;
    const inst = await this.store.getInstance(instanceId);
    // S155: $claims and $lineage are the runtime's; a dispatch that supplies either is refused before any step.
    const reserved = data && typeof data === 'object' && !Array.isArray(data) ? ['$claims', '$lineage'].filter((k) => k in (data as object)) : [];
    if (reserved.length) {
      const reason = `PL1208 RESERVED_NAME: ${action} on ${instanceId} supplies ${reserved.join(' and ')}, which only the runtime writes (S155)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S155', reason });
      throw new RefusedDispatch(reason, 'S155');
    }
    // Review C4: the hosted OutboxIntent instances are internal to the runtime; only its worker steps them.
    if (inst && this.modelOf(inst.machine_id)) {
      const reason = `${action} on ${instanceId}: an OutboxIntent instance is internal to the runtime, and only its worker takes its transitions (S119)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S119', reason });
      throw new RefusedDispatch(reason, 'S119');
    }
    const why = this.outsideType(instanceId, action, data, inst?.machine_id);
    if (why) {
      const reason = `${action} on ${instanceId}: ${why}, so it is no step (PS3.2, S140)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S140', reason });
      throw new RefusedDispatch(`${reason}: the input is outside its type`, 'S140');
    }
    // S173: a work order's completions are delivered by the runtime only, from the agent's report (K9).
    if (inst && this.workOrderCompletions(inst.machine_id).has(action)) {
      const reason = `K9: '${action}' completes a work order of '${instanceId}', and only the runtime delivers it, from the agent's report (S173)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'K9', reason });
      throw new RefusedDispatch(reason, 'K9');
    }
    if (inst && this.decisionCompletions(inst.machine_id).has(action)) {
      const reason = `K10: '${action}' completes a decision of '${instanceId}', and only the outbox worker delivers it, with its decision event`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'K10', reason });
      throw new RefusedDispatch(reason, 'K10');
    }
    // S162: in a scope that requires attribution, an effect's completion and a timer's target are started only by
    // their completion or timer, which carry the emitting step's origin. From outside they would start a chain with no
    // origin, so they are refused before any step, as K9 and K10 refuse theirs; the gate's deny stays the second line.
    if (inst && this.policyGate?.requiresAttribution(inst.machine_id.slice(0, inst.machine_id.lastIndexOf('.'))) && this.startedInside(inst.machine_id).has(action)) {
      const reason = `S162: '${action}' on '${instanceId}' is started only by an effect's completion or a timer, and its scope requires attribution, so an outside dispatch of it would start a chain with no origin`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S162', reason });
      throw new RefusedDispatch(reason, 'S162');
    }
    // PD5.1.4, K11: an action with claims gets them from the verifier adapter, under $claims; the module's first acceptor
    // rejects missing or bad ones (PS3.2's claims row). A verifier that throws is no answer: no claims (O10).
    let payload = data;
    if (inst && this.claimed(inst.machine_id, action)) {
      let claims: Record<string, unknown> | null = null;
      if (opts.credentials !== undefined) {
        try { claims = await this.verifier(opts.credentials, { instance: instanceId, action, data: data ?? {}, actionId }); } catch { claims = null; }
      }
      payload = { ...((data ?? {}) as object), $claims: claims ?? null };
    }
    // PD5.2.2a: an outside dispatch starts a chain, whatever its action id.
    this.store.outside.add(`${instanceId}\u0000${actionId}`);
    try {
      return await this.kernel.dispatch(instanceId, action, payload, actionId);
    } catch (e) {
      if (e instanceof InputOutsideType) {
        await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S140', reason: e.message });
        throw new RefusedDispatch(e.message, 'S140');
      }
      if (!(e instanceof OutcomeWithoutDecision)) throw e;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'PD2.4', reason: e.message });
      throw new RefusedDispatch(e.message, 'PD2.4');
    } finally {
      this.store.outside.delete(`${instanceId}\u0000${actionId}`);
    }
  }

  /** PD5.2.2: a step's lineage, with its seq, or null. */
  lineageOf(run: string, seq: number): (Lineage & { seq: number }) | null {
    const l = this.store.lineage(run, seq);
    return l ? { seq, ...l } : null;
  }

  /** PD5.2.2b: whether a step's lineage chain is whole, and how many hops it has. */
  verifyLineage(run: string, seq: number): { ok: true; hops: number } | { ok: false; problem: string } {
    return this.store.verifyLineage(run, seq);
  }

  /** PD5.1.2: whether an action of a machine requires claims (its contract has the field $claims). */
  claimed(machineId: string, action: string): boolean {
    return this.verified.machines.find((x) => x.id === machineId)?.types.get(action)?.some(([p]) => p === '$claims') ?? false;
  }

  /** S140: why data is outside an action's type on an instance's machine, or null (a runtime model's actions take none). */
  outsideType(instanceId: string, action: string, data: unknown, machineId?: string): string | null {
    const id = machineId ?? (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined);
    const m = this.verified.machines.find((x) => x.id === id);
    if (!m) return null;
    // Review C9: an address names a live instance of its machine, in the module of the machine that receives it.
    const module = m.id.slice(0, m.id.lastIndexOf('.'));
    const exists = (machine: string, ref: string) => this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(ref)?.machine_id === `${module}.${machine}`;
    return dataOutside(m.types, action, data, exists);
  }

  /** The manifest entry of an effect kind on an instance's machine, or null. */
  effectDeclaration(instanceId: string, kind: string): any {
    const id = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined;
    return this.verified.machines.find((x) => x.id === id)?.manifest?.effects?.[kind] ?? null;
  }

  /** Review C5: audit the K10 refusals the store made inside transactions that rolled back. */
  async auditRefusals(): Promise<void> {
    for (const e of this.store.refused.splice(0)) await this.store.insertAudit({ at: this.now(), instanceId: e.instanceId, action: e.action, actionId: e.actionId, rule: 'K10', reason: e.message });
  }

  /** The decision whose ok completion an action is, on a machine, or null. */
  decisionOf(machineId: string, action: string): string | null {
    const m = this.verified.machines.find((x) => x.id === machineId);
    for (const [kind, e] of Object.entries(m?.manifest?.effects ?? {})) if (e.decision && e.onSuccess?.action === action) return kind.slice('decision.'.length);
    return null;
  }

  /** S162: the actions an effect's completions and the machine's timers start, as the certified manifest names them. */
  startedInside(machineId: string): Set<string> {
    const m = this.verified.machines.find((x) => x.id === machineId);
    const out = new Set<string>((m?.manifest as { timerTargets?: string[] } | null)?.timerTargets ?? []);
    for (const e of Object.values(m?.manifest?.effects ?? {})) {
      if (e.decision || e.outcome) continue;
      for (const h of ['onSuccess', 'onFailure', 'onExhausted']) if (e[h]?.action) out.add(e[h].action);
    }
    return out;
  }

  /** S173: the tool a workflow maps an instance's effect kind to, or null when the kind is not a work order. */
  orderToolOf(instanceId: string, kind: string): (WorkOrderTool & { workflow: string }) | null {
    const id = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined;
    return (id && this.orderTools.get(id)?.get(kind)) || null;
  }

  /** S173: the actions a machine's work orders complete with, which only the runtime delivers (K9). */
  workOrderCompletions(machineId: string): Set<string> {
    const m = this.verified.machines.find((x) => x.id === machineId);
    const out = new Set<string>();
    for (const kind of this.orderTools.get(machineId)?.keys() ?? []) {
      const e = m?.manifest?.effects?.[kind];
      for (const h of ['onSuccess', 'onFailure', 'onExhausted']) if (e?.[h]?.action) out.add(e[h].action);
    }
    return out;
  }

  /** S173: the work orders open now, of one run or of all: each issued after the gate allowed it, and not yet reported. */
  async workOrders(instanceId?: string): Promise<WorkOrder[]> {
    return (await this.worker.openOrders(instanceId)).map(({ row, orderId, attempt, deadline }) => {
      const t = this.orderToolOf(row.instance_id, row.kind)!;
      return { orderId, intent: row.intent_id, instanceId: row.instance_id, workflow: t.workflow, kind: row.kind, tool: t.tool, ...(t.target !== undefined ? { target: t.target } : {}), why: t.why, args: row.payload as Record<string, unknown>, attempt, deadline };
    });
  }

  /** S173: the agent's report of a work order, which settles its intent; any report but the open attempt's is refused and audited. */
  reportWorkOrder(orderId: string, report: { ok: boolean; result?: unknown; error?: string; permanent?: boolean }): Promise<ReportOutcome> {
    return this.worker.report(orderId, report);
  }

  /** S173: the run an order id belongs to, or null when no intent has that id. */
  orderRun(orderId: string): string | null {
    const p = parseOrderId(orderId);
    return p ? (this.store.db.prepare('SELECT instance_id FROM pr_outbox WHERE intent_id = ?').get(p.intent)?.instance_id as string | undefined) ?? null : null;
  }

  /** PT10: the certified workflows, as polyflow's catalogue lists them (S174). */
  workflowList(): { name: string; admitted: true; guarantees: string[]; tools: string[]; key: { template: string; derived_from: string[] } }[] {
    return this.verified.workflows.map((w) => ({
      name: w.name,
      admitted: true as const,
      guarantees: this.certificate.guarantees.filter((g) => g.startsWith(`${w.machine}:`) && g !== `${w.machine}:deadlock-free`).map((g) => g.slice(w.machine.length + 1)),
      tools: Object.entries(w.tools).map(([kind, t]) => `${kind} -> ${t.tool}`),
      key: { template: w.key.template, derived_from: keyFields(w) },
    }));
  }

  private workflowNamed(name: string): VerifiedWorkflow {
    const w = this.verified.workflows.find((x) => x.name === name);
    if (!w) throw new WorkflowError(`unknown workflow '${name}'`);
    return w;
  }

  /**
   * PT10, S174: starts a run, or attaches to the run its key already names. The key is derived from the input (a key
   * the caller passes is ignored, with a note), so starting is idempotent. The run is created with the input action.
   */
  async startWorkflow(name: string, input: Record<string, unknown> = {}, key?: string): Promise<{ instanceId: string; key: string; note?: string; attached: boolean }> {
    const w = this.workflowNamed(name);
    const derived = deriveKey(w, input);
    const note = key && key !== derived ? `key '${key}' ignored: this workflow's runs are identified by ${w.key.template} = '${derived}', derived from the input you gave.` : undefined;
    const instanceId = runIdOf(name, derived);
    if (await this.store.getInstance(instanceId)) return { instanceId, key: derived, attached: true, ...(note ? { note } : {}) };
    await this.create(w.machine, { id: instanceId, creation: { action: w.inputAction, data: input } });
    return { instanceId, key: derived, attached: false, ...(note ? { note } : {}) };
  }

  /** PT10: a run as polyflow's tools show it: its state, whether it is done, and its open work orders. */
  async workflowView(instanceId: string): Promise<{ instance: string; workflow: string; key: string; status: string; state: Record<string, unknown>; done: boolean; seq: number; orders: WorkOrder[] }> {
    const inst = await this.store.getInstance(instanceId);
    const w = inst ? this.verified.workflows.find((x) => x.machine === inst.machine_id && instanceId.startsWith(`${x.name}|`)) : undefined;
    if (!inst || !w) throw new WorkflowError(`no run '${instanceId}'`);
    return { instance: instanceId, workflow: w.name, key: keyOfRun(instanceId), status: inst.status, state: inst.state as Record<string, unknown>, done: inst.status !== 'active', seq: inst.seq, orders: await this.workOrders(instanceId) };
  }

  /**
   * Takes every step that is due now (effects, timers and messages), until a pass finds nothing to do, at most `passes`
   * times, so a view after a report shows the next order the gate allowed.
   */
  async advance(passes = 32): Promise<void> {
    for (let k = 0; k < passes; k++) {
      const r = await this.tick();
      if (!r.effects && !r.timers && !r.messages) return;
    }
  }

  /** The actions a machine's decisions complete with, which only the worker dispatches (K10). */
  decisionCompletions(machineId: string): Set<string> {
    const m = this.verified.machines.find((x) => x.id === machineId);
    const out = new Set<string>();
    for (const e of Object.values(m?.manifest?.effects ?? {})) {
      if (!e.decision) continue;
      for (const h of ['onSuccess', 'onFailure', 'onExhausted']) if (e[h]?.action) out.add(e[h].action);
    }
    return out;
  }

  /** PD1.7, PD3: the provider of a decision, its model and its calibration map: runtime configuration, never certified. */
  provide(decision: string, config: ProviderConfig): void {
    const kind = `decision.${decision}`;
    const entry = this.verified.machines.map((m) => m.manifest?.effects?.[kind]).find(Boolean);
    if (!entry) throw new Error(`no decision ${decision} in the certified build`);
    if (config.calibration && config.calibration.decision !== decision) throw new Error(`the calibration map is for ${config.calibration.decision}, not ${decision}`);
    // Review B10, PD1.6: the decision event names the map by its digest, so the digest must be the map applied, and
    // the map must be the non-decreasing step function calibrate reads.
    if (config.calibration) {
      const c = config.calibration;
      if (c.digest !== mapDigest(c)) throw new Error(`the calibration map for ${decision} states digest ${c.digest}, and its points have ${mapDigest(c)}`);
      for (let i = 1; i < c.points.length; i++) {
        if (!(c.points[i][0] > c.points[i - 1][0])) throw new Error(`the calibration map for ${decision}: its raw values are not strictly ascending at point ${i}`);
        if (c.points[i][1] < c.points[i - 1][1]) throw new Error(`the calibration map for ${decision} is not non-decreasing at point ${i}: ${c.points[i - 1][1]} then ${c.points[i][1]}`);
      }
    }
    this.handlers.set(kind, decisionHandler(decision, entry.decision?.provider ?? null, config, this.records));
  }

  /**
   * PD2.2d: every accepted completion of a decision links a decision event of the run, and its data are the
   * recorded answer, confidence and margin, through the manifest's own map. Each problem is PL9003.
   */
  /**
   * PD5-A11: each step event's claims digest is its journal row's claims, and its lineage digest is the step's lineage
   * record, which recomputes. Each problem is listed.
   */
  async verifyAttribution(run: string): Promise<string[]> {
    const problems: string[] = [];
    const journal = await this.store.getJournal(run);
    for (const e of await this.chain(run)) {
      if (e.kind !== 'step') continue;
      const b = e.body as { seq: number; claims?: string; lineage?: string };
      const row = journal.find((x) => x.seq === b.seq);
      if (!row) continue;
      if (b.claims !== undefined && b.claims !== digest((row.data as { $claims?: unknown } | null)?.$claims ?? null)) problems.push(`step ${b.seq}: the claims digest is not the journal row's claims`);
      const l = this.store.lineage(run, b.seq);
      if (b.lineage !== undefined) {
        if (!l) problems.push(`step ${b.seq}: no lineage record for its lineage digest`);
        else if (l.digest !== b.lineage) problems.push(`step ${b.seq}: the lineage record's digest is not the step event's`);
        else if (lineageDigest(run, b.seq, l.origin, l.intent, l.prev) !== l.digest) problems.push(`step ${b.seq}: the lineage record does not recompute to its digest`);
      }
    }
    return problems;
  }

  async verifyProvenance(instanceId: string): Promise<string[]> {
    const inst = await this.store.getInstance(instanceId);
    const events = await this.chain(instanceId);
    const wf = events[0]?.run.wf ?? inst?.machine_id;
    const m = this.verified.machines.find((x) => x.id === wf);
    const problems: string[] = [];
    const byHash = new Map(events.map((e) => [e.hash, e]));
    for (const [, entry] of Object.entries(m?.manifest?.effects ?? {})) {
      if (!entry.decision || !entry.onSuccess?.action) continue;
      for (const e of events) {
        const b = e.body as Record<string, any>;
        if (e.kind !== 'step' || b.action !== entry.onSuccess.action || b.stepKind !== 'accepted') continue;
        const d = b.decision ? byHash.get(b.decision) : undefined;
        if (!d || d.kind !== 'decision') { problems.push(`step ${b.seq} (${b.action}) completes a decision and links no decision event`); continue; }
        const data = await this.store.body(b.data) as Record<string, unknown> | undefined;
        const result = d.body as Record<string, unknown>;
        for (const [field, path] of Object.entries(entry.onSuccess.map ?? {})) {
          const want = String(path).replace(/^\$\.result\.?/, '').split('.').filter(Boolean).reduce<any>((v, k) => (v == null ? v : v[k]), result);
          if (JSON.stringify(data?.[field]) !== JSON.stringify(want)) problems.push(`step ${b.seq} (${b.action}): ${field} is ${JSON.stringify(data?.[field])}, and the decision event records ${JSON.stringify(want)}`);
        }
      }
    }
    return problems;
  }


  getState(instanceId: string) { return this.kernel.getState(instanceId); }
  getStateAt(instanceId: string, seq: number) { return this.kernel.getStateAt(instanceId, seq); }
  getJournal(instanceId: string): Promise<JournalRow[]> { return this.kernel.getJournal(instanceId); }
  list(machineId: string, status?: string) { return this.kernel.list(machineId, status); }
  audit(instanceId?: string) { return this.store.listAudit(instanceId); }

  /** Every instance the store holds, with its snapshot: the fold's cache (PS11.4). */
  async instances(): Promise<{ id: string; machineId: string; status: string; state: Record<string, unknown> }[]> {
    return this.store.txn(() => this.store.db.prepare('SELECT instance_id, machine_id, status, state FROM pr_instance ORDER BY instance_id').all()
      .map((r) => ({ id: r.instance_id as string, machineId: r.machine_id as string, status: r.status as string, state: JSON.parse(r.state) as Record<string, unknown> })));
  }

  /** Every run with a chain, archived ones included (PT16). */
  runs() { return this.store.runs(); }

  /** A run's chain (PT16). */
  chain(instanceId: string): Promise<LedgerEvent[]> { return this.store.chain(instanceId); }
  async verifyChain(instanceId: string): Promise<ChainResult> { return verifyRunChain(await this.chain(instanceId)); }

  /** PT16: an `advice` event (a Polyx verdict) on a run; it has no write path into the program. */
  async advise(instanceId: string, verdict: unknown): Promise<LedgerEvent> {
    return this.store.txn(() => this.store.appendEvent(instanceId, 'advice', verdict, this.now()));
  }

  /** S123: signs the latest head of each run that moved; off the step path. */
  async signHeads(only?: string): Promise<SignedHead[]> {
    if (!this.ledger) return [];
    return signHeads(this.store, this.ledger, only);
  }

  heads(instanceId: string): Promise<SignedHead[]> { return headsOf(this.store, instanceId); }

  /** S123: an anchor over the latest signed head of every run, for the period it names. */
  /** PD5.4b, S108: countersigns the latest signed head of each run through the host's adapter. */
  async countersignHeads(adapter: CountersignAdapter): Promise<Countersignature[]> {
    return countersignHeads(this.store, adapter);
  }

  async publishAnchor(period: { from: number; to: number }): Promise<{ anchor: Anchor; heads: SignedHead[] }> {
    if (!this.ledger) throw new Error('no ledger signer: an anchor is signed (S123)');
    return publishAnchor(this.store, this.ledger, period);
  }

  /** The chain, the signed heads, the closure and the binding to the journal while it exists (PT16). */
  async verifyRun(instanceId: string, trust: Record<string, string>): Promise<RunVerification> {
    const exists = await this.store.getInstance(instanceId);
    // PD5-A11, review B4: with the run's lineage records, so the lineage digest is bound here as in poly journal verify.
    const lineage = new Map((this.store.db.prepare('SELECT seq, origin, intent, prev, digest FROM poly_lineage WHERE run = ?').all(instanceId) as { seq: number; origin: string; intent: string; prev: string | null; digest: string }[]).map((r) => [r.seq, { origin: JSON.parse(r.origin), intent: r.intent, prev: r.prev, digest: r.digest }]));
    return verifyRun(await this.chain(instanceId), await this.heads(instanceId), trust, exists ? await this.getJournal(instanceId) : null, lineage);
  }

  /**
   * Archives a terminal instance: its `closure` event, then polyrun's purge, in one transaction, then its head is
   * signed (S122, S123). The chain outlives the purge; polyrun 8.3.2 drops the dedupe keys with the journal, which
   * K4 forbids, until E1 (S124).
   */
  async archive(instanceId: string): Promise<LedgerEvent> {
    const inst = await this.store.getInstance(instanceId);
    if (!inst) throw new Error(`unknown instance '${instanceId}'`);
    const closure = await this.store.txn(async () => {
      const e = this.store.appendEvent(instanceId, 'closure', { outcome: 'archived', seq: inst.seq, status: inst.status }, this.now());
      await this.store.purgeInstance(instanceId, inst.seq);
      return e;
    });
    await this.signHeads(instanceId);
    return closure;
  }

  /** A run's chain, signed heads and the bodies its step events name, for an auditor (PT16 trace export). */
  async exportRun(instanceId: string): Promise<{ events: LedgerEvent[]; heads: SignedHead[]; bodies: Record<string, unknown> }> {
    const events = await this.chain(instanceId);
    const bodies: Record<string, unknown> = {};
    for (const e of events) {
      if (e.kind !== 'step') continue;
      for (const k of ['data', 'pre', 'post']) { const d = (e.body as Record<string, string>)[k]; bodies[d] = await this.store.body(d); }
    }
    return { events, heads: await this.heads(instanceId), bodies };
  }

  /** PT15 streams: every intent of a kind, after the gate allowed it. Handlers remain the only way to execute an effect. */
  intents(kind: string): { subscribe(f: (intent: any) => void): () => void } {
    return {
      subscribe: (f) => {
        if (!this.intentSubscribers.has(kind)) this.intentSubscribers.set(kind, new Set());
        this.intentSubscribers.get(kind)!.add(f);
        return () => this.intentSubscribers.get(kind)?.delete(f);
      },
    };
  }

  /** PT15 streams: every labelled step of an instance, after its transaction commits. */
  inputs(instanceId: string): { subscribe(f: (step: any) => void): () => void } {
    return {
      subscribe: (f) => {
        if (!this.inputSubscribers.has(instanceId)) this.inputSubscribers.set(instanceId, new Set());
        this.inputSubscribers.get(instanceId)!.add(f);
        return () => this.inputSubscribers.get(instanceId)?.delete(f);
      },
    };
  }

  /** Timers and messages run on polyrun's own workers; effects never do (S119). */
  async tick(now = this.now()): Promise<{ effects: number; timers: number; messages: number }> {
    // Review C6: each pass runs whatever another one threw; the first error is reported after all three.
    const errors: unknown[] = [];
    const pass = async (f: () => Promise<number>) => { try { return await f(); } catch (e) { errors.push(e); return 0; } };
    await pass(() => this.recoverMessages(now));
    const effects = await pass(() => this.worker.tick(now));
    const timers = await pass(() => this.kernel.workers.tickTimers(now));
    const messages = await pass(() => this.tickMessages(now));
    await this.auditRefusals();
    if (errors.length) throw errors[0];
    return { effects, timers, messages };
  }

  /**
   * A message whose delivery lease expired (the worker crashed after claiming it, or after the receiver's step and
   * before the mark) goes back to pending and is sent again; the receiver dedupes it (K4, PT9.8). polyrun does this
   * in its effect tick, which poly-runtime does not run (S119), so the runtime does it here.
   */
  /**
   * PS8.7, PT9.9: delivers the messages in transit. A message between two trust scopes is first proposed to the
   * policy gate in the sender's session: allowed, it is delivered; denied, it is not, and SendDenied(to, action,
   * reason) is dispatched to the sender with its own action id. An escalation of a send has no approval path in M5a,
   * so it is denied, and says so. A gate that cannot decide leaves the message pending (PT9.5). Within one scope,
   * and without policies, messages are delivered as polyrun delivers them.
   */
  async tickMessages(now = this.now()): Promise<number> {
    let n = 0;
    for (const m of await this.kernel.workers.pendingMessages()) {
      const fromMachine = (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(m.from) as { machine_id: string } | undefined)?.machine_id;
      const toMachine = (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(m.to) as { machine_id: string } | undefined)?.machine_id;
      const scope = (x: string | undefined) => (x ? x.slice(0, x.lastIndexOf('.')) : null);
      if (!this.policyGate || !fromMachine || !toMachine || scope(fromMachine) === scope(toMachine)) {
        if (await this.kernel.workers.deliverMessage(m.id, now)) n++;
        continue;
      }
      // Review D1, D2: a message has one gate decision. A delivery retried after an allow (the receiver's step committed
      // and the mark did not) is delivered under the recorded allow; a recorded deny is finished, not proposed again.
      const recorded = this.sendDecision(m.from, m.id);
      if (recorded?.outcome === 'allowed') { if (await this.kernel.workers.deliverMessage(m.id, now)) n++; continue; }
      if (recorded?.outcome === 'denied') { await this.sendDenied(m, recorded.reason ?? 'denied'); n++; continue; }
      // PD5.2.2b: the sender's step's lineage must be whole; a missing or broken chain is a deny with reason lineage.
      const outRow = this.store.db.prepare('SELECT seq FROM pr_outbox WHERE intent_id = ?').get(m.id) as { seq: number } | undefined;
      const chain = outRow ? this.store.verifyLineage(m.from, outRow.seq) : { ok: false as const, problem: 'the message has no sending step' };
      if (!chain.ok) {
        await this.store.txn(() => { this.store.appendEvent(m.from, 'verdict', { stage: 'gate', kind: 'send', intent: m.id, to: m.to, message: m.action, outcome: 'denied', reason: 'lineage', problem: chain.problem, gateDecision: 'lineage' }, this.now()); });
        await this.sendDenied(m, 'lineage');
        n++;
        continue;
      }
      const sender = await this.store.getInstance(m.from);
      let g;
      try {
        const l = outRow ? this.store.lineage(m.from, outRow.seq) : null;
        g = await this.policyGate.proposeSend({ id: m.id, from: m.from, to: m.to, fromMachine, toMachine, action: m.action, data: m.data, senderState: sender?.state ?? {}, lineage: l ? { origin: l.origin, intent: l.intent } : null });
      } catch (e) {
        const held = (e as { record?: Record<string, unknown> }).record;
        if (held) await this.store.txn(() => { const { action, ...rest } = held; this.store.appendEvent(m.from, 'verdict', { stage: 'gate', kind: 'send', intent: m.id, outcome: 'held', reason: String((e as Error).message), ...rest, gateDecision: 'held', action: this.store.keep(action) }, this.now()); });
        continue; // PT9.5: held, still pending
      }
      const { action, ...rest } = (g.record ?? {}) as Record<string, unknown>;
      const outcome = g.decision === 'allow' ? 'allowed' : 'denied';
      const reason = g.decision === 'allow' ? null : g.decision === 'escalate' ? `escalate:${g.reason ?? ''}: a send has no approval path in M5a, so it is denied` : g.reason;
      await this.store.txn(() => { this.store.appendEvent(m.from, 'verdict', { stage: 'gate', kind: 'send', intent: m.id, to: m.to, message: m.action, outcome, reason, ...rest, gateDecision: g.decision, action: this.store.keep(action) }, this.now()); });
      if (g.decision === 'allow') { if (await this.kernel.workers.deliverMessage(m.id, now)) n++; continue; }
      await this.sendDenied(m, reason ?? 'denied');
      n++;
    }
    return n;
  }

  /** The gate's recorded decision on a message, from the sender's verdict events, or null (a held answer is none). */
  private sendDecision(from: string, id: string): { outcome: 'allowed' | 'denied'; reason: string | null } | null {
    for (const r of this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict' ORDER BY seq DESC`).all(from) as { event: string }[]) {
      const b = JSON.parse(r.event).body as { kind?: string; intent?: string; outcome?: string; reason?: string | null };
      if (b?.kind === 'send' && b.intent === id && (b.outcome === 'allowed' || b.outcome === 'denied')) return { outcome: b.outcome, reason: b.reason ?? null };
    }
    return null;
  }

  /**
   * PT9.9: SendDenied to the sender, with its own action id (so a second dispatch is deduped), then the message is
   * dead. The message is pending and unclaimed, so it is marked here, not through polyrun's mark for a claimed row.
   */
  private async sendDenied(m: { id: string; from: string; to: string; action: string }, reason: string): Promise<void> {
    try { await this.kernel.dispatch(m.from, 'SendDenied', { to: m.to, action: m.action, reason }, `${m.id}:send-denied`); } catch (e) {
      await this.store.insertAudit({ at: this.now(), instanceId: m.from, action: 'SendDenied', actionId: `${m.id}:send-denied`, rule: 'PT9.9', reason: String((e as Error).message) });
    }
    await this.store.txn(() => { this.store.db.prepare("UPDATE pr_outbox SET status = 'dead', claimed_until = NULL, attempts = attempts + 1, last_error = ? WHERE intent_id = ? AND status = 'pending'").run(`send denied: ${reason}`, m.id); });
  }

  async recoverMessages(now = this.now()): Promise<number> {
    return this.store.txn(() => this.store.db.prepare("UPDATE pr_outbox SET status = 'pending', claimed_until = NULL WHERE kind = 'sendTo' AND status = 'inflight' AND claimed_until < ?").run(now).changes);
  }

  startWorkers({ effectPollMs = 200, timerPollMs = 200, messagePollMs = 200 }: { effectPollMs?: number; timerPollMs?: number; messagePollMs?: number } = {}): void {
    const report = (e: unknown) => console.error('[poly-runtime]', (e as Error)?.message ?? e);
    const w = setInterval(() => { this.worker.tick().catch(report); }, effectPollMs);
    w.unref?.();
    this.timers.push(w);
    const t = setInterval(() => { this.kernel.workers.tickTimers().catch(report); }, timerPollMs);
    // Review C6, as in tick: each pass runs whatever the one before it threw, so a failing recovery starves neither
    // the message pass nor the audit of its K10 refusals.
    const m = setInterval(() => {
      void (async () => {
        for (const pass of [() => this.recoverMessages(), () => this.tickMessages(), () => this.auditRefusals()]) await pass().catch(report);
      })();
    }, messagePollMs);
    t.unref?.(); m.unref?.();
    this.timers.push(t, m);
    if (this.ledger?.headMs) { const h = setInterval(() => { this.signHeads().catch(report); }, this.ledger.headMs); h.unref?.(); this.timers.push(h); }
    if (this.ledger?.anchorMs) {
      let from = this.now();
      const a = setInterval(() => { const to = this.now(); this.publishAnchor({ from, to }).then(() => { from = to; }).catch(report); }, this.ledger.anchorMs);
      a.unref?.(); this.timers.push(a);
    }
  }

  stopWorkers(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async close(): Promise<void> { this.stopWorkers(); await this.kernel.close(); }
}

export async function load(buildDir: string, opts: LoadOptions): Promise<PolyRuntime> {
  const verified = verifyBuild(buildDir, resolve(opts.certificate), opts.trust, { allowWitness: opts.allowWitness });
  const dbPath = opts.store?.sqlite ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  // S143: runtime.* and runtime<m>.* are the runtime's own ids, whatever this build or store needs. The checker refuses
  // them (PL1208); load refuses them again, so a certificate from an older toolchain cannot bring one in.
  const reserved = verified.machines.find((m) => RESERVED_MODULE.test(m.id.slice(0, m.id.lastIndexOf('.'))));
  if (reserved) throw new LoadError(`refused at load: the program's machine ${reserved.id} is in a module reserved for the runtime's own OutboxIntent model (PL1208, S143)`);
  const store = openLedgerStore(dbPath);
  // S119, S120: the OutboxIntent instance for every retry bound the build declares. Review C8: and every bound an
  // intent in the store started under, so it keeps its own machine after a redeploy changes the bound.
  const bounds = new Set<number>(verified.machines.flatMap((m) => Object.values(m.manifest?.effects ?? {}).map((e) => e.retry.maxAttempts as number)));
  for (const r of store.db.prepare("SELECT DISTINCT machine_id FROM pr_instance WHERE machine_id LIKE 'runtime%.OutboxIntent'").all() as { machine_id: string }[]) {
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(r.machine_id);
    if (m) bounds.add(m[1] ? Number(m[1]) : 3);
  }
  const models = verifiedModels([...bounds].filter((b) => BOUNDS.includes(b as 1)).sort((x, y) => x - y));
  let kernel: Runtime;
  const certified = new Map<string, Readonly<Record<string, unknown>>>();
  try {
    kernel = await createRuntime({
      store,
      machines: [
        ...verified.machines.map((m) => ({ machineId: m.id, module: m.module, ...(m.contract ? { contract: m.contract } : {}), ...(m.effects ? { effects: m.effects } : {}) })),
        ...models.map((x) => ({ machineId: x.machineId, module: x.module, contract: x.contract })),
      ],
      ...(opts.now ? { now: opts.now } : {}),
    });
    recheckCopy(verified);
    // S142: the handlers, imported from their verified copies, after the copies are checked again.
    for (const [path, copy] of verified.handlers) {
      let ns: Record<string, unknown>;
      try { ns = await import(pathToFileURL(copy).href) as Record<string, unknown>; } catch (e) { throw new LoadError(`refused at load: the certified handler file ${path} does not import: ${(e as Error).message} (S142)`); }
      certified.set(path, Object.freeze({ ...ns }));
    }
    // S119: polyrun's own effect worker must never run beside the one that hosts OutboxIntent.
    (kernel as unknown as { startWorkers: () => never }).startWorkers = () => { throw new Error('polyrun\'s workers do not run under poly-runtime; use rt.startWorkers (S119)'); };
  } catch (e) {
    await store.close();
    if (e instanceof LoadError) throw e;
    throw new LoadError(`refused at load: polyrun did not register the certified machines: ${(e as Error).message}`);
  }
  // PT9: a build with policies runs behind the policy gate, and only behind it.
  let policyGate: PolicyGate | null = null;
  if (verified.policies.length) {
    if (opts.gate?.gate) { await kernel.close(); throw new LoadError('refused at load: the build has policies, so its gate is the policy gate, and no other gate is taken (PT9)'); }
    const peer = polyaxionPeer();
    if (!peer.ok) { await kernel.close(); throw new LoadError(`refused at load: the build has policies, and the gate engine is not available: ${peer.reason}`); }
    const modules = [...new Set(verified.machines.map((m) => m.id.slice(0, m.id.lastIndexOf('.'))))];
    const view: ProgramView = {
      singleton: (machineId) => {
        const rows = store.db.prepare("SELECT instance_id, seq, state FROM pr_instance WHERE machine_id = ? AND status != 'poisoned'").all(machineId) as { instance_id: string; seq: number; state: string }[];
        return rows.length === 1 ? { instance: rows[0].instance_id, seq: rows[0].seq, state: JSON.parse(rows[0].state) } : null;
      },
      decisions: (run) => {
        const out: Record<string, unknown> = {};
        for (const r of store.db.prepare("SELECT event FROM poly_ledger WHERE run = ? AND kind = 'decision' ORDER BY seq").all(run) as { event: string }[]) {
          const b = JSON.parse(r.event).body as { decision: string };
          out[b.decision] = b;
        }
        return out;
      },
      lineage: (run, seq) => { const l = store.lineage(run, seq); return l ? { origin: l.origin, intent: l.intent } : null; },
      stepClaims: (run, seq) => { const r = store.db.prepare('SELECT data FROM pr_journal WHERE instance_id = ? AND seq = ?').get(run, seq) as { data: string } | undefined; const c = r ? JSON.parse(r.data)?.$claims : null; return c && typeof c === 'object' ? c : null; },
      nextSseq: (session) => (store.db.prepare('INSERT INTO poly_gate_session (session, sseq) VALUES (?, 1) ON CONFLICT(session) DO UPDATE SET sseq = sseq + 1 RETURNING sseq').get(session) as { sseq: number }).sseq,
      recordLate: (run, record) => {
        const { action, ...rest } = record;
        return store.txn(() => { store.appendEvent(run, 'verdict', { ...rest, action: store.keep(action) }, opts.now ? opts.now() : Date.now()); });
      },
    };
    const gateStore = opts.gate?.policy?.store ?? (opts.store?.sqlite ? `${resolve(opts.store.sqlite)}.gate.db` : ':memory:');
    try { policyGate = await PolicyGate.open(await loadPolyaxion(), verified.policies, modules, view, { ...opts.gate?.policy, store: gateStore }); } catch (e) {
      await kernel.close();
      throw new LoadError(`refused at load: the policy gate did not open: ${(e as Error).message}`);
    }
  }
  return new PolyRuntime(kernel, store, verified, opts.ledger, { gate: opts.gate, worker: opts.worker, certified, policyGate, transports: opts.transports, verifier: opts.verifier });
}
