// Pure transition core for one workflow run: no I/O, no ids, just the three
// tasks and the derived run status.

import type { Status } from '../host.ts';

export type Tasks = readonly [Status, Status, Status];

export interface RunState {
  status: Status;
  tasks: Tasks;
}

export type TaskEvent = 'started' | 'completed' | 'failed' | 'evicted' | 'requeued' | 'retried';

export type StepResult = { ok: true; state: RunState } | { ok: false; reason: string };

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
const FINAL_RUN: ReadonlySet<Status> = new Set<Status>(['completed', 'failed', 'cancelled']);

/** Each task report: the status it requires, and the status it moves to. */
const MOVES: Record<TaskEvent, { from: Status; to: Status }> = {
  started: { from: 'queued', to: 'running' },
  completed: { from: 'running', to: 'completed' },
  failed: { from: 'running', to: 'failed' },
  evicted: { from: 'running', to: 'evicted' },
  requeued: { from: 'evicted', to: 'queued' },
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
  return { status: 'queued', tasks: ['queued', 'queued', 'queued'] };
}

export function isClosed(state: RunState): boolean {
  return FINAL_RUN.has(state.status);
}

function settle(tasks: Tasks): RunState {
  return { status: deriveStatus(tasks), tasks };
}

export function applyTaskEvent(state: RunState, event: TaskEvent, task: number): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (!Number.isInteger(task) || task < 0 || task > 2) {
    return { ok: false, reason: `no task ${String(task)}` };
  }
  const move = MOVES[event];
  const current = state.tasks[task];
  if (current !== move.from) {
    return { ok: false, reason: `task ${task} is ${current}, not ${move.from}` };
  }
  const tasks = state.tasks.map((s, i) => (i === task ? move.to : s)) as unknown as Tasks;
  return { ok: true, state: settle(tasks) };
}

export function applyCancel(state: RunState): StepResult {
  if (isClosed(state)) return { ok: false, reason: `run is ${state.status}` };
  if (!state.tasks.some(isInFlight)) return { ok: false, reason: 'no task in flight' };
  const tasks = state.tasks.map((s) => (isInFlight(s) ? 'cancelled' : s)) as unknown as Tasks;
  return { ok: true, state: settle(tasks) };
}
