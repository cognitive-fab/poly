// The PolicyKernel — gate() / settle() / mediate() (docs/polyman-spec.md §8).
// Deployment-agnostic: adapters (vercel.ts, openhands/) are thin shells that
// feed this. Default-deny everywhere; a denial is observable and journaled.
import { loadEngine } from './engine.ts';
import { loadSecurity } from './config.ts';
import { defaultPolicyMachine, defaultSecurityPath } from './defaults.ts';
import { makeLabeler } from './labeler.ts';
import { compileRegion } from './region.ts';
import { memoryStore } from './session-store.ts';
import { memoryJournal } from './journal.ts';
import type {
  AbstractAction, Decision, Journal, JournalEntry, Polyman, PolymanOptions, SamState, SessionStore, ToolCall,
} from './types.ts';

export async function createPolyman(opts: PolymanOptions = {}): Promise<Polyman> {
  const security = loadSecurity(opts.security ?? defaultSecurityPath());
  const engine = opts.engine ?? loadEngine(opts.machine ?? defaultPolicyMachine());
  const labeler = opts.labeler ?? makeLabeler(security);
  const stateKeys = Object.keys(engine.init());
  const regions = security.forbiddenRegions.map((r) => ({ name: r.name, inRegion: compileRegion(r.predicate, stateKeys) }));
  const regionNames = new Set(regions.map((r) => r.name));

  const store: SessionStore = opts.store ?? memoryStore(engine.init);
  const journal: Journal = opts.journal ?? memoryJournal();

  // ── Per-session serialization (spec §14.1) ────────────────────────────────
  // gate()/settle() on the SAME session must be an atomic read-modify-write even
  // when the store is async (Redis/SQL have await points at which two racing
  // gates would both read the same stale pre-state and last-write-wins would
  // drop a taint flag). A per-session promise chain enforces it. In-process,
  // single-instance only — a multi-process store needs CAS / a distributed lock.
  const locks = new Map<string, Promise<void>>();
  function withSession<T>(session: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(session) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run after the previous op settles, pass or fail
    // keep a swallowed tail so one rejection can't poison the chain
    const tail = run.then(() => undefined, () => undefined);
    locks.set(session, tail);
    // Evict when the chain drains: if no newer op chained after this tail, drop
    // the entry so the map does not grow one-per-session forever (the lock holds
    // no state — the store does — so a fresh chain later is equivalent).
    tail.then(() => { if (locks.get(session) === tail) locks.delete(session); });
    return run;
  }

  const entry = (
    session: string, pre: SamState, actions: AbstractAction[], call: ToolCall, post: SamState,
    decision: 'allow' | 'reject' | 'settle', reason?: string, region?: string, note?: string,
  ): JournalEntry => ({
    session, ts: Date.now(), pre, action: actions.map((a) => a.action),
    data: { tool: call.tool, args: call.args }, post, decision, reason, region, note,
  });

  // ── Evidence degrade path (availability-spec SS-2/SS-3/SS-7/SS-8) ─────────
  // The journal is EVIDENCE, not a decision input: a failed append must degrade
  // the record, never the decision. A failing entry goes to a bounded in-memory
  // spill buffer (oldest dropped and COUNTED on overflow — SS-7) and is
  // re-emitted in original order, marked `spilled: true`, the next time the
  // sink accepts a write (SS-8). record() never throws.
  const SPILL_CAP = 1000;
  const spill: JournalEntry[] = [];
  let evidenceDegraded = 0;
  let spillDropped = 0;
  async function record(e: JournalEntry): Promise<'ok' | 'degraded'> {
    try {
      // Reconcile first so re-emitted entries keep their original ordering.
      while (spill.length > 0) {
        await journal.append({ ...spill[0], spilled: true });
        spill.shift();
      }
      await journal.append(e);
      return 'ok';
    } catch {
      evidenceDegraded += 1;
      if (spill.length >= SPILL_CAP) { spill.shift(); spillDropped += 1; }
      spill.push(e);
      return 'degraded';
    }
  }
  /** Stamp `record: 'degraded'` on a decision whose evidence write spilled. */
  const stamped = (d: Decision, rec: 'ok' | 'degraded'): Decision =>
    rec === 'degraded' ? { ...d, record: 'degraded' } : d;

  /** SS-5: a decision-path input was unreachable — deny as `unavailable`,
   *  never as a policy deny. Our outage is not their attack: no region, no
   *  forbidden-region reason, and the journal entry carries the class. */
  async function unavailable(session: string, call: ToolCall, dep: string, e: unknown, pre: SamState = {}): Promise<Decision> {
    const reason = `unavailable:${dep}: ${(e as Error).message}`;
    const rec = await record({ ...entry(session, pre, [], call, pre, 'reject', reason), class: 'unavailable' });
    return stamped({ ok: false, reason, class: 'unavailable', actions: [], post: pre }, rec);
  }

  // ── Phase 1: the gate (in-line, blocking) ─────────────────────────────────
  function gate(session: string, call: ToolCall): Promise<Decision> {
    return withSession(session, () => gateImpl(session, call));
  }
  async function gateImpl(session: string, call: ToolCall): Promise<Decision> {
    // The session store IS a decision-path input (the taint state is genuinely
    // required to decide — doctrine 28 does not permit inventing one). Its
    // outage is therefore a deny, but an `unavailable` one (SS-5/SS-9).
    let pre: SamState;
    try {
      pre = await store.get(session);
    } catch (e) {
      return unavailable(session, call, 'session-store', e);
    }

    // Unknown/unlabeled tool → default-deny (fail closed).
    if (!labeler.hasTool(call.tool)) {
      const rec = await record(entry(session, pre, [], call, pre, 'reject', 'unknown-tool'));
      return stamped({ ok: false, reason: 'unknown-tool', actions: [], post: pre }, rec);
    }

    const actions = labeler.pre(call);
    let s = pre;
    for (const a of actions) {
      let res;
      try {
        res = engine.step(s, a.action, a.data);
      } catch (e) {
        // Engine defect → fail closed, observable.
        const rec = await record(entry(session, pre, actions, call, s, 'reject', `engine-error: ${(e as Error).message}`));
        return stamped({ ok: false, reason: `engine-error: ${(e as Error).message}`, actions, post: s }, rec);
      }
      if (res.rejected) {
        const region = regionNames.has(res.reason as string) ? (res.reason as string) : undefined;
        const rec = await record(entry(session, pre, actions, call, pre, 'reject', res.reason as string, region));
        return stamped({ ok: false, reason: res.reason as string, region, actions, post: pre }, rec);
      }
      s = res.post;
    }

    // Allowed. Commit the DECLARED effect now (safe direction: if we crash
    // before settle, we have over-recorded taint, never under-recorded). settle
    // then layers observed post-effects on top. A failed commit converts the
    // allow into an `unavailable` deny: an allow whose taint we could not
    // persist would under-record — the one direction that is unsound.
    try {
      await store.set(session, s);
    } catch (e) {
      return unavailable(session, call, 'session-store', e, pre);
    }
    const rec = await record(entry(session, pre, actions, call, s, 'allow'));
    return stamped({ ok: true, actions, post: s }, rec);
  }

  // ── Phase 2: settle observed taint from the result ────────────────────────
  function settle(session: string, call: ToolCall, result: unknown): Promise<void> {
    return withSession(session, () => settleImpl(session, call, result));
  }
  async function settleImpl(session: string, call: ToolCall, result: unknown): Promise<void> {
    const posts = labeler.post(call, result);
    if (posts.length === 0) return;
    // A store outage here loses OBSERVED taint (the declared effect was already
    // committed at gate time — the safe direction). Throwing out of settle()
    // after the tool ran helps nobody persist it; journal the loss (spec §13:
    // every uncertainty resolves to a journaled reason) and return.
    let pre: SamState;
    try {
      pre = await store.get(session);
    } catch (e) {
      await record({ ...entry(session, {}, posts, call, {}, 'settle', `unavailable:session-store: ${(e as Error).message}`), class: 'unavailable' });
      return;
    }
    let s = pre;
    for (const a of posts) {
      let res;
      try {
        res = engine.step(s, a.action, a.data);
      } catch (e) {
        // A post-label that cannot apply never OPENS anything (settle only ADDS
        // observed taint), but it is not dropped silently — journal the skip.
        await record(entry(session, pre, [a], call, s, 'settle', undefined, undefined, `post-skipped (threw): ${a.action}: ${(e as Error).message}`));
        continue;
      }
      if (res.rejected) {
        await record(entry(session, pre, [a], call, s, 'settle', res.reason as string, undefined, `post-skipped (rejected): ${a.action}`));
        continue;
      }
      s = res.post;
    }
    try {
      await store.set(session, s);
    } catch (e) {
      await record({ ...entry(session, pre, posts, call, s, 'settle', `unavailable:session-store: ${(e as Error).message}`), class: 'unavailable' });
      return;
    }
    await record(entry(session, pre, posts, call, s, 'settle', undefined, undefined, 'settled observed taint'));
  }

  // ── Convenience: mediate a whole call (used by the sidecar adapter) ────────
  async function mediate(session: string, call: ToolCall, run: () => Promise<unknown>): Promise<unknown> {
    const d = await gate(session, call);
    if (!d.ok) {
      const err = new Error(`blocked by policy: ${d.reason}`) as Error & { polyman?: unknown };
      err.polyman = { decision: 'reject', reason: d.reason, region: d.region, session };
      throw err;
    }
    const result = await run();
    await settle(session, call, result);
    return result;
  }

  const api: Polyman = { gate, settle, mediate, mediates: (tool) => labeler.hasTool(tool), journal, stateKeys };
  // Internal, non-enumerable: count of sessions with an in-flight/undrained lock
  // chain — for tests asserting eviction (#3). Not part of the public API.
  Object.defineProperty(api, '__activeSessions', { value: () => locks.size, enumerable: false });
  // Internal, non-enumerable: the degraded-evidence report (SS-3/SS-7) — how
  // many appends failed, how many entries sit unspilled, how many were dropped.
  Object.defineProperty(api, '__evidence', {
    value: () => ({ degraded: evidenceDegraded, spilled: spill.length, dropped: spillDropped }),
    enumerable: false,
  });
  return api;
}
