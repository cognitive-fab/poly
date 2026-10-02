// The ledger (PT16, S122): a hash chain per run, in the polyflow platform's event format.
//
// Events are `{ v: 1, run: { ns, wf, run }, seq, kind, at, body, prev, hash }`, hashed with polyflow's own
// `hashOf` and anchored at polyflow's `genesis` (vendor/polyflow), so a poly chain and a polyflow chain are the
// same object. polyflow's `verifyChain` refuses the four kinds poly adds until engine change E2 lands, so the
// chain is verified here by the same rules over the ten kinds; `verifyWithPolyflow` says when E2 is in.
import { KINDS as POLYFLOW_KINDS, genesis, hashOf, verifyChain, type LedgerEvent, type Run } from '@cognitive-fab/polyflow-kernel';

export type { LedgerEvent, Run };

/** PT16: polyflow's six kinds, and poly's four. */
export const POLY_KINDS = ['step', 'advice', 'decision', 'outcome'] as const;
export const KINDS: readonly string[] = [...POLYFLOW_KINDS, ...POLY_KINDS];

/** S122: `ns` is the module, `wf` the machine, `run` the instance id. */
export function runOf(instanceId: string, machineId: string): Run {
  const dot = machineId.indexOf('.');
  return { ns: dot > 0 ? machineId.slice(0, dot) : 'default', wf: machineId, run: instanceId };
}

/** The next event of a chain whose last event is `last` (null at genesis). */
export function nextEvent(run: Run, last: { seq: number; hash: string } | null, kind: string, body: unknown, at: number): LedgerEvent {
  if (!KINDS.includes(kind)) throw new Error(`unknown ledger event kind '${kind}'`);
  if (!Number.isFinite(at)) throw new Error('ledger events need a finite time `at` in milliseconds (S122)');
  const event = { v: 1 as const, run, seq: last ? last.seq + 1 : 0, kind, at, body: body ?? {}, prev: last ? last.hash : genesis(run) };
  return { ...event, hash: hashOf(event) };
}

export type ChainResult = { ok: true; head: { seq: number; hash: string }; count: number } | { ok: false; seq: number | null; reason: string };

/**
 * polyflow's `verifyChain`, rule for rule, over poly's ten kinds: the same run throughout, consecutive seq from
 * 0, version 1, a known kind, a finite time, each `prev` the hash before it, each `hash` its content's. The first
 * bad link is named.
 */
export function verifyRunChain(events: LedgerEvent[]): ChainResult {
  if (!Array.isArray(events) || events.length === 0) return { ok: false, seq: null, reason: 'empty ledger' };
  const run = events[0].run;
  let seq = -1;
  let prev = genesis(run);
  for (const e of events) {
    if (!e || typeof e !== 'object') return { ok: false, seq: seq + 1, reason: 'not an event' };
    if (e.run?.wf !== run.wf || e.run?.run !== run.run || e.run?.ns !== run.ns) return { ok: false, seq: e.seq, reason: 'event belongs to another run' };
    if (e.seq !== seq + 1) return { ok: false, seq: seq + 1, reason: e.seq > seq + 1 ? `missing event (next present is ${e.seq})` : `out of order (got ${e.seq})` };
    if (e.v !== 1) return { ok: false, seq: e.seq, reason: `unsupported event version ${e.v}` };
    if (!KINDS.includes(e.kind)) return { ok: false, seq: e.seq, reason: `unknown kind '${e.kind}'` };
    if (!Number.isFinite(e.at)) return { ok: false, seq: e.seq, reason: 'event time is not a finite number' };
    if (e.prev !== prev) return { ok: false, seq: e.seq, reason: 'prev does not match the preceding event' };
    if (hashOf(e) !== e.hash) return { ok: false, seq: e.seq, reason: 'hash does not match content' };
    seq = e.seq;
    prev = e.hash;
  }
  return { ok: true, head: { seq, hash: prev }, count: events.length };
}

/** True once E2 is vendored: polyflow's own verifier accepts every kind poly writes. */
export const polyflowAcceptsPolyKinds = (): boolean => POLY_KINDS.every((k) => POLYFLOW_KINDS.includes(k));

/** polyflow's verifier itself, for when E2 is in (and for chains of polyflow's six kinds before). */
export const verifyWithPolyflow = (events: LedgerEvent[]): ChainResult => verifyChain(events);
