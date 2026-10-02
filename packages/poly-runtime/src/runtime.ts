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
import { dirname, resolve } from 'node:path';
import { createRuntime, type Runtime, type DispatchResult, type JournalRow } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import type { Certificate } from '@poly/core';
import { LedgerStore, openLedgerStore } from './ledger-store.js';
import { verifyBuild, recheckCopy, LoadError } from './load.js';
import { verifyRunChain, type LedgerEvent, type ChainResult } from './ledger.js';

export { LoadError };

export interface LoadOptions {
  certificate: string;
  /** Trusted admission keys: key id to public key, PEM. The runtime never reads a private key at load. */
  trust: Record<string, string>;
  /** S135: SQLite only. ':memory:' when omitted. */
  store?: { sqlite: string };
  now?: () => number;
}

export type Handler = (payload: any, caps: Readonly<Record<string, never>>, ctx: { idempotencyKey: string; instanceId: string; seq: number; attempt: number }) => unknown;

/** An outside dispatch that the runtime refuses before any step, with an audit row (K9, K10). */
export class RefusedDispatch extends Error {
  constructor(message: string, readonly rule: string) { super(message); this.name = 'RefusedDispatch'; }
}

export class PolyRuntime {
  readonly handlers = new Map<string, Handler>();
  private readonly inputSubscribers = new Map<string, Set<(step: unknown) => void>>();
  private timers: NodeJS.Timeout[] = [];

  constructor(readonly kernel: Runtime, readonly store: LedgerStore, readonly certificate: Certificate) {
    kernel.events.on('step', (step) => {
      for (const f of this.inputSubscribers.get(step.instanceId) ?? []) f(step);
    });
  }

  get now(): () => number { return this.kernel.now; }

  /** PT15: a handler for an effect kind. It runs only from the outbox worker, after the gate allows (PT9.2). */
  handle(kind: string, handler: Handler): void { this.handlers.set(kind, handler); }

  async create(machineId: string, opts: { id?: string; creation?: { action: string; data?: unknown } } = {}): Promise<{ id: string; state: Record<string, unknown> }> {
    const r = await this.kernel.create(machineId, opts.id, opts.creation);
    return { id: r.instanceId, state: r.state };
  }

  /** PT15. polyrun refuses an outside dispatch of a live child's completion (K9). */
  async dispatch(instanceId: string, action: string, data: unknown = {}, opts: { actionId?: string } = {}): Promise<DispatchResult> {
    return this.kernel.dispatch(instanceId, action, data, opts.actionId);
  }

  getState(instanceId: string) { return this.kernel.getState(instanceId); }
  getStateAt(instanceId: string, seq: number) { return this.kernel.getStateAt(instanceId, seq); }
  getJournal(instanceId: string): Promise<JournalRow[]> { return this.kernel.getJournal(instanceId); }
  list(machineId: string, status?: string) { return this.kernel.list(machineId, status); }
  audit(instanceId?: string) { return this.store.listAudit(instanceId); }

  /** A run's chain (PT16). */
  chain(instanceId: string): Promise<LedgerEvent[]> { return this.store.chain(instanceId); }
  async verifyChain(instanceId: string): Promise<ChainResult> { return verifyRunChain(await this.chain(instanceId)); }

  /** PT16: an `advice` event (a Polyx verdict) on a run; it has no write path into the program. */
  async advise(instanceId: string, verdict: unknown): Promise<LedgerEvent> {
    return this.store.txn(() => this.store.appendEvent(instanceId, 'advice', verdict, this.now()));
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
  async tick(now = this.now()): Promise<{ timers: number; messages: number }> {
    return { timers: await this.kernel.workers.tickTimers(now), messages: await this.kernel.workers.tickMessages(now) };
  }

  startWorkers({ timerPollMs = 200, messagePollMs = 200 }: { timerPollMs?: number; messagePollMs?: number } = {}): void {
    const report = (e: unknown) => console.error('[poly-runtime]', (e as Error)?.message ?? e);
    const t = setInterval(() => { this.kernel.workers.tickTimers().catch(report); }, timerPollMs);
    const m = setInterval(() => { this.kernel.workers.tickMessages().catch(report); }, messagePollMs);
    t.unref?.(); m.unref?.();
    this.timers.push(t, m);
  }

  stopWorkers(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async close(): Promise<void> { this.stopWorkers(); await this.kernel.close(); }
}

export async function load(buildDir: string, opts: LoadOptions): Promise<PolyRuntime> {
  const verified = verifyBuild(buildDir, resolve(opts.certificate), opts.trust);
  const dbPath = opts.store?.sqlite ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const store = openLedgerStore(dbPath);
  let kernel: Runtime;
  try {
    kernel = await createRuntime({
      store,
      machines: verified.machines.map((m) => ({ machineId: m.id, module: m.module, ...(m.contract ? { contract: m.contract } : {}), ...(m.effects ? { effects: m.effects } : {}) })),
      ...(opts.now ? { now: opts.now } : {}),
    });
    recheckCopy(verified);
  } catch (e) {
    await store.close();
    if (e instanceof LoadError) throw e;
    throw new LoadError(`refused at load: polyrun did not register the certified machines: ${(e as Error).message}`);
  }
  return new PolyRuntime(kernel, store, verified.certificate);
}
