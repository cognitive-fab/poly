// M9 step 12, the code review's findings on the checker (PT10e, PT10g, PS16.3, PS8.9), each a test written before its
// fix and failing on the code it found: poly-ref's decision table read a credential and a mandate as unknown, which
// the runtime never leaves them, and a credential's name from the embedded form reached a file path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { parse } from '@poly/lang';
import { printModule } from '@poly/embed';
import { polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const skipGate = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
const REFUND = readFileSync(join(ROOT, 'test', 'fixtures', 'm9', 'stripe-refund.poly'), 'utf8');

/** The refund desk with a policy whose `never` forbids every refund that a rule over `read` lets through. */
const desk = (read) => `${REFUND}
policy pay {
  scope "stripe_refund"
  obligation reads "A refund is allowed only as the rule reads." rule {
    when effect.kind == "payments.refund"
    require ${read} else deny
    on unknown deny
  }
  never no-refund "No refund is ever allowed.": allow when effect.kind == "payments.refund"
}
`;
async function checked(src, file = 'm.poly') {
  const dir = mkdtempSync(join(tmpdir(), 'poly-review-m9-'));
  writeFileSync(join(dir, file), src);
  return { dir, r: await checkFile(join(dir, file), { root: dir }) };
}
const neverStage = (r) => r.policies[0].stages.find((s) => s.stage === 'never');

test('review A1: poly-ref reads a delegated effect\'s proposal with its credential granted, as the grant check leaves it, so a never that a granted refund breaks is found', { skip: skipGate, timeout: 300_000 }, async () => {
  const { r } = await checked(desk('effect.credential.grantState == "Granted"'));
  assert.equal(neverStage(r).verdict, 'FINDINGS', JSON.stringify(r.policies[0].stages));
  // The control: a rule no proposal passes leaves the never unbroken.
  const { r: c } = await checked(desk('effect.credential.grantState == "Revoked"'));
  assert.equal(neverStage(c).verdict, 'CLEAN', JSON.stringify(c.policies[0].stages));
});

test('review A1: poly-ref reads step.mandate with no mandate and with each delegate and delegator the policies tell apart, so a never that a mandate breaks is found', { skip: skipGate, timeout: 300_000 }, async () => {
  // A mandate comes with claims (PT2.4f), so the refund is asked for by a member of staff.
  const claimed = (src) => src.replace('machine Desk {', 'claims Staff {\n  principal: Principal\n}\n\nmachine Desk {').replace('  on Refund(merchant, amount) {', '  on Refund(merchant, amount) by s: Staff {');
  const { r } = await checked(claimed(desk('step.mandate.delegator == "alice"')));
  assert.equal(r.machines.find((m) => m.machine === 'Desk')?.verdict, 'CLEAN', JSON.stringify(r.diagnostics));
  assert.equal(neverStage(r).verdict, 'FINDINGS', JSON.stringify(r.policies[0].stages));
  // The agent is never the delegator: no proposal has both the same.
  const { r: c } = await checked(claimed(desk('step.mandate.delegator == step.mandate.delegate')));
  assert.equal(neverStage(c).verdict, 'CLEAN', JSON.stringify(c.policies[0].stages));
  // An action without claims carries no mandate, so the same rule lets no refund through.
  const { r: u } = await checked(desk('step.mandate.delegator == "alice"'));
  assert.equal(neverStage(u).verdict, 'CLEAN', JSON.stringify(u.policies[0].stages));
});

test('review A2: a credential\'s name is an identifier in the embedded form too (PL1201), so it never names a file outside the build', { timeout: 300_000 }, async () => {
  const ts = printModule(parse(REFUND).module).split('"payments"').join('"../../../pwn"');
  assert.ok(ts.includes('"../../../pwn"'), 'the embedded module names the credential');
  const { dir, r } = await checked(ts, 'm.poly.ts');
  assert.notEqual(r.verdict, 'CLEAN');
  assert.ok([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].some((d) => d.code === 'PL1201' && /identifier/.test(d.message)), JSON.stringify(r.diagnostics));
  assert.equal(existsSync(join(dir, 'pwn.json')), false);
});
