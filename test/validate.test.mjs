// M0 gate: every lowered next.cjs passes strict validate() from
// @cognitive-fab/sam-pattern (PT18). Also: the module's initial state is the
// contract's, and its invariants module loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, polyFiles, build, requireModule } from './helpers.mjs';

const SOURCES = [...polyFiles(join(ROOT, 'examples')), ...polyFiles(join(ROOT, 'conformance', 'm0'))];

test('the sources exist', () => assert.ok(SOURCES.length >= 12, SOURCES.join('\n')));

for (const file of SOURCES) {
  test(`strict validate(): ${basename(file)}`, async () => {
    // The OutboxIntent forms state liveness, refused until M2 (S13); it is removed before lowering.
    for (const b of build(file, 'validate', { stripLiveness: true })) {
      const mod = requireModule(b.dir);
      const problems = mod.instance({}).validate();
      assert.deepEqual(problems, []);
      mod.init();
      assert.deepEqual(mod.getState(), b.lowered.contract.initState);
      const inv = await import(pathToFileURL(join(b.dir, 'invariants.mjs')).href + `?t=${Date.now()}`);
      for (const p of inv.stateInvariants) assert.equal(p.pred(mod.getState()), true, `${p.name} holds in the initial state`);
    }
  });
}
