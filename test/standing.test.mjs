// Standing rule (decisions-m0.md, after the review): PL2501 and PL2001 are
// for toolchain faults only. A user program with an error is reported at its
// source line with a user-facing code; any user program that reaches PL2501
// or PL2001 is a checker bug.
//
// Every poly source in the repository goes through the whole `poly check`
// pipeline with no exception. The deliberately broken lowerings, the only
// programs allowed a toolchain code, are not sources: they are named in the
// explicit list of test/toolchain-faults.mjs, which is checked here against
// poly-lower's own list, and are exercised only by test/tv.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { checkFile } from '@poly/check';
import { FAULTS } from '@poly/lower';
import { ROOT } from './helpers.mjs';
import { DELIBERATELY_BROKEN_LOWERINGS, toolchainFaults } from './toolchain-faults.mjs';

// Build output and installed packages are not sources. Their directories are not entered at all: an
// installed package may be a link to an engine's own checkout, with files a walk cannot stat.
const NOT_SOURCES = new Set(['node_modules', '.poly', '.git']);

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (NOT_SOURCES.has(e)) continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.poly')) out.push(p);
  }
  return out.sort();
}

// Every directory that holds poly sources, and nothing filtered out of them.
const ALL = ['examples', 'conformance', join('test', 'fixtures')].flatMap((d) => sources(join(ROOT, d)));
const OUT = join(ROOT, '.poly', 'test-build', 'standing');

test('the exception is an explicit list, equal to poly-lower\'s faults', () => {
  assert.deepEqual([...DELIBERATELY_BROKEN_LOWERINGS].sort(), [...FAULTS].sort());
});

test('the standing rule covers every source in the repository', () => {
  const everywhere = sources(ROOT);
  assert.deepEqual(everywhere.map((p) => relative(ROOT, p)).sort(), ALL.map((p) => relative(ROOT, p)).sort());
  assert.ok(ALL.length >= 49, `${ALL.length} sources`);
});

for (const file of ALL) {
  test(`no toolchain fault: ${relative(ROOT, file)}`, async () => {
    const r = await checkFile(file, { root: OUT });
    assert.ok(r.verdict !== 'ERROR', `poly check errored: ${r.error}`);
    const faults = toolchainFaults([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)]);
    assert.deepEqual(faults.map((d) => `${d.code} ${d.message}`), []);
  });
}
