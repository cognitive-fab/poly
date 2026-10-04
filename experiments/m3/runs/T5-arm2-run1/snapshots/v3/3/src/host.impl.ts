// Workflow run status: an in-memory host for runs of three tasks.

export type Outcome = { ok: true } | { ok: false; reason: string };

export type Status = 'queued' | 'running' | 'evicted' | 'completed' | 'failed' | 'cancelled';

export interface RunView {
  status: Status;
  task0: Status;
  task1: Status;
  task2: Status;
  paused: boolean;
}

export interface Host {
  start(run: string): Promise<Outcome>;
  taskStarted(run: string, task: number): Promise<Outcome>;
  taskCompleted(run: string, task: number): Promise<Outcome>;
  taskFailed(run: string, task: number): Promise<Outcome>;
  taskEvicted(run: string, task: number): Promise<Outcome>;
  taskRequeued(run: string, task: number): Promise<Outcome>;
  taskRetried(run: string, task: number): Promise<Outcome>;
  cancel(run: string): Promise<Outcome>;
  cancelTask(run: string, task: number): Promise<Outcome>;
  pause(run: string): Promise<Outcome>;
  resume(run: string): Promise<Outcome>;
  run(run: string): Promise<RunView | null>;
}

export type CreateHost = () => Promise<Host>;

type Tasks = [Status, Status, Status];

export interface RunState {
  status: Status;
  tasks: Tasks;
  paused: boolean;
}

export type TaskReport = 'taskStarted' | 'taskCompleted' | 'taskFailed' | 'taskEvicted' | 'taskRequeued' | 'taskRetried';

/** Each task report: the status it moves from, and the status it moves to. */
export const MOVES: Record<TaskReport, { from: Status; to: Status }> = {
  taskStarted: { from: 'queued', to: 'running' },
  taskCompleted: { from: 'running', to: 'completed' },
  taskFailed: { from: 'running', to: 'failed' },
  taskEvicted: { from: 'running', to: 'evicted' },
  taskRequeued: { from: 'evicted', to: 'queued' },
  taskRetried: { from: 'failed', to: 'queued' },
};

export function inFlight(s: Status): boolean {
  return s === 'queued' || s === 'running' || s === 'evicted';
}

export function isFinal(s: Status): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

/** A run with this status refuses every command; a failed run can still be retried. */
export function isClosed(s: Status): boolean {
  return s === 'completed' || s === 'cancelled';
}

/** The run's status, derived from its three tasks. */
export function deriveStatus(tasks: readonly Status[]): Status {
  if (tasks[0] === tasks[1] && tasks[1] === tasks[2]) return tasks[0];
  if (tasks.some((t) => t === 'failed')) return 'failed';
  if (tasks.some(inFlight)) return 'running';
  return 'cancelled';
}

type Step = { ok: true; state: RunState } | { ok: false; reason: string };

function settle(tasks: Tasks): Step {
  return { ok: true, state: { status: deriveStatus(tasks), tasks } };
}

/** The pure transition of one run. `state` is undefined for a run never started. */
export function stepStart(state: RunState | undefined): Step {
  if (state) return { ok: false, reason: 'run already exists' };
  return { ok: true, state: { status: 'queued', tasks: ['queued', 'queued', 'queued'] } };
}

export function stepTask(state: RunState | undefined, report: TaskReport, task: unknown): Step {
  if (!state) return { ok: false, reason: 'unknown run' };
  if (isClosed(state.status)) return { ok: false, reason: `run is ${state.status}` };
  if (task !== 0 && task !== 1 && task !== 2) return { ok: false, reason: 'no such task' };
  const move = MOVES[report];
  if (state.tasks[task] !== move.from) {
    return { ok: false, reason: `task ${task} is ${state.tasks[task]}, not ${move.from}` };
  }
  const tasks = [...state.tasks] as Tasks;
  tasks[task] = move.to;
  return settle(tasks);
}

export function stepCancel(state: RunState | undefined): Step {
  if (!state) return { ok: false, reason: 'unknown run' };
  if (isClosed(state.status)) return { ok: false, reason: `run is ${state.status}` };
  if (!state.tasks.some(inFlight)) return { ok: false, reason: 'no task in flight' };
  return settle(state.tasks.map((t) => (inFlight(t) ? 'cancelled' : t)) as Tasks);
}

export function stepCancelTask(state: RunState | undefined, task: unknown): Step {
  if (!state) return { ok: false, reason: 'unknown run' };
  if (isClosed(state.status)) return { ok: false, reason: `run is ${state.status}` };
  if (task !== 0 && task !== 1 && task !== 2) return { ok: false, reason: 'no such task' };
  if (!inFlight(state.tasks[task])) return { ok: false, reason: `task ${task} is ${state.tasks[task]}` };
  const tasks = [...state.tasks] as Tasks;
  tasks[task] = 'cancelled';
  return settle(tasks);
}

const createHost: CreateHost = async () => {
  const runs = new Map<string, RunState>();

  const apply = (run: string, step: Step): Outcome => {
    if (!step.ok) return { ok: false, reason: step.reason };
    runs.set(run, step.state);
    return { ok: true };
  };
  const report = (r: TaskReport) => async (run: string, task: number): Promise<Outcome> =>
    apply(run, stepTask(runs.get(run), r, task));

  return {
    start: async (run) => apply(run, stepStart(runs.get(run))),
    taskStarted: report('taskStarted'),
    taskCompleted: report('taskCompleted'),
    taskFailed: report('taskFailed'),
    taskEvicted: report('taskEvicted'),
    taskRequeued: report('taskRequeued'),
    taskRetried: report('taskRetried'),
    cancel: async (run) => apply(run, stepCancel(runs.get(run))),
    cancelTask: async (run, task) => apply(run, stepCancelTask(runs.get(run), task)),
    run: async (run) => {
      const s = runs.get(run);
      if (!s) return null;
      return { status: s.status, task0: s.tasks[0], task1: s.tasks[1], task2: s.tasks[2] };
    },
  };
};

export default createHost;
