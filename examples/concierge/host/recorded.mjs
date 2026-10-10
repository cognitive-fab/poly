// plan-ex.md E1: the concierge's recorded providers. No model is called (S356): each decision is answered from
// test/fixtures/concierge/answers.json, by the message its materials hold (PS17.2, PS18.2), so a run needs no digest
// written by hand and a message the fixture does not hold is a failure of the call, as a provider with no answer is.
import { readFileSync } from 'node:fs';

/** The fixture of recorded answers. */
export function loadAnswers(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || !Array.isArray(f.messages) || !f.models) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

/** The message whose text is among the bodies a decision was given. */
function messageOf(fixture, materials) {
  const bodies = Object.values(materials?.bodies ?? {}).filter((b) => typeof b === 'string');
  const m = fixture.messages.find((x) => bodies.includes(x.text));
  if (!m) throw new Error('no recorded answer for this message');
  return m;
}

/**
 * The tier providers of the route `triage` and the providers of the unrouted decisions `amount` and `reply`, each
 * recording the decision, tier and message it was asked about in `asked` (never the text).
 */
export function recordedConcierge(fixture) {
  const asked = [];
  const tier = (name) => (q, materials) => {
    const m = messageOf(fixture, materials);
    asked.push({ decision: q.decision, tier: q.tier ?? null, message: m.id });
    const a = (m.classify ?? []).find((c) => c.tier === name);
    if (!a) throw new Error(`no recorded ${name} answer for ${m.id}`);
    const second = a.answer === 'Other' ? 'Status' : 'Other';
    return { answer: a.answer, distribution: [[a.answer, a.p], [second, Math.max(0, 1 - a.p)]], usage: a.usage, reported: fixture.models[name], latencyMs: 0 };
  };
  const amount = (q, materials) => {
    const m = messageOf(fixture, materials);
    asked.push({ decision: q.decision, tier: null, message: m.id });
    if (!m.amount) throw new Error(`no recorded amount for ${m.id}`);
    const other = { value: m.amount.answer.value === 0 ? 1 : 0 };
    return { answer: m.amount.answer, distribution: [[m.amount.answer, m.amount.p], [other, Math.max(0, 1 - m.amount.p)]], usage: m.amount.usage, reported: fixture.models.small, latencyMs: 0 };
  };
  const reply = (q, materials) => {
    const m = messageOf(fixture, materials);
    const outcome = q.payload?.outcome;
    asked.push({ decision: q.decision, tier: null, message: m.id, outcome });
    const text = m.replies?.[outcome];
    if (typeof text !== 'string') throw new Error(`no recorded ${outcome} reply for ${m.id}`);
    return { answer: text, distribution: [[text, 1]], reported: fixture.models.small, latencyMs: 0 };
  };
  // The status answer: its text, and the ids it cites, kept to the items it was given (PS17.6); an id the fixture names
  // that the retrieval did not return is left out, as a provider citing only what it read.
  const answer = (q, materials) => {
    const m = messageOf(fixture, materials);
    asked.push({ decision: q.decision, tier: null, message: m.id });
    if (!m.answer) throw new Error(`no recorded answer for ${m.id}`);
    const given = new Set(Object.values(materials?.items ?? {}).flat().map((i) => i.id));
    return { answer: m.answer.text, distribution: [[m.answer.text, m.answer.p]], cites: m.answer.cites.filter((id) => given.has(id)), usage: m.answer.usage, reported: fixture.models.small, latencyMs: 0 };
  };
  // Q-EX7: the acknowledgement of a message that arrives while the Desk is busy, and of each staff message. Both are
  // the fixture's fixed texts, whatever the message: an acknowledgement says only that the message was seen.
  const fixed = (decision, text) => (q, materials) => {
    asked.push({ decision: q.decision, tier: null, message: decision === 'ack' ? messageOf(fixture, materials).id : null });
    return { answer: text, distribution: [[text, 1]], reported: fixture.models.small, latencyMs: 0 };
  };
  return {
    asked,
    tiers: { small: tier('small'), large: tier('large') },
    decisions: {
      answer: { provider: answer, model: fixture.models.small },
      amount: { provider: amount, model: fixture.models.small },
      reply: { provider: reply, model: fixture.models.small },
      ack: { provider: fixed('ack', fixture.acks?.customer ?? 'Thank you, we have your message and will answer it shortly.'), model: fixture.models.small },
      noted: { provider: fixed('noted', fixture.acks?.staff ?? 'Noted.'), model: fixture.models.small },
    },
  };
}

/** Registers every recorded provider with a loaded concierge runtime. */
export function provideRecorded(rt, recorded) {
  for (const [name, fn] of Object.entries(recorded.tiers)) rt.provideTier(name, fn);
  for (const [decision, config] of Object.entries(recorded.decisions)) rt.provide(decision, config);
}
