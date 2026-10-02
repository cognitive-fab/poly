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
import { InputOutsideType, DecisionWithoutRecord, type LedgerStore } from './ledger-store.js';
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
  /** S147: how many times a stale allow of this intent was rechecked, when it was. */
  rechecks?: number;
}

/**
 * A gate's decision. `reads` names each singleton instance the decision read, with its `seq` (S147): no allow is acted
 * on once one of them has moved on. `record` is what the gate adds to the `verdict` event (its session, `sseq`, Σ
 * digests and reason, S146).
 */
export type GateDecision = ({ decision: 'allow' } | { decision: 'deny'; reason: string; witnessDigest?: string } | { decision: 'escalate'; reason?: string }) & { reads?: Record<string, number>; record?: Record<string, unknown> };

/** PT9.1 to PT9.4, before M5's policy gate (S118): a decision is a function of the proposal and the snapshot (K6). */
export interface Gate {
  propose(proposal: Proposal, snapshot: Record<string, unknown>): GateDecision | Promise<GateDecision>;
  /** PT9.4: the observed result of the handler for this proposal, by digest. */
  settle(observed: { ok: boolean; output: string }, proposal: Proposal): SettleResult | Promise<SettleResult>;
}

/** A settle's outcome, with what the gate adds to the ledger (its session and `sseq`, S146). */
export type SettleResult = 'ok' | 'failed' | { result: 'ok' | 'failed'; record?: Record<string, unknown> };

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
  /** How long a row whose transition the machine refused waits before it is tried again (every park has a deadline). */
  faultRetryMs?: number;
  /** Built-in handlers by kind, which run without a host handler (the outcome of an adjudication, PD2.4). */
  builtins?: Record<string, EffectHandler>;
  /** Called with a completion's action id and the handler's result just before the completion is dispatched. */
  beforeCompletion?: (row: OutboxRow, decl: any, result: unknown) => void;
  afterCompletion?: (row: OutboxRow) => void;
  drift?: WorkerDrift;
  /**
   * S147: whether the allow an intent holds is stale, because a singleton it read has moved on. By default the
   * `reads` of the allow are compared with each instance's current `seq`.
   */
  isStale?: (row: OutboxRow, reads: Record<string, number>) => boolean | Promise<boolean>;
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

type IntentState = { intent: string; intent_decision?: number | null; intent_approved?: boolean | null; intent_attempts?: number | null; intent_attempt?: number | null; intent_rechecks?: number | null };

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

  /** The claim is the fence: a transition or a completion is taken only while the row is still ours (review C2). */
  private checkFence(row: OutboxRow): void {
    const fence = (row as Fenced).fence;
    if (fence === undefined) return;
    const cur = this.store.db.prepare('SELECT status, claimed_until FROM pr_outbox WHERE intent_id = ?').get(row.intent_id);
    if (!cur || cur.status !== 'inflight' || cur.claimed_until !== fence) throw new StaleClaim(`the claim on ${row.intent_id} was taken over`);
  }

  /** One step of the hosted machine, accepted or (in a race the machine settles, review C3) rejected and journaled. */
  private async attempt(row: OutboxRow, action: string): Promise<{ accepted: boolean; reason: string | null; from: string }> {
    const id = this.intentId(row);
    this.checkFence(row);
    const inst = await this.store.getInstance(id);
    if (!inst) throw new RuntimeFault(`no OutboxIntent instance for ${row.intent_id}`);
    // The action id is the transition and the seq it is taken from, so a repeat after a crash dedupes.
    const r = await this.kernel.dispatch(id, action, {}, `${action}@${inst.seq}`);
    return { accepted: r.stepKind === 'accepted', reason: r.rejectReason ?? null, from: (inst.state as IntentState).intent };
  }

  /** One transition of the hosted machine. Inside a transaction when the caller opened one. */
  private async transition(row: OutboxRow, action: string): Promise<void> {
    const r = await this.attempt(row, action);
    if (!r.accepted) throw new RuntimeFault(`the worker took ${action} on intent ${row.intent_id} in state ${r.from}, and OutboxIntent refuses it (rejected${r.reason ? ` "${r.reason}"` : ''}): PL2401 RUNTIME_MODEL_DRIFT`);
  }

  /**
   * Review C1, C2: a terminal transition and the completion it delivers commit in one transaction (K1 extended to
   * the hosted OutboxIntent), behind the claim's fence: neither exists without the other, and a stale holder delivers
   * nothing.
   */
  private async finish(row: OutboxRow, action: string, completion: { hook: any; suffix: string; data: Record<string, unknown> } | null, after: () => Promise<void> | void): Promise<void> {
    await this.store.txn(async () => {
      this.checkFence(row);
      await this.transition(row, action);
      if (completion) await this.dispatchCompletion(row, completion.hook, completion.suffix, completion.data);
      await after();
    });
  }

  /** S120, review C8: the bound an intent was created under, from its own machine, whatever the manifest says now. */
  private async boundOf(row: OutboxRow): Promise<number> {
    const inst = await this.store.getInstance(this.intentId(row));
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(inst?.machine_id ?? '');
    if (!m) throw new RuntimeFault(`intent ${row.intent_id} is not an OutboxIntent instance`);
    return m[1] ? Number(m[1]) : 3;
  }

  private verdict(row: OutboxRow, body: Record<string, unknown>): void {
    this.store.appendEvent(row.instance_id, 'verdict', { stage: 'gate', intent: row.intent_id, effectKind: row.kind, ...body }, this.now);
  }

  private async dispatchCompletion(row: OutboxRow, hook: any, suffix: string, data: Record<string, unknown>): Promise<void> {
    if (!hook || !hook.action) return;
    const why = this.opts.outsideType?.(row.instance_id, hook.action, data);
    if (why) {
      const message = `${hook.action} on ${row.instance_id}: ${why} (PS3.2, S140)`;
      // A success's data comes from the handler, and its settle fails; a failure's cannot be delivered, so it is
      // audited and the intent still takes its terminal transition.
      if (suffix === ':done') throw new InputOutsideType(message, row.instance_id, hook.action);
      await this.store.insertAudit({ at: this.now, instanceId: row.instance_id, action: hook.action, actionId: `${row.intent_id}${suffix}`, rule: 'S140', reason: message });
      return;
    }
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
  async proposalOf(row: OutboxRow, decl: any, approved?: { by: string; ref: string }, rechecks = 0): Promise<{ proposal: Proposal; snapshot: Record<string, unknown> }> {
    const inst = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instance_id);
    const snapshot = await this.kernel.getStateAt(row.instance_id, row.seq);
    const proposal: Proposal = {
      kind: 'effect', effectKind: row.kind, labels: decl.labels ?? [], class: decl.class ?? 'none', machine: inst.machine_id,
      instance: row.instance_id, seq: row.seq, idempotencyKey: row.intent_id, payloadDigest: digest(row.payload), stateDigest: digest(snapshot),
      ...(approved ? { approved } : {}),
      ...(rechecks ? { rechecks } : {}),
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
        const decl = this.decl(row);
        // As at a claim: a row whose machine or manifest is unavailable is parked and takes no transition.
        if (decl === null) await this.store.markEffectRetry(row.intent_id, row.attempts, now + 30_000, `parked: machine or manifest unavailable for effect '${row.kind}', not executed`);
        else if (st?.intent === 'Running') await this.failed(row, decl, st.intent_attempt!, 'lease expired while running (a crash)', now, 'lost');
        else await this.store.txn(() => this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', claimed_until = NULL WHERE intent_id = ? AND status = 'inflight'`).run(row.intent_id));
      } catch (e) { if (!(e instanceof StaleClaim)) throw e; }
    }
  }

  /** One pass: recover expired leases, claim due rows, take each as far as it can go now. */
  async tick(now = this.now): Promise<number> {
    await this.recover(now);
    const claimed = await this.store.claimEffects(now, this.batch, this.leaseMs);
    const errors: unknown[] = [];
    for (const row of claimed) {
      (row as Fenced).fence = now + this.leaseMs; // the claimed_until polyrun's claimEffects wrote
      try {
        await this.run(row, now);
      } catch (e) {
        if (e instanceof StaleClaim) continue;
        if (!(e instanceof RuntimeFault)) { errors.push(e); continue; } // review C6: the rest of the batch still runs
        // The worker stops on this intent, the fault recorded, never the refused transition; every park has a deadline.
        await this.store.markEffectRetry(row.intent_id, row.attempts, now + (this.opts.faultRetryMs ?? 60 * 60_000), e.message);
        await this.store.insertAudit({ at: now, instanceId: row.instance_id, action: row.kind, actionId: row.intent_id, rule: 'PL2401', reason: e.message });
      }
    }
    // An unexpected error (a crash of the pass) is reported once the batch is done; its row recovers by its lease.
    if (errors.length) throw errors[0];
    return claimed.length;
  }

  /** PT9.2, PT12.5: a verified, signed approval re-proposes an escalated intent; the runtime checked the record. */
  async approve(intentId: string, approval: { by: string; person: string; record: string; subject: string; at: string }): Promise<void> {
    const row = await this.store.txn(() => this.store.db.prepare('SELECT * FROM pr_outbox WHERE intent_id = ?').get(intentId));
    if (!row) throw new Error(`no intent ${intentId}`);
    const r = { ...row, payload: JSON.parse(row.payload) } as OutboxRow;
    // Review C3: Approve and EscalationTimeout race; whichever commits first wins, and the other is a rejected step.
    const res = await this.store.txn(async () => {
      const a = await this.attempt(r, 'Approve');
      if (!a.accepted) return a;
      this.verdict(r, { outcome: 'approved', by: approval.by, person: approval.person, record: approval.record, escalation: approval.subject, at: approval.at, signed: true });
      this.store.db.prepare(`UPDATE pr_outbox SET next_attempt_at = ? WHERE intent_id = ? AND status = 'pending'`).run(this.now, intentId);
      return a;
    });
    if (!res.accepted) {
      throw new Error(res.from === 'Denied' ? `intent ${intentId}: the escalation timed out and the intent was denied before the approval (PT9.2)` : `intent ${intentId} is ${res.from}, not waiting for an approval`);
    }
  }

  private async run(row: OutboxRow, now: number): Promise<void> {
    const decl = this.decl(row);
    if (decl === null) {
      await this.store.markEffectRetry(row.intent_id, row.attempts, now + 30_000, `parked: machine or manifest unavailable for effect '${row.kind}', not executed`);
      return;
    }
    const declared = decl.retry?.maxAttempts;
    if (!Number.isInteger(declared)) throw new RuntimeFault(`effect ${row.kind} declares no retry.maxAttempts (S120)`);
    if (!(await this.store.getInstance(this.intentId(row)))) await this.kernel.create(machineOfBound(declared), this.intentId(row));
    // Review C8: the intent keeps the bound it was created under, across a redeploy that changes the manifest's.
    const m = await this.boundOf(row);
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
          {
            // Claimed while waiting: the escalation's time is up (PT9.2), so it is denied, unless an approval committed
            // first, in which case the timeout is a rejected step and the approved intent is proposed again (review C3).
            const won = await this.store.txn(async () => {
              const t = await this.attempt(row, 'EscalationTimeout');
              if (!t.accepted) return false;
              await this.dispatchCompletion(row, decl.onFailure, ':failed', mapCompletion(decl.onFailure ?? {}, { error: { message: 'escalation-timeout', reason: 'escalation-timeout' } }, { reason: 'escalation-timeout' }));
              this.verdict(row, { outcome: 'denied', reason: 'escalation-timeout' });
              await this.store.markEffectDead(row.intent_id, row.attempts, 'denied: escalation-timeout');
              return true;
            });
            if (won) return;
            continue;
          }
        case 'Proposed': {
          const d = st.intent_decision!;
          const approval = d === 2 ? this.lastApproval(row) : undefined;
          const { proposal, snapshot } = await this.proposalOf(row, decl, approval, st.intent_rechecks ?? 0);
          let g: GateDecision;
          try {
            g = await this.gate.propose(proposal, snapshot);
          } catch (e) {
            // Review C6: a gate that fails holds only this intent, Proposed with a backoff, and never allows it (PT9.5).
            await this.store.txn(async () => {
              this.checkFence(row);
              this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', claimed_until = NULL, next_attempt_at = ?, last_error = ? WHERE intent_id = ?`).run(now + this.backoff(decl, 1), `gate unavailable: ${String((e as Error)?.message ?? e)}`, row.intent_id);
            });
            return;
          }
          // Rule 2 of PT9.7: an approved re-proposal is allowed or denied, never escalated again.
          if (d === 2 && g.decision === 'escalate') g = { decision: 'deny', reason: 'escalate-once' };
          const recorded = { decision: d, proposal: this.store.keep(proposal), snapshot: this.store.keep(snapshot), ...(g.reads ? { reads: g.reads } : {}), ...(g.record ?? {}) };
          if (g.decision === 'allow') {
            await this.store.txn(async () => { await this.transition(row, 'GateAllow'); this.verdict(row, { outcome: 'allowed', ...recorded }); });
            this.opts.onAllowed?.(row, proposal);
            continue;
          }
          if (g.decision === 'deny') {
            const deny = { reason: g.reason, witnessDigest: g.witnessDigest ?? null };
            await this.finish(row, 'GateDeny', { hook: decl.onFailure, suffix: ':failed', data: mapCompletion(decl.onFailure ?? {}, { error: { message: g.reason, ...deny } }, deny) }, async () => {
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
          // S147: no allow outlives the state it read. A stale allow is rechecked, at most twice, and then denied.
          if (await this.stale(row)) {
            if ((st.intent_rechecks ?? 0) < 2) {
              await this.store.txn(async () => { await this.transition(row, 'Recheck'); this.verdict(row, { outcome: 'rechecked', reason: 'stale-allow' }); });
              continue;
            }
            const stale = { reason: 'stale-allow' };
            await this.finish(row, 'Recheck', { hook: decl.onFailure, suffix: ':failed', data: mapCompletion(decl.onFailure ?? {}, { error: { message: 'stale-allow', ...stale } }, stale) }, async () => {
              this.verdict(row, { outcome: 'denied', reason: 'stale-allow' });
              await this.store.markEffectDead(row.intent_id, row.attempts, 'denied: stale-allow');
            });
            return;
          }
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
            else await this.failed(row, decl, n, message, now, (e as { permanent?: boolean })?.permanent ? 'permanent' : 'failed', m);
            return;
          }
          await this.store.txn(async () => { await this.transition(row, 'HandlerOk'); this.observed(row, (await this.intentState(row))!.intent_attempt!, 'ok'); });
          continue;
        case 'Running':
          // Found running at a claim: the previous attempt crashed (S119).
          await this.failed(row, decl, st.intent_attempt!, 'found running at claim (a crash)', now, 'lost', m);
          return;
        case 'Settled': {
          const n = st.intent_attempt!;
          if (!ran) {
            // Recovered: the result is gone. A completion already journaled is done; otherwise the settle failed.
            if (this.journaled(row, ':done')) { await this.settled(row); return; }
            await this.settleFailed(row, decl, n, 'settled before a crash, result lost', now, m);
            return;
          }
          let s: 'ok' | 'failed';
          try {
            const r = await this.gate.settle({ ok: true, output: digest(result ?? null) }, (await this.proposalOf(row, decl)).proposal);
            s = typeof r === 'string' ? r : r.result;
            // S146: the gate's settle is a ledger event, with its session sequence.
            if (typeof r === 'object' && r.record) await this.store.txn(() => this.verdict(row, { outcome: 'settled', result: s, ...r.record }));
          } catch { s = 'failed'; }
          if (s !== 'ok') { await this.settleFailed(row, decl, n, 'the gate refused the settle', now, m); return; }
          this.opts.beforeCompletion?.(row, decl, result);
          try {
            await this.finish(row, 'SettleOk', { hook: decl.onSuccess, suffix: ':done', data: mapCompletion(decl.onSuccess ?? {}, { result }, result && typeof result === 'object' ? result as Record<string, unknown> : {}) }, () => this.store.markEffectDone(row.intent_id).then(() => undefined));
          } catch (e) {
            if (!(e instanceof InputOutsideType) && !(e instanceof DecisionWithoutRecord)) throw e;
            // S140, review B2: a completion that cannot be a step (outside its type, or a decision with no record) takes
            // none; the settle failed, and the intent retries or dies.
            const rule = e instanceof InputOutsideType ? 'S140' : 'K10';
            await this.store.insertAudit({ at: now, instanceId: row.instance_id, action: decl.onSuccess.action, actionId: `${row.intent_id}:done`, rule, reason: e.message });
            await this.settleFailed(row, decl, n, rule === 'S140' ? 'the completion is outside its type (S140)' : 'the decision has no record (K10)', now, m);
            return;
          } finally { this.opts.afterCompletion?.(row); }
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

  /** S147: the allow this intent holds read a singleton that has moved on since. */
  private async stale(row: OutboxRow): Promise<boolean> {
    const events = this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict' ORDER BY seq DESC`).all(row.instance_id).map((r) => JSON.parse(r.event));
    const allowed = events.find((x) => x.body?.intent === row.intent_id && x.body?.outcome === 'allowed');
    const reads: Record<string, number> = allowed?.body?.reads ?? {};
    if (this.opts.isStale) return this.opts.isStale(row, reads);
    for (const [instance, seq] of Object.entries(reads)) {
      const now = this.store.db.prepare('SELECT seq FROM pr_instance WHERE instance_id = ?').get(instance)?.seq;
      if (now !== seq) return true;
    }
    return false;
  }

  private lastApproval(row: OutboxRow): { by: string; ref: string } | undefined {
    const events = this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict' ORDER BY seq DESC`).all(row.instance_id).map((r) => JSON.parse(r.event));
    const e = events.find((x) => x.body?.intent === row.intent_id && x.body?.outcome === 'approved');
    // The gate sees who approved and the intent it approved (Polyaxion's approved.ref is the escalated call's id).
    return e ? { by: e.body.by, ref: row.intent_id } : undefined;
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
    await this.finish(row, 'HandlerFailedPermanent', { hook: decl.onFailure, suffix: ':failed', data: mapCompletion(decl.onFailure ?? {}, { error: { message, permanent: true } }, { reason: message }) }, async () => {
      this.observed(row, n, 'permanent');
      await this.store.markEffectDead(row.intent_id, n, `permanent: ${message}`);
    });
  }

  /** HandlerFailed: back to Allowed with the attempt counted, or Dead at the bound with the exhausted completion first. */
  private async failed(row: OutboxRow, decl: any, n: number, message: string, now: number, outcome: 'failed' | 'lost' | 'permanent' = 'failed', bound?: number): Promise<void> {
    const m = bound ?? await this.boundOf(row);
    if (n < m) {
      await this.store.txn(async () => {
        await this.transition(row, 'HandlerFailed');
        this.observed(row, n, outcome);
        this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, claimed_until = NULL, last_error = ? WHERE intent_id = ?`).run(n, now + this.backoff(decl, n), message, row.intent_id);
      });
      return;
    }
    const hook = decl.onExhausted || decl.onFailure;
    await this.finish(row, 'HandlerFailed', { hook, suffix: ':exhausted', data: mapCompletion(hook ?? {}, { error: { message } }, { reason: 'exhausted' }) }, async () => {
      this.observed(row, n, outcome);
      await this.store.markEffectDead(row.intent_id, n, message);
    });
  }

  private async settleFailed(row: OutboxRow, decl: any, n: number, message: string, now: number, bound?: number): Promise<void> {
    const m = bound ?? await this.boundOf(row);
    if (n < m) {
      await this.store.txn(async () => {
        await this.transition(row, 'SettleFailed');
        this.store.db.prepare(`UPDATE pr_outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, claimed_until = NULL, last_error = ? WHERE intent_id = ?`).run(n, now + this.backoff(decl, n), message, row.intent_id);
      });
      return;
    }
    const hook = decl.onExhausted || decl.onFailure;
    await this.finish(row, 'SettleFailed', { hook, suffix: ':exhausted', data: mapCompletion(hook ?? {}, { error: { message } }, { reason: 'exhausted' }) }, async () => {
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
