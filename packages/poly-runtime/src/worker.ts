// The effect worker (PT9.7, S118, S119): it hosts the OutboxIntent machine. Each intent is an instance of the
// lowered OutboxIntent for its kind's retry bound (S120), and every transition the worker takes is a dispatch of
// one of that machine's actions, written in one transaction with the matching change to polyrun's outbox row and
// with the gate's verdict event on the emitting run. An action the machine rejects is a runtime fault: the worker
// stops on that intent, records it, and never takes the transition (PL2401 at runtime).
//
// Ordering, as polyrun's worker: a completion is dispatched first and the transition written second; the
// completion's action id dedupes a repeat, and recovery checks its journal row. A crash or an expired lease while
// Running is HandlerFailed and counts an attempt; the idempotency key keeps a re-run from repeating the effect.
// A row whose machine or manifest is unavailable is parked and takes no transition. Dead is terminal.
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import type { OutboxRow, Runtime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { InputOutsideType, type LedgerStore } from './ledger-store.js';
import { machineOfBound } from './model.js';

export interface Proposal {
  kind: 'effect';
  effectKind: string;
  labels: string[];
  class: string;
  machine: string;
  instance: string;
  seq: number;
  idempotencyKey: string;
  payloadDigest: string;
  stateDigest: string;
  approved?: { by: string; ref: string };
}

export type GateDecision = { decision: 'allow' } | { decision: 'deny'; reason: string; witnessDigest?: string } | { decision: 'escalate'; reason?: string };

/** PT9.1 to PT9.4, before M5's policy gate (S118): a decision is a function of the proposal and the snapshot (K6). */
export interface Gate {
  propose(proposal: Proposal, snapshot: Record<string, unknown>): GateDecision | Promise<GateDecision>;
  /** PT9.4: the observed result of the handler for this proposal, by digest. */
  settle(observed: { ok: boolean; output: string }, proposal: Proposal): 'ok' | 'failed' | Promise<'ok' | 'failed'>;
}

/** S118: the default gate allows every proposal and every settle. */
export const ALLOW_ALL: Gate = { propose: () => ({ decision: 'allow' }), settle: () => 'ok' };

export type EffectHandler = (payload: any, caps: Readonly<Record<string, never>>, ctx: { idempotencyKey: string; instanceId: string; seq: number; attempt: number }) => unknown;

/** S134: handlers receive no capabilities until M5. */
const NO_CAPABILITIES: Readonly<Record<string, never>> = Object.freeze({});

/** Deliberately drifting workers, for the runtime CI's PL2401 test only (test/runtime-drift.test.mjs). */
export const WORKER_DRIFTS = ['repropose-after-failure', 'resurrect-dead', 'denied-marked-done', 'retry-permanent'] as const;
export type WorkerDrift = (typeof WORKER_DRIFTS)[number];

export interface WorkerOptions {
  gate?: Gate;
  /** PT9.2: an escalation not approved within this time is denied. */
  escalationTimeoutMs?: number;
  leaseMs?: number;
  batch?: number;
  /** S140: why a completion's data is outside its action's type, or null. */
  outsideType?: (instanceId: string, action: string, data: unknown) => string | null;
  /** Built-in handlers by kind, which run without a host handler (the outcome of an adjudication, PD2.4). */
  builtins?: Record<string, EffectHandler>;
  /** Called with a completion's action id and the handler's result just before the completion is dispatched. */
  beforeCompletion?: (row: OutboxRow, decl: any, result: unknown) => void;
  afterCompletion?: (row: OutboxRow) => void;
  drift?: WorkerDrift;
  /** PT15: called with each intent the gate allowed, after its transaction commits. Observation only. */
  onAllowed?: (row: OutboxRow, proposal: Proposal) => void;
}

/** A worker whose claim was taken over (its lease expired and another pass reclaimed the row) stops quietly. */
export class StaleClaim extends Error {
  constructor(message: string) { super(message); this.name = 'StaleClaim'; }
}

type Fenced = OutboxRow & { fence?: number };

export class RuntimeFault extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeFault'; }
}

type IntentState = { intent: string; intent_decision?: number | null; intent_approved?: boolean | null; intent_attempts?: number | null; intent_attempt?: number | null };

const MAX_BACKOFF_MS = 60 * 60_000;

/** Completion data, as polyrun's worker resolves it: the manifest's `data`, then `map` paths over the context, else the fallback. */
function mapCompletion(hook: { data?: Record<string, unknown>; map?: Record<string, string> }, context: Record<string, unknown>, fallback: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(hook.data || {}) };
  if (hook.map && typeof hook.map === 'object') {
    for (const [field, path] of Object.entries(hook.map)) {
      let v: any = context;
      for (const part of String(path).replace(/^\$\.?/, '').split('.').filter(Boolean)) { if (v == null) break; v = v[part]; }
      out[field] = v;
    }
    return out;
  }
  return { ...fallback, ...out };
}

export class EffectWorker {
  readonly gate: Gate;
  private readonly escalationTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly batch: number;

  constructor(private readonly kernel: Runtime, private readonly store: LedgerStore, private readonly handlers: Map<string, EffectHandler>, private readonly opts: WorkerOptions = {}) {
    this.gate = opts.gate ?? ALLOW_ALL;
    this.escalationTimeoutMs = opts.escalationTimeoutMs ?? 24 * 60 * 60_000;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.batch = opts.batch ?? 16;
  }

  private get now(): number { return this.kernel.now(); }
  private decl(row: OutboxRow): any {
    const inst = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instance_id);
    if (!inst) return null;
    return this.kernel.machines.get(inst.machine_id)?.manifest?.effects?.[row.kind] ?? null;
  }
  intentId(row: { intent_id: string }): string { return `intent:${row.intent_id}`; }

  /** The intent's state, as the lowered OutboxIntent keeps it (PS9.1b: a tag and its payload fields). */
  async intentState(row: OutboxRow): Promise<IntentState | null> {
    const inst = await this.store.getInstance(this.intentId(row));
    return inst ? inst.state as IntentState : null;
  }

  /** One transition of the hosted machine. Inside a transaction when the caller opened one. */
  private async transition(row: OutboxRow, action: string): Promise<IntentState> {
    const id = this.intentId(row);
    // The claim is the fence: a transition is taken only while the row is still ours, as polyrun fences its marks on 'inflight'.
    const fence = (row as Fenced).fence;
    if (fence !== undefined) {
      const cur = this.store.db.prepare('SELECT status, claimed_until FROM pr_outbox WHERE intent_id = ?').get(row.intent_id);
      if (!cur || cur.status !== 'inflight' || cur.claimed_until !== fence) throw new StaleClaim(`the claim on ${row.intent_id} was taken over`);
    }
    const inst = await this.store.getInstance(id);
    if (!inst) throw new RuntimeFault(`no OutboxIntent instance for ${row.intent_id}`);
    // The action id is the transition and the seq it is taken from, so a repeat after a crash dedupes.
    const r = await this.kernel.dispatch(id, action, {}, `${action}@${inst.seq}`);
    if (r.stepKind !== 'accepted') throw new RuntimeFault(`the worker took ${action} on intent ${row.intent_id} in state ${(inst.state as IntentState).intent}, and OutboxIntent refuses it (${r.stepKind}${r.rejectReason ? ` "${r.rejectReason}"` : ''}): PL2401 RUNTIME_MODEL_DRIFT`);
    return r.state as IntentState;
  }

  private verdict(row: OutboxRow, body: Record<string, unknown>): void {
    this.store.appendEvent(row.instance_id, 'verdict', { stage: 'gate', intent: row.intent_id, effectKind: row.kind, ...body }, this.now);
  }

  private async dispatchCompletion(row: OutboxRow, hook: any, suffix: string, data: Record<string, unknown>): Promise<void> {
    if (!hook || !hook.action) return;
    const why = this.opts.outsideType?.(row.instance_id, hook.action, data);
    if (why) throw new InputOutsideType(`${hook.action} on ${row.instance_id}: ${why} (PS3.2, S140)`, row.instance_id, hook.action);
    await this.kernel.dispatch(row.instance_id, hook.action, data, `${row.intent_id}${suffix}`);
  }

  private journaled(row: OutboxRow, suffix: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM pr_journal WHERE instance_id = ? AND action_id = ?').get(row.instance_id, `${row.intent_id}${suffix}`);
  }

  private backoff(decl: any, attempts: number): number {
    const base = decl?.retry?.baseMs ?? 500;
    return Math.min(base * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  }

  /** PT9.1: the proposal, and PT9.3: the post-state of the emitting step, never a newer one. */
  async proposalOf(row: OutboxRow, decl: any, approved?: { by: string; ref: string }): Promise<{ proposal: Proposal; snapshot: Record<string, unknown> }> {
    const inst = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instance_id);
    const snapshot = await this.kernel.getStateAt(row.instance_id, row.seq);
    const proposal: Proposal = {
      kind: 'effect', effectKind: row.kind, labels: decl.labels ?? [], class: decl.class ?? 'none', machine: inst.machine_id,
      instance: row.instance_id, seq: row.seq, idempotencyKey: row.intent_id, payloadDigest: digest(row.payload), stateDigest: digest(snapshot),
      ...(approved ? { approved } : {}),
    };
    return { proposal, snapshot };
  }

  /** Expired leases (S119): Running is HandlerFailed and counts an attempt; any other state returns to pending. */
  private async recover(now: number): Promise<void> {
    const rows: OutboxRow[] = await this.store.txn(() => this.store.db.prepare(
      `SELECT * FROM pr_outbox WHERE status = 'inflight' AND kind <> 'sendTo' AND claimed_until < ?`).all(now)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) })));
    for (const row of rows) {
      // Reclaim first, so a worker still running on the old claim is fenced off.
      const fence = now + this.leaseMs;
      const taken = await this.store.txn(() => this.store.db.prepare(`UPDATE pr_outbox SET claimed_until = ? WHERE intent_id = ? AND status = 'inflight' AND claimed_until < ?`).run(fence, row.intent_id, now).changes);
      if (taken !== 1) continue;
      (row as Fenced).fence = fence;
      const st = await this.intentState(row);
      try {
        if (st?.intent === 'Running') await this.failed(row, this.decl(row), st.intent_attempt!, 'lease expired while running (a crash)', now, 'lost');
        else await this.store.txn(() => this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', claimed_until = NULL WHERE intent_id = ? AND status = 'inflight'`).run(row.intent_id));
      } catch (e) { if (!(e instanceof StaleClaim)) throw e; }
    }
  }

  /** One pass: recover expired leases, claim due rows, take each as far as it can go now. */
  async tick(now = this.now): Promise<number> {
    await this.recover(now);
    const claimed = await this.store.claimEffects(now, this.batch, this.leaseMs);
    for (const row of claimed) {
      (row as Fenced).fence = now + this.leaseMs; // the claimed_until polyrun's claimEffects wrote
      try {
        await this.run(row, now);
      } catch (e) {
        if (e instanceof StaleClaim) continue;
        if (!(e instanceof RuntimeFault)) throw e;
        // The worker stops on this intent: parked far ahead, the fault recorded, never the refused transition.
        await this.store.markEffectRetry(row.intent_id, row.attempts, now + 365 * 24 * 60 * 60_000, e.message);
        await this.store.insertAudit({ at: now, instanceId: row.instance_id, action: row.kind, actionId: row.intent_id, rule: 'PL2401', reason: e.message });
      }
    }
    return claimed.length;
  }

  /** PT9.2: a recorded approval re-proposes an escalated intent; in M4 it carries no person-key signature (S118). */
  async approve(intentId: string, approval: { by: string; ref: string }): Promise<void> {
    const row = await this.store.txn(() => this.store.db.prepare('SELECT * FROM pr_outbox WHERE intent_id = ?').get(intentId));
    if (!row) throw new Error(`no intent ${intentId}`);
    const r = { ...row, payload: JSON.parse(row.payload) } as OutboxRow;
    await this.store.txn(async () => {
      await this.transition(r, 'Approve');
      this.verdict(r, { outcome: 'approved', by: approval.by, ref: approval.ref, signed: false });
      this.store.db.prepare(`UPDATE pr_outbox SET next_attempt_at = ? WHERE intent_id = ? AND status = 'pending'`).run(this.now, intentId);
    });
  }

  private async run(row: OutboxRow, now: number): Promise<void> {
    const decl = this.decl(row);
    if (decl === null) {
      await this.store.markEffectRetry(row.intent_id, row.attempts, now + 30_000, `parked: machine or manifest unavailable for effect '${row.kind}', not executed`);
      return;
    }
    const m = decl.retry?.maxAttempts;
    if (!Number.isInteger(m)) throw new RuntimeFault(`effect ${row.kind} declares no retry.maxAttempts (S120)`);
    if (!(await this.store.getInstance(this.intentId(row)))) await this.kernel.create(machineOfBound(m), this.intentId(row));
    let result: unknown;
    let ran = false;
    for (;;) {
      const st = (await this.intentState(row))!;
      switch (st.intent) {
        case 'Pending':
          await this.store.txn(() => this.transition(row, 'Propose'));
          continue;
        case 'Escalated':
          if (st.intent_approved) { await this.store.txn(() => this.transition(row, 'Propose')); continue; }
          // Claimed while waiting: the escalation's time is up (PT9.2), so it is denied.
          await this.dispatchCompletion(row, decl.onFailure, ':failed', mapCompletion(decl.onFailure ?? {}, { error: { message: 'escalation-timeout', reason: 'escalation-timeout' } }, { reason: 'escalation-timeout' }));
          await this.store.txn(async () => {
            await this.transition(row, 'EscalationTimeout');
            this.verdict(row, { outcome: 'denied', reason: 'escalation-timeout' });
            await this.store.markEffectDead(row.intent_id, row.attempts, 'denied: escalation-timeout');
          });
          return;
        case 'Proposed': {
          const d = st.intent_decision!;
          const approval = d === 2 ? this.lastApproval(row) : undefined;
          const { proposal, snapshot } = await this.proposalOf(row, decl, approval);
          let g = await this.gate.propose(proposal, snapshot);
          // Rule 2 of PT9.7: an approved re-proposal is allowed or denied, never escalated again.
          if (d === 2 && g.decision === 'escalate') g = { decision: 'deny', reason: 'escalate-once' };
          const recorded = { decision: d, proposal: this.store.keep(proposal), snapshot: this.store.keep(snapshot) };
          if (g.decision === 'allow') {
            await this.store.txn(async () => { await this.transition(row, 'GateAllow'); this.verdict(row, { outcome: 'allowed', ...recorded }); });
            this.opts.onAllowed?.(row, proposal);
            continue;
          }
          if (g.decision === 'deny') {
            const deny = { reason: g.reason, witnessDigest: g.witnessDigest ?? null };
            await this.dispatchCompletion(row, decl.onFailure, ':failed', mapCompletion(decl.onFailure ?? {}, { error: { message: g.reason, ...deny } }, deny));
            await this.store.txn(async () => {
              await this.transition(row, 'GateDeny');
              this.verdict(row, { outcome: 'denied', reason: g.reason, witness: g.witnessDigest ?? null, ...recorded });
              if (this.opts.drift === 'denied-marked-done') { await this.store.markEffectDone(row.intent_id); return; }
              await this.store.markEffectDead(row.intent_id, row.attempts, `denied: ${g.reason}`);
            });
            return;
          }
          await this.store.txn(async () => {
            await this.transition(row, 'GateEscalate');
            this.verdict(row, { outcome: 'escalated', reason: g.decision === 'escalate' ? g.reason ?? null : null, ...recorded });
            this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', claimed_until = NULL, next_attempt_at = ? WHERE intent_id = ?`).run(now + this.escalationTimeoutMs, row.intent_id);
          });
          return;
        }
        case 'Allowed':
          if (this.opts.drift === 'repropose-after-failure' && st.intent_attempts! > 0) { await this.store.txn(() => this.transition(row, 'Propose')); continue; }
          await this.store.txn(() => this.transition(row, 'Start'));
          ran = false;
          try {
            result = await this.execute(row, decl, (await this.intentState(row))!.intent_attempt!);
            ran = true;
          } catch (e) {
            const n = (await this.intentState(row))!.intent_attempt!;
            const message = String((e as Error)?.message ?? e);
            // S138: a permanent error is final, and a drifting worker that retries it is what PL2401 is about.
            if ((e as { permanent?: boolean })?.permanent && this.opts.drift !== 'retry-permanent') await this.permanent(row, decl, n, message);
            else await this.failed(row, decl, n, message, now, (e as { permanent?: boolean })?.permanent ? 'permanent' : 'failed');
            return;
          }
          await this.store.txn(async () => { await this.transition(row, 'HandlerOk'); this.observed(row, (await this.intentState(row))!.intent_attempt!, 'ok'); });
          continue;
        case 'Running':
          // Found running at a claim: the previous attempt crashed (S119).
          await this.failed(row, decl, st.intent_attempt!, 'found running at claim (a crash)', now, 'lost');
          return;
        case 'Settled': {
          const n = st.intent_attempt!;
          if (!ran) {
            // Recovered: the result is gone. A completion already journaled is done; otherwise the settle failed.
            if (this.journaled(row, ':done')) { await this.settled(row); return; }
            await this.settleFailed(row, decl, n, 'settled before a crash, result lost', now);
            return;
          }
          const s = await this.gate.settle({ ok: true, output: digest(result ?? null) }, (await this.proposalOf(row, decl)).proposal);
          if (s !== 'ok') { await this.settleFailed(row, decl, n, 'the gate refused the settle', now); return; }
          this.opts.beforeCompletion?.(row, decl, result);
          try {
            await this.dispatchCompletion(row, decl.onSuccess, ':done', mapCompletion(decl.onSuccess ?? {}, { result }, result && typeof result === 'object' ? result as Record<string, unknown> : {}));
          } catch (e) {
            if (!(e instanceof InputOutsideType)) throw e;
            // S140: a result whose completion is outside its type takes no step; the settle failed, and the intent retries or dies.
            await this.store.insertAudit({ at: now, instanceId: row.instance_id, action: decl.onSuccess.action, actionId: `${row.intent_id}:done`, rule: 'S140', reason: e.message });
            await this.settleFailed(row, decl, n, 'the completion is outside its type (S140)', now);
            return;
          } finally { this.opts.afterCompletion?.(row); }
          await this.settled(row);
          return;
        }
        case 'Done':
          await this.store.markEffectDone(row.intent_id);
          return;
        case 'Denied':
        case 'Dead':
          if (this.opts.drift === 'resurrect-dead') { await this.store.txn(() => this.transition(row, 'Propose')); return; }
          await this.store.markEffectDead(row.intent_id, row.attempts, row.last_error ?? st.intent.toLowerCase());
          return;
        default:
          throw new RuntimeFault(`intent ${row.intent_id} is in ${st.intent}, a state OutboxIntent does not have: PL2401 RUNTIME_MODEL_DRIFT`);
      }
    }
  }

  private lastApproval(row: OutboxRow): { by: string; ref: string } | undefined {
    const events = this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict' ORDER BY seq DESC`).all(row.instance_id).map((r) => JSON.parse(r.event));
    const e = events.find((x) => x.body?.intent === row.intent_id && x.body?.outcome === 'approved');
    return e ? { by: e.body.by, ref: e.body.ref } : undefined;
  }

  private async execute(row: OutboxRow, decl: any, attempt: number): Promise<unknown> {
    const handler = this.handlers.get(row.kind) ?? this.opts.builtins?.[row.kind];
    if (typeof handler !== 'function') throw new Error(`no handler registered for effect '${row.kind}'`);
    const timeoutMs = Math.min(decl.retry?.timeoutMs ?? 30_000, Math.floor(this.leaseMs * 0.8));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`effect '${row.kind}' timed out after ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); });
    try {
      return await Promise.race([Promise.resolve(handler(row.payload, NO_CAPABILITIES, { idempotencyKey: row.intent_id, instanceId: row.instance_id, seq: row.seq, attempt })), timeout]);
    } finally { clearTimeout(timer); }
  }

  /** S138: each handler outcome, observed on the emitting run in the transaction of the transition it leads to. */
  private observed(row: OutboxRow, attempt: number, outcome: 'ok' | 'failed' | 'permanent' | 'lost'): void {
    this.store.appendEvent(row.instance_id, 'observation', { stage: 'handler', intent: row.intent_id, attempt, outcome }, this.now);
  }

  /** S138: HandlerFailedPermanent, Running to Dead, with the failed completion first and no further attempt. */
  private async permanent(row: OutboxRow, decl: any, n: number, message: string): Promise<void> {
    await this.dispatchCompletion(row, decl.onFailure, ':failed', mapCompletion(decl.onFailure ?? {}, { error: { message, permanent: true } }, { reason: message }));
    await this.store.txn(async () => {
      await this.transition(row, 'HandlerFailedPermanent');
      this.observed(row, n, 'permanent');
      await this.store.markEffectDead(row.intent_id, n, `permanent: ${message}`);
    });
  }

  /** HandlerFailed: back to Allowed with the attempt counted, or Dead at the bound with the exhausted completion first. */
  private async failed(row: OutboxRow, decl: any, n: number, message: string, now: number, outcome: 'failed' | 'lost' | 'permanent' = 'failed'): Promise<void> {
    const m = decl.retry.maxAttempts;
    if (n < m) {
      await this.store.txn(async () => {
        await this.transition(row, 'HandlerFailed');
        this.observed(row, n, outcome);
        this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, claimed_until = NULL, last_error = ? WHERE intent_id = ?`).run(n, now + this.backoff(decl, n), message, row.intent_id);
      });
      return;
    }
    const hook = decl.onExhausted || decl.onFailure;
    await this.dispatchCompletion(row, hook, ':exhausted', mapCompletion(hook ?? {}, { error: { message } }, { reason: 'exhausted' }));
    await this.store.txn(async () => {
      await this.transition(row, 'HandlerFailed');
      this.observed(row, n, outcome);
      await this.store.markEffectDead(row.intent_id, n, message);
    });
  }

  private async settleFailed(row: OutboxRow, decl: any, n: number, message: string, now: number): Promise<void> {
    const m = decl.retry.maxAttempts;
    if (n < m) {
      await this.store.txn(async () => {
        await this.transition(row, 'SettleFailed');
        this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, claimed_until = NULL, last_error = ? WHERE intent_id = ?`).run(n, now + this.backoff(decl, n), message, row.intent_id);
      });
      return;
    }
    const hook = decl.onExhausted || decl.onFailure;
    await this.dispatchCompletion(row, hook, ':exhausted', mapCompletion(hook ?? {}, { error: { message } }, { reason: 'exhausted' }));
    await this.store.txn(async () => {
      await this.transition(row, 'SettleFailed');
      await this.store.markEffectDead(row.intent_id, n, message);
    });
  }

  private async settled(row: OutboxRow): Promise<void> {
    await this.store.txn(async () => {
      await this.transition(row, 'SettleOk');
      await this.store.markEffectDone(row.intent_id);
    });
  }
}
