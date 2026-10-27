// The recorded models of the support-drafts example (docs/examples/support-drafts.md). No model is called: the decisions
// `summary` (external), `write` and `brief` (internal) are answered from recorded/answers.json by the items they are
// given (materials.items), whose ids belong to the fixture's tickets and notes. `asked` keeps the decision and the ids,
// never a body. An item the fixture does not hold throws, as a provider with no answer fails the call.
import { readFileSync } from 'node:fs';

/** The fixture of recorded answers. */
export function loadAnswers(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || !Array.isArray(f.tickets) || !Array.isArray(f.notes) || !f.answers || !f.models) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

/** The three providers, each answering from the owner whose items it was given. */
export function recordedDrafts(fixture) {
  const asked = [];
  const known = new Map([...fixture.tickets, ...fixture.notes].map((x) => [x.id, x]));
  const provider = (decision, model, cites) => (q, materials) => {
    const ids = Object.values(materials?.items ?? {}).flat().map((i) => i.id);
    if (!ids.length) throw new Error(`no items given to ${decision}`);
    const owners = new Set(ids.map((id) => {
      const item = known.get(id);
      if (!item) throw new Error(`no recorded item ${id}`);
      return item.owner;
    }));
    if (owners.size !== 1) throw new Error(`${decision} was given the items of more than one owner`);
    const owner = [...owners][0];
    const a = fixture.answers[decision]?.[owner];
    if (!a) throw new Error(`no recorded ${decision} answer for ${owner}`);
    asked.push({ decision: q.decision, items: ids });
    return { answer: a.text, distribution: [[a.text, a.p]], ...(cites ? { cites: ids } : {}), usage: fixture.usage, reported: fixture.models[model], latencyMs: 0 };
  };
  return {
    asked,
    decisions: {
      summary: { provider: provider('summary', 'small', false), model: fixture.models.small },
      write: { provider: provider('write', 'internal', true), model: fixture.models.internal },
      brief: { provider: provider('brief', 'internal', false), model: fixture.models.internal },
    },
  };
}

/** Registers every recorded provider with a loaded runtime. */
export function provideRecorded(rt, recorded) {
  for (const [decision, config] of Object.entries(recorded.decisions)) rt.provide(decision, config);
}
