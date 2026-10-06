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
import { createHmac, randomBytes } from 'node:crypto';

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
CREATE TABLE IF NOT EXISTS poly_evidence (
  run  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (run, seq)
);
CREATE TABLE IF NOT EXISTS poly_revoked_mandate (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_ingress_nonce (
  channel TEXT NOT NULL,
  nonce   TEXT NOT NULL,
  until   INTEGER NOT NULL,
  PRIMARY KEY (channel, nonce)
);
CREATE TABLE IF NOT EXISTS poly_store_key (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  key BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_gate_session (
  session TEXT PRIMARY KEY,
  sseq    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poly_lineage (
  run    TEXT NOT NULL,
  seq    INTEGER NOT NULL,
  origin TEXT NOT NULL,
  intent TEXT NOT NULL,
  prev   TEXT,
  digest TEXT NOT NULL,
  PRIMARY KEY (run, seq)
);
CREATE INDEX IF NOT EXISTS poly_lineage_digest ON poly_lineage (digest);
CREATE TABLE IF NOT EXISTS poly_timer_cause (
  timer_id TEXT PRIMARY KEY,
  run      TEXT NOT NULL,
  seq      INTEGER NOT NULL
);
`;

/** PD5.2.2: a step's lineage: the origin (the claims that started the chain), the intent (that step's machine and action) and the previous hop's digest. */
export interface Lineage { origin: Record<string, unknown> | null; intent: string; prev: string | null; digest: string }

/** The digest of one hop: what it binds is the run, the step, the origin, the intent and the hop before it. */
export function lineageDigest(run: string, seq: number, origin: unknown, intent: string, prev: string | null): string {
  return digest({ run, seq, origin: origin ?? null, intent, prev });
}

/**
 * S140: PS3.2 defines steps only for data in the action's type. The SAM strict profile refuses data outside it
 * with a SamSchemaError, which polyrun journals as a rejected step; here, before that row is written, the whole
 * dispatch is refused instead, so no step, no journal row and no ledger event exist for it.
 */
/**
 * Review C5, K10: a decision's completion delivered by anything but the outbox worker (a message, a timer). Named
 * RefusedError so that polyrun's message worker dead-letters it, as it does a K9 refusal; the runtime audits it.
 */
export class DecisionCompletionRefused extends Error {
  readonly rule = 'K10';
  constructor(message: string, readonly instanceId: string, readonly action: string, readonly actionId: string) { super(message); this.name = 'RefusedError'; }
}

/** Review B6: an id whose run was archived; creating it again would extend a closed chain under another machine. */
export class ArchivedId extends Error {
  constructor(message: string) { super(message); this.name = 'ArchivedId'; }
}

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
  /** PS8.8, PS8.9: the evidence the verifier gave beside the step's claims, kept with the step and bound into its event. */
  evidence?: Record<string, unknown>;
}

export class LedgerStore extends Store {
  /** Events to write with the step whose `(instance, actionId)` is the key; set by the worker before it dispatches. */
  readonly pending = new Map<string, StepEvents>();
  /** Builds the events of a step's outbox rows inside its transaction (the outcome event, PD2.4). */
  /** Review C5: the actions that complete a decision on a machine, and whether a witness walk may deliver them. */
  decisionCompletions: ((machineId: string) => Set<string>) | null = null;
  allowWitnessCompletions = false;
  /** Review C5: refusals made inside a transaction that rolled back, for the runtime to audit after it. */
  readonly refused: DecisionCompletionRefused[] = [];
  onOutbox: ((instanceId: string, rows: CommitStep['outboxRows'], seq: number, now: number) => { kind: string; body: unknown }[]) | null = null;
  /** PD5.2.2a: the action ids of outside dispatches in flight; their steps start a chain, whatever their id looks like. */
  readonly outside = new Set<string>();

  /** PD5.2.2a: the step that caused a step, from its action id: a completion, a delivered message or a fired timer. */
  private causeOf(row: InsertJournal): { run: string; seq: number } | null {
    if (this.outside.has(`${row.instanceId}\u0000${row.actionId}`)) return null;
    const timer = /^timer:(.+)$/.exec(row.actionId);
    if (timer) {
      const t = this.db.prepare('SELECT run, seq FROM poly_timer_cause WHERE timer_id = ?').get(timer[1]) as { run: string; seq: number } | undefined;
      return t && t.run === row.instanceId ? t : null;
    }
    const completion = /^(.+):(done|failed|exhausted|send-denied)$/.exec(row.actionId);
    if (completion) {
      const o = this.db.prepare('SELECT instance_id, seq FROM pr_outbox WHERE intent_id = ?').get(completion[1]) as { instance_id: string; seq: number } | undefined;
      return o && o.instance_id === row.instanceId ? { run: o.instance_id, seq: o.seq } : null;
    }
    // A delivered message's action id is its intent id; the message must be addressed to this instance with this action.
    const m = this.db.prepare("SELECT instance_id, seq, payload FROM pr_outbox WHERE intent_id = ? AND kind = 'sendTo'").get(row.actionId) as { instance_id: string; seq: number; payload: string } | undefined;
    if (m) {
      const p = JSON.parse(m.payload) as { target?: string; action?: string };
      if (p.target === row.instanceId && p.action === row.action) return { run: m.instance_id, seq: m.seq };
    }
    return null;
  }

  /** A step's lineage, or null when it has none. */
  lineage(run: string, seq: number): Lineage | null {
    const r = this.db.prepare('SELECT origin, intent, prev, digest FROM poly_lineage WHERE run = ? AND seq = ?').get(run, seq) as { origin: string; intent: string; prev: string | null; digest: string } | undefined;
    return r ? { origin: JSON.parse(r.origin), intent: r.intent, prev: r.prev, digest: r.digest } : null;
  }

  /** PD5.2.2b: whether a step's chain is whole: every hop recomputes to its digest, and each previous hop is present. */
  verifyLineage(run: string, seq: number): { ok: true; hops: number } | { ok: false; problem: string } {
    let at: { run: string; seq: number } | null = { run, seq };
    let hops = 0;
    for (let guard = 0; at && guard < 100_000; guard++) {
      const r = this.db.prepare('SELECT run, seq, origin, intent, prev, digest FROM poly_lineage WHERE run = ? AND seq = ?').get(at.run, at.seq) as { run: string; seq: number; origin: string; intent: string; prev: string | null; digest: string } | undefined;
      if (!r) return { ok: false, problem: `${at.run} has no lineage at seq ${at.seq}` };
      if (lineageDigest(r.run, r.seq, JSON.parse(r.origin), r.intent, r.prev) !== r.digest) return { ok: false, problem: `the lineage of ${r.run} at seq ${r.seq} does not recompute to its digest` };
      hops++;
      if (r.prev === null) return { ok: true, hops };
      const p = this.db.prepare('SELECT run, seq, origin, intent FROM poly_lineage WHERE digest = ?').get(r.prev) as { run: string; seq: number; origin: string; intent: string } | undefined;
      if (!p) return { ok: false, problem: `the hop before ${r.run} at seq ${r.seq} is missing` };
      // PD5.2.2a, review B4: a hop inherits its previous hop's origin and intent.
      if (p.origin !== r.origin || p.intent !== r.intent) return { ok: false, problem: `the hop of ${r.run} at seq ${r.seq} does not inherit the origin and intent of the hop before it` };
      at = { run: p.run, seq: p.seq };
    }
    return { ok: false, problem: 'the chain does not end' };
  }

  override initSync(): this {
    super.initSync();
    this.db.exec(LEDGER_SCHEMA);
    initJournalTables(this);
    // Ruled on step 9: the store's own key, made when the store is, for keyed digests of addresses. It is read only by
    // recipientDigest, and never exported, logged, journaled or certified.
    this.db.prepare('INSERT OR IGNORE INTO poly_store_key (id, key) VALUES (1, ?)').run(randomBytes(32));
    return this;
  }

  /** PT25.1, ruled on step 9: a recipient's digest, an HMAC-SHA256 under the store's key, so it cannot be inverted by
   * enumerating addresses; one address gives one digest in one store. */
  recipientDigest(text: string): string {
    const k = this.db.prepare('SELECT key FROM poly_store_key WHERE id = 1').get() as { key: Uint8Array };
    return `hmac-sha256:${createHmac('sha256', Buffer.from(k.key)).update(text, 'utf8').digest('hex')}`;
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

  /** S189: a run of the runtime's own, with no instance behind it (the approvals drop folder's), named once. */
  ensureRun(run: string, ns: string, wf: string): void {
    this.db.prepare('INSERT OR IGNORE INTO poly_run (run, ns, wf) VALUES (?, ?, ?)').run(run, ns, wf);
  }

  /** Appends one event to a run's chain. Must be called inside a transaction of this store. */
  appendEvent(instanceId: string, kind: string, body: unknown, at: number): LedgerEvent {
    const run = this.runOfInstance(instanceId);
    const last = this.db.prepare('SELECT seq, hash, kind FROM poly_ledger WHERE run = ? ORDER BY seq DESC LIMIT 1').get(instanceId) ?? null;
    // Review B8, S122: a closure is a run's last event; nothing is chained after it.
    if (last?.kind === 'closure') throw new Error(`ledger: the run '${instanceId}' is closed at seq ${last.seq}; no ${kind} event is chained after its closure`);
    const event = nextEvent(run, last, kind, body, at);
    this.db.prepare('INSERT INTO poly_ledger (run, seq, kind, event, hash) VALUES (?, ?, ?, ?, ?)').run(instanceId, event.seq, kind, JSON.stringify(event), event.hash);
    return event;
  }

  /** Every journal row, with its `step` event (and the events the worker set for it) in the same transaction. */
  override async insertJournal(row: InsertJournal): Promise<unknown> {
    if (row.stepKind === 'rejected' && typeof row.rejectReason === 'string' && row.rejectReason.startsWith(`${SCHEMA_REJECTION}${row.action}'`)) {
      throw new InputOutsideType(`${row.action} on ${row.instanceId}: the input is outside its type, so it is no step (PS3.2, S140): ${row.rejectReason}`, row.instanceId, row.action);
    }
    if (row.seq === 0 && this.db.prepare("SELECT 1 FROM poly_ledger WHERE run = ? AND kind = 'closure'").get(row.instanceId)) {
      throw new ArchivedId(`instance '${row.instanceId}' was archived: its run is closed, and its id is not created again (K4)`);
    }
    const extra = this.pending.get(`${row.instanceId}\u0000${row.actionId}`);
    // Review C5, K10: only the worker delivers a decision's completion: its action id names a decision intent of this
    // instance. A message or any other path carrying one is refused before its step (S130).
    if (this.decisionCompletions) {
      const machine = this.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instanceId)?.machine_id as string | undefined;
      if (machine && this.decisionCompletions(machine).has(row.action)) {
        const m = /^(.+):(done|failed|exhausted)$/.exec(row.actionId);
        const intent = m ? this.db.prepare('SELECT kind FROM pr_outbox WHERE intent_id = ? AND instance_id = ?').get(m[1], row.instanceId) : null;
        const byWorker = typeof intent?.kind === 'string' && intent.kind.startsWith('decision.');
        const byWitness = this.allowWitnessCompletions && row.actionId.startsWith('witness:');
        if (!byWorker && !byWitness) {
          const e = new DecisionCompletionRefused(`K10: '${row.action}' completes a decision of '${row.instanceId}', and only the outbox worker delivers it (action id ${row.actionId})`, row.instanceId, row.action, row.actionId);
          this.refused.push(e);
          throw e;
        }
      }
    }
    // Review B2: the worker's success completion of a decision commits only with its decision record (K10, PD2.2).
    const done = /^(.+):done$/.exec(row.actionId);
    if (done && !extra?.before?.some((e) => e.kind === 'decision')) {
      const intent = this.db.prepare('SELECT kind FROM pr_outbox WHERE intent_id = ? AND instance_id = ?').get(done[1], row.instanceId);
      if (typeof intent?.kind === 'string' && intent.kind.startsWith('decision.')) {
        throw new DecisionWithoutRecord(`${row.action} completes ${intent.kind} on ${row.instanceId} with no decision record: its provider is not the provider host's (K10, PD2.2)`);
      }
    }
    const result = await super.insertJournal(row);
    // PD5.2.2a: the step's lineage. An outside action starts a chain with its claims as the origin; a step a completion,
    // a delivered message or a fired timer started inherits the causing step's origin and intent, one hop on.
    const cause = this.causeOf(row);
    const parent = cause ? this.lineage(cause.run, cause.seq) : null;
    const machine = (this.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instanceId)?.machine_id as string | undefined) ?? '';
    const claims = (row.data as { $claims?: unknown } | null)?.$claims;
    const origin = parent ? parent.origin : claims && typeof claims === 'object' ? claims as Record<string, unknown> : null;
    const intent = parent ? parent.intent : `${machine}.${row.action}`;
    const prev = parent ? parent.digest : null;
    const lineage = lineageDigest(row.instanceId, row.seq, origin, intent, prev);
    this.db.prepare('INSERT OR REPLACE INTO poly_lineage (run, seq, origin, intent, prev, digest) VALUES (?, ?, ?, ?, ?, ?)').run(row.instanceId, row.seq, JSON.stringify(origin), intent, prev, lineage);
    if (extra?.evidence) this.db.prepare('INSERT OR REPLACE INTO poly_evidence (run, seq, body) VALUES (?, ?, ?)').run(row.instanceId, row.seq, JSON.stringify(extra.evidence));
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
      // PD5-A11: the digest of the claims that admitted the step, and its lineage digest.
      claims: digest((row.data as { $claims?: unknown } | null)?.$claims ?? null),
      ...(extra?.evidence ? { evidence: digest(extra.evidence) } : {}),
      lineage,
    }, row.now);
    for (const e of extra?.after ?? []) this.appendEvent(row.instanceId, e.kind, e.body, row.now);
    return result;
  }

  /** The step's outbox rows can carry events of their own (an adjudication's outcome, PD2.4). */
  override async commitStep(step: CommitStep): Promise<void> {
    return this.txn(async () => {
      await super.commitStep(step);
      // PD5.2.2a: a timer's step inherits the lineage of the step that set it.
      for (const t of step.timerRows as { timerId: string }[]) this.db.prepare('INSERT OR REPLACE INTO poly_timer_cause (timer_id, run, seq) VALUES (?, ?, ?)').run(t.timerId, step.instanceId, step.seq);
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
