// plan-e3.md E3.5, E3.6: the corpus of recorded trajectories run under every configuration of the four mechanisms, each in a
// fresh runtime over one shared admission, and what each run left, read from the runtime's own records (the journal, the
// outbox, the decision events), never from the host's counters alone.
import { trajectories } from './fixtures/harness/trajectories.mjs';
import { ALL_OFF, ALL_ON } from '../examples/harness/host/loop.mjs';
import { run } from './e3-loop-helpers.mjs';

export const CONFIGS = {
  base: ALL_OFF,
  fusion: { ...ALL_OFF, fusion: true },
  compaction: { ...ALL_OFF, compaction: true },
  pack: { ...ALL_OFF, pack: true },
  reducer: { ...ALL_OFF, reducer: true },
  all: ALL_ON,
};

/** Calls, tokens and cost of the model calls of a run, by decision, from the decision events the runtime wrote. */
export function costOf(rt) {
  const by = {};
  for (const r of rt.store.db.prepare("SELECT event FROM poly_ledger WHERE kind = 'decision'").all()) {
    const b = JSON.parse(r.event).body;
    const k = (by[b.decision] ??= { calls: 0, input: 0, output: 0, units: 0 });
    k.calls += 1;
    k.input += b.usage?.input ?? 0;
    k.output += b.usage?.output ?? 0;
    k.units += b.cost?.units ?? 0;
  }
  return by;
}

/** The accepted steps of the pay-gate (Context.Measured), with the state before and after, from the journal. */
export async function gateRows(rt, context) {
  return (await rt.getJournal(context)).filter((j) => j.action === 'Measured' && j.step_kind === 'accepted').map((j) => ({
    data: typeof j.data === 'string' ? JSON.parse(j.data) : j.data,
    pre: typeof j.pre === 'string' ? JSON.parse(j.pre) : j.pre,
    post: typeof j.post === 'string' ? JSON.parse(j.post) : j.post,
  }));
}

/** The act effects of a run, with the fused flag of their payloads, from the outbox. */
export function actsOf(rt) {
  return rt.store.db.prepare("SELECT payload FROM pr_outbox WHERE kind = 'tool.act'").all().map((r) => JSON.parse(String(r.payload)).fused === true);
}

let cache = null;
/** Every trajectory under every configuration: { [trajectory]: { [config]: summary } }. */
export function matrix() {
  cache ??= (async () => {
    const out = {};
    for (const t of trajectories()) {
      out[t.name] = { t, runs: {} };
      for (const [cfg, mechanisms] of Object.entries(CONFIGS)) {
        const { rt, store, result } = await run(`e3-matrix-${t.name}-${cfg}`, structuredClone(t.recording), { mechanisms });
        try {
          out[t.name].runs[cfg] = {
            mode: result.trial.mode,
            why: result.trial.why,
            steps: result.turns.length,
            metrics: result.metrics,
            requests: result.requests,
            cost: costOf(rt),
            acts: actsOf(rt),
            gate: await gateRows(rt, result.ids.context),
            context: result.context,
            observations: await Promise.all(result.live.map(async (o) => ({ ...o, state: (await rt.getState(o.id)).state, bytes: result.archive.size(o.handle), refs: result.archive.refs(o.handle) }))),
            receipts: await Promise.all(result.receipts.map(async (r) => ({ id: r, state: (await rt.getState(r)).state, shown: store.read('shown', r)?.what, reads: (await rt.chain(r)).filter((e) => e.kind === 'decision').length }))),
            compactions: result.compactions,
          };
        } finally {
          await rt.close();
        }
      }
    }
    return out;
  })();
  return cache;
}
