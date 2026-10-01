// S116: freeze.json records the environment every arm shares (the Node version, the claude CLI's version, the exact
// model id and the operating system), and the runner refuses a run, pilots included, when any of them differs from
// the record. The model id is the exact id passed to the CLI, never an alias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { currentEnvironment, environmentDiff, isExactModelId } from '../experiments/m3/lib/environment.mjs';
import { M3 } from '../experiments/m3/lib/task.mjs';

const frozen = JSON.parse(readFileSync(join(M3, 'freeze.json'), 'utf8'));

test('S116: freeze.json records the Node version, the claude CLI version, the exact model id and the operating system', () => {
  const e = frozen.environment;
  assert.ok(e, 'freeze.json has no environment');
  assert.match(e.node, /^v\d+\.\d+\.\d+$/);
  assert.match(e.claude, /^\d+\.\d+\.\d+/);
  assert.ok(isExactModelId(e.model), e.model);
  assert.ok(e.os.platform && e.os.release && e.os.arch, JSON.stringify(e.os));
  // The machine the tests run on is the one the freeze was taken on.
  assert.deepEqual(environmentDiff(e, currentEnvironment({ model: e.model })), []);
});

test('S116: an alias is never a model id', () => {
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default', 'opus[1m]', 'best', '']) assert.equal(isExactModelId(alias), false, alias);
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]']) assert.equal(isExactModelId(id), true, id);
});

test('S116: every field that differs is named', () => {
  const e = frozen.environment;
  assert.deepEqual(environmentDiff(e, { ...e }), []);
  assert.deepEqual(environmentDiff(e, { ...e, node: 'v0.0.0', claude: '0.0.0 (Claude Code)' }), ['claude', 'node']);
  assert.deepEqual(environmentDiff(e, { ...e, os: { ...e.os, release: '0' } }), ['os']);
  assert.deepEqual(environmentDiff(e, { ...e, model: 'claude-other-1' }), ['model']);
  // A freeze without a record matches nothing.
  assert.deepEqual(environmentDiff(undefined, e), ['claude', 'model', 'node', 'os']);
});

test('S116: the runner refuses a run, a pilot included, whose model differs from the record or is an alias', () => {
  const runner = join(M3, 'runner', 'run.mjs');
  const out = join(tmpdir(), 'poly-m3-env-test');
  for (const [task, model] of [['P1', 'claude-other-1'], ['T1', 'claude-other-1'], ['P1', 'opus']]) {
    const r = spawnSync(process.execPath, [runner, '--arm', '1', '--task', task, '--model', model, '--tokens', '1', '--wall', '1', '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${task} ${model}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /environment/i, `${task} ${model}: ${r.stderr}`);
    assert.match(r.stderr, /model/, `${task} ${model}: ${r.stderr}`);
  }
});
