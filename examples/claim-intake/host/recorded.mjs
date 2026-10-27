// The recorded models of the claim intake (docs/examples/claim-intake.md). No model is called: the route's two tiers are
// answered from recorded/answers.json, by the claim whose text is among the bodies the route was given. `asked` keeps the
// decision, the tier and the claim's id, never its text. A claim with no entry for the tier throws, as a provider with no
// answer fails the call.
import { readFileSync } from 'node:fs';

/** The fixture of recorded answers. */
export function loadAnswers(file) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  if (!f || !Array.isArray(f.claims) || !f.models) throw new Error(`${file}: not a recorded-answers fixture`);
  return f;
}

/** The two tier providers of the route classify. */
export function recordedClaims(fixture) {
  const asked = [];
  const tier = (name) => (q, materials) => {
    const bodies = Object.values(materials?.bodies ?? {}).filter((b) => typeof b === 'string');
    const claim = fixture.claims.find((c) => bodies.includes(c.text));
    if (!claim) throw new Error('no recorded claim for this text');
    const a = (claim.classify ?? []).find((c) => c.tier === name);
    if (!a) throw new Error(`no recorded ${name} answer for ${claim.id}`);
    asked.push({ decision: q.decision, tier: q.tier ?? name, claim: claim.id });
    const other = a.answer === 'Other' ? 'Auto' : 'Other';
    return { answer: a.answer, distribution: [[a.answer, a.p], [other, Math.max(0, 1 - a.p)]], usage: a.usage, reported: fixture.models[name], latencyMs: 0 };
  };
  return { asked, tiers: { small: tier('small'), large: tier('large') } };
}

/** Registers the tier providers with a loaded runtime. */
export function provideRecorded(rt, recorded) {
  for (const [name, fn] of Object.entries(recorded.tiers)) rt.provideTier(name, fn);
}
