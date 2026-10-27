// The expense claims' recorded provider (docs/examples/expense-approval.md). No model is called: the decision `categorize` is
// answered from recorded/answers.json, by the receipt whose text is among the bodies the decision was given. A text the
// fixture does not hold throws, as a provider with no answer fails the call.
import { readFileSync } from 'node:fs';

/** The fixture of recorded answers. */
export function loadAnswers(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || !Array.isArray(f.receipts) || !f.models) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

/** The provider of `categorize`; `asked` keeps the decision and the receipt's id, never its text. */
export function recordedExpenses(fixture) {
  const asked = [];
  const categorize = (q, materials) => {
    const bodies = Object.values(materials?.bodies ?? {}).filter((b) => typeof b === 'string');
    const r = fixture.receipts.find((x) => bodies.includes(x.text));
    if (!r) throw new Error('no recorded answer for this receipt');
    asked.push({ decision: q.decision, receipt: r.id });
    return { answer: r.answer, distribution: r.distribution, usage: r.usage, reported: fixture.models.small, latencyMs: 0 };
  };
  return { asked, decisions: { categorize: { provider: categorize, model: fixture.models.small } } };
}

/** Registers every recorded provider with a loaded runtime. */
export function provideRecorded(rt, recorded) {
  for (const [decision, config] of Object.entries(recorded.decisions)) rt.provide(decision, config);
}
