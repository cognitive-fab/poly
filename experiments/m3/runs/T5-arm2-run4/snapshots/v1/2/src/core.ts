// The stateful core: a pure transition function over one run's three tasks.

export type Status = 'queued' | 'running' | 'evicted' | 'completed' | 'failed' | 'cancelled';

export interface RunState {
  status: Status;
  tasks: [Status, Status, Status];
}

export type TaskMove = 'taskStarted' | 'taskCompleted' | 'taskFailed' | 'taskEvicted' | 'taskRequeued' | 'taskRetried';

export type Step = { ok: true; state: RunState } | { ok: false; reason: string };

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
// A failed run is not final: a failed task can be retried.
const FINAL_RUN: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

/** The allowed moves of a single task: [from, to]. */
export const MOVES: Readonly<Record<TaskMove, readonly [Status, Status]>> = {
  taskStarted: ['queued', 'running'],
  taskCompleted: ['running', 'completed'],
  taskFailed: ['running', 'failed'],
  taskEvicted: ['running', 'evicted'],
  taskRequeued: ['evicted', 'queued'],
};

export function isInFlight(s: Status): boolean {
  return IN_FLIGHT.has(s);
}

export function isFinalRun(s: Status): boolean {
  return FINAL_RUN.has(s);
}

export function deriveStatus(tasks: readonly Status[]): Status {
  if (tasks.every((t) => t === tasks[0])) return tasks[0];
  if (tasks.some((t) => t === 'failed')) return 'failed';
  if (tasks.some(isInFlight)) return 'running';
  return 'cancelled';
}

export function initialRun(): RunState {
  return { status: 'queued', tasks: ['queued', 'queued', 'queued'] };
}

function settle(tasks: [Status, Status, Status]): RunState {
  return { status: deriveStatus(tasks), tasks };
}

export function applyTaskMove(state: RunState, move: TaskMove, task: unknown): Step {
  if (isFinalRun(state.status)) return { ok: false, reason: `run is ${state.status}` };
  if (task !== 0 && task !== 1 && task !== 2) return { ok: false, reason: 'no such task' };
  const [from, to] = MOVES[move];
  const current = state.tasks[task];
  if (current !== from) return { ok: false, reason: `task ${task} is ${current}, not ${from}` };
  const tasks: [Status, Status, Status] = [state.tasks[0], state.tasks[1], state.tasks[2]];
  tasks[task] = to;
  return { ok: true, state: settle(tasks) };
}

export function applyCancel(state: RunState): Step {
  if (isFinalRun(state.status)) return { ok: false, reason: `run is ${state.status}` };
  if (!state.tasks.some(isInFlight)) return { ok: false, reason: 'no task in flight' };
  const cancel = (t: Status): Status => (isInFlight(t) ? 'cancelled' : t);
  const tasks: [Status, Status, Status] = [cancel(state.tasks[0]), cancel(state.tasks[1]), cancel(state.tasks[2])];
  return { ok: true, state: settle(tasks) };
}
