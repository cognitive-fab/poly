// plan-e3.md E3.7: the tool calls of a live turn run in a scratch copy and nowhere else. No admission, no checker: file
// operations and the repositories' own tests in a copy only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originalsUnchanged, prepare } from '../../examples/harness/host/tasks.mjs';
import { runCall, runCalls, words } from '../../examples/harness/host/world.mjs';

const run = `world-${process.pid}`;

test('words: quotes group, nothing expands, no shell is involved', () => {
  assert.deepEqual(words('go test ./... -run "A B" -count=1'), ['go', 'test', './...', '-run', 'A B', '-count=1']);
  assert.deepEqual(words("node -e 'x y' ''"), ['node', '-e', 'x y', '']);
  assert.deepEqual(words('echo $HOME && ls'), ['echo', '$HOME', '&&', 'ls']);
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

test('a bash call runs without a shell, offline, with no key; network commands and shells are refused', async () => {
  const { copy } = prepare('snip-config', run);
  process.env.ANTHROPIC_API_KEY = 'canary-world-key';
  try {
    const r = await runCall(copy, { tool: 'bash', command: 'node -e "console.log(JSON.stringify(process.env))"' });
    assert.equal(r.exitStatus, 0, r.text);
    assert.ok(!r.text.includes('canary-world-key'));
    assert.match(r.text, /"GOPROXY":"off"/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  for (const command of ['curl http://example.com', 'powershell -c x', 'npm install left-pad', 'git push', 'node -e "fetch(\'https://example.com\')"']) {
    const r = await runCall(copy, { tool: 'bash', command });
    assert.equal(r.exitStatus, 1, command);
    assert.match(r.text, /refused/);
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
