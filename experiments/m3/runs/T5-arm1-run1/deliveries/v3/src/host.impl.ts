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

interface Run {
  status: Status;
  tasks: Status[];
  paused: boolean;
}

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
const FINAL_RUN: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

function derive(tasks: Status[]): Status {
  if (tasks.every((t) => t === tasks[0])) return tasks[0];
  if (tasks.includes('failed')) return 'failed';
  if (tasks.some((t) => IN_FLIGHT.has(t))) return 'running';
  return 'cancelled';
}

export default async function createHost(): Promise<Host> {
  const runs = new Map<string, Run>();

  function open(id: string): Run | Outcome {
    const r = runs.get(id);
    if (!r) return refuse(`run ${id} does not exist`);
    if (FINAL_RUN.has(r.status)) return refuse(`run ${id} is ${r.status}`);
    return r;
  }

  function move(id: string, task: number, from: Status | ReadonlySet<Status>, to: Status): Outcome {
    const r = open(id);
    if ('ok' in r) return r;
    if (task !== 0 && task !== 1 && task !== 2) return refuse(`no task ${String(task)}`);
    const allowed = typeof from === 'string' ? r.tasks[task] === from : from.has(r.tasks[task]);
    if (!allowed) return refuse(`task ${task} is ${r.tasks[task]}, cannot become ${to}`);
    r.tasks[task] = to;
    r.status = derive(r.tasks);
    return OK;
  }

  return {
    async start(id) {
      if (runs.has(id)) return refuse(`run ${id} already exists`);
      runs.set(id, { status: 'queued', tasks: ['queued', 'queued', 'queued'], paused: false });
      return OK;
    },
    async taskStarted(id, task) {
      const r = open(id);
      if ('ok' in r) return r;
      if (r.paused) return refuse(`run ${id} is paused`);
      return move(id, task, 'queued', 'running');
    },
    async pause(id) {
      const r = open(id);
      if ('ok' in r) return r;
      if (r.paused) return refuse(`run ${id} is already paused`);
      r.paused = true;
      return OK;
    },
    async resume(id) {
      const r = open(id);
      if ('ok' in r) return r;
      if (!r.paused) return refuse(`run ${id} is not paused`);
      r.paused = false;
      return OK;
    },
    async taskCompleted(id, task) {
      return move(id, task, 'running', 'completed');
    },
    async taskFailed(id, task) {
      return move(id, task, 'running', 'failed');
    },
    async taskEvicted(id, task) {
      return move(id, task, 'running', 'evicted');
    },
    async taskRequeued(id, task) {
      return move(id, task, 'evicted', 'queued');
    },
    async taskRetried(id, task) {
      return move(id, task, 'failed', 'queued');
    },
    async cancelTask(id, task) {
      return move(id, task, IN_FLIGHT, 'cancelled');
    },
    async cancel(id) {
      const r = open(id);
      if ('ok' in r) return r;
      if (!r.tasks.some((t) => IN_FLIGHT.has(t))) return refuse('no task in flight');
      r.tasks = r.tasks.map((t) => (IN_FLIGHT.has(t) ? 'cancelled' : t));
      r.status = derive(r.tasks);
      return OK;
    },
    async run(id) {
      const r = runs.get(id);
      if (!r) return null;
      return { status: r.status, task0: r.tasks[0], task1: r.tasks[1], task2: r.tasks[2], paused: r.paused };
    },
  };
}
