// T5 v0: workflow run status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

// ---------- helpers ----------
const IN_FLIGHT = new Set(['queued', 'running', 'evicted']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function ok(p) {
  const r = await p;
  assert.equal(r.ok, true);
}
async function no(p) {
  const r = await p;
  assert.equal(r.ok, false);
}
async function expectRun(h, id, status, tasks) {
  const v = await h.run(id);
  assert.notEqual(v, null);
  assert.equal(v.status, status);
  if (tasks) {
    assert.equal(v.task0, tasks[0]);
    assert.equal(v.task1, tasks[1]);
    assert.equal(v.task2, tasks[2]);
  }
}
async function snapshot(h, ids) {
  const out = [];
  for (const id of ids) out.push(await h.run(id));
  return out;
}
// Asserts the command is refused and that the given runs are unchanged.
async function refusedNoChange(h, ids, fn) {
  const before = await snapshot(h, ids);
  const r = await fn();
  assert.equal(r.ok, false);
  assert.deepEqual(await snapshot(h, ids), before);
}
async function started(h, id) {
  await ok(h.start(id));
}
async function running(h, id, t) {
  await ok(h.taskStarted(id, t));
}
async function completed(h, id, t) {
  await ok(h.taskStarted(id, t));
  await ok(h.taskCompleted(id, t));
}
async function failed(h, id, t) {
  await ok(h.taskStarted(id, t));
  await ok(h.taskFailed(id, t));
}
async function evicted(h, id, t) {
  await ok(h.taskStarted(id, t));
  await ok(h.taskEvicted(id, t));
}
function derive(ts) {
  if (ts[0] === ts[1] && ts[1] === ts[2]) return ts[0];
  if (ts.includes('failed')) return 'failed';
  if (ts.some((s) => IN_FLIGHT.has(s))) return 'running';
  return 'cancelled';
}

// ---------- query ----------
test('run returns null for an id never started', async () => {
  const h = await createHost();
  assert.equal(await h.run('nope'), null);
});

test('a fresh system has no runs', async () => {
  const h = await createHost();
  assert.equal(await h.run('r'), null);
  assert.equal(await h.run(''), null);
});

test('fresh hosts are independent', async () => {
  const h1 = await createHost();
  await started(h1, 'r');
  const h = await createHost();
  assert.equal(await h.run('r'), null);
});

// ---------- start ----------
test('start takes effect for a new id', async () => {
  const h = await createHost();
  await ok(h.start('r'));
});

test('a started run is queued with three queued tasks', async () => {
  const h = await createHost();
  await started(h, 'r');
  await expectRun(h, 'r', 'queued', ['queued', 'queued', 'queued']);
});

test('start is refused for an id that exists', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.start('r'));
});

test('start is refused for an id that exists, freshly started', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.start('r'));
  await expectRun(h, 'r', 'queued', ['queued', 'queued', 'queued']);
});

test('start is refused for an id whose run completed', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await completed(h, 'r', t);
  await refusedNoChange(h, ['r'], () => h.start('r'));
});

test('start is refused for an id whose run was cancelled', async () => {
  const h = await createHost();
  await started(h, 'r');
  await ok(h.cancel('r'));
  await refusedNoChange(h, ['r'], () => h.start('r'));
});

test('start is refused for an id whose run failed', async () => {
  const h = await createHost();
  await started(h, 'r');
  await failed(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.start('r'));
});

test('runs with different ids are independent', async () => {
  const h = await createHost();
  await started(h, 'a');
  await started(h, 'b');
  await completed(h, 'a', 0);
  await expectRun(h, 'a', 'running', ['completed', 'queued', 'queued']);
  await expectRun(h, 'b', 'queued', ['queued', 'queued', 'queued']);
});

test('starting a second run does not change the first', async () => {
  const h = await createHost();
  await started(h, 'a');
  await running(h, 'a', 1);
  await started(h, 'b');
  await expectRun(h, 'a', 'running', ['queued', 'running', 'queued']);
});

test('ids are compared exactly', async () => {
  const h = await createHost();
  await started(h, 'run');
  await ok(h.start('run2'));
  await expectRun(h, 'run2', 'queued', ['queued', 'queued', 'queued']);
});

// ---------- unknown run ----------
test('taskStarted on an unknown run is refused', async () => {
  const h = await createHost();
  await no(h.taskStarted('x', 0));
  assert.equal(await h.run('x'), null);
});

test('taskCompleted on an unknown run is refused', async () => {
  const h = await createHost();
  await no(h.taskCompleted('x', 0));
  assert.equal(await h.run('x'), null);
});

test('taskFailed on an unknown run is refused', async () => {
  const h = await createHost();
  await no(h.taskFailed('x', 0));
  assert.equal(await h.run('x'), null);
});

test('taskEvicted on an unknown run is refused', async () => {
  const h = await createHost();
  await no(h.taskEvicted('x', 0));
  assert.equal(await h.run('x'), null);
});

test('taskRequeued on an unknown run is refused', async () => {
  const h = await createHost();
  await no(h.taskRequeued('x', 0));
  assert.equal(await h.run('x'), null);
});

test('cancel on an unknown run is refused', async () => {
  const h = await createHost();
  await no(h.cancel('x'));
  assert.equal(await h.run('x'), null);
});

test('commands on an unknown run do not change other runs', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await refusedNoChange(h, ['r', 'x'], () => h.taskCompleted('x', 0));
  await refusedNoChange(h, ['r', 'x'], () => h.cancel('x'));
});

// ---------- taskStarted ----------
for (const t of [0, 1, 2]) {
  test(`taskStarted makes queued task ${t} running`, async () => {
    const h = await createHost();
    await started(h, 'r');
    await ok(h.taskStarted('r', t));
    const exp = ['queued', 'queued', 'queued'];
    exp[t] = 'running';
    await expectRun(h, 'r', 'running', exp);
  });
}

test('taskStarted on all three tasks gives a running run', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await running(h, 'r', t);
  await expectRun(h, 'r', 'running', ['running', 'running', 'running']);
});

test('taskStarted is refused for a running task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', 0));
});

test('taskStarted is refused for a completed task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', 0));
});

test('taskStarted is refused for an evicted task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 2);
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', 2));
});

test('taskStarted is refused for a task number outside 0..2', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', 3));
});

test('taskStarted is refused for a negative task number', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', -1));
});

// ---------- taskCompleted ----------
test('taskCompleted makes a running task completed', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 1);
  await ok(h.taskCompleted('r', 1));
  await expectRun(h, 'r', 'running', ['queued', 'completed', 'queued']);
});

test('taskCompleted is refused for a queued task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.taskCompleted('r', 0));
});

test('taskCompleted is refused for an evicted task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskCompleted('r', 0));
});

test('taskCompleted is refused for an already completed task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskCompleted('r', 0));
});

test('taskCompleted is refused for a task number outside 0..2', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await running(h, 'r', t);
  await refusedNoChange(h, ['r'], () => h.taskCompleted('r', 3));
});

test('a run is completed when all three tasks completed', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await completed(h, 'r', t);
  await expectRun(h, 'r', 'completed', ['completed', 'completed', 'completed']);
});

test('two completed and one queued task give a running run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await completed(h, 'r', 1);
  await expectRun(h, 'r', 'running', ['completed', 'completed', 'queued']);
});

test('two completed and one running task give a running run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await completed(h, 'r', 2);
  await running(h, 'r', 1);
  await expectRun(h, 'r', 'running', ['completed', 'running', 'completed']);
});

test('two completed and one evicted task give a running run, not completed', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await completed(h, 'r', 1);
  await evicted(h, 'r', 2);
  await expectRun(h, 'r', 'running', ['completed', 'completed', 'evicted']);
});

test('tasks may complete in any order', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await running(h, 'r', t);
  await ok(h.taskCompleted('r', 2));
  await ok(h.taskCompleted('r', 0));
  await expectRun(h, 'r', 'running', ['completed', 'running', 'completed']);
  await ok(h.taskCompleted('r', 1));
  await expectRun(h, 'r', 'completed', ['completed', 'completed', 'completed']);
});

// ---------- taskFailed ----------
test('taskFailed makes a running task failed and the run failed', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await ok(h.taskFailed('r', 0));
  await expectRun(h, 'r', 'failed', ['failed', 'queued', 'queued']);
});

test('a failed task makes the run failed even while other tasks run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await running(h, 'r', 1);
  await evicted(h, 'r', 2);
  await ok(h.taskFailed('r', 1));
  await expectRun(h, 'r', 'failed', ['running', 'failed', 'evicted']);
});

test('a failed task with two completed tasks gives a failed run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await completed(h, 'r', 1);
  await failed(h, 'r', 2);
  await expectRun(h, 'r', 'failed', ['completed', 'completed', 'failed']);
});

test('taskFailed is refused for a queued task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.taskFailed('r', 1));
});

test('taskFailed is refused for an evicted task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 1);
  await refusedNoChange(h, ['r'], () => h.taskFailed('r', 1));
});

test('taskFailed is refused for a completed task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 1);
  await refusedNoChange(h, ['r'], () => h.taskFailed('r', 1));
});

// ---------- a failed run refuses every command ----------
async function failedRun(h) {
  // task0 failed, task1 running, task2 evicted
  await started(h, 'r');
  await running(h, 'r', 1);
  await evicted(h, 'r', 2);
  await failed(h, 'r', 0);
  await expectRun(h, 'r', 'failed', ['failed', 'running', 'evicted']);
}

test('a failed run refuses taskCompleted for a running task', async () => {
  const h = await createHost();
  await failedRun(h);
  await refusedNoChange(h, ['r'], () => h.taskCompleted('r', 1));
});

test('a failed run refuses taskFailed for a running task', async () => {
  const h = await createHost();
  await failedRun(h);
  await refusedNoChange(h, ['r'], () => h.taskFailed('r', 1));
});

test('a failed run refuses taskEvicted for a running task', async () => {
  const h = await createHost();
  await failedRun(h);
  await refusedNoChange(h, ['r'], () => h.taskEvicted('r', 1));
});

test('a failed run refuses taskRequeued for an evicted task', async () => {
  const h = await createHost();
  await failedRun(h);
  await refusedNoChange(h, ['r'], () => h.taskRequeued('r', 2));
});

test('a failed run refuses taskStarted for a queued task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await failed(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', 1));
});

test('a failed run refuses cancel while tasks are in flight', async () => {
  const h = await createHost();
  await failedRun(h);
  await refusedNoChange(h, ['r'], () => h.cancel('r'));
});

test('a failed run does not stop other runs', async () => {
  const h = await createHost();
  await failedRun(h);
  await started(h, 's');
  await completed(h, 's', 0);
  await expectRun(h, 's', 'running', ['completed', 'queued', 'queued']);
});

// ---------- taskEvicted ----------
test('taskEvicted makes a running task evicted', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 2);
  await ok(h.taskEvicted('r', 2));
  await expectRun(h, 'r', 'running', ['queued', 'queued', 'evicted']);
});

test('taskEvicted is refused for a queued task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.taskEvicted('r', 0));
});

test('taskEvicted is refused for an evicted task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskEvicted('r', 0));
});

test('taskEvicted is refused for a completed task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskEvicted('r', 0));
});

test('a run whose three tasks are evicted is evicted', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await evicted(h, 'r', t);
  await expectRun(h, 'r', 'evicted', ['evicted', 'evicted', 'evicted']);
});

test('an evicted run still accepts commands', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await evicted(h, 'r', t);
  await ok(h.taskRequeued('r', 0));
  await expectRun(h, 'r', 'running', ['queued', 'evicted', 'evicted']);
});

// ---------- taskRequeued ----------
test('taskRequeued makes an evicted task queued', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await evicted(h, 'r', 1);
  await ok(h.taskRequeued('r', 1));
  await expectRun(h, 'r', 'running', ['completed', 'queued', 'queued']);
});

test('taskRequeued is refused for a queued task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await refusedNoChange(h, ['r'], () => h.taskRequeued('r', 0));
});

test('taskRequeued is refused for a running task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskRequeued('r', 0));
});

test('taskRequeued is refused for a completed task', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await refusedNoChange(h, ['r'], () => h.taskRequeued('r', 0));
});

test('a requeued task can be started again and completed', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 0);
  await ok(h.taskRequeued('r', 0));
  await ok(h.taskStarted('r', 0));
  await ok(h.taskCompleted('r', 0));
  await expectRun(h, 'r', 'running', ['completed', 'queued', 'queued']);
});

test('a run returns to queued when its only started task is evicted and requeued', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 1);
  await expectRun(h, 'r', 'running', ['queued', 'evicted', 'queued']);
  await ok(h.taskRequeued('r', 1));
  await expectRun(h, 'r', 'queued', ['queued', 'queued', 'queued']);
});

test('a run completes after evictions and requeues', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) {
    await evicted(h, 'r', t);
    await ok(h.taskRequeued('r', t));
    await completed(h, 'r', t);
  }
  await expectRun(h, 'r', 'completed', ['completed', 'completed', 'completed']);
});

// ---------- cancel ----------
test('cancel on a fresh run cancels every task and the run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await ok(h.cancel('r'));
  await expectRun(h, 'r', 'cancelled', ['cancelled', 'cancelled', 'cancelled']);
});

test('cancel cancels running, queued and evicted tasks', async () => {
  const h = await createHost();
  await started(h, 'r');
  await running(h, 'r', 0);
  await evicted(h, 'r', 2);
  await ok(h.cancel('r'));
  await expectRun(h, 'r', 'cancelled', ['cancelled', 'cancelled', 'cancelled']);
});

test('cancel leaves completed tasks completed and the run cancelled', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await completed(h, 'r', 1);
  await ok(h.cancel('r'));
  await expectRun(h, 'r', 'cancelled', ['completed', 'completed', 'cancelled']);
});

test('cancel with one completed task gives a cancelled run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 1);
  await running(h, 'r', 2);
  await ok(h.cancel('r'));
  await expectRun(h, 'r', 'cancelled', ['cancelled', 'completed', 'cancelled']);
});

test('cancel is refused on a completed run', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await completed(h, 'r', t);
  await refusedNoChange(h, ['r'], () => h.cancel('r'));
  await expectRun(h, 'r', 'completed', ['completed', 'completed', 'completed']);
});

test('cancel is refused on a cancelled run', async () => {
  const h = await createHost();
  await started(h, 'r');
  await ok(h.cancel('r'));
  await refusedNoChange(h, ['r'], () => h.cancel('r'));
});

test('a cancelled run refuses taskStarted', async () => {
  const h = await createHost();
  await started(h, 'r');
  await ok(h.cancel('r'));
  await refusedNoChange(h, ['r'], () => h.taskStarted('r', 0));
});

test('a cancelled run refuses taskRequeued', async () => {
  const h = await createHost();
  await started(h, 'r');
  await evicted(h, 'r', 0);
  await ok(h.cancel('r'));
  await refusedNoChange(h, ['r'], () => h.taskRequeued('r', 0));
});

test('a completed run refuses every task report', async () => {
  const h = await createHost();
  await started(h, 'r');
  for (const t of [0, 1, 2]) await completed(h, 'r', t);
  for (const t of [0, 1, 2]) {
    await refusedNoChange(h, ['r'], () => h.taskStarted('r', t));
    await refusedNoChange(h, ['r'], () => h.taskCompleted('r', t));
    await refusedNoChange(h, ['r'], () => h.taskFailed('r', t));
    await refusedNoChange(h, ['r'], () => h.taskEvicted('r', t));
    await refusedNoChange(h, ['r'], () => h.taskRequeued('r', t));
  }
});

test('cancel of one run does not change another', async () => {
  const h = await createHost();
  await started(h, 'a');
  await started(h, 'b');
  await running(h, 'b', 0);
  await ok(h.cancel('a'));
  await expectRun(h, 'b', 'running', ['running', 'queued', 'queued']);
});

// ---------- conclusion: the status never hides a task ----------
test('the run is never completed while an evicted task remains', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await evicted(h, 'r', 1);
  await completed(h, 'r', 2);
  const v = await h.run('r');
  assert.notEqual(v.status, 'completed');
  assert.notEqual(v.status, 'cancelled');
  assert.equal(v.status, 'running');
});

test('the run is not completed while a queued task remains', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 1);
  await completed(h, 'r', 2);
  const v = await h.run('r');
  assert.notEqual(v.status, 'completed');
});

test('the run is failed whenever a task failed, whatever the others are', async () => {
  const h = await createHost();
  await started(h, 'r');
  await completed(h, 'r', 0);
  await evicted(h, 'r', 1);
  await failed(h, 'r', 2);
  await expectRun(h, 'r', 'failed', ['completed', 'evicted', 'failed']);
});

// Seeded pseudo-random walks: after every command the brief's rules must hold.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const MOVES = {
  taskStarted: ['queued', 'running'],
  taskCompleted: ['running', 'completed'],
  taskFailed: ['running', 'failed'],
  taskEvicted: ['running', 'evicted'],
  taskRequeued: ['evicted', 'queued'],
};
const CMDS = ['taskStarted', 'taskStarted', 'taskCompleted', 'taskFailed', 'taskEvicted', 'taskEvicted', 'taskRequeued', 'taskRequeued', 'cancel'];

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`random walk ${seed}: every command follows the moves and the status follows the derivation`, async () => {
    const h = await createHost();
    const rnd = lcg(seed);
    for (let k = 0; k < 6; k++) {
      const id = `w${k}`;
      await started(h, id);
      for (let step = 0; step < 25; step++) {
        const before = await h.run(id);
        const ts = [before.task0, before.task1, before.task2];
        const cmd = CMDS[Math.floor(rnd() * CMDS.length)];
        const t = Math.floor(rnd() * 3);
        const terminal = TERMINAL.has(before.status);
        let expectOk;
        if (cmd === 'cancel') expectOk = !terminal && ts.some((s) => IN_FLIGHT.has(s));
        else expectOk = !terminal && ts[t] === MOVES[cmd][0];
        const r = cmd === 'cancel' ? await h.cancel(id) : await h[cmd](id, t);
        const ctx = `${cmd}(${t}) from ${JSON.stringify(before)}`;
        assert.equal(r.ok, expectOk, ctx);
        const after = await h.run(id);
        if (!expectOk) {
          assert.deepEqual(after, before, ctx);
          continue;
        }
        const exp = ts.slice();
        if (cmd === 'cancel') {
          for (let i = 0; i < 3; i++) if (IN_FLIGHT.has(exp[i])) exp[i] = 'cancelled';
        } else exp[t] = MOVES[cmd][1];
        assert.equal(after.task0, exp[0], ctx);
        assert.equal(after.task1, exp[1], ctx);
        assert.equal(after.task2, exp[2], ctx);
        assert.equal(after.status, derive(exp), ctx);
        if (after.status === 'completed') assert.ok(exp.every((s) => s === 'completed'), ctx);
        if (exp.includes('failed')) assert.equal(after.status, 'failed', ctx);
        if (exp.some((s) => IN_FLIGHT.has(s))) {
          assert.notEqual(after.status, 'completed', ctx);
          assert.notEqual(after.status, 'cancelled', ctx);
        }
      }
    }
  });
}
