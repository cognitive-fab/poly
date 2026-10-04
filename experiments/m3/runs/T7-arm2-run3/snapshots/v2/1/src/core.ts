// The stateful core: the run actor and the worker actors, as pure handlers over
// plain state. Each handler returns the messages it sends; the host queues them.

export type TaskStatus = 'idle' | 'assigned' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type WorkerStatus = 'idle' | 'busy';
export type ReportOutcome = 'completed' | 'failed' | 'cancelled';

export interface RunState {
  status: RunStatus;
  tasks: [TaskStatus, TaskStatus];
  retried: [boolean, boolean];
}

export interface WorkerState {
  status: WorkerStatus;
}

export interface Outgoing {
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export const RUN_ID = 'run';
export const WORKER_IDS = ['worker0', 'worker1'] as const;

export function taskOf(worker: string): 0 | 1 | null {
  if (worker === 'worker0') return 0;
  if (worker === 'worker1') return 1;
  return null;
}

export function initialRun(): RunState {
  return { status: 'idle', tasks: ['idle', 'idle'], retried: [false, false] };
}

export function initialWorker(): WorkerState {
  return { status: 'idle' };
}

type Result = { ok: true; send: Outgoing[] } | { ok: false; reason: string };

// ---- run commands -------------------------------------------------------

export function runStart(run: RunState): Result {
  if (run.status !== 'idle') return { ok: false, reason: 'run already started' };
  run.status = 'running';
  run.tasks = ['assigned', 'assigned'];
  return {
    ok: true,
    send: WORKER_IDS.map((w) => ({ from: RUN_ID, to: w, action: 'Assign', data: {} })),
  };
}

export function runCancel(run: RunState): Result {
  if (run.status !== 'running') return { ok: false, reason: 'run is not running' };
  run.status = 'cancelling';
  const send: Outgoing[] = [];
  run.tasks.forEach((t, i) => {
    if (t === 'assigned') send.push({ from: RUN_ID, to: WORKER_IDS[i], action: 'Abort', data: {} });
  });
  return { ok: true, send };
}

// ---- run message handling -----------------------------------------------

export function runOnReport(run: RunState, task: unknown, outcome: unknown): Outgoing[] {
  if (run.status !== 'running' && run.status !== 'cancelling') return []; // idle or terminal: ignore
  if (task !== 0 && task !== 1) return [];
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return [];
  if (run.tasks[task] !== 'assigned') return []; // a task's final report is recorded once
  if (outcome === 'failed' && run.status === 'running' && !run.retried[task]) {
    // first failure while running: retry once; the task stays assigned
    const retried: [boolean, boolean] = [run.retried[0], run.retried[1]];
    retried[task] = true;
    run.retried = retried;
    return [{ from: RUN_ID, to: WORKER_IDS[task], action: 'Assign', data: {} }];
  }
  record(run, task, outcome);
  return [];
}

export function runTaskTimeout(run: RunState, task: unknown): Result {
  if (task !== 0 && task !== 1) return { ok: false, reason: 'no such task' };
  if (run.status !== 'running' && run.status !== 'cancelling') return { ok: false, reason: 'run is not running or cancelling' };
  if (run.tasks[task] !== 'assigned') return { ok: false, reason: 'task is not assigned' };
  // a final failure: recorded without retry
  record(run, task, 'failed');
  return { ok: true, send: [{ from: RUN_ID, to: WORKER_IDS[task], action: 'Abort', data: {} }] };
}

// Record a task's final outcome and recompute the run's status.
function record(run: RunState, task: 0 | 1, outcome: ReportOutcome): void {
  const tasks: [TaskStatus, TaskStatus] = [run.tasks[0], run.tasks[1]];
  tasks[task] = outcome;
  run.tasks = tasks;
  const bothReported = tasks.every((t) => t === 'completed' || t === 'failed' || t === 'cancelled');
  if (tasks[0] === 'completed' && tasks[1] === 'completed') run.status = 'completed';
  else if (bothReported && tasks.includes('failed')) run.status = 'failed';
  else if (bothReported) run.status = 'cancelled';
  // otherwise unchanged
  return [];
}

// ---- worker commands ----------------------------------------------------

function report(worker: string, outcome: ReportOutcome): Outgoing {
  return { from: worker, to: RUN_ID, action: 'Report', data: { task: taskOf(worker), outcome } };
}

export function workerFinish(id: string, w: WorkerState, outcome: 'completed' | 'failed'): Result {
  if (w.status !== 'busy') return { ok: false, reason: 'worker is not busy' };
  w.status = 'idle';
  return { ok: true, send: [report(id, outcome)] };
}

// ---- worker message handling --------------------------------------------

export function workerOnAssign(w: WorkerState): Outgoing[] {
  if (w.status === 'idle') w.status = 'busy';
  return [];
}

export function workerOnAbort(id: string, w: WorkerState): Outgoing[] {
  if (w.status !== 'busy') return []; // ignored
  w.status = 'idle';
  return [report(id, 'cancelled')];
}
