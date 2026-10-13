// plan-e3.md E3.7: the tool calls of a live turn run in a scratch copy and nowhere else. No admission, no checker: file
// operations and the repositories' own tests in a copy only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originalsUnchanged, prepare } from '../../examples/harness/host/tasks.mjs';
import { bashArgv, runCall, runCalls } from '../../examples/harness/host/world.mjs';

const run = `world-${process.pid}`;

test('bashArgv: a declared runner is an argv, and a shell metacharacter, an unlisted program or a path out of the copy is refused', async () => {
  const { copy } = prepare('snip-config', run);
  for (const command of ['go test ./internal/config -run TestX -count 1', 'go vet ./...', 'npm test', 'npm run test', 'node --test t/a.test.mjs', 'node node_modules/vitest/vitest.mjs run tests/a.test.js']) {
    assert.ok(bashArgv(copy, { command }).argv, command);
  }
  assert.deepEqual(bashArgv(copy, { argv: ['go', 'test', './...'] }).argv, ['go', 'test', './...']);
  // each of the shell metacharacters, whole or inside a word, in a command that would otherwise pass
  for (const meta of [';', '&', '&&', '|', '||', '>', '<', '>>', '`x`', '$(x)', '$HOME', '*', '?', '~', '!', '#', '"x"', "'x'", '(', ')', '{', '}', '\n', '\\']) {
    for (const command of [`go test ./... ${meta}`, `npm test${meta}`, `go test ./...${meta}ls`]) {
      assert.ok(bashArgv(copy, { command }).refused, JSON.stringify(command));
    }
    assert.ok(bashArgv(copy, { argv: ['go', 'test', `./${meta}`] }).refused, `argv with ${JSON.stringify(meta)}`);
  }
  assert.ok(bashArgv(copy, { command: 'go  test' }).refused, 'a double space is not a word');
  // a program that is not on the list, however innocent
  for (const command of ['ls', 'cat a.txt', 'echo hi', 'git status', 'make test', 'cargo test', 'tsc --noEmit', 'pytest', 'py -m pytest', 'python -m unittest', 'sh run.sh', 'rm -rf x', 'curl x', 'powershell x', 'node', 'node a.js', 'npm install', 'npm exec x', 'go get x', 'go run main.go', 'go mod tidy']) {
    assert.match(bashArgv(copy, { command }).refused ?? 'accepted', /declared runners|word holds/, command);
  }
  // node runs no code by option, go runs no other program
  for (const command of ['node --test -e x', 'node node_modules/vitest/vitest.mjs run --import x', 'node --test C:/x.test.mjs', 'go test ./... -exec sh', 'go test ./... -toolexec sh', 'go test -o out ./...']) {
    assert.ok(bashArgv(copy, { command }).refused, command);
  }
  // a path out of the copy
  for (const command of ['node --test ../x.test.mjs', 'node --test /etc/x.test.mjs', 'go test ../other', 'go test ./a/../../b', 'node node_modules/vitest/vitest.mjs run ../../x']) {
    assert.match(bashArgv(copy, { command }).refused ?? 'accepted', /outside the copy/, command);
  }
  assert.ok(bashArgv(copy, { command: 7 }).refused);
  assert.ok(bashArgv(copy, {}).refused);
  assert.ok(bashArgv(copy, { argv: [] }).refused);
  assert.ok(bashArgv(copy, { argv: 'go test' }).refused);
  // and through the tool: refused, not run
  const r = await runCall(copy, { tool: 'bash', command: 'go test ./... | cat' });
  assert.deepEqual([r.exitStatus, r.text.startsWith('refused:')], [1, true]);
});

test('edit, write, read and search work inside the copy; an edit needs its old text once; a path out of the copy is an error, not an escape', async () => {
  const { copy } = prepare('snip-config', run);
  const f = 'internal/config/config.go';
  const text = readFileSync(join(copy, f), 'utf8');
  const dup = await runCall(copy, { tool: 'edit', path: f, old: 'func ', new: 'func  ' });
  assert.equal(dup.exitStatus, 1, 'an old text that occurs many times is refused');
  assert.match(dup.text, /must occur once/);
  assert.equal(readFileSync(join(copy, f), 'utf8'), text, 'a refused edit changes nothing');
  const w = await runCall(copy, { tool: 'write', path: 'notes/a.txt', content: 'hello\nworld\n' });
  assert.equal(w.exitStatus, 0);
  assert.equal((await runCall(copy, { tool: 'read', path: 'notes/a.txt' })).text, 'hello\nworld\n');
  assert.equal((await runCall(copy, { tool: 'edit', path: 'notes/a.txt', old: 'world', new: 'there' })).exitStatus, 0);
  assert.equal(readFileSync(join(copy, 'notes/a.txt'), 'utf8'), 'hello\nthere\n');
  assert.equal((await runCall(copy, { tool: 'edit', path: 'notes/a.txt', old: 'zzz', new: 'q' })).exitStatus, 1);
  const s = await runCall(copy, { tool: 'search', pattern: '^there$', path: 'notes' });
  assert.match(s.text, /notes\/a\.txt:2:there/);
  for (const path of ['../escape.txt', '..\escape.txt']) {
    const r = await runCall(copy, { tool: 'write', path, content: 'x' });
    assert.equal(r.exitStatus, 1, path);
    assert.match(r.text, /outside the copy/);
  }
  assert.ok(!existsSync(join(copy, '..', 'escape.txt')));
  assert.equal((await runCall(copy, { tool: 'nope' })).exitStatus, 1);
});

test('a listed runner runs in the copy, offline, with no key in its environment', async () => {
  const { copy } = prepare('snip-config', run);
  const probe = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('env', () => {",
    "  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);",
    "  assert.equal(process.env.GOPROXY, 'off');",
    "  assert.equal(process.cwd().includes('e3-tasks'), true);",
    '});',
    '',
  ].join('\n');
  assert.equal((await runCall(copy, { tool: 'write', path: 'probe/env.test.mjs', content: probe })).exitStatus, 0);
  process.env.ANTHROPIC_API_KEY = 'canary-world-key';
  try {
    const r = await runCall(copy, { tool: 'bash', command: 'node --test probe/env.test.mjs' });
    assert.equal(r.exitStatus, 0, r.text);
    assert.ok(!r.text.includes('canary-world-key'));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('runCalls: the calls of a turn in order, the last failure sets the status, bad JSON is a failed turn and not a throw', async () => {
  const { copy } = prepare('snip-config', run);
  const r = await runCalls(copy, JSON.stringify([{ tool: 'write', path: 'a.txt', content: '1' }, { tool: 'read', path: 'missing.txt' }, { tool: 'read', path: 'a.txt' }]));
  assert.equal(r.exitStatus, 1);
  assert.match(r.text, /wrote a\.txt/);
  assert.ok(r.text.endsWith('1'));
  assert.equal((await runCalls(copy, '[{"tool":"edit"')).exitStatus, 1);
  assert.equal((await runCalls(copy, '{"tool":"read"}')).exitStatus, 1);
});

test('the originals are unchanged after the calls', () => {
  assert.deepEqual(originalsUnchanged(), { 'todo-app': true, snip: true });
});
