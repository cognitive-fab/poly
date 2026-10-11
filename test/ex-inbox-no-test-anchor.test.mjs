// plan-ex.md E2, S194: the dry run's preload calls acceptTestAnchors so that its host can load a certificate admitted under
// a test keyring anchor. That workaround must stay in the harness. This test runs the README's own startup command (the
// dry run's host step, filled for a scaffolded project) with no preload, against a certificate that says it was admitted
// under a test anchor, and holds that the host refuses with PL6410 KEYRING_NOT_SIGNED before it reads anything else. It
// also holds that nothing under examples/ calls acceptTestAnchors, so the owner's first live run cannot accept one.
// Light: no admission runs; the certificate is a stub, and the refusal precedes every other check of it (load.ts verifyBuild).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { fill, readmeSteps, runCommand } from './ex-inbox-readme.mjs';

test('the README\'s startup path, with no preload, refuses a certificate admitted under a test anchor (S194)', () => {
  const base = mkdtempSync(join(tmpdir(), 'poly-inbox-s194-'));
  const vars = { REPO: ROOT, DRY_PROJECT: join(base, 'project'), DRY_KEYS: join(base, 'keys') };
  const anchors = join(base, 'anchors');
  try {
    const { steps } = readmeSteps();
    const by = (name) => steps.find((s) => s.name === name).commands;
    for (const c of by('dry-1-setup')) assert.equal(runCommand(fill(c, vars), { anchors }).status, 0);
    // A certificate that claims a test anchor. Every other check of it comes after the refusal, so a stub is enough.
    mkdirSync(join(vars.DRY_PROJECT, '.poly'), { recursive: true });
    writeFileSync(join(vars.DRY_PROJECT, '.poly', 'certificate.json'), JSON.stringify({ subject: { machines: [] }, poly: { keyringChain: { source: 'test' } } }));

    const start = fill(by('dry-6-run')[0], vars);
    const bare = runCommand(start, { anchors, preload: false });
    assert.notEqual(bare.status, 0, `the host started under a test anchor:\n${bare.stdout}`);
    assert.match(bare.stderr, /PL6410 KEYRING_NOT_SIGNED/);
    assert.match(bare.stderr, /test keyring anchor, which only a test process accepts \(S194\)/);
    assert.ok(!/inbox host started/.test(bare.stdout), bare.stdout);

    // The same command with the preload gets past that check (and fails later, on the stub), which shows the test sees the flag.
    const preloaded = runCommand(start, { anchors });
    assert.ok(!/PL6410/.test(preloaded.stderr), preloaded.stderr);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10 }); }
});

test('nothing the owner runs calls acceptTestAnchors: only the tests\' preload does', () => {
  const callers = [];
  for (const e of readdirSync(join(ROOT, 'examples'), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.(mjs|js|ts|json|md)$/.test(e.name)) continue;
    const file = join(e.parentPath, e.name);
    if (/acceptTestAnchors/.test(readFileSync(file, 'utf8'))) callers.push(file);
  }
  assert.deepEqual(callers, [], 'examples/ must not call acceptTestAnchors');
  assert.match(readFileSync(join(ROOT, 'test', 'ex-inbox-preload.mjs'), 'utf8'), /acceptTestAnchors\(\)/);
});
