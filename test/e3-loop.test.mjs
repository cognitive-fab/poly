// plan-e3.md E3.4: recorded tasks run end to end through the harness under poly-runtime. No model, network or tool is
// called: the provider answers from the recording and the tool results are recorded. The host (examples/harness/host/loop.mjs)
// holds no rule. Gates (owner, 2026-10-11): the journal replays (HAC5); the AC18 canary scan over the real store, with a
// control (gate 3) and over the effect payloads (gate 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRuntime } from '@poly/check';
import { buildLog, canary, found, outputs, recording, run, FUSED } from './e3-loop-helpers.mjs';
import { ALL_OFF } from '../examples/harness/host/loop.mjs';
import { step, trajectories } from './fixtures/harness/trajectories.mjs';

const decisions = async (rt, id) => (await rt.chain(id)).filter((e) => e.kind === 'decision').map((e) => e.body);

test('E3.4: a recorded task of three steps runs to the end of its plan', { timeout: 600_000 }, async () => {
  const { rt, result, store } = await run('e3-loop-plan');
  try {
    assert.equal(result.trial.mode, 'Done');
    assert.equal(result.trial.why, 'PlanDone');
    assert.equal(result.trial.step, 2);
    assert.equal(result.trial.failedAt, 1, 'the failing stage is the first state with a failed check: step 1');
    for (const t of result.turns) assert.equal((await rt.getState(t)).state.mode, 'Done', t);
    assert.equal((await rt.getState('turn:t1:0')).state.plan, 'Fusable', 'an edit then a declared runner is fused');
    assert.equal((await rt.getState('turn:t1:2')).state.plan, 'Separate', 'a command that inspects runs apart');
    assert.equal((await rt.getState('turn:t1:1')).state.reprompts, 1, 'the cutoff was answered by one reprompt');
    assert.deepEqual(result.receipts, ['receipt:t1:1']);
    assert.equal((await rt.getState('receipt:t1:1')).state.st, 'Shown');
    assert.equal(store.read('shown', 'receipt:t1:1').what, 'receipt');
    assert.equal(store.read('trial', 'trial:t1').ended, 'finished');
  } finally {
    await rt.close();
  }
});

test('HAC5: the journal replays every state of the run, and every model call is a decision event with its model, usage, cost and reservation', { timeout: 600_000 }, async () => {
  const { rt } = await run('e3-loop-replay');
  try {
    const runs = await replayRuntime(rt);
    for (const r of runs) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
    assert.equal(runs.reduce((n, r) => n + r.folded, 0), runs.reduce((n, r) => n + r.rows, 0), 'every row is folded');
    assert.ok(runs.some((r) => r.run.includes('turn:t1:1')) && runs.some((r) => r.run.includes('receipt:t1:1')), 'the turns and the receipt are among the runs');
    // the cut-off turn asked the model twice (the answer, then the reprompt); every call carries its price record
    const asks = await decisions(rt, 'turn:t1:1');
    assert.equal(asks.length, 2);
    for (const d of asks) {
      assert.ok(d.model && d.usage && d.cost && typeof d.reservation === 'number' && d.prices, JSON.stringify(Object.keys(d)));
      assert.equal(d.cost.unit, 'micro-usd');
    }
    // the receipt was read by the cheaper model, then checked by the verifier, and both are in its journal
    assert.equal((await decisions(rt, 'receipt:t1:1')).length, 1);
    const kinds = (await rt.chain('receipt:t1:1')).filter((e) => e.kind === 'verdict').map((e) => e.body.effectKind);
    assert.ok(kinds.includes('decision.read') && kinds.includes('tool.verify') && kinds.includes('tool.show-receipt'), kinds.join(' '));
  } finally {
    await rt.close();
  }
});

test('HF2.3, S561, HAC5: a chosen compaction starts at a finished step when it pays, shrinks the transcript and replays', { timeout: 600_000 }, async () => {
  const t08 = trajectories().find((t) => t.name === 't08-long-session').recording;
  const { rt, store, result } = await run('e3-loop-compact', t08, { mechanisms: { fusion: false, compaction: true, pack: false, reducer: false } });
  try {
    assert.equal(result.trial.mode, 'Done');
    assert.ok(result.metrics.compaction.chosen >= 1, JSON.stringify(result.metrics.compaction));
    assert.ok(result.compactions.length >= result.metrics.compaction.chosen, "every chosen compaction was adopted");
    for (const k of result.compactions) assert.ok(k.after < k.before, "a compaction shrinks the transcript");
    assert.ok(result.transcript.some((m) => m.role === 'summary'));
    assert.ok((await decisions(rt, 'context:t08')).length >= 1, 'the summary was a decision event');
    for (const r of await replayRuntime(rt)) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
  } finally {
    await rt.close();
  }
});

test('S561, HF3.8: over the limit, one compaction is tried; when it cannot shrink the window the next Overflowed ends the trial, with the reason', { timeout: 600_000 }, async () => {
  // one 26 KiB read fills the window (6 of 6) and is the last thing said, so nothing in the transcript can be dropped to make a summary smaller
  const rec = recording({ steps: [step.inspect(20, 26000), step.fuse(2)].map(({ spec, receipt, ...s }) => s) });
  rec.task = 't1';
  const { rt, store, result } = await run('e3-loop-overflow', rec, { mechanisms: ALL_OFF });
  try {
    assert.equal(result.trial.mode, 'Stopped');
    assert.equal(result.trial.why, 'Overflow');
    const c = (await rt.getState('context:t1')).state;
    assert.equal(c.attempts, 1, 'one compaction was tried first');
    assert.equal(c.mode, 'Closed');
    assert.equal(store.read('trial', 'context:t1').ended, 'overflow');
    for (const r of await replayRuntime(rt)) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
  } finally {
    await rt.close();
  }
});

test('HF3.9, HAC5: a cap saves the work, then ends the trial reporting the cap', { timeout: 600_000 }, async () => {
  const rec = recording();
  rec.steps[1].cap = true;
  const { rt, store, result } = await run('e3-loop-cap', rec);
  try {
    assert.equal(result.trial.mode, 'Stopped');
    assert.equal(result.trial.why, 'Cap');
    assert.equal(result.trial.saved, true);
    assert.deepEqual(store.read('work', 'trial:t1'), { saved: true });
    assert.equal(store.read('trial', 'trial:t1').ended, 'cap');
    for (const r of await replayRuntime(rt)) assert.deepEqual(r.diagnostics.map((d) => d.message), [], r.run);
  } finally {
    await rt.close();
  }
});

// ---------------------------------------------------------------- the canary over the real store (AC18, S554, gates 2 and 3)

/** The recording's tool output holds the token in all four encodings; the world's own staging row is the only place it may be. */
function leakyRecording(token) {
  const extra = [`TOKEN=${token}`, `b64 ${Buffer.from(token).toString('base64')}`, `b64url ${Buffer.from(token).toString('base64url')}`, `url ${encodeURIComponent(token)}`].join('\n');
  const { log, receipt } = buildLog(extra);
  const rec = recording();
  rec.steps[1].tool = { output: log, exitStatus: 1 };
  rec.receipts = [receipt];
  return rec;
}
const notTheWorld = (texts) => texts.filter(([where]) => !where.startsWith('store recorded-tool/'));

test('AC18, S554, gates 2 and 3: a token in a tool output reaches nothing the runtime, the store, the journal or the effect payloads hold', { timeout: 600_000 }, async () => {
  const token = canary();
  const { rt, store, a } = await run('e3-loop-canary', leakyRecording(token), { secrets: [token] });
  try {
    const where = found(notTheWorld(outputs(rt, store, a.dir)), [token]);
    assert.deepEqual(where, [], `the token was found in ${[...new Set(where)].join(', ')}`);
    // the scan flagged the log, so the cheaper reader was never asked, and the agent saw the original, redacted
    assert.equal((await decisions(rt, 'receipt:t1:1')).length, 0);
    assert.equal((await rt.getState('receipt:t1:1')).state.st, 'Original');
    assert.equal(store.read('shown', 'receipt:t1:1').what, 'original');
    // the effect payloads are in the outbox and the proposals: the scan covered them (the tables above include pr_outbox)
    const payloads = rt.store.db.prepare('SELECT payload FROM pr_outbox').all().map((r) => String(r.payload));
    assert.ok(payloads.length > 20 && payloads.every((p) => !encodingsHit(p, token)));
    // the staging row of the raw output was cleared once the redaction was stored
    assert.deepEqual(store.read('output', 'turn:t1:1'), { cleared: true, exitStatus: 1 });
  } finally {
    await rt.close();
  }
});

const encodingsHit = (text, token) => found([['x', text]], [token]).length > 0;

test('AC18, S554, seeded control: a scan that does not know the secret leaves it in the archive, and the same canary scan finds it', { timeout: 600_000 }, async () => {
  const token = canary();
  const { rt, store, a } = await run('e3-loop-canary-control', leakyRecording(token), { secrets: [] });
  try {
    const where = found(notTheWorld(outputs(rt, store, a.dir)), [token]);
    assert.ok(where.length > 0, 'the control was not found: the canary scan is blind');
    assert.ok(where.some((w) => w.includes('archive') || w.includes('poly_content') || w.includes('table')), [...new Set(where)].join(', '));
  } finally {
    await rt.close();
  }
});

void FUSED;

// ---------------------------------------------------------------- runtime behaviours the checker does not see (E3.4)

const overflowRecording = () => recording({ steps: [step.inspect(20, 26000), step.fuse(2)].map(({ spec, receipt, ...s }) => s) });
const outboxCount = (rt) => rt.store.db.prepare('SELECT COUNT(*) AS n FROM pr_outbox').get().n;

test('K10: the runtime refuses a decision and an effect that complete through one action (the checker does not see it)', { timeout: 600_000 }, async () => {
  // the summary decision fails into CompactFailed, as the first draft of the module had it, and so does the compact effect
  const shared = (s) => {
    const from = '    failed -> SummaryFailed()';
    assert.equal(s.split(from).length, 2);
    return s.replace(from, '    failed -> CompactFailed()');
  };
  await assert.rejects(run('e3-loop-k10', overflowRecording(), { edit: shared }), (e) => /K10/.test(String(e.message)) && /CompactFailed/.test(String(e.message)));
});

test('E3.4: a late Begun, after the plan is done or the trial ended on overflow, reopens nothing and emits no effect', { timeout: 600_000 }, async () => {
  for (const [name, rec, mode, why] of [['done', recording(), 'Done', 'PlanDone'], ['overflow', overflowRecording(), 'Stopped', 'Overflow']]) {
    const { rt } = await run(`e3-loop-late-begun-${name}`, rec);
    try {
      const before = { trial: (await rt.getState('trial:t1')).state, context: (await rt.getState('context:t1')).state, outbox: outboxCount(rt) };
      assert.deepEqual([before.trial.mode, before.trial.why], [mode, why]);
      // the dispatch may be accepted (the pin is taken whenever it arrives) or rejected (the context is closed); either way:
      await rt.dispatch('context:t1', 'Begun', {}).catch(() => {});
      await rt.advance(8);
      const after = { trial: (await rt.getState('trial:t1')).state, context: (await rt.getState('context:t1')).state, outbox: outboxCount(rt) };
      assert.deepEqual(after.trial, before.trial, `${name}: the trial was touched`);
      assert.equal(after.context.mode, before.context.mode, `${name}: the context was reopened`);
      assert.equal(after.outbox, before.outbox, `${name}: a late Begun emitted an effect`);
    } finally {
      await rt.close();
    }
  }
});
