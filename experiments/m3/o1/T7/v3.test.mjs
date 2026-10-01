import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

// ---------------------------------------------------------------- helpers

const RUN = 'run';
const W0 = 'worker0';
const W1 = 'worker1';
const TERMINAL = ['completed', 'failed', 'cancelled'];
const taskOf = (w) => (w === W0 ? 0 : 1);
const workerOf = (t) => (t === 0 ? W0 : W1);

function ht(name, fn) {
  test(name, async () => {
    const h = await createHost();
    await fn(h);
  });
}

function dataMatches(actual, expected) {
  if (expected === undefined) return true;
  if (!actual || typeof actual !== 'object') return false;
  return Object.keys(expected).every((k) => Object.is(actual[k], expected[k]));
}

async function findMsgs(h, f = {}) {
  const all = await h.inFlight();
  return all.filter(
    (m) =>
      (f.from === undefined || m.from === f.from) &&
      (f.to === undefined || m.to === f.to) &&
      (f.action === undefined || m.action === f.action) &&
      dataMatches(m.data, f.data),
  );
}

async function countMsgs(h, f) {
  return (await findMsgs(h, f)).length;
}

async function deliverMsg(h, f) {
  const l = await findMsgs(h, f);
  assert.ok(l.length > 0, 'expected a message in flight matching ' + JSON.stringify(f));
  await h.deliver(l[0].id);
}

const assignTo = (w) => ({ from: RUN, to: w, action: 'Assign' });
const abortTo = (w) => ({ from: RUN, to: w, action: 'Abort' });
const reportFrom = (w, outcome) =>
  outcome === undefined
    ? { from: w, to: RUN, action: 'Report', data: { task: taskOf(w) } }
    : { from: w, to: RUN, action: 'Report', data: { task: taskOf(w), outcome } };

async function view(h) {
  const r = await h.run();
  return {
    status: r.status,
    task0: r.task0,
    task1: r.task1,
    retried0: r.retried0,
    retried1: r.retried1,
    processed: r.processed,
  };
}

async function wstatus(h, w) {
  const r = await h.worker(w);
  return r === null ? null : r.status;
}

async function snap(h) {
  const msgs = (await h.inFlight()).map((m) => JSON.stringify([m.from, m.to, m.action, m.data])).sort();
  return JSON.stringify({ run: await view(h), w0: await wstatus(h, W0), w1: await wstatus(h, W1), msgs });
}

async function ok(p) {
  const r = await p;
  assert.equal(r.ok, true);
}

async function refusedUnchanged(h, thunk) {
  const before = await snap(h);
  const r = await thunk();
  assert.equal(r.ok, false);
  assert.equal(await snap(h), before);
}

function done(h, w, items = 1) {
  return h.workDone(w, items);
}

async function start(h) {
  await ok(h.start());
}

async function startBusy(h) {
  await ok(h.start());
  await deliverMsg(h, assignTo(W0));
  await deliverMsg(h, assignTo(W1));
}

async function finish(h, w, items = 1) {
  await ok(done(h, w, items));
  await deliverMsg(h, reportFrom(w, 'completed'));
}

async function failOnce(h, w) {
  await ok(h.workFailed(w));
  await deliverMsg(h, reportFrom(w, 'failed'));
}

// A first failure while running is retried; the second failure is recorded.
async function failFinal(h, w) {
  await failOnce(h, w);
  await deliverMsg(h, assignTo(w));
  await failOnce(h, w);
}

async function cancelBoth(h) {
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, abortTo(W1));
}

// ---------------------------------------------------------------- initial state

ht('initial run is idle', async (h) => {
  assert.equal((await h.run()).status, 'idle');
});

ht('initial tasks are idle', async (h) => {
  const r = await h.run();
  assert.equal(r.task0, 'idle');
  assert.equal(r.task1, 'idle');
});

ht('initial tasks are not retried', async (h) => {
  const r = await h.run();
  assert.equal(r.retried0, false);
  assert.equal(r.retried1, false);
});

ht('initial processed total is 0', async (h) => {
  assert.equal((await h.run()).processed, 0);
});

ht('initial workers are idle', async (h) => {
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await wstatus(h, W1), 'idle');
});

ht('worker query returns null for the run id', async (h) => {
  assert.equal(await h.worker('run'), null);
});

ht('worker query returns null for an unknown id', async (h) => {
  assert.equal(await h.worker('worker2'), null);
  assert.equal(await h.worker(''), null);
  assert.equal(await h.worker('Worker0'), null);
});

ht('worker query returns null for unknown id after start', async (h) => {
  await startBusy(h);
  assert.equal(await h.worker('worker2'), null);
});

ht('nothing is in flight initially', async (h) => {
  assert.equal((await h.inFlight()).length, 0);
});

ht('deliverAll with nothing in flight changes nothing', async (h) => {
  const before = await snap(h);
  await h.deliverAll();
  assert.equal(await snap(h), before);
});

// ---------------------------------------------------------------- start

ht('start succeeds on a fresh run', async (h) => {
  await ok(h.start());
});

ht('start makes the run running', async (h) => {
  await start(h);
  assert.equal((await h.run()).status, 'running');
});

ht('start makes both tasks assigned', async (h) => {
  await start(h);
  const r = await h.run();
  assert.equal(r.task0, 'assigned');
  assert.equal(r.task1, 'assigned');
});

ht('start sends Assign to worker0', async (h) => {
  await start(h);
  assert.equal(await countMsgs(h, assignTo(W0)), 1);
});

ht('start sends Assign to worker1', async (h) => {
  await start(h);
  assert.equal(await countMsgs(h, assignTo(W1)), 1);
});

ht('start sends exactly two messages', async (h) => {
  await start(h);
  assert.equal((await h.inFlight()).length, 2);
});

ht('Assign carries empty data', async (h) => {
  await start(h);
  for (const m of await findMsgs(h, { action: 'Assign' })) assert.deepEqual(m.data, {});
});

ht('start does not make workers busy before Assign is delivered', async (h) => {
  await start(h);
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await wstatus(h, W1), 'idle');
});

ht('start leaves both tasks not retried', async (h) => {
  await start(h);
  const r = await h.run();
  assert.equal(r.retried0, false);
  assert.equal(r.retried1, false);
});

ht('start leaves processed at 0', async (h) => {
  await start(h);
  assert.equal((await h.run()).processed, 0);
});

ht('start is refused while running', async (h) => {
  await start(h);
  await refusedUnchanged(h, () => h.start());
});

ht('start is refused while running with workers busy', async (h) => {
  await startBusy(h);
  await refusedUnchanged(h, () => h.start());
});

ht('start is refused while cancelling', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await refusedUnchanged(h, () => h.start());
});

ht('start is refused after the run completed', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  assert.equal((await h.run()).status, 'completed');
  await refusedUnchanged(h, () => h.start());
});

ht('start is refused after the run failed', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await finish(h, W1);
  assert.equal((await h.run()).status, 'failed');
  await refusedUnchanged(h, () => h.start());
});

ht('start is refused after the run was cancelled', async (h) => {
  await startBusy(h);
  await cancelBoth(h);
  await h.deliverAll();
  assert.equal((await h.run()).status, 'cancelled');
  await refusedUnchanged(h, () => h.start());
});

// ---------------------------------------------------------------- Assign delivery

ht('Assign delivered to idle worker0 makes it busy', async (h) => {
  await start(h);
  await deliverMsg(h, assignTo(W0));
  assert.equal(await wstatus(h, W0), 'busy');
});

ht('Assign delivered to idle worker1 makes it busy', async (h) => {
  await start(h);
  await deliverMsg(h, assignTo(W1));
  assert.equal(await wstatus(h, W1), 'busy');
});

ht('Assign to worker0 does not affect worker1', async (h) => {
  await start(h);
  await deliverMsg(h, assignTo(W0));
  assert.equal(await wstatus(h, W1), 'idle');
});

ht('delivering Assign does not change the run view', async (h) => {
  await start(h);
  const before = await view(h);
  await deliverMsg(h, assignTo(W0));
  assert.deepEqual(await view(h), before);
});

ht('delivering Assign sends no reply', async (h) => {
  await start(h);
  await deliverMsg(h, assignTo(W0));
  assert.equal(await countMsgs(h, { from: W0 }), 0);
});

ht('a delivered message is no longer in flight', async (h) => {
  await start(h);
  await deliverMsg(h, assignTo(W0));
  assert.equal(await countMsgs(h, assignTo(W0)), 0);
  assert.equal(await countMsgs(h, assignTo(W1)), 1);
});

ht('deliverAll after start makes both workers busy and leaves nothing in flight', async (h) => {
  await start(h);
  await h.deliverAll();
  assert.equal(await wstatus(h, W0), 'busy');
  assert.equal(await wstatus(h, W1), 'busy');
  assert.equal((await h.inFlight()).length, 0);
});

// ---------------------------------------------------------------- workDone

ht('workDone refused before start', async (h) => {
  await refusedUnchanged(h, () => done(h, W0));
  await refusedUnchanged(h, () => done(h, W1));
});

ht('workDone refused while Assign not yet delivered', async (h) => {
  await start(h);
  await refusedUnchanged(h, () => done(h, W0));
});

ht('workDone refused for the run id', async (h) => {
  await startBusy(h);
  await refusedUnchanged(h, () => done(h, 'run'));
});

ht('workDone refused for an unknown worker', async (h) => {
  await startBusy(h);
  await refusedUnchanged(h, () => done(h, 'worker2'));
});

ht('workDone succeeds for a busy worker', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
});

ht('workDone makes the worker idle', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  assert.equal(await wstatus(h, W0), 'idle');
});

ht('workDone does not affect the other worker', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  assert.equal(await wstatus(h, W1), 'busy');
});

ht('workDone by worker0 sends Report completed for task 0', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  const l = await findMsgs(h, { from: W0, to: RUN, action: 'Report' });
  assert.equal(l.length, 1);
  assert.equal(l[0].data.task, 0);
  assert.equal(l[0].data.outcome, 'completed');
});

ht('workDone by worker1 sends Report completed for task 1', async (h) => {
  await startBusy(h);
  await ok(done(h, W1));
  const l = await findMsgs(h, { from: W1, to: RUN, action: 'Report' });
  assert.equal(l.length, 1);
  assert.equal(l[0].data.task, 1);
  assert.equal(l[0].data.outcome, 'completed');
});


ht('workDone does not change the run before its report is delivered', async (h) => {
  await startBusy(h);
  const before = await view(h);
  await ok(done(h, W0));
  assert.deepEqual(await view(h), before);
});

ht('workDone twice is refused the second time', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await refusedUnchanged(h, () => done(h, W0));
});

ht('workDone refused after workFailed', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W0));
  await refusedUnchanged(h, () => done(h, W0));
});

ht('completed report makes the task completed', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  assert.equal((await h.run()).task0, 'completed');
});

ht('completed report for task 1 makes task 1 completed', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  const r = await h.run();
  assert.equal(r.task1, 'completed');
  assert.equal(r.task0, 'assigned');
});

ht('one completed task leaves the run running', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  assert.equal((await h.run()).status, 'running');
});

ht('delivering a Report sends no further message', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  assert.equal((await h.inFlight()).length, 0);
});

ht('both tasks completed makes the run completed (0 then 1)', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  const r = await h.run();
  assert.equal(r.status, 'completed');
  assert.equal(r.task0, 'completed');
  assert.equal(r.task1, 'completed');
});

ht('both tasks completed makes the run completed (1 then 0)', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  await finish(h, W0);
  assert.equal((await h.run()).status, 'completed');
});

ht('both reports in flight then delivered in reverse order completes the run', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(done(h, W1));
  assert.equal((await h.run()).status, 'running');
  await deliverMsg(h, reportFrom(W1, 'completed'));
  assert.equal((await h.run()).status, 'running');
  await deliverMsg(h, reportFrom(W0, 'completed'));
  assert.equal((await h.run()).status, 'completed');
});

ht('run is not completed while a completed report is still in flight', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await ok(done(h, W1));
  assert.equal((await h.run()).status, 'running');
  assert.equal((await h.run()).task1, 'assigned');
});

ht('workers are idle after the run completes', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await wstatus(h, W1), 'idle');
});

ht('workDone refused after the run completed', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  await refusedUnchanged(h, () => done(h, W0));
});

ht('deliverAll delivers reports and completes the run', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(done(h, W1));
  await h.deliverAll();
  assert.equal((await h.run()).status, 'completed');
  assert.equal((await h.inFlight()).length, 0);
});

// ---------------------------------------------------------------- workFailed

ht('workFailed refused before start', async (h) => {
  await refusedUnchanged(h, () => h.workFailed(W0));
  await refusedUnchanged(h, () => h.workFailed(W1));
});

ht('workFailed refused while Assign not yet delivered', async (h) => {
  await start(h);
  await refusedUnchanged(h, () => h.workFailed(W1));
});

ht('workFailed refused for the run id', async (h) => {
  await startBusy(h);
  await refusedUnchanged(h, () => h.workFailed('run'));
});

ht('workFailed refused for an unknown worker', async (h) => {
  await startBusy(h);
  await refusedUnchanged(h, () => h.workFailed('nobody'));
});

ht('workFailed succeeds for a busy worker', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W1));
});

ht('workFailed makes the worker idle', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W1));
  assert.equal(await wstatus(h, W1), 'idle');
  assert.equal(await wstatus(h, W0), 'busy');
});

ht('workFailed by worker0 sends Report failed for task 0', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W0));
  const l = await findMsgs(h, { from: W0, to: RUN, action: 'Report' });
  assert.equal(l.length, 1);
  assert.equal(l[0].data.task, 0);
  assert.equal(l[0].data.outcome, 'failed');
});

ht('workFailed by worker1 sends Report failed for task 1', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W1));
  const l = await findMsgs(h, { from: W1, to: RUN, action: 'Report' });
  assert.equal(l.length, 1);
  assert.equal(l[0].data.task, 1);
  assert.equal(l[0].data.outcome, 'failed');
});

ht('workFailed does not change the run before its report is delivered', async (h) => {
  await startBusy(h);
  const before = await view(h);
  await ok(h.workFailed(W0));
  assert.deepEqual(await view(h), before);
});

ht('workFailed twice is refused the second time', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W0));
  await refusedUnchanged(h, () => h.workFailed(W0));
});

ht('workFailed refused after workDone', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await refusedUnchanged(h, () => h.workFailed(W0));
});


ht('final failure plus completion makes the run failed (failure first)', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await finish(h, W1);
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'completed');
});

ht('completion plus final failure makes the run failed (completion first)', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  await failFinal(h, W0);
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'completed');
});

ht('both tasks failed makes the run failed', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await failFinal(h, W1);
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'failed');
});

ht('a final failure with the other task still assigned leaves the run running', async (h) => {
  await startBusy(h);
  await failFinal(h, W1);
  const r = await h.run();
  assert.equal(r.status, 'running');
  assert.equal(r.task1, 'failed');
  assert.equal(r.task0, 'assigned');
});

ht('run is not failed until both tasks reported', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await ok(done(h, W1));
  assert.equal((await h.run()).status, 'running');
  await deliverMsg(h, reportFrom(W1, 'completed'));
  assert.equal((await h.run()).status, 'failed');
});

ht('workDone refused after the run failed', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await finish(h, W1);
  await refusedUnchanged(h, () => done(h, W0));
  await refusedUnchanged(h, () => h.workFailed(W1));
});

// ---------------------------------------------------------------- cancel

ht('cancel refused before start', async (h) => {
  await refusedUnchanged(h, () => h.cancel());
});

ht('cancel succeeds while running', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
});

ht('cancel makes the run cancelling', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  assert.equal((await h.run()).status, 'cancelling');
});

ht('cancel leaves assigned tasks assigned', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  const r = await h.run();
  assert.equal(r.task0, 'assigned');
  assert.equal(r.task1, 'assigned');
});

ht('cancel sends one Abort to each worker whose task is assigned', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
  assert.equal(await countMsgs(h, abortTo(W1)), 1);
  assert.equal((await h.inFlight()).length, 2);
});

ht('Abort carries empty data', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  for (const m of await findMsgs(h, { action: 'Abort' })) assert.deepEqual(m.data, {});
});

ht('cancel does not make workers idle before Abort is delivered', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  assert.equal(await wstatus(h, W0), 'busy');
  assert.equal(await wstatus(h, W1), 'busy');
});

ht('cancel succeeds while Assign messages are still in flight', async (h) => {
  await start(h);
  await ok(h.cancel());
  assert.equal((await h.run()).status, 'cancelling');
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
  assert.equal(await countMsgs(h, abortTo(W1)), 1);
});

ht('cancel is refused while cancelling', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await refusedUnchanged(h, () => h.cancel());
});

ht('cancel is refused after the run completed', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  await refusedUnchanged(h, () => h.cancel());
});

ht('cancel is refused after the run failed', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await failFinal(h, W1);
  await refusedUnchanged(h, () => h.cancel());
});

ht('cancel is refused after the run was cancelled', async (h) => {
  await startBusy(h);
  await cancelBoth(h);
  await h.deliverAll();
  await refusedUnchanged(h, () => h.cancel());
});

ht('cancel sends no Abort to the worker of a completed task', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 0);
  assert.equal(await countMsgs(h, abortTo(W1)), 1);
});

ht('cancel sends no Abort to the worker of a failed task', async (h) => {
  await startBusy(h);
  await failFinal(h, W1);
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W1)), 0);
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
});

ht('cancel sends Abort for a task whose report is still in flight', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
});

// ---------------------------------------------------------------- Abort delivery

ht('Abort to a busy worker makes it idle', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await wstatus(h, W1), 'busy');
});

ht('Abort to a busy worker sends Report cancelled for its task', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W1));
  const l = await findMsgs(h, { from: W1, to: RUN, action: 'Report' });
  assert.equal(l.length, 1);
  assert.equal(l[0].data.task, 1);
  assert.equal(l[0].data.outcome, 'cancelled');
});

ht('cancelled report makes the task cancelled and the run stays cancelling', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, reportFrom(W0, 'cancelled'));
  const r = await h.run();
  assert.equal(r.task0, 'cancelled');
  assert.equal(r.task1, 'assigned');
  assert.equal(r.status, 'cancelling');
});

ht('both tasks cancelled makes the run cancelled', async (h) => {
  await startBusy(h);
  await cancelBoth(h);
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  assert.equal((await h.run()).status, 'cancelling');
  await deliverMsg(h, reportFrom(W0, 'cancelled'));
  const r = await h.run();
  assert.equal(r.status, 'cancelled');
  assert.equal(r.task0, 'cancelled');
  assert.equal(r.task1, 'cancelled');
});

ht('workDone refused for a worker stopped by Abort', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  await refusedUnchanged(h, () => done(h, W0));
});

ht('Abort to an idle worker is ignored', async (h) => {
  await start(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await countMsgs(h, { from: W0 }), 0);
  assert.equal((await h.run()).task0, 'assigned');
});

ht('Abort to a worker that already finished is ignored', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await countMsgs(h, reportFrom(W0)), 1);
  assert.equal(await countMsgs(h, reportFrom(W0, 'cancelled')), 0);
});

ht('work finished before cancel is recorded completed, not cancelled', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(h.cancel());
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.task0, 'completed');
  assert.equal(r.task1, 'cancelled');
  assert.equal(r.status, 'cancelled');
});

ht('report delivered before Abort: finished work completed, other cancelled', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(h.cancel());
  await deliverMsg(h, reportFrom(W0, 'completed'));
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  const r = await h.run();
  assert.equal(r.task0, 'completed');
  assert.equal(r.task1, 'cancelled');
  assert.equal(r.status, 'cancelled');
});

ht('both finished before cancel: the cancelling run becomes completed', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(done(h, W1));
  await ok(h.cancel());
  assert.equal((await h.run()).status, 'cancelling');
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.status, 'completed');
  assert.equal(r.task0, 'completed');
  assert.equal(r.task1, 'completed');
});

ht('completed plus cancelled makes the run cancelled', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  const r = await h.run();
  assert.equal(r.status, 'cancelled');
  assert.equal(r.task0, 'completed');
  assert.equal(r.task1, 'cancelled');
});

ht('failed plus cancelled makes the run failed', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'cancelled');
});

ht('cancelled first then a failure while cancelling makes the run failed', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  await ok(h.workFailed(W0));
  await deliverMsg(h, reportFrom(W0, 'failed'));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.status, 'failed');
});

ht('a failure reported while cancelling is recorded as failed', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W0));
  await ok(h.cancel());
  await deliverMsg(h, reportFrom(W0, 'failed'));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.status, 'cancelling');
});

ht('a completion reported while cancelling is recorded as completed', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await finish(h, W1);
  const r = await h.run();
  assert.equal(r.task1, 'completed');
  assert.equal(r.status, 'cancelling');
});

ht('worker finishes while Abort in flight: completion wins and Abort is ignored', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await ok(done(h, W1));
  await deliverMsg(h, abortTo(W1));
  assert.equal(await countMsgs(h, reportFrom(W1, 'cancelled')), 0);
  await deliverMsg(h, reportFrom(W1, 'completed'));
  assert.equal((await h.run()).task1, 'completed');
});

ht('Abort before Assign: worker becomes busy afterwards and its work counts', async (h) => {
  await start(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, assignTo(W0));
  assert.equal(await wstatus(h, W0), 'busy');
  await finish(h, W0);
  assert.equal((await h.run()).task0, 'completed');
  assert.equal((await h.run()).status, 'cancelling');
});

ht('Assign before Abort: worker is stopped and reports cancelled', async (h) => {
  await start(h);
  await ok(h.cancel());
  await deliverMsg(h, assignTo(W0));
  await deliverMsg(h, abortTo(W0));
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await countMsgs(h, reportFrom(W0, 'cancelled')), 1);
});

ht('cancel with nothing started yet: deliverAll ends with run not ahead of workers', async (h) => {
  await start(h);
  await ok(h.cancel());
  await h.deliverAll();
  const r = await h.run();
  // Whatever order deliverAll used, the run ends only when both tasks reported.
  if (TERMINAL.includes(r.status)) {
    assert.notEqual(r.task0, 'assigned');
    assert.notEqual(r.task1, 'assigned');
  } else {
    assert.equal(r.status, 'cancelling');
  }
});

ht('run stays cancelling while one worker keeps working', async (h) => {
  await start(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, assignTo(W0));
  await deliverMsg(h, assignTo(W1));
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  const r = await h.run();
  assert.equal(r.status, 'cancelling');
  assert.equal(r.task0, 'assigned');
  assert.equal(r.task1, 'cancelled');
});

ht('cancel after one task completed: Abort only reaches the other', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  await ok(h.cancel());
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.task1, 'completed');
  assert.equal(r.task0, 'cancelled');
  assert.equal(r.status, 'cancelled');
  assert.equal(await wstatus(h, W0), 'idle');
});


// ---------------------------------------------------------------- retry (change 1)

ht('first failure while running keeps the task assigned', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  assert.equal((await h.run()).task0, 'assigned');
});

ht('first failure while running marks the task retried', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  const r = await h.run();
  assert.equal(r.retried0, true);
  assert.equal(r.retried1, false);
});

ht('first failure of task 1 marks only task 1 retried', async (h) => {
  await startBusy(h);
  await failOnce(h, W1);
  const r = await h.run();
  assert.equal(r.retried1, true);
  assert.equal(r.retried0, false);
  assert.equal(r.task1, 'assigned');
});

ht('first failure while running leaves the run running', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  assert.equal((await h.run()).status, 'running');
});

ht('first failure while running sends Assign again to the worker', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  const l = await findMsgs(h, assignTo(W0));
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].data, {});
  assert.equal(await countMsgs(h, assignTo(W1)), 0);
});

ht('retry is not marked before the failed report is delivered', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W0));
  const r = await h.run();
  assert.equal(r.retried0, false);
  assert.equal(await countMsgs(h, assignTo(W0)), 0);
});

ht('the retry Assign makes the worker busy again', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  assert.equal(await wstatus(h, W0), 'busy');
});

ht('a retried task that completes is completed', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await finish(h, W0);
  const r = await h.run();
  assert.equal(r.task0, 'completed');
  assert.equal(r.retried0, true);
});

ht('a retried task that completes lets the run complete', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await finish(h, W0);
  await finish(h, W1);
  assert.equal((await h.run()).status, 'completed');
});

ht('both tasks retried then completed makes the run completed', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await failOnce(h, W1);
  const mid = await h.run();
  assert.equal(mid.retried0, true);
  assert.equal(mid.retried1, true);
  assert.equal(mid.status, 'running');
  await h.deliverAll();
  await finish(h, W1);
  await finish(h, W0);
  assert.equal((await h.run()).status, 'completed');
});

ht('second failure of the same task is recorded as failed', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await failOnce(h, W0);
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.retried0, true);
});

ht('second failure sends no further Assign', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await failOnce(h, W0);
  assert.equal(await countMsgs(h, assignTo(W0)), 0);
  assert.equal((await h.inFlight()).length, 0);
});

ht('second failure with the other task assigned leaves the run running', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await failOnce(h, W0);
  assert.equal((await h.run()).status, 'running');
});

ht('second failure with the other completed makes the run failed', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  await failOnce(h, W0);
  assert.equal((await h.run()).status, 'running');
  await deliverMsg(h, assignTo(W0));
  await failOnce(h, W0);
  assert.equal((await h.run()).status, 'failed');
});

ht('one failure of each task does not fail the run', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await failOnce(h, W1);
  const r = await h.run();
  assert.equal(r.status, 'running');
  assert.equal(r.task0, 'assigned');
  assert.equal(r.task1, 'assigned');
});

ht('retry of one task does not grant a second retry to it after the other is retried', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await failOnce(h, W1);
  await deliverMsg(h, assignTo(W0));
  await failOnce(h, W0);
  assert.equal((await h.run()).task0, 'failed');
});

ht('a first failure while cancelling is recorded as failed', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await failOnce(h, W0);
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.status, 'cancelling');
});

ht('a first failure while cancelling is not retried', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await failOnce(h, W0);
  assert.equal((await h.run()).retried0, false);
  assert.equal(await countMsgs(h, assignTo(W0)), 0);
});

ht('failure sent before cancel but delivered after is not retried', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W1));
  await ok(h.cancel());
  await deliverMsg(h, reportFrom(W1, 'failed'));
  const r = await h.run();
  assert.equal(r.task1, 'failed');
  assert.equal(r.retried1, false);
  assert.equal(await countMsgs(h, assignTo(W1)), 0);
});

ht('failure delivered before cancel is retried, then cancel aborts the retry', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
  await deliverMsg(h, assignTo(W0));
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, reportFrom(W0, 'cancelled'));
  const r = await h.run();
  assert.equal(r.task0, 'cancelled');
  assert.equal(r.retried0, true);
});

ht('retry Assign arriving after Abort: the worker works and its result is recorded', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  assert.equal(await wstatus(h, W0), 'idle');
  await deliverMsg(h, assignTo(W0));
  assert.equal(await wstatus(h, W0), 'busy');
  await failOnce(h, W0);
  assert.equal((await h.run()).task0, 'failed');
});

ht('retried task failing again while cancelling makes the run failed once the other is cancelled', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await ok(h.cancel());
  await ok(h.workFailed(W0));
  await deliverMsg(h, reportFrom(W0, 'failed'));
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
});

ht('retried flags are unchanged by a refused command', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await refusedUnchanged(h, () => h.start());
  await refusedUnchanged(h, () => h.workFailed(W0));
});

ht('retried flag stays true after the run completes', async (h) => {
  await startBusy(h);
  await failOnce(h, W1);
  await h.deliverAll();
  await finish(h, W1);
  await finish(h, W0);
  const r = await h.run();
  assert.equal(r.status, 'completed');
  assert.equal(r.retried1, true);
  assert.equal(r.retried0, false);
});

ht('completions never mark a task retried', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  const r = await h.run();
  assert.equal(r.retried0, false);
  assert.equal(r.retried1, false);
});

ht('cancellations never mark a task retried', async (h) => {
  await startBusy(h);
  await cancelBoth(h);
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.retried0, false);
  assert.equal(r.retried1, false);
});

// ---------------------------------------------------------------- taskTimeout (change 2)

ht('taskTimeout refused before start', async (h) => {
  await refusedUnchanged(h, () => h.taskTimeout(0));
  await refusedUnchanged(h, () => h.taskTimeout(1));
});

ht('taskTimeout refused for a task other than 0 or 1', async (h) => {
  await startBusy(h);
  await refusedUnchanged(h, () => h.taskTimeout(2));
  await refusedUnchanged(h, () => h.taskTimeout(-1));
});

ht('taskTimeout succeeds for an assigned task while running', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
});

ht('taskTimeout records the task as failed', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'assigned');
});

ht('taskTimeout does not retry the task', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(1));
  const r = await h.run();
  assert.equal(r.retried1, false);
  assert.equal(await countMsgs(h, assignTo(W1)), 0);
});

ht('taskTimeout sends Abort to the task worker', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(1));
  const l = await findMsgs(h, abortTo(W1));
  assert.equal(l.length, 1);
  assert.deepEqual(l[0].data, {});
  assert.equal(await countMsgs(h, abortTo(W0)), 0);
});

ht('taskTimeout with the other task assigned leaves the run running', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  assert.equal((await h.run()).status, 'running');
});

ht('taskTimeout with the other task completed makes the run failed', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  await ok(h.taskTimeout(0));
  assert.equal((await h.run()).status, 'failed');
});

ht('timing out both tasks makes the run failed', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await ok(h.taskTimeout(1));
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'failed');
});

ht('taskTimeout works while Assign is still in flight', async (h) => {
  await start(h);
  await ok(h.taskTimeout(0));
  assert.equal((await h.run()).task0, 'failed');
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
});

ht('taskTimeout refused for a task that completed', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await refusedUnchanged(h, () => h.taskTimeout(0));
});

ht('taskTimeout refused for a task already timed out', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await refusedUnchanged(h, () => h.taskTimeout(0));
});

ht('taskTimeout refused for a task that failed', async (h) => {
  await startBusy(h);
  await failFinal(h, W1);
  await refusedUnchanged(h, () => h.taskTimeout(1));
});

ht('taskTimeout refused for a task that was cancelled', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, reportFrom(W0, 'cancelled'));
  await refusedUnchanged(h, () => h.taskTimeout(0));
});

ht('taskTimeout refused after the run completed', async (h) => {
  await startBusy(h);
  await finish(h, W0);
  await finish(h, W1);
  await refusedUnchanged(h, () => h.taskTimeout(0));
  await refusedUnchanged(h, () => h.taskTimeout(1));
});

ht('taskTimeout refused after the run was cancelled', async (h) => {
  await startBusy(h);
  await cancelBoth(h);
  await h.deliverAll();
  await refusedUnchanged(h, () => h.taskTimeout(0));
});

ht('taskTimeout succeeds while cancelling for an assigned task', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await ok(h.taskTimeout(0));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.status, 'cancelling');
});

ht('taskTimeout while cancelling sends another Abort', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await ok(h.taskTimeout(0));
  assert.equal(await countMsgs(h, abortTo(W0)), 2);
});

ht('taskTimeout while cancelling with the other cancelled makes the run failed', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'cancelled'));
  await ok(h.taskTimeout(0));
  assert.equal((await h.run()).status, 'failed');
});

ht('timeout then cancel: the timed-out task gets no new Abort', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
  assert.equal(await countMsgs(h, abortTo(W1)), 1);
});

ht('timeout Abort stops the busy worker and it reports cancelled', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await deliverMsg(h, abortTo(W0));
  assert.equal(await wstatus(h, W0), 'idle');
  assert.equal(await countMsgs(h, reportFrom(W0, 'cancelled')), 1);
});

ht('cancelled report after a timeout is ignored', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, reportFrom(W0, 'cancelled'));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.status, 'running');
});

ht('completed report after a timeout is ignored', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await ok(h.taskTimeout(0));
  await deliverMsg(h, reportFrom(W0, 'completed'));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
});

ht('completed report after a timeout does not complete the run', async (h) => {
  await startBusy(h);
  await finish(h, W1);
  await ok(done(h, W0));
  await ok(h.taskTimeout(0));
  await deliverMsg(h, reportFrom(W0, 'completed'));
  assert.equal((await h.run()).status, 'failed');
});

ht('failed report after a timeout is ignored and not retried', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W0));
  await ok(h.taskTimeout(0));
  await deliverMsg(h, reportFrom(W0, 'failed'));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.retried0, false);
  assert.equal(await countMsgs(h, assignTo(W0)), 0);
});

ht('timing out a retried task records it failed and keeps it retried', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  await deliverMsg(h, assignTo(W0));
  await ok(h.taskTimeout(0));
  const r = await h.run();
  assert.equal(r.task0, 'failed');
  assert.equal(r.retried0, true);
});

ht('timing out while the retry Assign is in flight records failed', async (h) => {
  await startBusy(h);
  await failOnce(h, W1);
  await ok(h.taskTimeout(1));
  assert.equal((await h.run()).task1, 'failed');
  await h.deliverAll();
  assert.equal((await h.run()).task1, 'failed');
});

ht('timeout Abort before late Assign: later work by the worker is ignored', async (h) => {
  await start(h);
  await ok(h.taskTimeout(0));
  await deliverMsg(h, abortTo(W0));
  await deliverMsg(h, assignTo(W0));
  assert.equal(await wstatus(h, W0), 'busy');
  await finish(h, W0);
  assert.equal((await h.run()).task0, 'failed');
});

ht('timeout does not change the other worker', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  assert.equal(await wstatus(h, W1), 'busy');
  await h.deliverAll();
  assert.equal(await wstatus(h, W1), 'busy');
  assert.equal((await h.run()).task1, 'assigned');
});

ht('reports after a timeout-failed run are ignored', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await ok(h.taskTimeout(1));
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.status, 'failed');
  assert.equal(r.task0, 'failed');
  assert.equal(r.task1, 'failed');
});

ht('a run that ended ignores a later completed report', async (h) => {
  await startBusy(h);
  await ok(done(h, W1));
  await ok(h.taskTimeout(0));
  await ok(h.taskTimeout(1));
  const before = await view(h);
  await deliverMsg(h, reportFrom(W1, 'completed'));
  assert.deepEqual(await view(h), before);
});

ht('workDone still allowed for a busy worker whose task timed out', async (h) => {
  await startBusy(h);
  await ok(h.taskTimeout(0));
  await ok(done(h, W0));
  assert.equal(await wstatus(h, W0), 'idle');
});

// ---------------------------------------------------------------- items (change 3)

ht('completed Report carries the items processed (1)', async (h) => {
  await startBusy(h);
  await ok(done(h, W0, 1));
  const [m] = await findMsgs(h, { from: W0, to: RUN, action: 'Report' });
  assert.equal(m.data.items, 1);
  assert.equal(m.data.outcome, 'completed');
  assert.equal(m.data.task, 0);
});

ht('completed Report carries the items processed (2)', async (h) => {
  await startBusy(h);
  await ok(done(h, W1, 2));
  const [m] = await findMsgs(h, { from: W1, to: RUN, action: 'Report' });
  assert.equal(m.data.items, 2);
});

ht('Report data has exactly task, outcome and items', async (h) => {
  await startBusy(h);
  await ok(done(h, W0, 2));
  const [m] = await findMsgs(h, { from: W0, action: 'Report' });
  assert.deepEqual(m.data, { task: 0, outcome: 'completed', items: 2 });
});

ht('failed Report carries 0 items', async (h) => {
  await startBusy(h);
  await ok(h.workFailed(W1));
  const [m] = await findMsgs(h, { from: W1, action: 'Report' });
  assert.equal(m.data.items, 0);
  assert.equal(m.data.outcome, 'failed');
});

ht('cancelled Report carries 0 items', async (h) => {
  await startBusy(h);
  await ok(h.cancel());
  await deliverMsg(h, abortTo(W0));
  const [m] = await findMsgs(h, { from: W0, action: 'Report' });
  assert.equal(m.data.items, 0);
  assert.equal(m.data.outcome, 'cancelled');
});

ht('workDone does not change processed before its report is delivered', async (h) => {
  await startBusy(h);
  await ok(done(h, W0, 2));
  assert.equal((await h.run()).processed, 0);
});

ht('a recorded completion adds its items to processed', async (h) => {
  await startBusy(h);
  await finish(h, W0, 2);
  assert.equal((await h.run()).processed, 2);
});

ht('processed sums both completions (1 + 2)', async (h) => {
  await startBusy(h);
  await finish(h, W0, 1);
  await finish(h, W1, 2);
  const r = await h.run();
  assert.equal(r.processed, 3);
  assert.equal(r.status, 'completed');
});

ht('processed sums both completions (2 + 2)', async (h) => {
  await startBusy(h);
  await finish(h, W1, 2);
  await finish(h, W0, 2);
  assert.equal((await h.run()).processed, 4);
});

ht('processed sums both completions (1 + 1)', async (h) => {
  await startBusy(h);
  await finish(h, W1, 1);
  await finish(h, W0, 1);
  assert.equal((await h.run()).processed, 2);
});

ht('failures add nothing to processed', async (h) => {
  await startBusy(h);
  await failFinal(h, W0);
  await finish(h, W1, 2);
  const r = await h.run();
  assert.equal(r.processed, 2);
  assert.equal(r.status, 'failed');
});

ht('a retried failure adds nothing and the retry completion adds its items', async (h) => {
  await startBusy(h);
  await failOnce(h, W0);
  assert.equal((await h.run()).processed, 0);
  await deliverMsg(h, assignTo(W0));
  await finish(h, W0, 2);
  assert.equal((await h.run()).processed, 2);
});

ht('cancellations add nothing to processed', async (h) => {
  await startBusy(h);
  await cancelBoth(h);
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.status, 'cancelled');
  assert.equal(r.processed, 0);
});

ht('completion recorded while cancelling adds its items', async (h) => {
  await startBusy(h);
  await ok(done(h, W0, 2));
  await ok(h.cancel());
  await h.deliverAll();
  const r = await h.run();
  assert.equal(r.task0, 'completed');
  assert.equal(r.processed, 2);
});

ht('an ignored completed report after a timeout adds nothing', async (h) => {
  await startBusy(h);
  await ok(done(h, W0, 2));
  await ok(h.taskTimeout(0));
  await deliverMsg(h, reportFrom(W0, 'completed'));
  assert.equal((await h.run()).processed, 0);
});

ht('a completed report ignored by an ended run adds nothing', async (h) => {
  await startBusy(h);
  await finish(h, W0, 1);
  await ok(done(h, W1, 2));
  await ok(h.taskTimeout(1));
  assert.equal((await h.run()).status, 'failed');
  await deliverMsg(h, reportFrom(W1, 'completed'));
  assert.equal((await h.run()).processed, 1);
});

ht('late work after a timeout adds nothing', async (h) => {
  await start(h);
  await ok(h.taskTimeout(1));
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, assignTo(W1));
  await finish(h, W1, 2);
  assert.equal((await h.run()).processed, 0);
});

ht('refused workDone adds nothing to processed', async (h) => {
  await startBusy(h);
  await finish(h, W0, 2);
  await refusedUnchanged(h, () => done(h, W0, 2));
  assert.equal((await h.run()).processed, 2);
});

// ---------------------------------------------------------------- refused commands with messages in flight

ht('refused commands leave in-flight messages untouched', async (h) => {
  await start(h);
  await refusedUnchanged(h, () => h.start());
  await refusedUnchanged(h, () => done(h, W0));
  await refusedUnchanged(h, () => h.workFailed(W1));
});

ht('refused cancel while cancelling sends no new Abort', async (h) => {
  await start(h);
  await ok(h.cancel());
  await refusedUnchanged(h, () => h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 1);
});

// ---------------------------------------------------------------- conclusion: orders of delivery

test('both Assign orders followed by reports in reverse order end completed', async () => {
  for (const first of [W0, W1]) {
    const h = await createHost();
    await ok(h.start());
    await deliverMsg(h, assignTo(first));
    await deliverMsg(h, assignTo(first === W0 ? W1 : W0));
    await ok(done(h, W1));
    await ok(done(h, W0));
    await deliverMsg(h, reportFrom(W1, 'completed'));
    assert.equal((await h.run()).status, 'running');
    await deliverMsg(h, reportFrom(W0, 'completed'));
    assert.equal((await h.run()).status, 'completed');
  }
});

async function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of await permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

// Deliver messages in the given order of labels, where each label is matched to a message
// that is in flight at that moment; labels whose message is not in flight are skipped.
async function deliverByLabels(h, labels) {
  for (const f of labels) {
    const l = await findMsgs(h, f);
    if (l.length > 0) await h.deliver(l[0].id);
  }
}

test('cancel right after start: every order of Assign/Abort ends with no task cancelled that was not aborted while busy', async () => {
  const A = { worker0: assignTo(W0), worker1: assignTo(W1) };
  const B = { worker0: abortTo(W0), worker1: abortTo(W1) };
  const labels = [A[W0], B[W0], A[W1], B[W1]];
  for (const order of await permutations(labels)) {
    const h = await createHost();
    await ok(h.start());
    await ok(h.cancel());
    await deliverByLabels(h, order);
    // Busy workers finish their work; then everything is delivered.
    for (const w of [W0, W1]) if ((await wstatus(h, w)) === 'busy') await ok(done(h, w));
    await h.deliverAll();
    const r = await h.run();
    for (const [w, t] of [[W0, 'task0'], [W1, 'task1']]) {
      const assignFirst = order.indexOf(A[w]) < order.indexOf(B[w]);
      assert.equal(r[t], assignFirst ? 'cancelled' : 'completed', `order ${JSON.stringify(order.map((o) => o.action + '>' + o.to))}`);
    }
    assert.ok(TERMINAL.includes(r.status));
    if (r.task0 === 'completed' && r.task1 === 'completed') assert.equal(r.status, 'completed');
    else assert.equal(r.status, 'cancelled');
  }
});

test('reports delivered in every order give the same final status', async () => {
  const cases = [
    ['completed', 'completed', 'completed'],
  ];
  for (const [o0, o1, expected] of cases) {
    for (const order of [[W0, W1], [W1, W0]]) {
      const h = await createHost();
      await startBusy(h);
      for (const [w, o] of [[W0, o0], [W1, o1]]) {
        if (o === 'completed') await ok(done(h, w));
        else await ok(h.workFailed(w));
      }
      await deliverMsg(h, reportFrom(order[0]));
      assert.ok(!TERMINAL.includes((await h.run()).status));
      await deliverMsg(h, reportFrom(order[1]));
      assert.equal((await h.run()).status, expected);
    }
  }
});

ht('cancel between two in-flight completions: run still completes', async (h) => {
  await startBusy(h);
  await ok(done(h, W0));
  await deliverMsg(h, reportFrom(W0, 'completed'));
  await ok(done(h, W1));
  await ok(h.cancel());
  assert.equal(await countMsgs(h, abortTo(W0)), 0);
  await deliverMsg(h, abortTo(W1));
  await deliverMsg(h, reportFrom(W1, 'completed'));
  assert.equal((await h.run()).status, 'completed');
});

// ---------------------------------------------------------------- conclusion: random command sequences

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANK = { idle: 0, running: 1, cancelling: 2, completed: 3, failed: 3, cancelled: 3 };
const ITEMS = { worker0: 1, worker1: 2 };

function checkInvariants(prev, cur, tr) {
  const ctx = JSON.stringify({ prev, cur });
  assert.ok(Object.hasOwn(RANK, cur.status), 'valid run status ' + ctx);
  for (const t of ['task0', 'task1'])
    assert.ok(['idle', 'assigned', 'completed', 'failed', 'cancelled'].includes(cur[t]), 'valid task status ' + ctx);
  if (cur.status === 'idle') {
    assert.equal(cur.task0, 'idle', ctx);
    assert.equal(cur.task1, 'idle', ctx);
  } else {
    assert.notEqual(cur.task0, 'idle', ctx);
    assert.notEqual(cur.task1, 'idle', ctx);
  }
  // completed only when both completed
  if (cur.status === 'completed') {
    assert.equal(cur.task0, 'completed', ctx);
    assert.equal(cur.task1, 'completed', ctx);
  }
  // ends only when both reported
  if (TERMINAL.includes(cur.status)) {
    assert.notEqual(cur.task0, 'assigned', ctx);
    assert.notEqual(cur.task1, 'assigned', ctx);
  }
  if (cur.status === 'running' || cur.status === 'cancelling')
    assert.ok(cur.task0 === 'assigned' || cur.task1 === 'assigned', 'unfinished run has assigned task ' + ctx);
  if (cur.status === 'failed') assert.ok(cur.task0 === 'failed' || cur.task1 === 'failed', ctx);
  if (cur.status === 'cancelled') {
    assert.ok(cur.task0 !== 'failed' && cur.task1 !== 'failed', ctx);
    assert.ok(cur.task0 === 'cancelled' || cur.task1 === 'cancelled', ctx);
  }
  if (!TERMINAL.includes(cur.status) && cur.status !== 'idle') {
    // a run with both tasks reported must have ended
    assert.ok(cur.task0 === 'assigned' || cur.task1 === 'assigned', ctx);
  }
  // status only moves forward; an ended run stays ended
  assert.ok(RANK[cur.status] >= RANK[prev.status], 'status moved backwards ' + ctx);
  if (TERMINAL.includes(prev.status)) assert.equal(cur.status, prev.status, ctx);
  if (prev.status === 'running' && cur.status === 'cancelling') assert.ok(tr.cancelOk, ctx);
  // recorded task statuses never change
  for (const t of ['task0', 'task1']) if (TERMINAL.includes(prev[t])) assert.equal(cur[t], prev[t], ctx);
  // the run never runs ahead of its workers
  for (const [w, t, n] of [[W0, 'task0', 0], [W1, 'task1', 1]]) {
    if (cur[t] === 'completed') assert.ok(tr.doneOk[w], 'completed without workDone ' + ctx);
    if (cur[t] === 'failed') assert.ok(tr.failOk[w] || tr.timeoutOk[n], 'failed without failure ' + ctx);
    if (cur[t] === 'cancelled') assert.ok(tr.cancelOk, 'cancelled without cancel ' + ctx);
  }
  if (cur.task0 === 'cancelled' || cur.task1 === 'cancelled') assert.notEqual(cur.status, 'running', ctx);
  for (const [k, w] of [['retried0', W0], ['retried1', W1]]) {
    assert.equal(typeof cur[k], 'boolean', ctx);
    if (prev[k]) assert.equal(cur[k], true, ctx);
    if (cur[k]) assert.ok(tr.failOk[w], 'retried without failure ' + ctx);
  }
  const expected = (cur.task0 === 'completed' ? ITEMS[W0] : 0) + (cur.task1 === 'completed' ? ITEMS[W1] : 0);
  assert.equal(cur.processed, expected, 'processed total ' + ctx);
}

async function randomWalk(seed, steps) {
  const r = rng(seed);
  const h = await createHost();
  const tr = { doneOk: { worker0: false, worker1: false }, failOk: { worker0: false, worker1: false }, timeoutOk: [false, false], cancelOk: false };
  let prev = await view(h);
  checkInvariants(prev, prev, tr);
  for (let i = 0; i < steps; i++) {
    const v = await view(h);
    const ws = { worker0: await wstatus(h, W0), worker1: await wstatus(h, W1) };
    const inflight = await h.inFlight();
    const w = r() < 0.5 ? W0 : W1;
    const task = r() < 0.5 ? 0 : 1;
    const choice = r();
    let cmd = null;
    let expectOk = null;
    let onOk = () => {};
    if (choice < 0.35 && inflight.length > 0) {
      await h.deliver(inflight[Math.floor(r() * inflight.length)].id);
    } else if (choice < 0.4) {
      await h.deliverAll();
    } else if (choice < 0.47) {
      cmd = () => h.start();
      expectOk = v.status === 'idle';
    } else if (choice < 0.53) {
      cmd = () => h.cancel();
      expectOk = v.status === 'running';
      onOk = () => (tr.cancelOk = true);
    } else if (choice < 0.7) {
      cmd = () => done(h, w, ITEMS[w]);
      expectOk = ws[w] === 'busy';
      onOk = () => (tr.doneOk[w] = true);
    } else if (choice < 0.82) {
      cmd = () => h.workFailed(w);
      expectOk = ws[w] === 'busy';
      onOk = () => (tr.failOk[w] = true);
    } else if (choice < 0.9) {
      cmd = () => h.taskTimeout(task);
      expectOk = (v.status === 'running' || v.status === 'cancelling') && v['task' + task] === 'assigned';
      onOk = () => (tr.timeoutOk[task] = true);
    } else if (choice < 0.95) {
      cmd = () => done(h, 'worker9', 1);
      expectOk = false;
    } else {
      cmd = () => h.workFailed('run');
      expectOk = false;
    }
    if (cmd) {
      const before = await snap(h);
      const res = await cmd();
      assert.equal(res.ok, expectOk, `seed ${seed} step ${i}: unexpected outcome in ${before}`);
      if (res.ok) onOk();
      else assert.equal(await snap(h), before, `seed ${seed} step ${i}: refused command changed something`);
    }
    for (const x of [W0, W1]) assert.ok(['idle', 'busy'].includes(await wstatus(h, x)));
    const cur = await view(h);
    checkInvariants(prev, cur, tr);
    prev = cur;
  }
  // Let every busy worker finish (completing or failing) and deliver everything.
  for (let round = 0; round < 12; round++) {
    await h.deliverAll();
    let any = false;
    for (const x of [W0, W1]) {
      if ((await wstatus(h, x)) === 'busy') {
        any = true;
        if (r() < 0.5) {
          await ok(done(h, x, ITEMS[x]));
          tr.doneOk[x] = true;
        } else {
          await ok(h.workFailed(x));
          tr.failOk[x] = true;
        }
      }
    }
    const cur = await view(h);
    checkInvariants(prev, cur, tr);
    prev = cur;
    if (!any && (await h.inFlight()).length === 0) break;
  }
  assert.equal((await h.inFlight()).length, 0, `seed ${seed}: deliverAll left messages in flight`);
  const fin = await view(h);
  if (fin.status !== 'idle') assert.ok(TERMINAL.includes(fin.status), `seed ${seed}: run did not end once all workers finished: ${JSON.stringify(fin)}`);
}

for (let block = 0; block < 6; block++) {
  test(`random command and delivery sequences keep the run behind its workers (block ${block})`, async () => {
    for (let s = 0; s < 40; s++) await randomWalk(1000 * block + s + 1, 30);
  });
}

test('random sequences starting with start and cancel end cancelled, completed or failed consistently', async () => {
  for (let s = 0; s < 60; s++) {
    const r = rng(777 + s);
    const h = await createHost();
    await ok(h.start());
    const tr = { doneOk: { worker0: false, worker1: false }, failOk: { worker0: false, worker1: false }, timeoutOk: [false, false], cancelOk: false };
    let prev = await view(h);
    // deliver a random prefix of the Assign messages, maybe finish some work, then cancel
    for (let i = 0; i < 4; i++) {
      const l = await h.inFlight();
      if (l.length && r() < 0.6) await h.deliver(l[Math.floor(r() * l.length)].id);
      for (const x of [W0, W1]) {
        if ((await wstatus(h, x)) === 'busy' && r() < 0.3) {
          await ok(done(h, x, ITEMS[x]));
          tr.doneOk[x] = true;
        }
      }
      const cur = await view(h);
      checkInvariants(prev, cur, tr);
      prev = cur;
    }
    const pre = await view(h);
    const cr = await h.cancel();
    assert.equal(cr.ok, pre.status === 'running');
    if (cr.ok) tr.cancelOk = true;
    for (let i = 0; i < 12; i++) {
      const l = await h.inFlight();
      for (const x of [W0, W1]) {
        if ((await wstatus(h, x)) === 'busy' && r() < 0.3) {
          await ok(done(h, x, ITEMS[x]));
          tr.doneOk[x] = true;
        }
      }
      if (l.length === 0) {
        let any = false;
        for (const x of [W0, W1]) if ((await wstatus(h, x)) === 'busy') { any = true; await ok(done(h, x, ITEMS[x])); tr.doneOk[x] = true; }
        if (!any && (await h.inFlight()).length === 0) break;
      } else await h.deliver(l[Math.floor(r() * l.length)].id);
      const cur = await view(h);
      checkInvariants(prev, cur, tr);
      prev = cur;
    }
    await h.deliverAll();
    for (const x of [W0, W1]) if ((await wstatus(h, x)) === 'busy') { await ok(done(h, x, ITEMS[x])); tr.doneOk[x] = true; }
    await h.deliverAll();
    const fin = await view(h);
    checkInvariants(prev, fin, tr);
    assert.ok(TERMINAL.includes(fin.status), JSON.stringify(fin));
    // nothing failed here, so the run is completed exactly when both completed, otherwise cancelled
    if (fin.task0 === 'completed' && fin.task1 === 'completed') assert.equal(fin.status, 'completed');
    else assert.equal(fin.status, 'cancelled');
  }
});
