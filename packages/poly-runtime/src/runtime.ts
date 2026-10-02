// The host runtime API (PT15): polyrun's runtime with the certificate check at load, the ledger written in each
// step's transaction (S121), and, from the outbox worker on, the gate interface (S118, S119).
//
//   const rt = await load('./.poly/build', { certificate: './.poly/certificate.json', trust: { 'ops-2026': pem },
//                                           store: { sqlite: './orders.db' } })
//   const order = await rt.create('orders.Order')
//   const r = await rt.dispatch(order.id, 'Place', {}, { actionId: 'req-7781' })
//
// What M4's runtime does not do is stated in the certificate's `limits` and printed with it (S118, S134, S135).
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { createRuntime, type Runtime, type DispatchResult, type JournalRow } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import type { Certificate } from '@poly/core';
import { LedgerStore, openLedgerStore, InputOutsideType } from './ledger-store.js';
import { dataOutside } from './types.js';
import { verifyBuild, recheckCopy, LoadError, type VerifiedBuild } from './load.js';
import { verifyRunChain, type LedgerEvent, type ChainResult } from './ledger.js';
import { EffectWorker, ALLOW_ALL, type Gate, type EffectHandler, type WorkerDrift } from './worker.js';
import { verifiedModels, modelSource, BOUNDS } from './model.js';
import { decisionHandler, mapDigest, type DecisionRecord, type ProviderConfig } from './provider.js';
import { signHeads, headsOf, publishAnchor, verifyRun, type LedgerSigner, type SignedHead, type Anchor, type RunVerification } from './journal.js';

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
  /** S118: the gate interface; allow-all when omitted. */
  gate?: { gate?: Gate; escalationTimeoutMs?: number };
  worker?: { leaseMs?: number; batch?: number; drift?: WorkerDrift };
  /** S123: the head signer, and how often heads are signed and anchors published, off the step path. */
  ledger?: LedgerSigner & { headMs?: number; anchorMs?: number };
}

export type Handler = EffectHandler;

/** An outside dispatch that the runtime refuses before any step, with an audit row (K9, K10). */
/** PD2.4: an adjudication with no decision event to link; a checked program cannot reach it (PL6203). */
export class OutcomeWithoutDecision extends Error {
  constructor(message: string) { super(message); this.name = 'OutcomeWithoutDecision'; }
}

export class RefusedDispatch extends Error {
  constructor(message: string, readonly rule: string) { super(message); this.name = 'RefusedDispatch'; }
}

export class PolyRuntime {
  readonly handlers = new Map<string, Handler>();
  readonly worker: EffectWorker;
  /** Review B5: whether a gate was given at load; only then are recorded gate decisions recomputed. */
  readonly gateGiven: boolean;
  /** PD2.2: each decision's record, from the provider's return to its completion's commit, by intent id. */
  private readonly records = new Map<string, DecisionRecord>();
  private readonly inputSubscribers = new Map<string, Set<(step: unknown) => void>>();
  private readonly intentSubscribers = new Map<string, Set<(intent: unknown) => void>>();
  private timers: NodeJS.Timeout[] = [];

  constructor(readonly kernel: Runtime, readonly store: LedgerStore, readonly verified: VerifiedBuild, readonly ledger: LoadOptions['ledger'] = undefined, opts: Pick<LoadOptions, 'gate' | 'worker'> = {}) {
    this.gateGiven = opts.gate?.gate !== undefined;
    store.decisionCompletions = (machineId) => this.decisionCompletions(machineId);
    store.allowWitnessCompletions = verified.certificate.purpose === 'witness';
    const builtins: Record<string, EffectHandler> = {};
    for (const m of verified.machines) for (const kind of Object.keys(m.manifest?.effects ?? {})) if (kind.startsWith('outcome.')) builtins[kind] = () => ({});
    this.worker = new EffectWorker(kernel, store, this.handlers, {
      gate: opts.gate?.gate ?? ALLOW_ALL, escalationTimeoutMs: opts.gate?.escalationTimeoutMs, ...opts.worker, builtins,
      outsideType: (instanceId, action, data) => this.outsideType(instanceId, action, data),
      // PD2.2, K10: the decision event is written with the completion step, in its transaction.
      beforeCompletion: (row, decl) => {
        const record = decl?.decision ? this.records.get(row.intent_id) : undefined;
        if (record) this.store.pending.set(`${row.instance_id}\u0000${row.intent_id}:done`, { before: [{ kind: 'decision', body: record }] });
      },
      onAllowed: (row, proposal) => { for (const f of this.intentSubscribers.get(row.kind) ?? []) f({ intent: row.intent_id, kind: row.kind, instance: row.instance_id, seq: row.seq, payload: row.payload, proposal }); },
      afterCompletion: (row) => { this.store.pending.delete(`${row.instance_id}\u0000${row.intent_id}:done`); this.records.delete(row.intent_id); },
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
  async gateReplays(instanceId: string): Promise<{ seq: number; decision: string; recompute: (() => string) | null }[]> {
    const out: { seq: number; decision: string; recompute: (() => string) | null }[] = [];
    for (const e of await this.chain(instanceId)) {
      const b = e.body as Record<string, any>;
      if (e.kind !== 'verdict' || b?.stage !== 'gate' || !b.proposal) continue;
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
  approve(intentId: string, approval: { by: string; ref: string }): Promise<void> { return this.worker.approve(intentId, approval); }

  /** The outbox rows of an instance (polyrun's), for hosts and tests that watch the intents. */
  outbox(instanceId: string) { return this.store.getOutbox(instanceId); }

  /** One outbox row by its intent id (its status and attempts), or null. */
  async outboxRow(intentId: string): Promise<{ intent_id: string; instance_id: string; kind: string; status: string; attempts: number; last_error: string | null } | null> {
    return this.store.txn(() => this.store.db.prepare('SELECT intent_id, instance_id, kind, status, attempts, last_error FROM pr_outbox WHERE intent_id = ?').get(intentId) ?? null);
  }

  /** The runtime's own model behind a machine id (an OutboxIntent instance), or null for a program's machine. */
  modelOf(machineId: string): { source: string; module: string } | null {
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(machineId);
    // A program may name a machine runtime.OutboxIntent; load refuses it only where the runtime needs that model.
    if (!m || this.verified.machines.some((x) => x.id === machineId)) return null;
    const bound = m[1] ? Number(m[1]) : 3;
    return { source: modelSource(bound), module: verifiedModels([bound])[0].module };
  }

  /** PT15: a handler for an effect kind. It runs only from the outbox worker, after the gate allows (PT9.2). */
  handle(kind: string, handler: Handler): void {
    // Review B2: a decision's handler is the provider host's, which keeps the record its completion commits with.
    if (kind.startsWith('decision.')) throw new Error(`${kind} is a decision: register its provider with rt.provide, never rt.handle (PD2.2, K10)`);
    if (kind.startsWith('outcome.')) throw new Error(`${kind} is an adjudication's outcome, handled by the runtime itself (PD2.4)`);
    this.handlers.set(kind, handler);
  }

  async create(machineId: string, opts: { id?: string; creation?: { action: string; data?: unknown } } = {}): Promise<{ id: string; state: Record<string, unknown> }> {
    const r = await this.kernel.create(machineId, opts.id, opts.creation);
    return { id: r.instanceId, state: r.state };
  }

  /**
   * PT15. polyrun refuses an outside dispatch of a live child's completion (K9); this refuses one of a decision's
   * completion (K10, S130), since only the worker delivers it with its decision event, and an input outside its
   * action's type (S140). Each comes before any step, with an audit row and no journal row.
   */
  async dispatch(instanceId: string, action: string, data: unknown = {}, opts: { actionId?: string } = {}): Promise<DispatchResult> {
    const actionId = opts.actionId ?? `${action}:${randomUUID()}`;
    const inst = await this.store.getInstance(instanceId);
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
    if (inst && this.decisionCompletions(inst.machine_id).has(action)) {
      const reason = `K10: '${action}' completes a decision of '${instanceId}', and only the outbox worker delivers it, with its decision event`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'K10', reason });
      throw new RefusedDispatch(reason, 'K10');
    }
    try {
      return await this.kernel.dispatch(instanceId, action, data, actionId);
    } catch (e) {
      if (e instanceof InputOutsideType) {
        await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S140', reason: e.message });
        throw new RefusedDispatch(e.message, 'S140');
      }
      if (!(e instanceof OutcomeWithoutDecision)) throw e;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'PD2.4', reason: e.message });
      throw new RefusedDispatch(e.message, 'PD2.4');
    }
  }

  /** S140: why data is outside an action's type on an instance's machine, or null (a runtime model's actions take none). */
  outsideType(instanceId: string, action: string, data: unknown, machineId?: string): string | null {
    const id = machineId ?? (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined);
    const m = this.verified.machines.find((x) => x.id === id);
    return m ? dataOutside(m.types, action, data) : null;
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
  async publishAnchor(period: { from: number; to: number }): Promise<{ anchor: Anchor; heads: SignedHead[] }> {
    if (!this.ledger) throw new Error('no ledger signer: an anchor is signed (S123)');
    return publishAnchor(this.store, this.ledger, period);
  }

  /** The chain, the signed heads, the closure and the binding to the journal while it exists (PT16). */
  async verifyRun(instanceId: string, trust: Record<string, string>): Promise<RunVerification> {
    const exists = await this.store.getInstance(instanceId);
    return verifyRun(await this.chain(instanceId), await this.heads(instanceId), trust, exists ? await this.getJournal(instanceId) : null);
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
    const messages = await pass(() => this.kernel.workers.tickMessages(now));
    await this.auditRefusals();
    if (errors.length) throw errors[0];
    return { effects, timers, messages };
  }

  /**
   * A message whose delivery lease expired (the worker crashed after claiming it, or after the receiver's step and
   * before the mark) goes back to pending and is sent again; the receiver dedupes it (K4, PT9.8). polyrun does this
   * in its effect tick, which poly-runtime does not run (S119), so the runtime does it here.
   */
  async recoverMessages(now = this.now()): Promise<number> {
    return this.store.txn(() => this.store.db.prepare("UPDATE pr_outbox SET status = 'pending', claimed_until = NULL WHERE kind = 'sendTo' AND status = 'inflight' AND claimed_until < ?").run(now).changes);
  }

  startWorkers({ effectPollMs = 200, timerPollMs = 200, messagePollMs = 200 }: { effectPollMs?: number; timerPollMs?: number; messagePollMs?: number } = {}): void {
    const report = (e: unknown) => console.error('[poly-runtime]', (e as Error)?.message ?? e);
    const w = setInterval(() => { this.worker.tick().catch(report); }, effectPollMs);
    w.unref?.();
    this.timers.push(w);
    const t = setInterval(() => { this.kernel.workers.tickTimers().catch(report); }, timerPollMs);
    const m = setInterval(() => { this.recoverMessages().then(() => this.kernel.workers.tickMessages()).then(() => this.auditRefusals()).catch(report); }, messagePollMs);
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
  const store = openLedgerStore(dbPath);
  // S119, S120: the OutboxIntent instance for every retry bound the build declares. Review C8: and every bound an
  // intent in the store started under, so it keeps its own machine after a redeploy changes the bound.
  const bounds = new Set<number>(verified.machines.flatMap((m) => Object.values(m.manifest?.effects ?? {}).map((e) => e.retry.maxAttempts as number)));
  for (const r of store.db.prepare("SELECT DISTINCT machine_id FROM pr_instance WHERE machine_id LIKE 'runtime%.OutboxIntent'").all() as { machine_id: string }[]) {
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(r.machine_id);
    if (m && !verified.machines.some((x) => x.id === r.machine_id)) bounds.add(m[1] ? Number(m[1]) : 3);
  }
  const models = verifiedModels([...bounds].filter((b) => BOUNDS.includes(b as 1)).sort((x, y) => x - y));
  // Review C4, C8: a program machine with the id of a model the runtime registers would shadow it, or be stepped as it.
  const clash = models.find((x) => verified.machines.some((m) => m.id === x.machineId));
  if (clash) {
    await store.close();
    throw new LoadError(`refused at load: the program's machine ${clash.machineId} has the id of the runtime's own OutboxIntent model, which this build needs (S119)`);
  }
  let kernel: Runtime;
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
    // S119: polyrun's own effect worker must never run beside the one that hosts OutboxIntent.
    (kernel as unknown as { startWorkers: () => never }).startWorkers = () => { throw new Error('polyrun\'s workers do not run under poly-runtime; use rt.startWorkers (S119)'); };
  } catch (e) {
    await store.close();
    if (e instanceof LoadError) throw e;
    throw new LoadError(`refused at load: polyrun did not register the certified machines: ${(e as Error).message}`);
  }
  return new PolyRuntime(kernel, store, verified, opts.ledger, { gate: opts.gate, worker: opts.worker });
}
