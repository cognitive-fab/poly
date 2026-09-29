// M0 gate, field-study corpora (PT18, AC2): the turnstile, raft-roles and
// hatchet-status machines and their broken controls, written in poly, give
// the same pass or fail on every window as the hand-written controls, under
// polygraph's own replay. Identity is window by window, in both directions:
// a window the poly version passes and the control fails is also a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadWindows, replaySpecResults } from '@cognitive-fab/polygraph/scripts/replay.mjs';
import { ROOT, build } from './helpers.mjs';
import { verify, STUDIES } from '../scripts/sync-corpora.mjs';

const CORPORA = join(ROOT, 'conformance', 'field-studies');

// The pass counts the gate fixes (decisions-m0.md, S1).
const GATE = {
  turnstile: { windows: 12, reference: 12, broken: 9 },
  raft: { windows: 67, reference: 54, broken: 44 },
  hatchet: { windows: 19, reference: 19, broken: 18 },
};

test('the corpus copies match their PROVENANCE.md hashes (PT17, S17)', () => {
  // CI reads only the copies; the local sources are compared when present, by scripts/sync-corpora.mjs.
  const { problems } = verify({ sources: false });
  assert.deepEqual(problems, []);
});

function replay(specPath, windows) {
  const r = replaySpecResults(specPath, windows);
  assert.ok(r.ok, `replay of ${specPath} failed: ${r.error}`);
  return r.results.map((x) => x.status);
}

for (const study of STUDIES) {
  test(`${study.name}: poly and its broken control replay window for window like the hand-written controls`, (t) => {
    const windows = loadWindows(join(CORPORA, study.name, 'traces'));
    const gate = GATE[study.name];
    assert.equal(windows.length, gate.windows);
    const handRef = replay(join(CORPORA, study.name, study.controls.reference), windows);
    const handBroken = replay(join(CORPORA, study.name, study.controls.broken), windows);
    const [poly] = build(join(ROOT, 'examples', 'field-studies', study.name, `${study.name}.poly`), 'field-studies');
    const [polyBroken] = build(join(ROOT, 'examples', 'field-studies', study.name, `${study.name}-broken.poly`), 'field-studies');
    const polyRef = replay(join(poly.dir, 'next.cjs'), windows);
    const polyBad = replay(join(polyBroken.dir, 'next.cjs'), windows);
    const pass = (xs) => xs.filter((x) => x === 'pass').length;
    t.diagnostic(`hand ${pass(handRef)}/${windows.length} and ${pass(handBroken)}/${windows.length}; poly ${pass(polyRef)}/${windows.length} and ${pass(polyBad)}/${windows.length}`);
    // The controls behave as the gate records.
    assert.equal(pass(handRef), gate.reference);
    assert.equal(pass(handBroken), gate.broken);
    // Window-by-window identity, both directions.
    const differ = (a, b) => windows.map((w, i) => (a[i] !== b[i] ? `${w.scenario}#${w.index} ${w.action}: hand ${a[i]}, poly ${b[i]}` : null)).filter(Boolean);
    assert.deepEqual(differ(handRef, polyRef), []);
    assert.deepEqual(differ(handBroken, polyBad), []);
  });
}
