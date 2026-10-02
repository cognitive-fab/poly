// PT8.5, PS8.6, S148: obligation consistency. A mandate the obligations trap together is PL6501, with a minimal
// conflicting subset found by deletion in declaration order (not the smallest), the cost reported, and a path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

function projectOf(name, files) {
  const dir = join(ROOT, '.poly', 'test-policy', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'src', f), text);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return dir;
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('PT8.5: two obligations that trap a mandate together are PL6501 naming exactly them, with a path', { skip }, async () => {
  const p = await checkProject(projectOf('consistency', { 'orders.poly': read('conformance/m5/orders.poly'), 'c.policy.poly': read('conformance/m5/consistency.policy.poly') }));
  const s = p.files.flatMap((f) => f.policies).find((x) => x.scope === 'orders');
  const d = s.diagnostics.find((x) => x.code === 'PL6501');
  assert.ok(d, JSON.stringify(s.diagnostics.map((x) => x.message)));
  assert.match(d.message, /under the obligations orders-mandate\.reserved-by-end, orders-mandate\.no-reserve:/);
  assert.doesNotMatch(d.message, /fee-free/, 'the unrelated rule is not in the subset');
  assert.match(d.message, /\d+ discharge check\(s\)/);
  assert.ok(!s.diagnostics.some((x) => x.code === 'PL6001'), 'the engine\'s m2 refusal is this finding, not a refusal');
  assert.equal(s.verdict, 'FINDINGS');
  assert.ok(s.stages.some((x) => x.stage === 'consistency' && x.verdict === 'FINDINGS'));
});

test('PT8.5: each obligation alone leaves the mandate dischargeable', { skip }, async () => {
  const src = read('conformance/m5/consistency.policy.poly');
  const withoutRule = src.replace(/  obligation no-reserve[\s\S]*?\n  }\n/, '');
  const s = (await checkProject(projectOf('consistency-ok', { 'orders.poly': read('conformance/m5/orders.poly'), 'c.policy.poly': withoutRule }))).files.flatMap((f) => f.policies)[0];
  assert.ok(!s.diagnostics.some((x) => x.code === 'PL6501'), JSON.stringify(s.diagnostics.map((x) => x.message)));
});
