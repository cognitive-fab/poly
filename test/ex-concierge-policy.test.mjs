// plan-ex.md E1, ruled 2026-10-10: the concierge's policy gates every decision by its audience, and the rule can deny.
// A variant of the concierge feeds the staff's Slack message into decision.classify (test/fixtures/ex-concierge). Under
// the concierge's policy as it stands, poly-ref's decision table denies decision.classify proposed with a staff taint,
// by the customer-decisions obligation, and allows it with a customer one; polycheck's regions find every path gated.
// With the two audience obligations taken out, the credential-egress region is reached through decision.classify with
// no gate crossed: PL7001, with its witness. Also: the staff's decision is denied only for a taint above staff, which
// this audience has none of, or for none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { parse } from '@poly/lang';
import { decide, initialSigma, policyFacts, proposalTable } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { makeKey, project, signPolicies } from './runtime-helpers.mjs';

const VARIANT = join(ROOT, 'test', 'fixtures', 'ex-concierge', 'staff-classify.poly');
const POLICY = readFileSync(join(ROOT, 'examples', 'concierge', 'concierge.policy.poly'), 'utf8');
const swapOut = (src, from) => { const i = src.indexOf(from); assert.ok(i >= 0, from); const j = src.indexOf('\n  }\n', i); return src.slice(0, i) + src.slice(j + 5); };
// The policy with the audience obligations taken out: only the refund rule is left.
const UNGATED = swapOut(swapOut(POLICY.replace(/\r\n/g, '\n'), '  obligation customer-decisions'), '  obligation staff-decisions');

async function checked(name, policy) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-ex-concierge');
  copyFileSync(VARIANT, join(dir, 'src', 'concierge.poly'));
  writeFileSync(join(dir, 'src', 'concierge.policy.poly'), policy);
  await signPolicies(dir);
  const r = await checkProject(dir);
  const reports = r.files.flatMap((f) => f.policies ?? []);
  return { r, policy: reports.find((p) => p.scope === 'concierge') };
}
const stage = (p, s) => p.stages.find((x) => x.stage === s);

test('the concierge\'s policy: a staff note in decision.classify is denied by customer-decisions, and a customer message is allowed', () => {
  const program = parse(readFileSync(VARIANT, 'utf8')).module;
  const policyModule = parse(POLICY).module;
  assert.ok(program && policyModule);
  const scope = { scope: 'concierge', policies: policyModule.decls.filter((d) => d.kind === 'Policy') };
  const { rows } = proposalTable(scope, policyFacts([program]));
  const classify = rows.filter((x) => x.effect?.kind === 'decision.classify');
  const at = (cls) => classify.filter((x) => (x.effect?.taint?.class ?? null) === cls);
  assert.ok(at('staff').length && at('customer').length, `the table proposes decision.classify with each class: ${JSON.stringify(classify.map((x) => x.effect?.taint ?? null))}`);
  for (const row of at('staff')) {
    const d = decide(scope, initialSigma(scope), row);
    assert.equal(d.decision, 'deny', JSON.stringify(d));
    assert.ok(d.reasons.some((x) => x.includes('customer-decisions')), JSON.stringify(d.reasons));
  }
  for (const row of [...at('customer'), ...at('public')]) assert.equal(decide(scope, initialSigma(scope), row).decision, 'allow');
  // A decision proposed with no taint is unknown to the rule, and denied.
  for (const row of at(null)) assert.equal(decide(scope, initialSigma(scope), row).decision, 'deny');
  // The deny is the audience rule's: without it, the same proposal is allowed.
  const ungated = { scope: 'concierge', policies: parse(UNGATED).module.decls.filter((d) => d.kind === 'Policy') };
  for (const row of at('staff')) assert.equal(decide(ungated, initialSigma(ungated), row).decision, 'allow');
});

test('the concierge\'s policy over the staff-note variant: every path to the credential-egress region crosses a gate', { timeout: 300_000 }, async () => {
  const { policy } = await checked('ex-concierge-policy-gated', POLICY);
  assert.equal(stage(policy, 'regions').verdict, 'CLEAN', JSON.stringify(policy.diagnostics));
  assert.match(stage(policy, 'regions').note, /credential-egress: every path crosses a gate/);
  assert.equal(policy.verdict, 'CLEAN', JSON.stringify(policy.diagnostics));
});

test('without the audience obligations, the staff-note variant reaches the credential-egress region through decision.classify (PL7001, its witness)', { timeout: 300_000 }, async () => {
  const { policy } = await checked('ex-concierge-policy-ungated', UNGATED);
  const f = policy.diagnostics.filter((d) => d.code === 'PL7001');
  assert.equal(f.length, 1, JSON.stringify(policy.diagnostics));
  assert.equal(f[0].property, 'credential-egress');
  assert.deepEqual(f[0].witness.trace.map((s) => [s.action, s.post.held]), [['decision.classify', ['sensitive', 'egress']]]);
});
