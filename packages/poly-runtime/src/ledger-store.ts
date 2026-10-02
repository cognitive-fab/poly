// LedgerStore (S121): polyrun's SQLite store, subclassed so that the ledger is written in each step's own
// transaction. Every journal row reaches polyrun's store through `insertJournal`, inside the dispatch
// transaction (`commitStep`, `_createInTxn`, `recordUndeliverable`), so writing the `step` event there makes K1
// cover the ledger: the step and its events commit together or not at all. Nothing in polyrun changes (E4 is
// dropped); the subclass adds tables of its own to the same database.
//
// The content store keeps each body by digest, so the chain holds digests only (PT16, PD2.2a).
import { Store, type InsertJournal, type CommitStep } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import { canonical } from '@cognitive-fab/polyflow-kernel/canonical';
import { nextEvent, runOf, type LedgerEvent, type Run } from './ledger.js';
import { initJournalTables } from './journal.js';

const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS poly_ledger (
  run   TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  kind  TEXT NOT NULL,
  event TEXT NOT NULL,
  hash  TEXT NOT NULL,
  PRIMARY KEY (run, seq)
);
CREATE TABLE IF NOT EXISTS poly_run (
  run TEXT PRIMARY KEY,
  ns  TEXT NOT NULL,
  wf  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_content (
  digest TEXT PRIMARY KEY,
  body   TEXT NOT NULL
);
`;

/**
 * S140: PS3.2 defines steps only for data in the action's type. The SAM strict profile refuses data outside it
 * with a SamSchemaError, which polyrun journals as a rejected step; here, before that row is written, the whole
 * dispatch is refused instead, so no step, no journal row and no ledger event exist for it.
 */
export class InputOutsideType extends Error {
  constructor(message: string, readonly instanceId: string, readonly action: string) { super(message); this.name = 'InputOutsideType'; }
}

const SCHEMA_REJECTION = "Invalid proposal for intent '";

/** Review B2, K10: a decision's completion with no decision record held for it; its commit is refused. */
export class DecisionWithoutRecord extends Error {
  constructor(message: string) { super(message); this.name = 'DecisionWithoutRecord'; }
}

/** Events the runtime adds around a step, keyed by the step's action id (the decision record, PD2.2). */
export interface StepEvents {
  before?: { kind: string; body: unknown }[];
  after?: { kind: string; body: unknown }[];
}

export class LedgerStore extends Store {
  /** Events to write with the step whose `(instance, actionId)` is the key; set by the worker before it dispatches. */
  readonly pending = new Map<string, StepEvents>();
  /** Builds the events of a step's outbox rows inside its transaction (the outcome event, PD2.4). */
  onOutbox: ((instanceId: string, rows: CommitStep['outboxRows'], seq: number, now: number) => { kind: string; body: unknown }[]) | null = null;

  override initSync(): this {
    super.initSync();
    this.db.exec(LEDGER_SCHEMA);
    initJournalTables(this);
    return this;
  }

  /** The digest of a body, stored in the content store under it. Called inside a transaction. */
  keep(body: unknown): string {
    const d = digest(body ?? null);
    this.db.prepare('INSERT OR IGNORE INTO poly_content (digest, body) VALUES (?, ?)').run(d, canonical(body ?? null));
    return d;
  }

  /** The run of an instance, remembered at its first event so that it outlives an archive. */
  private runOfInstance(instanceId: string): Run {
    const known = this.db.prepare('SELECT ns, wf FROM poly_run WHERE run = ?').get(instanceId);
    if (known) return { ns: known.ns, wf: known.wf, run: instanceId };
    const inst = this.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId);
    if (!inst) throw new Error(`ledger: no instance '${instanceId}' to chain an event on`);
    const run = runOf(instanceId, inst.machine_id);
    this.db.prepare('INSERT INTO poly_run (run, ns, wf) VALUES (?, ?, ?)').run(instanceId, run.ns, run.wf);
    return run;
  }

  /** Appends one event to a run's chain. Must be called inside a transaction of this store. */
  appendEvent(instanceId: string, kind: string, body: unknown, at: number): LedgerEvent {
    const run = this.runOfInstance(instanceId);
    const last = this.db.prepare('SELECT seq, hash FROM poly_ledger WHERE run = ? ORDER BY seq DESC LIMIT 1').get(instanceId) ?? null;
    const event = nextEvent(run, last, kind, body, at);
    this.db.prepare('INSERT INTO poly_ledger (run, seq, kind, event, hash) VALUES (?, ?, ?, ?, ?)').run(instanceId, event.seq, kind, JSON.stringify(event), event.hash);
    return event;
  }

  /** Every journal row, with its `step` event (and the events the worker set for it) in the same transaction. */
  override async insertJournal(row: InsertJournal): Promise<unknown> {
    if (row.stepKind === 'rejected' && typeof row.rejectReason === 'string' && row.rejectReason.startsWith(`${SCHEMA_REJECTION}${row.action}'`)) {
      throw new InputOutsideType(`${row.action} on ${row.instanceId}: the input is outside its type, so it is no step (PS3.2, S140): ${row.rejectReason}`, row.instanceId, row.action);
    }
    const extra = this.pending.get(`${row.instanceId}\u0000${row.actionId}`);
    // Review B2: the worker's success completion of a decision commits only with its decision record (K10, PD2.2).
    const done = /^(.+):done$/.exec(row.actionId);
    if (done && !extra?.before?.some((e) => e.kind === 'decision')) {
      const intent = this.db.prepare('SELECT kind FROM pr_outbox WHERE intent_id = ? AND instance_id = ?').get(done[1], row.instanceId);
      if (typeof intent?.kind === 'string' && intent.kind.startsWith('decision.')) {
        throw new DecisionWithoutRecord(`${row.action} completes ${intent.kind} on ${row.instanceId} with no decision record: its provider is not the provider host's (K10, PD2.2)`);
      }
    }
    const result = await super.insertJournal(row);
    // A decision event keeps its question in the content store and carries its digest as `request` (PD2.2a).
    for (const e of extra?.before ?? []) {
      const { question, ...rest } = (e.body ?? {}) as Record<string, unknown>;
      this.appendEvent(row.instanceId, e.kind, question === undefined ? e.body : { ...rest, request: this.keep(question) }, row.now);
    }
    this.appendEvent(row.instanceId, 'step', {
      seq: row.seq,
      action: row.action,
      actionId: row.actionId,
      machineVersion: row.machineVersion,
      data: this.keep(row.data),
      stepKind: row.stepKind,
      rejectReason: row.rejectReason ?? null,
      pre: this.keep(row.pre),
      post: this.keep(row.post),
      ...(extra?.before?.length ? { decision: this.lastHash(row.instanceId, 'decision') } : {}),
    }, row.now);
    for (const e of extra?.after ?? []) this.appendEvent(row.instanceId, e.kind, e.body, row.now);
    return result;
  }

  /** The step's outbox rows can carry events of their own (an adjudication's outcome, PD2.4). */
  override async commitStep(step: CommitStep): Promise<void> {
    return this.txn(async () => {
      await super.commitStep(step);
      if (!this.onOutbox || !step.outboxRows.length) return;
      for (const e of this.onOutbox(step.instanceId, step.outboxRows, step.seq, step.now)) this.appendEvent(step.instanceId, e.kind, e.body, step.now);
    });
  }

  /** S122: a poisoning is an observation, written with the poison mark. */
  override async markPoisoned(instanceId: string, now: number): Promise<void> {
    return this.txn(async () => {
      await super.markPoisoned(instanceId, now);
      this.appendEvent(instanceId, 'observation', { poisoned: true }, now);
    });
  }

  /** PD2.4: the hash of the run's most recent `decision` event for a decision, or null. */
  lastDecision(instanceId: string, decision: string): string | null {
    for (const r of this.db.prepare("SELECT event, hash FROM poly_ledger WHERE run = ? AND kind = 'decision' ORDER BY seq DESC").all(instanceId)) {
      if (JSON.parse(r.event).body?.decision === decision) return r.hash;
    }
    return null;
  }

  /** The hash of the run's most recent event of a kind, or null. */
  lastHash(instanceId: string, kind: string): string | null {
    return this.db.prepare('SELECT hash FROM poly_ledger WHERE run = ? AND kind = ? ORDER BY seq DESC LIMIT 1').get(instanceId, kind)?.hash ?? null;
  }

  /** A run's chain, in order. */
  async chain(instanceId: string): Promise<LedgerEvent[]> {
    return this.txn(() => this.db.prepare('SELECT event FROM poly_ledger WHERE run = ? ORDER BY seq').all(instanceId).map((r) => JSON.parse(r.event) as LedgerEvent));
  }

  /** Every run with a chain. */
  async runs(): Promise<Run[]> {
    return this.txn(() => this.db.prepare('SELECT run, ns, wf FROM poly_run ORDER BY run').all().map((r) => ({ ns: r.ns, wf: r.wf, run: r.run })));
  }

  /** A body from the content store, or undefined when retention has removed it. */
  async body(d: string): Promise<unknown> {
    return this.txn(() => {
      const r = this.db.prepare('SELECT body FROM poly_content WHERE digest = ?').get(d);
      return r ? JSON.parse(r.body) : undefined;
    });
  }
}

export function openLedgerStore(dbPath: string): LedgerStore {
  return new LedgerStore(dbPath).initSync();
}
