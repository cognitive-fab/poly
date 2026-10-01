// The freeze of M3 covers the toolchain arms 2 to 4 run (S100): poly's package sources, the vendored engines and
// package-lock.json, with the git commit the freeze was taken from. A one-byte change to a package source, made
// in a temporary copy, shows up as a change to the `toolchain` part and to nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changedParts, manifest, toolchainFiles } from '../experiments/m3/freeze.mjs';
import { ROOT } from './helpers.mjs';

test('S100: the toolchain part holds package sources, the vendored engines and the lock file, and no build output', () => {
  const files = toolchainFiles(ROOT).map((f) => f.split('\\').join('/'));
  assert.ok(files.some((f) => f.endsWith('packages/poly-check/src/pipeline.ts')));
  assert.ok(files.some((f) => f.endsWith('vendor/polygraph/polyrun/src/kernel.mjs')));
  assert.ok(files.some((f) => f.endsWith('/package-lock.json')));
  // A vendored engine's dist/ is the engine itself, and is in; the packages' build output is not.
  assert.ok(files.some((f) => f.endsWith('vendor/sam-pattern/dist/SAM.js')));
  assert.deepEqual(files.filter((f) => /\/packages\/[^/]+\/(dist|node_modules)\/|\/node_modules\/|\.tsbuildinfo$/.test(f)), []);
});

test('S100: a one-byte change to a package source changes the toolchain part, and only it', () => {
  const before = manifest();
  assert.ok('toolchain' in before.parts);
  assert.match(before.commit, /^[0-9a-f]{40}$/);
  // A temporary copy of the toolchain, with one byte of one source changed.
  const copy = mkdtempSync(join(tmpdir(), 'poly-freeze-'));
  try {
    for (const d of ['packages', 'vendor']) cpSync(join(ROOT, d), join(copy, d), { recursive: true, filter: (p) => !/[\\/]packages[\\/][^\\/]+[\\/](dist|node_modules)$/.test(p) });
    cpSync(join(ROOT, 'package-lock.json'), join(copy, 'package-lock.json'));
    const victim = join(copy, 'packages', 'poly-core', 'src', 'digest.ts');
    const text = readFileSync(victim);
    text[0] = text[0] === 0x2f ? 0x20 : 0x2f;
    writeFileSync(victim, text);
    const after = manifest({ toolchainRoot: copy });
    assert.deepEqual(changedParts(before, after), ['toolchain']);
    // The same copy unchanged is the same part.
    text[0] = readFileSync(join(ROOT, 'packages', 'poly-core', 'src', 'digest.ts'))[0];
    writeFileSync(victim, text);
    assert.deepEqual(changedParts(before, manifest({ toolchainRoot: copy })), []);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
