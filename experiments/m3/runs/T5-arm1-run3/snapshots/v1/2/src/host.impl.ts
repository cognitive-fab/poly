import type { CreateHost, Host, Outcome, RunView, Status } from '../host.ts';

type Tasks = [Status, Status, Status];

interface Run {
  status: Status;
  tasks: Tasks;
}

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
// Run statuses after which every command is refused; a failed run can still retry.
const CLOSED: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

function derive(tasks: Tasks): Status {
  if (tasks[0] === tasks[1] && tasks[1] === tasks[2]) return tasks[0];
  if (tasks.includes('failed')) return 'failed';
  if (tasks.some((t) => IN_FLIGHT.has(t))) return 'running';
  return 'cancelled';
}

const createHost: CreateHost = async () => {
  const runs = new Map<string, Run>();

  // Returns the live run, or a refusal.
  function open(id: string): Run | Outcome {
    const r = runs.get(id);
    if (!r) return refuse(`run ${id} does not exist`);
    if (CLOSED.has(r.status)) return refuse(`run ${id} is ${r.status}`);
    return r;
  }

  function move(id: string, task: number, from: Status, to: Status): Outcome {
    const r = open(id);
    if ('ok' in r) return r;
    if (!Number.isInteger(task) || task < 0 || task > 2) return refuse(`no task ${task}`);
    const current = r.tasks[task];
    if (current !== from) return refuse(`task ${task} is ${current}, not ${from}`);
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
    async taskStarted(id, task) {
      return move(id, task, 'queued', 'running');
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
    async cancel(id) {
      const r = open(id);
      if ('ok' in r) return r;
      if (!r.tasks.some((t) => IN_FLIGHT.has(t))) return refuse('no task in flight');
      r.tasks = r.tasks.map((t) => (IN_FLIGHT.has(t) ? 'cancelled' : t)) as Tasks;
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
