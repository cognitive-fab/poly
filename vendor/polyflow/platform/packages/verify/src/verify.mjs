// Offline verification of a run's ledger — FR-LED.3.
//
// Needs no network, no Temporal and no vendor service: the events, the signed
// heads and a trust store. An auditor who did not produce the record can run
// it. It answers four separate questions, because they are different claims:
//
//   chain       — is the sequence internally consistent (no edit, drop, reorder)?
//   signatures  — did a trusted key vouch for heads of this chain?
//   covered     — does a trusted, anchored head cover the LAST event? Anything
//                 after the last signed head is unauthenticated: anyone can
//                 append correctly chained events, genesis is public (review V2).
//   closed      — does the record end in a closure? Without one, a truncated
//                 ledger and an unfinished run look the same (review V1).
//
// `allowOpen` accepts a run with no closure yet (in progress), and says so.
// `unsigned` accepts a history-derived ledger (polyflow export) with no heads,
// as a DIFFERENT verdict: consistent, not vouched for.

import { verifyChain } from '@cognitive-fab/polyflow-kernel';
import { verifyHead } from './sink.mjs';

export function verifyBundle({ events, heads = [], trust = {}, allowOpen = false, unsigned = false }) {
  const report = { ok: false, verdict: 'broken', chain: null, signatures: [], anchored: 0, signedThrough: null, closed: false, problems: [] };
  report.chain = verifyChain(events);
  if (!report.chain.ok) {
    report.problems.push(`chain breaks at seq ${report.chain.seq}: ${report.chain.reason}`);
    return report;
  }
  const run = events[0].run;
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  for (const h of heads) {
    const sameRun = h.run?.ns === run.ns && h.run?.wf === run.wf && h.run?.run === run.run;
    const sig = sameRun ? verifyHead(h, trust) : { ok: false, reason: 'head belongs to another run' };
    const at = bySeq.get(h.seq);
    const anchored = Boolean(at && at.hash === h.hash);
    report.signatures.push({ seq: h.seq, keyId: h.keyId, ok: sig.ok, anchored, reason: sig.reason });
    if (!sig.ok) report.problems.push(`head at seq ${h.seq}: ${sig.reason}`);
    else if (!anchored) report.problems.push(`signed head at seq ${h.seq} does not match the event at that seq`);
    else report.anchored++;
  }
  const good = report.signatures.filter((s) => s.ok && s.anchored).map((s) => s.seq);
  report.signedThrough = good.length ? Math.max(...good) : null;
  // A continued-as-new closure hands the chain on; only a final one ends it.
  report.closed = events.some((e) => e.kind === 'closure' && e.body?.outcome !== 'continued-as-new');
  const last = report.chain.head.seq;

  if (unsigned) {
    if (!report.closed && !allowOpen) report.problems.push('no closure: the record is unfinished or truncated');
    report.ok = report.problems.length === 0;
    report.verdict = report.ok ? 'consistent-unsigned' : 'not-ok';
    return report;
  }
  if (report.signedThrough === null) report.problems.push('no trusted signed head anchors this chain');
  else if (report.signedThrough < last) report.problems.push(`seq ${report.signedThrough + 1}..${last} are not covered by any trusted signed head: anyone could have appended them`);
  if (!report.closed && !allowOpen) report.problems.push('no closure: the record is unfinished or truncated');
  report.ok = report.problems.length === 0;
  report.verdict = report.ok ? (report.closed ? 'closed-and-signed' : 'open-and-signed') : 'not-ok';
  return report;
}

/**
 * A thread of linked chains (the LangGraph binding, P10 review VF1): every
 * chain verifies as a bundle (the open one may be open); exactly one chain
 * starts the thread; every other one's admission `continues` a CLOSURE of
 * another chain of the thread, and no closure is continued twice; at most one
 * chain is open; every effect follows its proposal's `allowed` verdict; every
 * observation names an effect of its chain, once. The same rules as Python's
 * `polyflow_langgraph.verify_thread`.
 * @param {{ events: object[], heads: object[] }[]} chains
 */
export function verifyThread(chains, { trust = {}, unsigned = false } = {}) {
  const problems = [];
  const byRun = new Map();
  for (const c of chains) if (c.events.length) byRun.set(c.events[0].run.run, c);
  if (!byRun.size) return { ok: false, problems: ['no chain in this thread'], chains: 0, roots: [], open: [], links: [] };
  const roots = [];
  const open = [];
  const links = [];
  const continued = new Map();
  const thread = (e) => e?.body?.execution?.thread;
  const threads = new Set([...byRun.values()].map((c) => thread(c.events[0])));
  if (threads.size !== 1) problems.push(`the chains name ${threads.size} different threads`);
  for (const [run, { events, heads }] of byRun) {
    const closed = events.some((e) => e.kind === 'closure');
    if (!closed) open.push(run);
    // Unsigned: a consistency check of what the thread holds; heads are not judged.
    const r = verifyBundle({ events, heads: unsigned ? [] : heads, trust, allowOpen: !closed, unsigned });
    if (!r.ok) { problems.push(`${run}: ${r.problems.join('; ')}`); continue; }
    const first = events[0];
    if (first.kind !== 'admission') problems.push(`${run}: does not start with an admission`);
    const link = first.kind === 'admission' ? first.body?.continues : null;
    if (!link) roots.push(run);
    else {
      const target = byRun.get(link.run?.run);
      const at = target?.events.find((e) => e.seq === link.seq);
      if (!at || at.hash !== link.hash || at.kind !== 'closure') problems.push(`${run}: its continues link does not resolve to a closure of this thread`);
      const key = `${link.run?.run}#${link.seq}`;
      if (continued.has(key)) problems.push(`${run} and ${continued.get(key)} both continue the same closure`);
      continued.set(key, run);
      links.push({ from: link.run?.run, to: run });
    }
    const verdicts = new Map();
    const effects = new Set();
    const observed = new Set();
    for (const e of events) {
      const b = e.body ?? {};
      if (e.kind === 'verdict') verdicts.set(b.proposal, b.outcome);
      else if (e.kind === 'effect') {
        if (verdicts.get(b.proposal) !== 'allowed') problems.push(`${run}: effect ${b.id} does not follow an allowed verdict`);
        effects.add(b.id);
      } else if (e.kind === 'observation') {
        if (!effects.has(b.effect)) problems.push(`${run}: observation of unknown effect ${b.effect}`);
        if (observed.has(b.effect)) problems.push(`${run}: effect ${b.effect} observed twice`);
        observed.add(b.effect);
      }
    }
  }
  if (roots.length !== 1) problems.push(`the thread has ${roots.length} unlinked chains; it must have exactly one`);
  if (open.length > 1) problems.push(`the thread has ${open.length} open chains: ${open.sort().join(', ')}`);
  return { ok: problems.length === 0, problems, chains: byRun.size, roots, open, links };
}
