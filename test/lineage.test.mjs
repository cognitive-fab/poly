// PD5.2 (S105, S155), PD5-A5: lineage at run time. Every step has a lineage: its origin (the claims of the step that
// started the chain), its intent (that step's machine and action) and the digest of the previous hop. A step started by
// an outside action takes its origin from its claims; a step started by a completion, a timer or a delivered message
// inherits the lineage of the step that caused it and appends one hop. A cross-scope send whose chain is missing or
// broken is denied with SendDenied(to, action, "lineage").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyaxionPeer } from '@poly/runtime';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const ANN = { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' };

test('PD5-A5: a completion, a timer and a delivered message inherit the starting step\'s origin, one hop each', async () => {
  const a = await admitted('lineage', ['conformance/m5/lineage.poly']);
  const { rt, clock } = await loaded(a, { verifier: () => ANN });
  try {
    handleWith(rt, 'lin.work', () => 'done');
    await rt.create('lin.Peer', { id: 'peer' });
    await rt.create('lin.Job', { id: 'job' });
    const start = await rt.dispatch('job', 'Start', { to: 'peer' }, { actionId: 's1', credentials: 'x' });
    assert.equal(start.stepKind, 'accepted');
    clock.advance(2_000);
    await rt.kernel.workers.tickTimers(); // Tick fires while the job works
    await rt.worker.tick(); // the effect runs, and Worked completes it, which sends Ping
    await rt.tick(); // delivers Ping
    const L = (run, action) => rt.lineageOf(run, (rt.store.db.prepare('SELECT seq FROM pr_journal WHERE instance_id = ? AND action = ?').get(run, action)).seq);
    const root = L('job', 'Start');
    assert.deepEqual([root.origin, root.intent, root.prev], [ANN, 'lin.Job.Start', null]);
    for (const [run, action] of [['job', 'Worked'], ['job', 'Tick']]) {
      const l = L(run, action);
      assert.deepEqual([l.origin, l.intent, l.prev], [ANN, 'lin.Job.Start', root.digest], action);
    }
    const worked = L('job', 'Worked');
    const ping = L('peer', 'Ping');
    assert.deepEqual([ping.origin, ping.intent, ping.prev], [ANN, 'lin.Job.Start', worked.digest]);
    assert.deepEqual(rt.verifyLineage('peer', ping.seq), { ok: true, hops: 3 });
    // The step event records the lineage digest (PD5-A11).
    const step = (await rt.chain('peer')).find((e) => e.kind === 'step' && e.body.action === 'Ping').body;
    assert.equal(step.lineage, ping.digest);
  } finally { await rt.close(); }
});

const skip = polyaxionPeer().ok ? false : `not run: ${polyaxionPeer().reason}`;
function inject(rt, id, from, to, action, at, seq) {
  rt.store.db.prepare("INSERT INTO pr_outbox (intent_id, instance_id, seq, kind, payload, status, attempts, next_attempt_at) VALUES (?, ?, ?, 'sendTo', ?, 'pending', 0, ?)").run(id, from, seq, JSON.stringify({ target: to, action, data: {} }), at);
}

test('PD5-A5: a cross-scope send whose lineage is missing or broken is SendDenied(to, action, "lineage")', { skip }, async () => {
  const a = await admitted('lineage-cross', ['conformance/m5/scope-a.poly', 'conformance/m5/scope-b.poly', 'conformance/m5/scope.policy.poly']);
  const { rt, clock } = await loaded(a);
  try {
    await rt.create('sa.Pinger', { id: 'ping' });
    await rt.create('sb.Ponger', { id: 'pong' });
    // The sender's creation step has a lineage; a message from it is proposed and delivered.
    inject(rt, 'm-ok', 'ping', 'pong', 'Ping', clock.now(), 0);
    // A message from a step of the sender that has no lineage (no such step): missing.
    inject(rt, 'm-missing', 'ping', 'pong', 'Ping', clock.now(), 41);
    await rt.tick();
    const v = (await rt.chain('ping')).filter((e) => e.kind === 'verdict').map((e) => [e.body.intent, e.body.outcome, e.body.reason ?? null]);
    assert.deepEqual(v.sort(), [['m-missing', 'denied', 'lineage'], ['m-ok', 'allowed', null]]);
    const denied = (await rt.getJournal('ping')).find((r) => r.action === 'SendDenied');
    assert.equal(denied.data.reason, 'lineage');
    // A broken chain: the sender's lineage record is edited.
    rt.store.db.prepare("UPDATE poly_lineage SET intent = 'sa.Pinger.Forged' WHERE run = 'ping' AND seq = 0").run();
    assert.equal(rt.verifyLineage('ping', 0).ok, false);
    inject(rt, 'm-broken', 'ping', 'pong', 'Shout', clock.now(), 0);
    await rt.tick();
    const broken = (await rt.chain('ping')).filter((e) => e.kind === 'verdict' && e.body.intent === 'm-broken').map((e) => [e.body.outcome, e.body.reason]);
    assert.deepEqual(broken, [['denied', 'lineage']]);
  } finally { await rt.close(); }
});
