import type { Status } from '../host.ts';

export type Tasks = [Status, Status, Status];

export interface RunState {
  status: Status;
  tasks: Tasks;
}

export type TaskEvent = 'taskStarted' | 'taskCompleted' | 'taskFailed' | 'taskEvicted' | 'taskRequeued' | 'taskRetried';

export type StepResult = { ok: true; state: RunState } | { ok: false; reason: string };

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
/** Run statuses that refuse every command (a failed run can still be retried). */
const CLOSED_RUN: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

/** The legal moves of a task report: from which status, to which status. */
const MOVES: Record<TaskEvent, { from: Status; to: Status }> = {
  taskStarted: { from: 'queued', to: 'running' },
  taskCompleted: { from: 'running', to: 'completed' },
  taskFailed: { from: 'running', to: 'failed' },
  taskEvicted: { from: 'running', to: 'evicted' },
  taskRequeued: { from: 'evicted', to: 'queued' },
  taskRetried: { from: 'failed', to: 'queued' },
};

export function isInFlight(s: Status): boolean {
  return IN_FLIGHT.has(s);
}

/** The run's status, derived from its tasks in the brief's order. */
export function deriveStatus(tasks: readonly Status[]): Status {
  if (tasks.every((t) => t === tasks[0])) return tasks[0];
  if (tasks.some((t) => t === 'failed')) return 'failed';
  if (tasks.some(isInFlight)) return 'running';
  return 'cancelled';
}

export function initialRun(): RunState {
  return { status: 'queued', tasks: ['queued', 'queued', 'queued'] };
}

function closedReason(run: RunState): string | null {
  return CLOSED_RUN.has(run.status) ? `run is ${run.status}` : null;
}

function settle(tasks: Tasks): RunState {
  return { status: deriveStatus(tasks), tasks };
}

export function applyTaskEvent(run: RunState, event: TaskEvent, task: unknown): StepResult {
  const closed = closedReason(run);
  if (closed) return { ok: false, reason: closed };
  if (task !== 0 && task !== 1 && task !== 2) return { ok: false, reason: 'no such task' };
  const move = MOVES[event];
  const current = run.tasks[task];
  if (current !== move.from) {
    return { ok: false, reason: `task ${task} is ${current}, not ${move.from}` };
  }
  const tasks: Tasks = [...run.tasks];
  tasks[task] = move.to;
  return { ok: true, state: settle(tasks) };
}

export function applyCancelTask(run: RunState, task: unknown): StepResult {
  const closed = closedReason(run);
  if (closed) return { ok: false, reason: closed };
  if (task !== 0 && task !== 1 && task !== 2) return { ok: false, reason: 'no such task' };
  const current = run.tasks[task];
  if (!isInFlight(current)) return { ok: false, reason: `task ${task} is ${current}, not in flight` };
  const tasks: Tasks = [...run.tasks];
  tasks[task] = 'cancelled';
  return { ok: true, state: settle(tasks) };
}

export function applyCancel(run: RunState): StepResult {
  const closed = closedReason(run);
  if (closed) return { ok: false, reason: closed };
  if (!run.tasks.some(isInFlight)) return { ok: false, reason: 'no task in flight' };
  const tasks = run.tasks.map((t) => (isInFlight(t) ? 'cancelled' : t)) as Tasks;
  return { ok: true, state: settle(tasks) };
}
