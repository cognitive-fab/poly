// M0 gate: translation validation agrees on every transition of every
// conformance case, and a deliberately broken lowering is caught with
// PL2501 (PT18, AC8, PS9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { translationValidate } from '@poly/ref';
import { DELIBERATELY_BROKEN_LOWERINGS } from './toolchain-faults.mjs';
import { ROOT, polyFiles, build } from './helpers.mjs';

const SOURCES = [...polyFiles(join(ROOT, 'examples')), ...polyFiles(join(ROOT, 'conformance', 'm0'))];

for (const file of SOURCES) {
  test(`translation validation agrees: ${basename(file)}`, async (t) => {
    // The OutboxIntent forms state liveness, refused until M2 (S13); it is removed before lowering.
    for (const b of build(file, 'tv', { stripLiveness: true })) {
      const r = await translationValidate(b.module, b.machine, b.dir);
      assert.deepEqual(r.mismatches.map((d) => d.message), []);
      assert.ok(r.transitions > 0);
      t.diagnostic(`${b.machine}: ${r.report.states} states, ${r.transitions} transitions and ${r.propertyChecks} property evaluations compared${b.stripped.length ? `; liveness removed: ${b.stripped.join(', ')}` : ''}`);
    }
  });
}

// Each fault must be caught with PL2501 on at least one source. Where a fault
// changes the artefacts but translation validation agrees, the change had no
// effect on any transition of I (for example, a frame dropped after a
// `return reject(...)`, which never runs): an equivalent mutant. Those are
// listed, never counted as caught.
// Only the lowerings named in the explicit list may reach PL2501 (the standing rule's one exception).
for (const fault of DELIBERATELY_BROKEN_LOWERINGS) {
  test(`a broken lowering is caught with PL2501: ${fault}`, async (t) => {
    let caught = 0;
    const equivalent = [];
    for (const file of SOURCES) {
      const good = build(file, 'tv-good', { stripLiveness: true });
      const bad = build(file, `tv-${fault}`, { stripLiveness: true, fault });
      for (const [k, b] of bad.entries()) {
        const changed = ['next.cjs', 'invariants.mjs'].some((f) => readFileSync(join(b.dir, f), 'utf8') !== readFileSync(join(good[k].dir, f), 'utf8'));
        if (!changed) continue;
        const r = await translationValidate(b.module, b.machine, b.dir);
        if (r.mismatches.length === 0) { equivalent.push(basename(file)); continue; }
        caught++;
        assert.ok(r.mismatches.every((d) => d.code === 'PL2501'));
        t.diagnostic(`caught on ${basename(file)}: ${r.mismatches.length} mismatches, first: ${r.mismatches[0].message}`);
      }
    }
    if (equivalent.length) t.diagnostic(`equivalent on I (no transition changed): ${equivalent.join(', ')}`);
    assert.ok(caught > 0, `the fault ${fault} is caught on no source`);
  });
}
