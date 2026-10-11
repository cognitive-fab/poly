// PT12.5 (ruled 2026-10-11): POLY_ANCHORS_CONFIG names a keyring configuration file only for a process that already accepts
// test anchors (S194). Any other process ignores it, says so with PL6410, and reads the owner's configuration under the home
// directory, so the environment cannot redirect the owner's anchor.
//
// An earlier version ran `poly anchor keyrings` with the variable and no test anchors, which on a build that ignored the
// variable wrote the real home's configuration. Nothing here runs a command that writes unless the process is a test
// process (the preload), and the process that is not one is only asked, read-only, which file it would read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeKey, project } from './runtime-helpers.mjs';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const CORE = pathToFileURL(join(ROOT, 'packages', 'poly-core', 'dist', 'src', 'index.js')).href;
/** What readAnchorConfig does under an environment: the file it reads and its source, or the refusal. Read-only. */
const PROBE = `import('${CORE}').then((m) => { try { const c = m.readAnchorConfig(); console.log(JSON.stringify({ file: c.file, source: c.source })); } catch (e) { console.log(JSON.stringify({ error: e.message })); } })`;
/** A process that is not a test process, or, with test, one that accepts test anchors by the preload every test child uses. */
function probe(env, { test = false } = {}) {
  const r = spawnSync(process.execPath, [...(test ? ACCEPT_TEST_ANCHORS : []), '--input-type=module', '-e', PROBE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout), stderr: r.stderr };
}
const HOME_CONFIG = join(userInfo().homedir, '.poly', 'anchors.json');

test('PT12.5: a process that is not a test process ignores POLY_ANCHORS_CONFIG, says so with PL6410, and reads the home configuration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-anchors-env-'));
  try {
    const r = probe({ POLY_ANCHORS_CONFIG: join(tmp, 'anchors.json') });
    assert.equal(r.file, HOME_CONFIG);
    assert.equal(r.source, 'user');
    assert.match(r.stderr, /PL6410/);
    assert.match(r.stderr, /POLY_ANCHORS_CONFIG is not honoured outside a test process/);
    // Without the variable it says nothing.
    assert.doesNotMatch(probe({ POLY_ANCHORS_CONFIG: '' }).stderr, /PL6410/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PT12.5: a test process reads the file POLY_ANCHORS_CONFIG names, as source "test"', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-anchors-env-'));
  try {
    const file = join(tmp, 'anchors.json');
    const r = probe({ POLY_ANCHORS_CONFIG: file }, { test: true });
    assert.deepEqual([r.file, r.source], [file, 'test']);
    assert.doesNotMatch(r.stderr, /PL6410/);
    // Without the variable it reads its own folder, as before.
    assert.notEqual(probe({ POLY_ANCHORS_CONFIG: '' }, { test: true }).file, file);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PT12.5: in a test process a relative path, or one inside a tree under version control, is refused with PL6410', () => {
  const rel = probe({ POLY_ANCHORS_CONFIG: 'relative/anchors.json' }, { test: true });
  assert.match(rel.error ?? '', /PL6410/, JSON.stringify(rel));
  assert.match(rel.error, /absolute/);
  const inRepo = probe({ POLY_ANCHORS_CONFIG: join(ROOT, 'test', 'anchors-refused.json') }, { test: true });
  assert.match(inRepo.error ?? '', /PL6410/, JSON.stringify(inRepo));
  assert.match(inRepo.error, /version control/);
});

test('PT12.5: poly anchor keyrings in a test process writes the configuration at the named path, and the anchor beside it', { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-anchors-env-'));
  try {
    const config = join(tmp, 'anchors.json');
    // The guard: only a process that honours the variable gets as far as a write.
    assert.deepEqual(probe({ POLY_ANCHORS_CONFIG: config }, { test: true }).file, config, 'the variable is not honoured, so nothing is run');
    const dir = project('anchors-env-test', ['conformance/m4/outbox.poly'], makeKey('anchors-env-test'), 'test-anchors-env');
    const anchor = join(tmp, 'test.anchor');
    execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, 'anchor', 'keyrings', '--project', dir, '--out', anchor], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, POLY_ANCHORS_CONFIG: config } });
    assert.ok(existsSync(config), 'the configuration is at the named path');
    const doc = JSON.parse(readFileSync(config, 'utf8'));
    assert.deepEqual(Object.keys(doc.anchors), ['anchors-env-test']);
    assert.ok(doc.anchors['anchors-env-test'].startsWith('file:'), JSON.stringify(doc));
    assert.ok(existsSync(anchor), 'the anchor is written');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
