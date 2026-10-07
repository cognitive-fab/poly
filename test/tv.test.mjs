// M0 gate: translation validation agrees on every transition of every
// conformance case, and a deliberately broken lowering is caught with
// PL2501 (PT18, AC8, PS9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { translationValidate } from '@poly/ref';
import { DELIBERATELY_BROKEN_LOWERINGS, FAULT_SOURCES } from './toolchain-faults.mjs';
import { ROOT, TEST_STD, polyFiles, build } from './helpers.mjs';

const SOURCES = [...polyFiles(join(ROOT, 'examples')), ...polyFiles(join(ROOT, 'conformance', 'm0')), ...polyFiles(join(ROOT, 'conformance', 'm1')), ...polyFiles(join(ROOT, 'conformance', 'm2'))];

for (const file of SOURCES) {
  test(`translation validation agrees: ${basename(file)}`, async (t) => {
    for (const b of build(file, 'tv')) {
      const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program });
      assert.deepEqual(r.mismatches.map((d) => d.message), []);
      assert.ok(r.transitions > 0);
      t.diagnostic(`${b.machine}: ${r.report.states} states, ${r.transitions} transitions and ${r.propertyChecks} property evaluations compared`);
    }
  });
}

// Each fault must be caught with PL2501 on every source listed beside it in toolchain-faults.mjs. Where a fault
// changes the artefacts but translation validation agrees, the change had no
// effect on any transition of I (for example, a frame dropped after a
// `return reject(...)`, which never runs): an equivalent mutant. Those are
// listed, never counted as caught.
// Only the lowerings named in the explicit list may reach PL2501 (the standing rule's one exception).
for (const fault of DELIBERATELY_BROKEN_LOWERINGS) {
  test(`a broken lowering is caught with PL2501: ${fault}`, async (t) => {
    let caught = 0;
    const equivalent = [];
    const listed = FAULT_SOURCES[fault].map((p) => join(ROOT, p));
    for (const file of listed) {
      const good = build(file, 'tv-good');
      const bad = build(file, `tv-${fault}`, { fault });
      for (const [k, b] of bad.entries()) {
        // The effects mapper is an artefact too (PS9.2): a fault that changes only it must be caught as well.
        const read = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
        const changed = ['next.cjs', 'invariants.mjs', 'effects.cjs', 'contract.json', 'effects.manifest.json', 'effect-invariants.mjs', 'invariants.compose.mjs', 'liveness.mjs', 'openshell.policies.yaml', 'types.d.ts', ...Object.keys(b.lowered.files).filter((f) => f.startsWith('../workflows/') || f.startsWith('../channels/') || f.startsWith('../credentials/') || f.startsWith('../sources/') || f.startsWith('../flow/') || f.startsWith('../routes/') || f.startsWith('../budgets/'))].some((f) => read(b.dir, f) !== read(good[k].dir, f));
        if (!changed) continue;
        // PT10e: the sources are built with the tests' std (helpers.mjs), so the provider profiles are read back from it.
        const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: TEST_STD, sourceDir: b.sourceDir });
        if (r.mismatches.length === 0) { equivalent.push(basename(file)); continue; }
        caught++;
        assert.ok(r.mismatches.every((d) => d.code === 'PL2501'));
        t.diagnostic(`caught on ${basename(file)}: ${r.mismatches.length} mismatches, first: ${r.mismatches[0].message}`);
      }
    }
    if (equivalent.length) t.diagnostic(`equivalent on I (no transition changed): ${equivalent.join(', ')}`);
    assert.deepEqual(equivalent, [], `the fault ${fault} changes nothing on a listed source`);
    assert.ok(caught >= listed.length, `the fault ${fault} is caught on ${caught} of ${listed.length} listed sources`);
  });
}
