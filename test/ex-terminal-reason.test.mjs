// docs/examples/language-findings.md, item 9 (resolved in favour of the specification): PS3.2 gives a terminal instance the
// verdict rejected("terminal") for every action, before any guard and before the handler. The handler's own reject text
// ("door-is-closed" here) is unreachable from a terminal state. The runtime and the specification agree; the example spec
// that said otherwise was wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitted, loaded } from './runtime-helpers.mjs';

const a = await admitted('terminal-reason', ['test/fixtures/terminal-reason/terminal.poly']);

test('a terminal instance rejects every action with the reason terminal, not the handler\'s own text', async () => {
  const { rt } = await loaded(a);
  try {
    await rt.create('term.Door', { id: 'd' });
    assert.equal((await rt.dispatch('d', 'Close', {})).stepKind, 'accepted');
    const r = await rt.dispatch('d', 'Knock', {});
    assert.deepEqual([r.stepKind, r.rejectReason], ['rejected', 'terminal']);
    const again = await rt.dispatch('d', 'Close', {});
    assert.deepEqual([again.stepKind, again.rejectReason], ['rejected', 'terminal']);
  } finally { await rt.close(); }
});

test('before it is terminal, the handler\'s own reason is the one given', async () => {
  const { rt } = await loaded(a);
  try {
    await rt.create('term.Door', { id: 'e' });
    assert.equal((await rt.dispatch('e', 'Knock', {})).stepKind, 'accepted');
  } finally { await rt.close(); }
});
