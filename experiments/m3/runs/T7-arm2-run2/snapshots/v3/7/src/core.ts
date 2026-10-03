// The stateful core: the run and its workers as pure step functions.
// Each step takes a state and returns the next state plus the messages it sends.
// spec/run.spec.cjs is the polygraph model of exactly these rules.

import type { RunView, TaskStatus } from '../host.ts';

export type RunStatus = RunView['status'];
export type Outcome = 'completed' | 'failed' | 'cancelled';
export type WorkerStatus = 'idle' | 'busy';

export interface Outgoing {
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export interface RunState {
  status: RunStatus;
  tasks: [TaskStatus, TaskStatus];
  /** Whether each task has had its one retry. */
  retried: [boolean, boolean];
  /** Items processed, summed over the completed reports the run recorded. */
  processed: number;
}

export interface WorkerState {
  status: WorkerStatus;
}

export const RUN_ID = 'run';
export const WORKER_IDS = ['worker0', 'worker1'] as const;

export type Step<S> = { ok: true; state: S; send: Outgoing[] } | { ok: false; reason: string };

export function initialRun(): RunState {
  return { status: 'idle', tasks: ['idle', 'idle'], retried: [false, false], processed: 0 };
}

export function initialWorker(): WorkerState {
  return { status: 'idle' };
}

export function taskOf(worker: string): number {
  return WORKER_IDS.indexOf(worker as (typeof WORKER_IDS)[number]);
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ── the run ──────────────────────────────────────────────────────────────────

export function runStart(s: RunState): Step<RunState> {
  if (s.status !== 'idle') return { ok: false, reason: 'run already started' };
  return {
    ok: true,
    state: { status: 'running', tasks: ['assigned', 'assigned'], retried: [false, false], processed: s.processed },
    send: WORKER_IDS.map((to) => ({ to, action: 'Assign', data: {} })),
  };
}

export function runCancel(s: RunState): Step<RunState> {
  if (s.status !== 'running') return { ok: false, reason: `run is ${s.status}, not running` };
  const send: Outgoing[] = [];
  s.tasks.forEach((t, i) => {
    if (t === 'assigned') send.push({ to: WORKER_IDS[i], action: 'Abort', data: {} });
  });
  return { ok: true, state: { ...s, status: 'cancelling', tasks: [...s.tasks], retried: [...s.retried] }, send };
}

/** A Report arriving at the run. Ignored (state unchanged, nothing sent) where the brief says so. */
export function runReport(s: RunState, task: number, outcome: Outcome, items: number): { state: RunState; send: Outgoing[] } {
  const ignore = { state: s, send: [] };
  if (s.status !== 'running' && s.status !== 'cancelling') return ignore;
  if (task !== 0 && task !== 1) return ignore;
  // A task reports once per assignment; a report for a task not assigned is not a fresh outcome.
  if (s.tasks[task] !== 'assigned') return ignore;
  // A first failure while running: assign the task again; it stays assigned.
  if (outcome === 'failed' && s.status === 'running' && !s.retried[task]) {
    const retried: [boolean, boolean] = [...s.retried];
    retried[task] = true;
    return {
      state: { ...s, tasks: [...s.tasks], retried },
      send: [{ to: WORKER_IDS[task], action: 'Assign', data: {} }],
    };
  }
  return { state: record(s, task, outcome, outcome === 'completed' ? items : 0), send: [] };
}

/** Record a task's final outcome, add its items, and recompute the run's status. */
function record(s: RunState, task: number, outcome: Outcome, items: number): RunState {
  const tasks: [TaskStatus, TaskStatus] = [...s.tasks];
  tasks[task] = outcome;
  const reported = tasks.every((t) => t !== 'assigned');
  let status: RunStatus = s.status;
  if (tasks.every((t) => t === 'completed')) status = 'completed';
  else if (reported && tasks.includes('failed')) status = 'failed';
  else if (reported) status = 'cancelled';
  return { status, tasks, retried: [...s.retried], processed: s.processed + items };
}

/** The run gives up on an assigned task: a final failure (no retry), and Abort to its worker. */
export function runTimeout(s: RunState, task: number): Step<RunState> {
  if (task !== 0 && task !== 1) return { ok: false, reason: `no task ${task}` };
  if (s.status !== 'running' && s.status !== 'cancelling') return { ok: false, reason: `run is ${s.status}` };
  if (s.tasks[task] !== 'assigned') return { ok: false, reason: `task ${task} is ${s.tasks[task]}, not assigned` };
  return {
    ok: true,
    state: record(s, task, 'failed'),
    send: [{ to: WORKER_IDS[task], action: 'Abort', data: {} }],
  };
}

// ── a worker ─────────────────────────────────────────────────────────────────

function finish(s: WorkerState, worker: string, outcome: Outcome): Step<WorkerState> {
  if (s.status !== 'busy') return { ok: false, reason: `${worker} is not busy` };
  return {
    ok: true,
    state: { status: 'idle' },
    send: [{ to: RUN_ID, action: 'Report', data: { task: taskOf(worker), outcome } }],
  };
}

export function workerDone(s: WorkerState, worker: string): Step<WorkerState> {
  return finish(s, worker, 'completed');
}

export function workerFailed(s: WorkerState, worker: string): Step<WorkerState> {
  return finish(s, worker, 'failed');
}

/** Assign or Abort arriving at a worker. */
export function workerReceive(s: WorkerState, worker: string, action: string): { state: WorkerState; send: Outgoing[] } {
  if (action === 'Assign' && s.status === 'idle') return { state: { status: 'busy' }, send: [] };
  if (action === 'Abort' && s.status === 'busy') {
    return {
      state: { status: 'idle' },
      send: [{ to: RUN_ID, action: 'Report', data: { task: taskOf(worker), outcome: 'cancelled' } }],
    };
  }
  return { state: s, send: [] };
}
