// The worker findings of M4's code review (part C), each a test that failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { workerConformance } from '@poly/check';
import { RefusedDispatch } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded } from './runtime-helpers.mjs';

const WORKER = join(ROOT, 'packages', 'poly-runtime', 'src', 'worker.ts');
const a = await admitted('review-c', ['conformance/m4/outbox.poly']);
const phase = async (rt, id) => (await rt.getState(id)).state.phase;
const intentOf = async (rt, id) => { const [row] = await rt.outbox(id); return { row, state: await rt.worker.intentState(row) }; };
const journal = async (rt, id) => (await rt.getJournal(id)).map((r) => `${r.action}/${r.step_kind}`);

test('review C1: a crash while a permanent failure ends leaves the completion and the transition together, and the effect is not re-run after its completion', async () => {
  const { rt, clock } = await loaded(a, { worker: { leaseMs: 60_000 } });
  try {
    let calls = 0;
    rt.handle('w.work', () => { calls++; if (calls === 1) throw Object.assign(new Error('card declined'), { permanent: true }); return 'charged'; });
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    // The process dies while HandlerFailedPermanent commits.
    const commit = rt.store.commitStep.bind(rt.store);
    rt.store.commitStep = (step) => rt.store.txn(async () => {
      await commit(step);
      if (step.instanceId.startsWith('intent:') && step.journal.action === 'HandlerFailedPermanent') throw new Error('crash');
    });
    await assert.rejects(rt.worker.tick(), /crash/);
    rt.store.commitStep = commit;
    assert.equal(await phase(rt, 'j'), 'Working', 'no completion without its transition');
    for (let k = 0; k < 3; k++) { clock.advance(61_000); await rt.worker.tick(); }
    const { state, row } = await intentOf(rt, 'j');
    const p = await phase(rt, 'j');
    // One story: the job's completion matches the intent's end.
    assert.ok((p === 'Done' && state.intent === 'Done' && row.status === 'done') || (p === 'Failed' && state.intent === 'Dead' && row.status === 'dead'), `${p} ${state.intent} ${row.status}`);
    assert.ok(!(await journal(rt, 'j')).some((x) => x.endsWith('/rejected')), (await journal(rt, 'j')).join(','));
    assert.deepEqual((await workerConformance(rt, WORKER)).diagnostics.map((d) => d.message), []);
  } finally { await rt.close(); }
});

test('review C2: a worker whose claim was taken over delivers no completion', async () => {
  const { rt, clock } = await loaded(a, { worker: { leaseMs: 60_000 } });
  try {
    let calls = 0;
    let fail;
    rt.handle('w.work', () => { calls++; if (calls === 1) return new Promise((_, rej) => { fail = rej; }); return 'charged'; });
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    const stale = rt.worker.tick();
    await new Promise((r) => setTimeout(r, 50));
    clock.advance(61_000);
    await rt.worker.tick(); // the lease expired: another pass takes the intent over
    fail(Object.assign(new Error('card declined'), { permanent: true }));
    await stale;
    assert.equal(await phase(rt, 'j'), 'Working', 'the stale worker delivered nothing');
    for (let k = 0; k < 3; k++) { clock.advance(61_000); await rt.worker.tick(); }
    assert.equal(await phase(rt, 'j'), 'Done');
    assert.deepEqual(await journal(rt, 'j'), ['$create/accepted', 'Go/accepted', 'Worked/accepted']);
    assert.deepEqual((await workerConformance(rt, WORKER)).diagnostics.map((d) => d.message), []);
  } finally { await rt.close(); }
});

const escalating = { propose: (p) => (p.approved ? { decision: 'allow' } : { decision: 'escalate', reason: 'ask' }), settle: () => 'ok' };

test('review C3: an approval that loses the race to the timeout is a rejected step and an error, never drift or a park', async () => {
  const { rt, clock } = await loaded(a, { gate: { gate: escalating, escalationTimeoutMs: 60_000 } });
  try {
    rt.handle('w.work', () => 'charged');
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    await rt.worker.tick(); // escalated
    clock.advance(61_000);
    await rt.worker.tick(); // timed out: denied
    assert.equal(await phase(rt, 'j'), 'Failed');
    const { row } = await intentOf(rt, 'j');
    await assert.rejects(rt.approve(row.intent_id, { by: 'ops', ref: 'late' }), /timed out/);
    const ij = await rt.getJournal(`intent:${row.intent_id}`);
    assert.deepEqual(ij.at(-1) && [ij.at(-1).action, ij.at(-1).step_kind], ['Approve', 'rejected']);
    assert.deepEqual((await workerConformance(rt, WORKER)).diagnostics.map((d) => d.message), []);
  } finally { await rt.close(); }
});

test('review C3: an approval that wins the race makes the timeout a rejected step, and the effect runs once', async () => {
  const { rt, clock } = await loaded(a, { gate: { gate: escalating, escalationTimeoutMs: 60_000 } });
  try {
    let calls = 0;
    rt.handle('w.work', () => { calls++; return 'charged'; });
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    await rt.worker.tick(); // escalated
    clock.advance(61_000);
    const { row } = await intentOf(rt, 'j');
    // The timeout pass reads the intent as waiting, then the approval commits before its EscalationTimeout does.
    const read = rt.worker.intentState.bind(rt.worker);
    let raced = false;
    rt.worker.intentState = async (r) => { const s = await read(r); if (!raced && s?.intent === 'Escalated' && !s.intent_approved) { raced = true; await rt.approve(row.intent_id, { by: 'ops', ref: 'race' }); } return s; };
    await rt.worker.tick();
    rt.worker.intentState = read;
    assert.ok(raced);
    for (let k = 0; k < 2; k++) { clock.advance(61_000); await rt.worker.tick(); }
    assert.equal(await phase(rt, 'j'), 'Done');
    assert.equal(calls, 1);
    assert.ok((await rt.getJournal(`intent:${row.intent_id}`)).some((r) => r.action === 'EscalationTimeout' && r.step_kind === 'rejected'));
    assert.deepEqual((await workerConformance(rt, WORKER)).diagnostics.map((d) => d.message), []);
    assert.ok(!(await rt.audit()).some((r) => r.rule === 'PL2401'));
  } finally { await rt.close(); }
});

test('review C4: an outside dispatch to a hosted OutboxIntent instance is refused before any step, with an audit row', async () => {
  const { rt } = await loaded(a, { gate: { gate: escalating } });
  try {
    rt.handle('w.work', () => 'charged');
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    await rt.worker.tick();
    const { row } = await intentOf(rt, 'j');
    const id = `intent:${row.intent_id}`;
    const before = (await rt.getJournal(id)).length;
    for (const action of ['EscalationTimeout', 'Approve']) {
      await assert.rejects(rt.dispatch(id, action), (e) => e instanceof RefusedDispatch && /internal to the runtime/.test(e.message));
    }
    assert.equal((await rt.getJournal(id)).length, before);
    assert.equal((await rt.audit(id)).length, 2);
  } finally { await rt.close(); }
});

test('review C6: a gate that throws holds only its own intent, Proposed with a backoff; the others, timers and messages go on', async () => {
  const gate = { propose: (p) => { if (p.instance === 'bad') throw new Error('policy service unavailable'); return { decision: 'allow' }; }, settle: () => 'ok' };
  const { rt, clock } = await loaded(a, { gate: { gate } });
  try {
    rt.handle('w.work', () => 'charged');
    for (const id of ['bad', 'g1', 'g2']) { await rt.create('outbox.Job', { id }); await rt.dispatch(id, 'Go'); }
    await rt.tick(); // never throws
    assert.equal(await phase(rt, 'g1'), 'Done');
    assert.equal(await phase(rt, 'g2'), 'Done');
    const { row, state } = await intentOf(rt, 'bad');
    assert.deepEqual([state.intent, row.status], ['Proposed', 'pending']);
    assert.match(row.last_error ?? '', /policy service unavailable/);
    clock.advance(1);
    await rt.tick();
    assert.equal(await phase(rt, 'bad'), 'Working', 'never allowed while the gate fails');
  } finally { await rt.close(); }
});

test('review C8: an intent keeps the bound it started under when a redeploy changes the effect\'s maxAttempts', async () => {
  const { rt, clock } = await loaded(a);
  try {
    let calls = 0;
    rt.handle('w.work', () => { calls++; if (calls < 3) throw new Error('flaky'); return 'charged'; });
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    await rt.worker.tick(); // attempt 1 fails under the bound 3
    // The manifest now says 1: the intent, created as runtime.OutboxIntent, keeps its bound of 3.
    rt.kernel.machines.get('outbox.Job').manifest.effects['w.work'].retry.maxAttempts = 1;
    for (let k = 0; k < 3; k++) { clock.advance(61_000); await rt.worker.tick(); }
    assert.equal(await phase(rt, 'j'), 'Done');
    const { row } = await intentOf(rt, 'j');
    assert.equal((await rt.store.getInstance(`intent:${row.intent_id}`)).machine_id, 'runtime.OutboxIntent');
  } finally { await rt.close(); }
});

test('review C7: conformance relates each intent\'s end to the program\'s completions, and finds a story that does not hold', async () => {
  const { rt } = await loaded(a);
  try {
    rt.handle('w.work', () => 'charged');
    await rt.create('outbox.Job', { id: 'j' });
    await rt.dispatch('j', 'Go');
    await rt.worker.tick();
    assert.deepEqual((await workerConformance(rt, WORKER)).diagnostics, []);
    // A failure completion delivered for an intent that ended Done, as a stale worker once could.
    const { row } = await intentOf(rt, 'j');
    await rt.kernel.dispatch('j', 'Gave', {}, `${row.intent_id}:failed`);
    assert.match((await workerConformance(rt, WORKER)).diagnostics.map((d) => d.message).join('\n'), /is Done, and the program took a failure completion for it/);
  } finally { await rt.close(); }
});

// Review C4 and C8 met a program machine named as the runtime's own model: the internal ids are reserved only where
// the runtime registers that model, and a program machine with one of those ids is refused at load, never shadowed.
test('review C4, C8: a program machine with the id of a model the runtime needs is refused at load; with no such need it runs as the program\'s', async () => {
  const { load, LoadError } = await import('@poly/runtime');
  const clash = await admitted('review-c-collide', ['test/fixtures/review-m4/collide.poly']);
  await assert.rejects(load(clash.build, { certificate: clash.certificate, trust: clash.trust }), (e) => e instanceof LoadError && /runtime\.OutboxIntent/.test(e.message));
  const own = await admitted('review-c-own', ['conformance/m2/seeded/liveness/fixed.poly']);
  const { rt } = await loaded(own);
  try {
    const o = await rt.create('runtime.OutboxIntent', { id: 'mine' });
    const r = await rt.dispatch(o.id, 'Propose');
    assert.equal(r.kind ?? r.verdict?.kind ?? 'accepted', 'accepted');
    assert.equal((await rt.getState(o.id)).state.status, 'Proposed');
  } finally { await rt.close(); }
});
