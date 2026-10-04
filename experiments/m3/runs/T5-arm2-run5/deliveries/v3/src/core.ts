// Pure transition core for one workflow run: no I/O, no ids, just the three
// tasks and the derived run status.

import type { Status } from '../host.ts';

export type Tasks = readonly [Status, Status, Status];

export interface RunState {
  status: Status;
  tasks: Tasks;
  /** While paused, no queued task starts; the status is unaffected. */
  paused: boolean;
}

export type TaskEvent = 'started' | 'completed' | 'failed' | 'evicted' | 'requeued' | 'retried';

export type StepResult = { ok: true; state: RunState } | { ok: false; reason: string };

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
/** Run statuses that refuse every command; a failed run can still retry. */
const CLOSED_RUN: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

/** Each task report: the status it requires, and the status it moves to. */
const MOVES: Record<TaskEvent, { from: Status; to: Status }> = {
  started: { from: 'queued', to: 'running' },
  completed: { from: 'running', to: 'completed' },
  failed: { from: 'running', to: 'failed' },
  evicted: { from: 'running', to: 'evicted' },
  requeued: { from: 'evicted', to: 'queued' },
  retried: { from: 'failed', to: 'queued' },
};

export function isInFlight(s: Status): boolean {
  return IN_FLIGHT.has(s);
}

export function deriveStatus(tasks: Tasks): Status {
  const [a, b, c] = tasks;
  if (a === b && b === c) return a;
  if (tasks.includes('failed')) return 'failed';
  if (tasks.some(isInFlight)) return 'running';
  return 'cancelled';
}

export function initialRun(): RunState {
  return { status: 'queued', tasks: ['queued', 'queued', 'queued'], paused: false };
}

export function isClosed(state: RunState): boolean {
  return CLOSED_RUN.has(state.status);
}

function settle(state: RunState, tasks: Tasks): RunState {
  return { ...state, status: deriveStatus(tasks), tasks };
}

export function applyTaskEvent(state: RunState, event: TaskEvent, task: number): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (!Number.isInteger(task) || task < 0 || task > 2) {
    return { ok: false, reason: `no task ${String(task)}` };
  }
  if (event === 'started' && state.paused) return { ok: false, reason: 'run is paused' };
  const move = MOVES[event];
  const current = state.tasks[task];
  if (current !== move.from) {
    return { ok: false, reason: `task ${task} is ${current}, not ${move.from}` };
  }
  const tasks = state.tasks.map((s, i) => (i === task ? move.to : s)) as unknown as Tasks;
  return { ok: true, state: settle(state, tasks) };
}

export function applyCancelTask(state: RunState, task: number): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (!Number.isInteger(task) || task < 0 || task > 2) {
    return { ok: false, reason: `no task ${String(task)}` };
  }
  const current = state.tasks[task];
  if (!isInFlight(current)) return { ok: false, reason: `task ${task} is ${current}` };
  const tasks = state.tasks.map((s, i) => (i === task ? 'cancelled' : s)) as unknown as Tasks;
  return { ok: true, state: settle(state, tasks) };
}

export function applyCancel(state: RunState): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (!state.tasks.some(isInFlight)) return { ok: false, reason: 'no task in flight' };
  const tasks = state.tasks.map((s) => (isInFlight(s) ? 'cancelled' : s)) as unknown as Tasks;
  return { ok: true, state: settle(state, tasks) };
}

export function applyPause(state: RunState): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (state.paused) return { ok: false, reason: 'run is already paused' };
  return { ok: true, state: { ...state, paused: true } };
}

export function applyResume(state: RunState): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (!state.paused) return { ok: false, reason: 'run is not paused' };
  return { ok: true, state: { ...state, paused: false } };
}
