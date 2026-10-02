// PS8.7, PT9.9, S160: a message between two trust scopes is proposed to the gate in the sender's session. Allowed, it
// is delivered; denied, it is not, and SendDenied reaches the sender. In M5a no program makes a cross-scope send
// (a scope is a module, and configurations have no runtime instances before S153), so the message is injected below
// the language; M5b adds the end-to-end test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyaxionPeer } from '@poly/runtime';
import { checkFile } from '@poly/check';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;

/** A message in transit from `from` to `to`, written as polyrun writes a sendTo intent (below the language). */
function inject(rt, id, from, to, action, at) {
  rt.store.db.prepare("INSERT INTO pr_outbox (intent_id, instance_id, seq, kind, payload, status, attempts, next_attempt_at) VALUES (?, ?, 0, 'sendTo', ?, 'pending', 0, ?)").run(id, from, JSON.stringify({ target: to, action, data: {} }), at);
}

test('PT9.9: a cross-scope send the policy denies is not delivered, and SendDenied reaches the sender', { skip }, async () => {
  const a = await admitted('cross-scope', ['conformance/m5/scope-a.poly', 'conformance/m5/scope-b.poly', 'conformance/m5/scope.policy.poly']);
  const { rt, clock } = await loaded(a);
  try {
    await rt.create('sa.Pinger', { id: 'ping' });
    await rt.create('sb.Ponger', { id: 'pong' });
    inject(rt, 'm-shout', 'ping', 'pong', 'Shout', clock.now());
    inject(rt, 'm-ping', 'ping', 'pong', 'Ping', clock.now());
    await rt.tick();
    const v = (await rt.chain('ping')).filter((e) => e.kind === 'verdict').map((e) => e.body);
    assert.deepEqual(v.map((b) => [b.intent, b.outcome, b.session]).sort(), [['m-ping', 'allowed', 'scope:sa'], ['m-shout', 'denied', 'scope:sa']]);
    assert.match(v.find((b) => b.intent === 'm-shout').reason, /no-shouting/);
    assert.equal((await rt.getState('pong')).state.pings, 1, 'the ping was delivered');
    const ponger = (await rt.getJournal('pong')).map((r) => r.action);
    assert.ok(!ponger.includes('Shout'), 'the shout was not delivered');
    assert.equal((await rt.getState('ping')).state.denied, 1, 'SendDenied reached the sender');
    const sd = (await rt.getJournal('ping')).find((r) => r.action === 'SendDenied');
    assert.equal(sd.action_id, 'm-shout:send-denied');
    assert.deepEqual([sd.data.to, sd.data.action], ['pong', 'Shout']);
    const [s] = await rt.replaySessions();
    assert.deepEqual(s.diagnostics, []);
  } finally { await rt.close(); }
});

test('PT9.9: a send within one scope is not proposed', { skip }, async () => {
  const a = await admitted('cross-scope-same', ['conformance/m5/scope-a.poly', 'conformance/m5/scope-b.poly', 'conformance/m5/scope.policy.poly']);
  const { rt, clock } = await loaded(a);
  try {
    await rt.create('sb.Ponger', { id: 'p1' });
    await rt.create('sb.Ponger', { id: 'p2' });
    inject(rt, 'm-local', 'p1', 'p2', 'Ping', clock.now());
    await rt.tick();
    assert.equal((await rt.getState('p2')).state.pings, 1);
    assert.deepEqual((await rt.chain('p1')).filter((e) => e.kind === 'verdict'), []);
  } finally { await rt.close(); }
});

test('PS8.7, S160: a configuration assigns scopes, and its check explores the gate\'s deny with SendDenied', async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm5', 'split.poly'), { root: join(ROOT, '.poly', 'test-policy', 'split') });
  const c = r.configurations.find((x) => x.configuration === 'split');
  const f = c.diagnostics.find((d) => d.code === 'PL5401');
  assert.ok(f, 'the invariant a denied send breaks is violated');
  assert.deepEqual(f.witness.trace.map((s) => s.global?.kind), ['input', 'gate', 'deliver']);
  assert.match(f.witness.trace[1].action, /^gate:deny$/);
  assert.equal(f.witness.trace[2].action, 'SendDenied');
});
