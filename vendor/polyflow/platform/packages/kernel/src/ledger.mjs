// The decision ledger — FR-LED.1/.2, technical spec §3.2 and §4.5.
//
// A per-run hash chain of typed decision events. It is computed INSIDE
// workflow code, so it must be pure: the same inputs produce the same chain on
// every replay, which is what lets it cost CPU on replay instead of billable
// Actions. Nothing here signs anything — signing needs keys and keys need I/O,
// so that happens where activities run (technical spec §5.3).
//
// A chain is identified by the run that STARTED it. A Continue-as-New execution
// resumes its predecessor's chain from the head it was handed; a retry, a cron
// run or a reset is a new execution with no such head, so it starts a chain of
// its own rather than forking one it shares a first-run id with.

import { digest } from './digest.mjs';

// `closure` ends an execution: completed, failed, cancelled or continued-as-new.
// It is what lets a verifier tell a finished record from a truncated one.
export const KINDS = Object.freeze(['admission', 'proposal', 'verdict', 'effect', 'observation', 'closure']);
const KIND_SET = new Set(KINDS);

/** The chain's anchor: what event 0's `prev` points at. */
export const genesis = (run) => digest({ genesis: { ns: run.ns, wf: run.wf, run: run.run } });

/** An event's own hash: the digest of the event with `hash` left out. */
export const hashOf = (event) => {
  const { hash, ...rest } = event;
  return digest(rest);
};

const checkRun = (run) => {
  if (!run || typeof run.wf !== 'string' || typeof run.run !== 'string') {
    throw new Error('a ledger needs run = { ns, wf, run } with string wf and run');
  }
  return { ns: String(run.ns ?? 'default'), wf: run.wf, run: run.run };
};

/**
 * Open a ledger for a run, or resume one (after Continue-as-New) from its head.
 *
 * @param {object} o
 * @param {{ns,wf,run}} o.run
 * @param {{seq:number, hash:string}} [o.head]  resume after this event
 */
export function openLedger({ run, head = null }) {
  const id = checkRun(run);
  let seq = head ? head.seq : -1;
  let prev = head ? head.hash : genesis(id);
  let buffer = [];   // appended, not yet drained onto a carrier
  const all = [];    // everything appended in this execution (for queries)

  function append(kind, body, at, hist) {
    if (!KIND_SET.has(kind)) throw new Error(`unknown ledger event kind '${kind}'`);
    if (!Number.isFinite(at)) throw new Error('ledger events need a finite workflow time `at`');
    const event = { v: 1, run: id, seq: seq + 1, kind, at, body: body ?? {}, prev };
    if (hist !== undefined && hist !== null) event.hist = hist;
    event.hash = hashOf(event);
    seq = event.seq;
    prev = event.hash;
    buffer.push(event);
    all.push(event);
    return event;
  }

  return {
    run: id,
    append,
    head: () => (seq < 0 ? null : { seq, hash: prev }),
    /** Events appended since the last drain, in order; empties the buffer. */
    drain() { const out = buffer; buffer = []; return out; },
    /** Not yet drained. */
    pending: () => buffer.length,
    events: () => all.slice(),
  };
}

/**
 * Verify a chain. Events must be the complete, ordered sequence for one run
 * from `from` (default: genesis). Returns { ok } or { ok:false, seq, reason }
 * naming the FIRST bad link — the thing an auditor needs to look at.
 */
export function verifyChain(events, { from = null } = {}) {
  if (!Array.isArray(events) || events.length === 0) return { ok: false, seq: null, reason: 'empty ledger' };
  const run = events[0].run;
  let seq = from ? from.seq : -1;
  let prev = from ? from.hash : genesis(run);
  for (const e of events) {
    if (!e || typeof e !== 'object') return { ok: false, seq: seq + 1, reason: 'not an event' };
    if (e.run?.wf !== run.wf || e.run?.run !== run.run || e.run?.ns !== run.ns) {
      return { ok: false, seq: e.seq, reason: 'event belongs to another run' };
    }
    if (e.seq !== seq + 1) {
      return { ok: false, seq: seq + 1, reason: e.seq > seq + 1 ? `missing event (next present is ${e.seq})` : `out of order (got ${e.seq})` };
    }
    if (e.v !== 1) return { ok: false, seq: e.seq, reason: `unsupported event version ${e.v}` };
    if (!KIND_SET.has(e.kind)) return { ok: false, seq: e.seq, reason: `unknown kind '${e.kind}'` };
    if (!Number.isFinite(e.at)) return { ok: false, seq: e.seq, reason: 'event time is not a finite number' };
    if (e.prev !== prev) return { ok: false, seq: e.seq, reason: 'prev does not match the preceding event' };
    if (hashOf(e) !== e.hash) return { ok: false, seq: e.seq, reason: 'hash does not match content' };
    seq = e.seq;
    prev = e.hash;
  }
  return { ok: true, head: { seq, hash: prev }, count: events.length };
}
