// The engines ship no type declarations. These are the parts poly-runtime uses, read from the vendored sources:
// polyrun's index, kernel, store and workers (vendor/polygraph, 755ac09) and the polyflow ledger and verifier
// (vendor/polyflow, 5170add).
declare module '@cognitive-fab/polygraph/polyrun/src/index.mjs' {
  export interface JournalRow {
    instance_id: string;
    machine_version: string;
    seq: number;
    action: string;
    data: Record<string, unknown>;
    pre: Record<string, unknown>;
    post: Record<string, unknown>;
    step_kind: 'accepted' | 'rejected' | 'unhandled';
    reject_reason: string | null;
    action_id: string;
    at: number;
  }
  export interface InstanceRow {
    instance_id: string;
    machine_id: string;
    machine_version: string;
    seq: number;
    status: 'active' | 'terminal' | 'poisoned';
    state: Record<string, unknown>;
    parent_instance_id: string | null;
    child_key: string | null;
    on_complete: string | null;
  }
  export interface OutboxRow {
    intent_id: string;
    instance_id: string;
    seq: number;
    kind: string;
    payload: any;
    status: 'pending' | 'inflight' | 'done' | 'dead';
    attempts: number;
    next_attempt_at: number;
    claimed_until: number | null;
    last_error: string | null;
  }
  export interface InsertJournal {
    instanceId: string; machineVersion: string; seq: number; action: string; data: unknown; pre: unknown; post: unknown;
    stepKind: string; rejectReason: string | null; actionId: string; now: number;
  }
  export interface CommitStep {
    instanceId: string; machineVersion: string; seq: number; journal: Record<string, unknown>; newState?: unknown; newStatus?: string;
    outboxRows: { intentId: string; kind: string; payload: unknown }[]; timerRows: unknown[]; cancelTimerKeys: string[]; cancelAllTimers: boolean; now: number;
  }
  export class Store {
    constructor(dbPath: string);
    db: { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): { changes: number }; get(...a: unknown[]): any; all(...a: unknown[]): any[] }; close(): void };
    fault: ((point: string) => void) | null;
    initSync(): this;
    init(): Promise<this>;
    close(): Promise<void>;
    txn<T>(fn: () => T | Promise<T>): Promise<T>;
    insertJournal(row: InsertJournal): Promise<unknown>;
    commitStep(step: CommitStep): Promise<void>;
    markPoisoned(instanceId: string, now: number): Promise<void>;
    getInstance(instanceId: string): Promise<InstanceRow | null>;
    getJournal(instanceId: string): Promise<JournalRow[]>;
    getJournalByActionId(instanceId: string, actionId: string): Promise<JournalRow | null>;
    purgeInstance(instanceId: string, expectedSeq?: number): Promise<void>;
    listAudit(instanceId?: string): Promise<{ instance_id: string; action: string; action_id: string; rule: string; reason: string }[]>;
    insertAudit(a: { at: number; instanceId: string; action: string; actionId: string; rule: string; reason: string }): Promise<unknown>;
    getOutbox(instanceId: string, status?: string): Promise<OutboxRow[]>;
    claimEffects(now: number, limit: number, leaseMs: number): Promise<OutboxRow[]>;
    markEffectDone(intentId: string): Promise<unknown>;
    markEffectRetry(intentId: string, attempts: number, nextAt: number, error: string): Promise<unknown>;
    markEffectDead(intentId: string, attempts: number, error: string): Promise<unknown>;
  }
  export interface DispatchResult { seq: number; stepKind: 'accepted' | 'rejected' | 'unhandled'; rejectReason?: string; state: Record<string, unknown>; terminal?: boolean; deduped?: boolean }
  export interface MachineRegistration { machineId: string; module: string; contract?: string; effects?: { mapper: string; manifest: string } }
  export class Runtime {
    store: Store;
    now: () => number;
    handlers: Record<string, (payload: unknown, intentId: string, ctx: unknown) => unknown>;
    machines: Map<string, { machineId: string; version: string; manifest: { effects?: Record<string, any> } | null; mod: any }>;
    events: { on(e: 'step', f: (step: any) => void): void; off(e: 'step', f: (step: any) => void): void };
    workers: Workers;
    create(machineId: string, instanceId?: string, creation?: { action: string; data?: unknown }): Promise<{ instanceId: string; created: boolean; state: Record<string, unknown> }>;
    dispatch(instanceId: string, action: string, data?: unknown, actionId?: string): Promise<DispatchResult>;
    getState(instanceId: string): Promise<{ state: Record<string, unknown>; status: string; seq: number; machineId: string }>;
    getStateAt(instanceId: string, seq: number): Promise<Record<string, unknown>>;
    getJournal(instanceId: string): Promise<JournalRow[]>;
    list(machineId: string, status?: string): Promise<InstanceRow[]>;
    close(): Promise<void>;
  }
  export class Workers {
    tickTimers(now?: number): Promise<number>;
    tickMessages(now?: number): Promise<number>;
    deliverMessage(id: string, now?: number): Promise<boolean>;
    pendingMessages(): Promise<{ id: string; from: string; to: string; action: string; data: unknown }[]>;
  }
  export class RefusedError extends Error { rule: string }
  export class PoisonedError extends Error {}
  export function createRuntime(config: { store: Store; machines: MachineRegistration[]; handlers?: Record<string, unknown>; now?: () => number; worker?: Record<string, unknown> }): Promise<Runtime>;
}

declare module '@cognitive-fab/polyflow-kernel' {
  export interface Run { ns: string; wf: string; run: string }
  export interface LedgerEvent { v: 1; run: Run; seq: number; kind: string; at: number; body: unknown; prev: string; hash: string }
  export const KINDS: readonly string[];
  export function genesis(run: Run): string;
  export function hashOf(event: Omit<LedgerEvent, 'hash'> & { hash?: string }): string;
  export function verifyChain(events: LedgerEvent[], opts?: { from?: { seq: number; hash: string } | null }): { ok: true; head: { seq: number; hash: string }; count: number } | { ok: false; seq: number | null; reason: string };
}

declare module '@cognitive-fab/polyflow-kernel/digest' {
  export function digest(value: unknown): string;
}

declare module '@cognitive-fab/polyflow-kernel/canonical' {
  export function canonical(value: unknown): string;
}

declare module '@cognitive-fab/polyflow-verify/sink' {
  import type { Run } from '@cognitive-fab/polyflow-kernel';
  export interface SignedHead { run: Run; seq: number; hash: string; keyId: string; alg: 'ed25519'; sig: string }
  export function headMessage(run: Run, head: { seq: number; hash: string }): string;
  export function signHead(run: Run, head: { seq: number; hash: string }, key: { keyId: string; privateKeyPem: string }): SignedHead;
  export function verifyHead(signed: SignedHead, trust: Record<string, string>): { ok: true } | { ok: false; reason: string };
}
