import type { CreateHost, Host, Outcome, RunView, Status } from '../host.ts';

type Tasks = [Status, Status, Status];

interface RunState {
  status: Status;
  tasks: Tasks;
  paused: boolean;
}

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
const FINAL_RUN: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

function derive(tasks: Tasks): Status {
  const [a, b, c] = tasks;
  if (a === b && b === c) return a;
  if (tasks.includes('failed')) return 'failed';
  if (tasks.some((t) => IN_FLIGHT.has(t))) return 'running';
  return 'cancelled';
}

const createHost: CreateHost = async () => {
  const runs = new Map<string, RunState>();

  function open(run: string): RunState | string {
    const state = typeof run === 'string' ? runs.get(run) : undefined;
    if (!state) return `no run with id ${String(run)}`;
    if (FINAL_RUN.has(state.status)) return `run ${run} is ${state.status}`;
    return state;
  }

  function move(run: string, task: number, from: Status | ReadonlySet<Status>, to: Status): Outcome {
    const state = open(run);
    if (typeof state === 'string') return refuse(state);
    if (task !== 0 && task !== 1 && task !== 2) return refuse(`no task ${String(task)}`);
    const current = state.tasks[task];
    const allowed = typeof from === 'string' ? current === from : from.has(current);
    if (!allowed) {
      return refuse(`task ${task} is ${current}, not ${typeof from === 'string' ? from : 'in flight'}`);
    }
    state.tasks[task] = to;
    state.status = derive(state.tasks);
    return ok;
  }

  const host: Host = {
    async start(run) {
      if (typeof run !== 'string') return refuse('run id must be a string');
      if (runs.has(run)) return refuse(`run ${run} already exists`);
      runs.set(run, { status: 'queued', tasks: ['queued', 'queued', 'queued'], paused: false });
      return ok;
    },
    async taskStarted(run, task) {
      const state = open(run);
      if (typeof state !== 'string' && state.paused) return refuse(`run ${run} is paused`);
      return move(run, task, 'queued', 'running');
    },
    async taskCompleted(run, task) {
      return move(run, task, 'running', 'completed');
    },
    async taskFailed(run, task) {
      return move(run, task, 'running', 'failed');
    },
    async taskEvicted(run, task) {
      return move(run, task, 'running', 'evicted');
    },
    async taskRequeued(run, task) {
      return move(run, task, 'evicted', 'queued');
    },
    async taskRetried(run, task) {
      return move(run, task, 'failed', 'queued');
    },
    async cancelTask(run, task) {
      return move(run, task, IN_FLIGHT, 'cancelled');
    },
    async cancel(run) {
      const state = open(run);
      if (typeof state === 'string') return refuse(state);
      if (!state.tasks.some((t) => IN_FLIGHT.has(t))) return refuse('no task in flight');
      state.tasks = state.tasks.map((t) => (IN_FLIGHT.has(t) ? 'cancelled' : t)) as Tasks;
      state.status = derive(state.tasks);
      return ok;
    },
    async run(run) {
      const state = typeof run === 'string' ? runs.get(run) : undefined;
      if (!state) return null;
      const view: RunView = {
        status: state.status,
        task0: state.tasks[0],
        task1: state.tasks[1],
        task2: state.tasks[2],
        paused: state.paused,
      };
      return view;
    },
  };
  return host;
};

export default createHost;
