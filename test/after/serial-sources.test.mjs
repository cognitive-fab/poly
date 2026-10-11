// The serial group's sources (test/serial-sources.mjs, ruled 2026-10-10): the standing rule's check and translation
// validation, the same assertions as test/standing.test.mjs and test/tv.test.mjs, run after the parallel suite so its
// load cannot slow them or them it. The concierge example's two took 434 s and 210 s beside the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { translationValidate } from '@poly/ref';
import { ROOT, build } from '../helpers.mjs';
import { toolchainFaults } from '../toolchain-faults.mjs';
import { SERIAL, serial } from '../serial-sources.mjs';
import { expectedOf, mismatch, exampleFiles, checkExample } from '../examples-expected.mjs';

const FILES = SERIAL.flatMap((d) => (existsSync(join(ROOT, d)) ? exampleFiles(join(ROOT, d)) : []));
const OUT = join(ROOT, '.poly', 'test-build', 'standing-serial');

test('the serial group holds only the paths it names', () => {
  assert.deepEqual(SERIAL, ['examples/concierge/']);
  assert.ok(FILES.every(serial));
  assert.ok(!serial(join(ROOT, 'examples', 'hello', 'hello.poly')));
  assert.ok(!serial(join(ROOT, 'examples', 'concierge-old', 'x.poly')));
});

for (const file of FILES) {
  test(`no toolchain fault: ${relative(ROOT, file)}`, async () => {
    const r = await checkExample(file, OUT, relative(ROOT, file).replace(/[^a-z0-9]+/gi, '-'));
    assert.ok(r.verdict !== 'ERROR', `poly check errored: ${r.error}`);
    const faults = toolchainFaults([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)]);
    assert.deepEqual(faults.map((d) => `${d.code} ${d.message}`), []);
    // V10 item 4 (ruled 2026-10-10): an example's verdict is the one its first line states.
    if (relative(ROOT, file).startsWith('examples')) { const e = expectedOf(file); assert.ok(e, 'the example states its expected verdict'); assert.equal(mismatch(e, r), null); }
  });
  test(`translation validation agrees: ${relative(ROOT, file)}`, async (t) => {
    for (const b of build(file, 'tv-serial')) {
      const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });
      assert.deepEqual(r.mismatches.map((d) => d.message), []);
      assert.ok(r.transitions > 0);
      t.diagnostic(`${b.machine}: ${r.report.states} states, ${r.transitions} transitions and ${r.propertyChecks} property evaluations compared`);
    }
  });
}
