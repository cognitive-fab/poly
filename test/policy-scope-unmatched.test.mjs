// PT8.4 (language findings 20): a policy whose scope matches no module of the project, no glob over module names and no
// configuration instance's `scope` governs nothing, and is PL6504 POLICY_SCOPE_UNMATCHED, an error (REFUSED), where it was
// CLEAN with every region "unreachable". A scope that matches stays clean, and a policy file with no machine anywhere is not
// reported. Light: small projects under .poly/test-policy-scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { makeKey, project, signPolicies } from './runtime-helpers.mjs';

const PROGRAM = readFileSync(join(ROOT, 'test', 'fixtures', 'flow-boundary', 'decision-input.poly'), 'utf8');
const policy = (scope, body = `  obligation summarize-while-summing "The decision runs only while the briefing is summing." rule {
    when proposal.kind == "effect" && effect.kind == "decision.summarize"
    require machine("fb_input.Briefing").phase == Summing else deny
    on unknown deny
  }`) => `module fb_policy\n\npolicy fb {\n  scope "${scope}"\n${body}\n}\n`;

async function checked(name, files) {
  const dir = project(name, [], makeKey(name), 'test-policy-scope');
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  // A scope that governs nothing is refused, and a refused policy cannot be signed; the check does not need the signature.
  try { await signPolicies(dir); } catch (e) { if (!/not lowered/.test(String(e.message))) throw e; }
  const r = await checkProject(dir, { root: dir });
  const policies = r.files.flatMap((f) => f.policies ?? []);
  const diagnostics = [...r.files.flatMap((f) => f.diagnostics), ...policies.flatMap((p) => p.diagnostics)];
  return { r, policies, diagnostics, codes: [...new Set(diagnostics.map((d) => d.code))].sort() };
}

test('a scope that names no module is PL6504 at its scope line, REFUSED, and its later stages are not run', async () => {
  const c = await checked('scope-none', { 'fb.poly': PROGRAM, 'fb.policy.poly': policy('fb') });
  assert.deepEqual(c.codes, ['PL6504']);
  assert.equal(c.r.verdict, 'REFUSED');
  const d = c.diagnostics.find((x) => x.code === 'PL6504');
  assert.match(d.message, /scope "fb"/);
  assert.equal(d.at.line, 4, 'the line of the policy\'s scope');
  const p = c.policies.find((x) => x.scope === 'fb');
  assert.ok(p, 'the policy is reported');
  assert.deepEqual(p.stages.filter((s) => s.status === 'not-run').map((s) => s.stage).sort(), ['consistency', 'never', 'policy-admission', 'policy-lower', 'policy-tv', 'regions']);
});

test('the module\'s own name matches, and so do a glob over module names and a scope a configuration instance assigns', async () => {
  const named = await checked('scope-named', { 'fb.poly': PROGRAM, 'fb.policy.poly': policy('fb_input') });
  assert.deepEqual([named.r.verdict, named.codes], ['CLEAN', []], 'named');
  const glob = await checked('scope-glob', { 'fb.poly': PROGRAM, 'fb.policy.poly': policy('fb_*') });
  // A glob that matches a module is not PL6504. (Its lowering then fails on the policy id, which may not hold a `*`: a separate
  // defect, language findings 24, so the verdict is ERROR and this test holds only that the scope was matched.)
  assert.ok(!glob.codes.includes('PL6504'), `a matching glob governs: ${glob.codes}`);
  const unmatchedGlob = await checked('scope-glob-none', { 'fb.poly': PROGRAM, 'fb.policy.poly': policy('zz_*') });
  assert.deepEqual(unmatchedGlob.codes, ['PL6504']);
  // A configuration instance that assigns the scope "stock" makes it a scope of the project (PS8.7, S160).
  const checkout = readFileSync(join(ROOT, 'examples', 'checkout', 'checkout.poly'), 'utf8').replace('inv       : Inventory', 'inv       : Inventory scope "stock"');
  assert.ok(checkout.includes('scope "stock"'));
  const stock = `module checkout_policy\n\npolicy stock {\n  scope "stock"\n  obligation inventory-sends "A send to the inventory is allowed only while it has stock." rule {\n    when proposal.kind == "send" && send.to == "checkout.Inventory"\n    require false else deny\n    on unknown deny\n  }\n}\n`;
  const assigned = await checked('scope-assigned', { 'checkout.poly': checkout, 'checkout.policy.poly': stock });
  assert.ok(!assigned.codes.includes('PL6504'), `an assigned scope matches: ${assigned.codes}`);
});

test('a policy file with no machine anywhere in the project is not reported', async () => {
  const c = await checked('scope-no-machine', { 'fb.policy.poly': policy('anything', '  recalled style "Keep replies short."') });
  assert.ok(!c.codes.includes('PL6504'), `no machine to govern: ${c.codes}`);
});
