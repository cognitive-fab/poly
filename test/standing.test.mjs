// Standing rule (decisions-m0.md, after the review): PL2501 and PL2001 are
// for toolchain faults only. A user program with an error is reported at its
// source line with a user-facing code; any user program that reaches PL2501
// or PL2001 is a checker bug. This runs the whole `poly check` pipeline over
// every poly source in the repository. The deliberately broken lowerings of
// test/tv.test.mjs are the only programs allowed to reach PL2501, and they
// never pass through this pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.poly')) out.push(p);
  }
  return out.sort();
}

const ALL = ['examples', 'conformance', join('test', 'fixtures')].flatMap((d) => sources(join(ROOT, d)));
const OUT = join(ROOT, '.poly', 'test-build', 'standing');

test('the standing rule covers every source', () => assert.ok(ALL.length >= 37, `${ALL.length} sources`));

for (const file of ALL) {
  test(`no toolchain fault: ${relative(ROOT, file)}`, async () => {
    const r = await checkFile(file, { root: OUT });
    assert.ok(r.verdict !== 'ERROR', `poly check errored: ${r.error}`);
    const all = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)];
    const faults = all.filter((d) => d.code === 'PL2501' || d.code === 'PL2001');
    assert.deepEqual(faults.map((d) => `${d.code} ${d.message}`), []);
  });
}
