// PL2401 RUNTIME_MODEL_DRIFT in the runtime's CI (PT9.7, S119): a worker that takes a transition, keeps a
// state, or names an action that OutboxIntent does not have is reported, and the real worker is not. Each
// drift is a deliberately broken worker (WORKER_DRIFTS) or an operator action polyrun offers and the machine
// does not (its DLQ retry and discard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerConformance, workerActions } from '@poly/check';
import { WORKER_DRIFTS } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, handleWith } from './runtime-helpers.mjs';

const WORKER_SOURCE = join(ROOT, 'packages', 'poly-runtime', 'src', 'worker.ts');
const a = await admitted('drift', ['conformance/m4/outbox.poly']);

async function run(jobs, opts = {}) {
  const deny = { propose: (p) => (p.instance.includes('deny') ? { decision: 'deny', reason: 'no' } : { decision: 'allow' }), settle: () => 'ok' };
  const { rt, clock } = await loaded(a, { gate: { gate: deny }, ...opts });
  const tries = new Map();
  handleWith(rt, 'w.work', (_p, _c, ctx) => {
    const k = (tries.get(ctx.instanceId) ?? 0) + 1;
    tries.set(ctx.instanceId, k);
    if (ctx.instanceId.includes('fail') && k === 1) throw new Error('first try fails');
    if (ctx.instanceId.includes('declined')) throw Object.assign(new Error('card declined'), { permanent: true });
    return 'ok';
  });
  for (const id of jobs) { await rt.create('outbox.Job', { id }); await rt.dispatch(id, 'Go'); }
  for (let k = 0; k < 4; k++) { clock.advance(61_000); await rt.worker.tick(); }
  return { rt, clock };
}

test('the real worker has no drift', async () => {
  const { rt } = await run(['job-ok', 'job-fail', 'job-deny', 'job-declined']);
  try { assert.deepEqual((await workerConformance(rt, WORKER_SOURCE)).diagnostics, []); } finally { await rt.close(); }
});

const EXPECT = {
  'repropose-after-failure': [['job-fail'], /took Propose on intent \S+ in state Allowed, and OutboxIntent refuses it \(rejected "not-proposable"\)/],
  'denied-marked-done': [['job-deny'], /is Denied and its outbox row is done/],
  'retry-permanent': [['job-declined'], /handler outcome permanent at attempt 1, and the worker took HandlerFailed/],
  'resurrect-dead': [['job-deny'], /took Propose on intent \S+ in state Denied, and OutboxIntent refuses it \(rejected "terminal"\)/],
};

for (const drift of WORKER_DRIFTS) {
  test(`a drifting worker is PL2401: ${drift}`, async () => {
    const [jobs, pattern] = EXPECT[drift];
    const { rt, clock } = await run(jobs, { worker: { drift } });
    try {
      if (drift === 'resurrect-dead') {
        // polyrun's DLQ retry puts the dead row back; the drifting worker then tries to revive the intent.
        const [row] = await rt.outbox('job-deny');
        await rt.store.dlqRetry(row.intent_id, clock.now());
        await rt.worker.tick();
      }
      const c = await workerConformance(rt, WORKER_SOURCE);
      assert.ok(c.diagnostics.length > 0, drift);
      assert.ok(c.diagnostics.every((d) => d.code === 'PL2401'));
      assert.match(c.diagnostics.map((d) => d.message).join('\n'), pattern);
    } finally { await rt.close(); }
  });
}

test('the real worker refuses to revive a dead intent after polyrun\'s DLQ retry, and polyrun\'s DLQ discard is drift', async () => {
  const { rt, clock } = await run(['job-deny']);
  try {
    const [row] = await rt.outbox('job-deny');
    await rt.store.dlqRetry(row.intent_id, clock.now());
    await rt.worker.tick();
    assert.equal((await rt.outboxRow(row.intent_id)).status, 'dead', 'marked dead again, with no transition');
    assert.deepEqual((await workerConformance(rt, WORKER_SOURCE)).diagnostics, []);
    await rt.store.dlqDiscard(row.intent_id);
    assert.match((await workerConformance(rt, WORKER_SOURCE)).diagnostics.map((d) => d.message).join('\n'), /is Denied and its outbox row is done/);
  } finally { await rt.close(); }
});

test('a worker source that names an action the machine does not have is PL2401', async () => {
  assert.deepEqual(workerActions(readFileSync(WORKER_SOURCE, 'utf8')), ['Approve', 'EscalationTimeout', 'GateAllow', 'GateDeny', 'GateEscalate', 'HandlerFailed', 'HandlerFailedPermanent', 'HandlerOk', 'Propose', 'SettleFailed', 'SettleOk', 'Start']);
  assert.deepEqual(workerActions("await this.transition(row, 'Retry')"), ['Retry']);
});
