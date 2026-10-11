// PT12.5 (ruled 2026-10-11): POLY_ANCHORS_CONFIG names the owner's per-user keyring configuration file. It is read from the
// process's own environment only; a relative path, or one in a tree under version control, is refused (PL6410).
//
// The first version of this file ran `poly anchor keyrings` with the variable set and no test anchors, which on a build
// that ignores the variable wrote the real home's configuration. These tests never reach a write unless a read-only
// probe of the same process has shown that the variable is honoured, so a build without it cannot touch the real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeKey, project } from './runtime-helpers.mjs';
import { ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const CORE = pathToFileURL(join(ROOT, 'packages', 'poly-core', 'dist', 'src', 'index.js')).href;
/** What readAnchorConfig does under an environment: the file it reads, or the refusal. Read-only. */
const PROBE = `import('${CORE}').then((m) => { try { console.log(JSON.stringify({ file: m.readAnchorConfig().file })); } catch (e) { console.log(JSON.stringify({ error: e.message })); } })`;
const probe = (env) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('PT12.5: POLY_ANCHORS_CONFIG names the configuration file that is read', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-anchors-env-'));
  try {
    const file = join(tmp, 'anchors.json');
    assert.deepEqual(probe({ POLY_ANCHORS_CONFIG: file }), { file });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('PT12.5: a relative POLY_ANCHORS_CONFIG, or one inside a tree under version control, is refused with PL6410', () => {
  const rel = probe({ POLY_ANCHORS_CONFIG: 'relative/anchors.json' });
  assert.match(rel.error ?? '', /PL6410/, JSON.stringify(rel));
  assert.match(rel.error, /absolute/);
  const inRepo = probe({ POLY_ANCHORS_CONFIG: join(ROOT, 'test', 'anchors-refused.json') });
  assert.match(inRepo.error ?? '', /PL6410/, JSON.stringify(inRepo));
  assert.match(inRepo.error, /version control/);
});

test('PT12.5: poly anchor keyrings writes the configuration at the named path, and the anchor beside it', { timeout: 120_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-anchors-env-'));
  try {
    const config = join(tmp, 'anchors.json');
    // The guard: only a build that honours the variable gets as far as a write.
    assert.deepEqual(probe({ POLY_ANCHORS_CONFIG: config }), { file: config }, 'the variable is not honoured, so nothing is run');
    const dir = project('anchors-env-test', ['conformance/m4/outbox.poly'], makeKey('anchors-env-test'), 'test-anchors-env');
    const anchor = join(tmp, 'test.anchor');
    execFileSync(process.execPath, [CLI, 'anchor', 'keyrings', '--project', dir, '--out', anchor], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, POLY_ANCHORS_CONFIG: config } });
    assert.ok(existsSync(config), 'the configuration is at the named path');
    const doc = JSON.parse(readFileSync(config, 'utf8'));
    assert.deepEqual(Object.keys(doc.anchors), ['anchors-env-test']);
    assert.ok(doc.anchors['anchors-env-test'].startsWith('file:'), JSON.stringify(doc));
    assert.ok(existsSync(anchor), 'the anchor is written');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
