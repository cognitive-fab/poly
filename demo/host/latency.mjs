// DF12 item 6: the latency of a whole call of each tier, as the room makes it (a vote of 5 asks: a first ask, then four in parallel),
// measured over the providers the launcher gives. It is how the timeouts of the demo copy are based on a measurement, and a live
// call is made only when the owner runs it with a key and a cap.

const TIERS = ['small', 'large'];
const QUESTION = { decision: 'classify', limits: { maxInputTokens: 2000, maxTokens: 400 } };
const MATERIALS = { bodies: { m: 'Where is my order?' }, items: {} };

/** The timeout that holds a whole call twice over: max(2, ceil(2 * max / 1000)) seconds (DF12 item 5). */
export const suggestedSeconds = (maxMs) => Math.max(2, Math.ceil((2 * maxMs) / 1000));

export async function measureLatency({ providers, models, runs = 5, now = () => Date.now() }) {
  const out = {};
  for (const tier of TIERS) {
    const runsMs = [];
    for (let i = 0; i < runs; i++) {
      const t0 = now();
      await providers.tiers[tier](QUESTION, MATERIALS);
      runsMs.push(now() - t0);
    }
    const sorted = [...runsMs].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const medianMs = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    const maxMs = sorted[sorted.length - 1];
    out[tier] = { model: models[tier], runsMs, minMs: sorted[0], medianMs, maxMs, suggestedSeconds: suggestedSeconds(maxMs) };
  }
  return out;
}

/** The lines the launcher prints for a measurement. */
export function formatLatency(result, copy = { classify: '20s', amount: '10s', answer: '10s', reply: '10s' }) {
  const lines = TIERS.map((t) => {
    const r = result[t];
    return `${t} (${r.model}): runs ${r.runsMs.join(' ')} ms; min ${r.minMs}, median ${r.medianMs}, max ${r.maxMs}; suggested ${r.suggestedSeconds}s`;
  });
  const larger = Math.max(result.small.suggestedSeconds, result.large.suggestedSeconds);
  const small = result.small.suggestedSeconds;
  lines.push(`suggested timeouts: classify ${larger}s, amount ${small}s, answer ${small}s, reply ${small}s`);
  lines.push(`the demo copy has: classify ${copy.classify}, amount ${copy.amount}, answer ${copy.answer}, reply ${copy.reply}`);
  return lines;
}
