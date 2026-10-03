import type { CreateHost, Host, Outcome, RunView, Status } from '../host.ts';

type Run = { status: Status; tasks: Status[] };

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
const TERMINAL: ReadonlySet<Status> = new Set<Status>(['completed', 'failed', 'cancelled']);

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

function derive(tasks: Status[]): Status {
  if (tasks.every((t) => t === tasks[0])) return tasks[0];
  if (tasks.includes('failed')) return 'failed';
  if (tasks.some((t) => IN_FLIGHT.has(t))) return 'running';
  return 'cancelled';
}

const createHost: CreateHost = async () => {
  const runs = new Map<string, Run>();

  function open(id: string): Run | string {
    const r = runs.get(id);
    if (!r) return `run ${id} does not exist`;
    if (TERMINAL.has(r.status)) return `run ${id} is ${r.status}`;
    return r;
  }

  function move(id: string, task: number, from: Status, to: Status): Outcome {
    const r = open(id);
    if (typeof r === 'string') return refuse(r);
    if (!Number.isInteger(task) || task < 0 || task > 2) return refuse(`no task ${task}`);
    if (r.tasks[task] !== from) return refuse(`task ${task} is ${r.tasks[task]}, not ${from}`);
    r.tasks[task] = to;
    r.status = derive(r.tasks);
    return ok;
  }

  const host: Host = {
    async start(id) {
      if (runs.has(id)) return refuse(`run ${id} already exists`);
      runs.set(id, { status: 'queued', tasks: ['queued', 'queued', 'queued'] });
      return ok;
    },
    async taskStarted(id, t) { return move(id, t, 'queued', 'running'); },
    async taskCompleted(id, t) { return move(id, t, 'running', 'completed'); },
    async taskFailed(id, t) { return move(id, t, 'running', 'failed'); },
    async taskEvicted(id, t) { return move(id, t, 'running', 'evicted'); },
    async taskRequeued(id, t) { return move(id, t, 'evicted', 'queued'); },
    async cancel(id) {
      const r = open(id);
      if (typeof r === 'string') return refuse(r);
      if (!r.tasks.some((t) => IN_FLIGHT.has(t))) return refuse(`no task of run ${id} is in flight`);
      r.tasks = r.tasks.map((t) => (IN_FLIGHT.has(t) ? 'cancelled' : t));
      r.status = derive(r.tasks);
      return ok;
    },
    async run(id) {
      const r = runs.get(id);
      if (!r) return null;
      const view: RunView = { status: r.status, task0: r.tasks[0], task1: r.tasks[1], task2: r.tasks[2] };
      return view;
    },
  };
  return host;
};

export default createHost;
