// S459 (c), as ruled on 2026-10-09: the examples' checks resolve `use`, provider profiles and route files as
// `poly check` does, from std/ and beside the source. This replaces the check in packages/poly-lang/test, which read
// each example with checkModule alone and so could not check one that uses a credential, a route or a channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { ROOT, TEST_STD, polyFiles, load, stdFor } from './helpers.mjs';

test('S459 (c): a source under examples/ resolves from std/, any other from the tests\' own std', () => {
  assert.equal(stdFor(join(ROOT, 'examples', 'hello', 'hello.poly')), join(ROOT, 'std'));
  assert.equal(stdFor(join(ROOT, 'conformance', 'm0', 'strict-param.poly')), TEST_STD);
  assert.equal(stdFor(join(ROOT, 'test', 'fixtures', 'cut-ranges', 'refunds.poly')), TEST_STD);
  // A directory whose name only begins with examples is not under it.
  assert.equal(stdFor(join(ROOT, 'examples-old', 'x.poly')), TEST_STD);
});

test('every example checks with no diagnostic, liveness included (M1-2, S459)', () => {
  // load throws on any diagnostic of the parse, the uses, the expansions or the check.
  for (const f of polyFiles(join(ROOT, 'examples'))) assert.doesNotThrow(() => load(f), f);
});

// V10 item 4, clarified 2026-10-10: a policy file in examples/ is never checked alone. The program and its policy are
// one project, and the expected line lives in the program (test/fixtures/examples-policy is such a pair).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expectedOf, mismatch, exampleFiles, checkExample, isPolicy, policyOf } from './examples-expected.mjs';

const PAIR = join(ROOT, 'test', 'fixtures', 'examples-policy');

test('V10 item 4: the files checked on their own are the programs, never a policy, and a program with a policy is one project with it', async () => {
  const files = exampleFiles(PAIR);
  assert.deepEqual(files.map((f) => basename(f)), ['held.poly']);
  assert.ok(files.every((f) => !isPolicy(f)));
  assert.ok(isPolicy(join(PAIR, 'held.policy.poly')));
  assert.equal(policyOf(files[0]), join(PAIR, 'held.policy.poly'));
  assert.equal(policyOf(join(ROOT, 'examples', 'hello', 'hello.poly')), null);
  const e = expectedOf(files[0]);
  assert.deepEqual(e, { verdict: 'CLEAN', codes: [] }, 'the expected line lives in the program');
  assert.equal(expectedOf(join(PAIR, 'held.policy.poly')), null, 'and not in the policy');
  const r = await checkExample(files[0], join(ROOT, '.poly', 'test-build', 'examples-policy'), 'examples-policy-pair');
  assert.equal(mismatch(e, r), null, JSON.stringify(r.diagnostics.map((d) => `${d.code} ${d.message}`)));
});

test('V10 item 4: the policy is part of the example\'s check, so a broken policy changes its verdict', async () => {
  const dir = join(ROOT, '.poly', 'test-build', 'examples-policy-broken');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(PAIR, 'held.poly'), join(dir, 'held.poly'));
  // A policy that does not parse.
  writeFileSync(join(dir, 'held.policy.poly'), readFileSync(join(PAIR, 'held.policy.poly'), 'utf8').replace('on unknown deny', 'on unknown frobnicate'));
  const r = await checkExample(join(dir, 'held.poly'), join(dir, 'root'), 'examples-policy-broken');
  assert.notEqual(mismatch({ verdict: 'CLEAN', codes: [] }, r), null, `the broken policy was not seen: ${r.verdict}`);
});
