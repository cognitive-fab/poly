// plan-e3.md E3.7, docs/e3/tasks-spec.md, and the owner's three rules of 2026-10-12 for the handlers that run a task:
//   (1) work only in the ignored scratch copies, never on the originals;
//   (2) no network for the commands a task runs;
//   (3) no key in any environment a task sees.
// And the proof, before any model is called: for every stage of every task, the stage's check fails as a test before its
// reference fix and passes after it, and every check passes once every stage is fixed (the oracle). No model, no checker, no
// network: the commands are the repositories' own tests (vitest, go test), run in copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../helpers.mjs';
import {
  SCRATCH, TASKS_DIR, commandEnv, digestOf, failedAsATest, originalOf, originalsUnchanged, prepare, prove, refusal, replaceIn, repos, runIn, snapshot, taskIds, taskOf,
} from '../../examples/harness/host/tasks.mjs';

const ids = taskIds();

test('the twelve tasks: six from each repository, 31 stages, plans of two to four, each with its check and its files', () => {
  assert.equal(ids.length, 12);
  const by = { 'todo-app': 0, snip: 0 };
  let stages = 0;
  for (const id of ids) {
    const t = taskOf(id);
    assert.equal(t.id, id);
    by[t.repo] += 1;
    assert.ok(t.stages.length >= 2 && t.stages.length <= 4, id);
    assert.equal(t.plan.length, t.stages.length, `${id}: the plan names each stage`);
    assert.ok(t.prompt.length > 40);
    stages += t.stages.length;
    for (const s of t.stages) {
      assert.ok(s.edits.length >= 1 && s.edits.every((e) => e.fixed !== e.broken && ['injected', 'pristine'].includes(e.origin)), `${id}: ${s.title}`);
      assert.equal(refusal(s.check.cmd, s.check.args), null, `${id}: a check is not a network command`);
      assert.ok(['node', 'go'].includes(s.check.cmd));
    }
    for (const a of t.addFiles ?? []) assert.ok(existsSync(join(TASKS_DIR, id, a.from)), `${id}: ${a.from}`);
  }
  assert.deepEqual(by, { 'todo-app': 6, snip: 6 });
  assert.equal(stages, 31);
});

test('Q-E3-7: a snip task carries snip\'s MIT notice and the attribution line; no md2pdf task exists', () => {
  for (const id of ids.filter((x) => taskOf(x).repo === 'snip')) {
    const n = readFileSync(join(TASKS_DIR, id, 'NOTICE'), 'utf8');
    assert.match(n, /MIT License/);
    assert.match(n, /Copyright \(c\) 2026 snip contributors/);
    assert.match(n, /Portions of snip, by Edouard Claude and contributors, MIT licensed/);
  }
  assert.ok(!ids.some((id) => taskOf(id).repo === 'md2pdf'));
  assert.deepEqual(Object.keys(repos()).sort(), ['snip', 'todo-app']);
});

test('rule 3: the environment of a command holds no key, whatever the process holds', () => {
  const canary = `canary-${'cd'.repeat(10)}`;
  const base = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
    ANTHROPIC_API_KEY: canary, OPENAI_API_KEY: canary, GITHUB_TOKEN: canary, AWS_SECRET_ACCESS_KEY: canary, MY_PASSWORD: canary,
    NPM_CONFIG__AUTH: canary, GOOGLE_APPLICATION_CREDENTIALS: canary, SESSION_COOKIE: canary, SOME_PRIVATE_THING: canary,
    PATH_TOKEN: canary, GOPATH: process.env.GOPATH ?? 'C:\\go', EDITOR: 'vim', RANDOM_NAME: canary,
  };
  const env = commandEnv(base);
  assert.deepEqual(Object.keys(env).filter((k) => String(env[k]).includes(canary)), [], 'no value of the process leaks by a secret-looking name, and no unlisted name passes');
  assert.ok(!('EDITOR' in env) && !('RANDOM_NAME' in env), 'only the allow-list passes');
  assert.ok(env.PATH && 'GOPATH' in env);
});

test('rule 3, at run time: a real command sees no key, with keys set in this process', async () => {
  const { copy } = prepare('snip-config', `env-${process.pid}`);
  const canary = `canary-${'ef'.repeat(10)}`;
  const names = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'POLY_TEST_PASSWORD'];
  for (const n of names) process.env[n] = canary;
  try {
    const r = await runIn(copy, 'node', ['-e', 'console.log(JSON.stringify(process.env))']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(canary), 'a key reached a command');
    const seen = JSON.parse(r.stdout);
    for (const n of names) assert.ok(!(n in seen), n);
    // rule 2's environment, seen from inside
    assert.equal(seen.GOPROXY, 'off');
    assert.equal(seen.GOFLAGS, '-mod=readonly');
    assert.equal(seen.npm_config_offline, 'true');
    assert.match(seen.HTTPS_PROXY, /127\.0\.0\.1:9$/);
  } finally {
    for (const n of names) delete process.env[n];
  }
});

test('rule 2: a command that names a network tool, a fetching subcommand or a URL is refused before it runs', async () => {
  for (const [cmd, args] of [
    ['curl', ['x']], ['wget', ['x']], ['ssh', ['host']], ['nc', ['host', '1']], ['powershell', ['-c', 'x']], ['bash', ['-c', 'x']], ['cmd', ['/c', 'x']],
    ['npm', ['install']], ['npm', ['ci']], ['pnpm', ['add', 'x']], ['npx', ['left-pad']], ['go', ['get', 'x']], ['go', ['install', 'x']], ['go', ['mod', 'download']],
    ['git', ['clone', 'x']], ['git', ['fetch']], ['git', ['push']], ['pip', ['install', 'x']], ['py', ['-m', 'pip']], ['node', ['-e', 'fetch("https://example.com")']],
  ]) assert.notEqual(refusal(cmd, args), null, `${cmd} ${args.join(' ')}`);
  for (const [cmd, args] of [['node', ['x.js']], ['node', ['node_modules/vitest/vitest.mjs', 'run']], ['go', ['test', './...']], ['go', ['vet', './...']], ['git', ['diff']], ['npx', ['--no-install', 'vitest']]]) {
    assert.equal(refusal(cmd, args), null, `${cmd} ${args.join(' ')}`);
  }
  const { copy } = prepare('snip-config', `refuse-${process.pid}`);
  const r = await runIn(copy, 'curl', ['http://example.com']);
  assert.deepEqual([r.status, r.refused !== null, r.stdout], [null, true, ''], 'refused, not run');
});

test('rule 1: a copy is made in the scratch folder, from an original whose digest is pinned, and a changed original refuses the task', () => {
  const r = prepare('todo-urgency', `copy-${process.pid}`);
  assert.ok(r.copy.startsWith(SCRATCH), r.copy);
  assert.ok(r.copy.startsWith(resolve(ROOT, '.poly', 'e3-tasks')));
  // the originals' installed packages are linked, read, never copied or written
  const nm = join(r.copy, 'node_modules');
  assert.ok(lstatSync(nm).isSymbolicLink());
  assert.equal(realpathSync(nm), realpathSync(join(originalOf('todo-app'), 'node_modules')));
  assert.throws(() => prepare('todo-urgency', `stale-${process.pid}`, { expectDigest: '0'.repeat(64) }), /has changed since the tasks were written/);
  // an edit cannot leave the copy
  assert.throws(() => replaceIn(r.copy, '../escape.txt', 'a', 'b'), /outside the copy/);
  assert.throws(() => replaceIn(r.copy, resolve(ROOT, 'package.json'), 'a', 'b'), /outside the copy/);
  // the break is in the copy and not in the original
  assert.ok(readFileSync(join(r.copy, 'src/core/urgency.js'), 'utf8').includes('return 59;'));
  assert.ok(!readFileSync(join(originalOf('todo-app'), 'src/core/urgency.js'), 'utf8').includes('return 59;'));
});

test('a failure counts as a failed test only when a test failed, not when the copy would not build', () => {
  assert.equal(failedAsATest({ stdout: '--- FAIL: TestX (0.00s)\nFAIL', stderr: '' }), true);
  assert.equal(failedAsATest({ stdout: ' FAIL  tests/a.test.js > x\nAssertionError: expected 1 to be 2', stderr: '' }), true);
  assert.equal(failedAsATest({ stdout: '', stderr: 'pipeline.go:129:6: declared and not used: i\nFAIL x [build failed]' }), false);
  assert.equal(failedAsATest({ stdout: 'SyntaxError: Unexpected token', stderr: '', }), false);
  assert.equal(failedAsATest({ stdout: '', stderr: '', timedOut: true }), false);
});

test('the originals are unchanged at the start (their digests are the pinned ones)', () => {
  assert.deepEqual(originalsUnchanged(), { 'todo-app': true, snip: true });
  for (const name of Object.keys(repos())) assert.equal(digestOf(snapshot(originalOf(name))), repos()[name].digest);
});

for (const id of ids) {
  test(`the oracle, ${id}: every stage's check fails as a test before its fix, passes after it, and passes with every stage fixed`, { timeout: 900_000 }, async () => {
    const r = await prove(id, { run: `proof-${process.pid}` });
    assert.deepEqual(r.problems, [], id);
    assert.equal(r.stages, taskOf(id).stages.length);
  });
}

test('the originals are unchanged after the proofs, and nothing was written outside the scratch folder', () => {
  assert.deepEqual(originalsUnchanged(), { 'todo-app': true, snip: true });
  // the junction still points at the original's packages and the original has no scratch file
  const nm = join(SCRATCH, `proof-${process.pid}`, 'todo-urgency', 'node_modules');
  assert.ok(lstatSync(nm).isSymbolicLink());
  assert.ok(readlinkSync(nm).length > 0);
  for (const name of Object.keys(repos())) {
    assert.ok(!existsSync(join(originalOf(name), '.gocache')), `${name}: no build cache in the original`);
    assert.ok(!existsSync(join(originalOf(name), 'internal', 'filter', 'task_dedup_test.go')), `${name}: no added test in the original`);
  }
});
