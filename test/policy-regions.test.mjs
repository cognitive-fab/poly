// PT8.4, S161: stage 5a runs polycheck's default regions over the effects of the modules a scope governs, with each
// effect's labels mapped to polycheck's flags by PT8.4's table and the kinds a policy names counted as gated.
// Controls: the trifecta with no gate is a finding with a witness; the same program with its egress gated is clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { polycheckPeer, polyaxionPeer } from '@poly/runtime';
import { ROOT } from './helpers.mjs';

const ok = polycheckPeer().ok && polyaxionPeer().ok;
const skip = ok ? false : `not run: ${polycheckPeer().ok ? polyaxionPeer().reason : polycheckPeer().reason}`;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

async function scope(name, policy) {
  const dir = join(ROOT, '.poly', 'test-policy', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'tri.poly'), read('conformance/m5/trifecta.poly'));
  writeFileSync(join(dir, 'src', 'tri.policy.poly'), policy);
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name, modules: ['src/*.poly'] }));
  return (await checkProject(dir)).files.flatMap((f) => f.policies).find((s) => s.scope === 'tri');
}

test('S161: the trifecta with its egress ungated is PL7001, with the path that reaches it', { skip }, async () => {
  const s = await scope('trifecta', read('conformance/m5/trifecta.policy.poly'));
  const f = s.diagnostics.filter((d) => d.code === 'PL7001');
  assert.deepEqual(f.map((d) => d.property).sort(), ['credential-egress', 'lethal-trifecta']);
  const tri = f.find((d) => d.property === 'lethal-trifecta');
  assert.deepEqual(tri.witness.trace.map((s) => s.action).sort(), ['http.post', 'vault.read', 'web.fetch']);
  assert.match(tri.witness.id, /^sha256:/);
  assert.match(tri.message, /http\.post/, 'the fix names the egress');
  assert.ok(s.stages.some((x) => x.stage === 'regions' && x.verdict === 'FINDINGS'));
});

test('S161: the same program with its egress gated by a policy is clean, and a region it cannot reach is noted', { skip }, async () => {
  const gated = read('conformance/m5/trifecta.policy.poly').replace('when effect.class == "irreversible"', 'when effect.kind == "http.post"');
  const s = await scope('trifecta-gated', gated);
  assert.deepEqual(s.diagnostics.filter((d) => d.code === 'PL7001'), []);
  const st = s.stages.find((x) => x.stage === 'regions');
  assert.equal(st.verdict, 'CLEAN');
  assert.match(st.note, /source-egress: unreachable, no effect provides proprietary/);
});
