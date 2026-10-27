// The recorded models and documents of the research agents (docs/examples/research-agents.md). No model is called: `plan`
// answers the fixture's focus and `research` its text, citing the ids of the items it was given. `asked` keeps the decision
// and, for `research`, the ids; never a body. An item the fixture does not hold throws, as a provider with no answer fails.
import { readFileSync } from 'node:fs';

/** The fixture of recorded answers. */
export function loadAnswers(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || !Array.isArray(f.documents) || !f.plan || !f.research || !f.models) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

/** The providers of `plan` and `research`. */
export function recordedResearch(fixture) {
  const asked = [];
  const known = new Set(fixture.documents.map((d) => d.id));
  const plan = (q) => {
    asked.push({ decision: q.decision });
    return { answer: fixture.plan.focus, distribution: [[fixture.plan.focus, fixture.plan.p]], usage: fixture.plan.usage, reported: fixture.models.small, latencyMs: 0 };
  };
  const research = (q, materials) => {
    const ids = Object.values(materials?.items ?? {}).flat().map((i) => i.id);
    if (!ids.length) throw new Error('no documents given to research');
    for (const id of ids) if (!known.has(id)) throw new Error(`no recorded document ${id}`);
    asked.push({ decision: q.decision, items: ids });
    return { answer: fixture.research.text, distribution: [[fixture.research.text, fixture.research.p]], cites: ids, usage: fixture.research.usage, reported: fixture.models.small, latencyMs: 0 };
  };
  return { asked, decisions: { plan: { provider: plan, model: fixture.models.small }, research: { provider: research, model: fixture.models.small } } };
}

/** Registers every recorded provider with a loaded runtime. */
export function provideRecorded(rt, recorded) {
  for (const [decision, config] of Object.entries(recorded.decisions)) rt.provide(decision, config);
}
