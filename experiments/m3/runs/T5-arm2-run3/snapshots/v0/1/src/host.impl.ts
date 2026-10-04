import type { CreateHost, Host, Outcome, RunView, Status } from '../host.ts';

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
const CLOSED: ReadonlySet<Status> = new Set<Status>(['completed', 'failed', 'cancelled']);

type Tasks = [Status, Status, Status];

interface Run {
  status: Status;
  tasks: Tasks;
}

/** The run's status, derived from its three tasks (brief: "The run's status"). */
export function deriveStatus(tasks: Tasks): Status {
  if (tasks[0] === tasks[1] && tasks[1] === tasks[2]) return tasks[0];
  if (tasks.includes('failed')) return 'failed';
  if (tasks.some((t) => IN_FLIGHT.has(t))) return 'running';
  return 'cancelled';
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const runs = new Map<string, Run>();

  /** Looks up a run that may still take commands, or explains why not. */
  function open(id: string): Run | string {
    const r = runs.get(id);
    if (!r) return 'unknown run';
    if (CLOSED.has(r.status)) return `run is ${r.status}`;
    return r;
  }

  function move(id: string, task: number, from: Status, to: Status): Outcome {
    const r = open(id);
    if (typeof r === 'string') return refuse(r);
    if (!Number.isInteger(task) || task < 0 || task > 2) return refuse('no such task');
    if (r.tasks[task] !== from) return refuse(`task ${task} is ${r.tasks[task]}, not ${from}`);
    const tasks = [...r.tasks] as Tasks;
    tasks[task] = to;
    runs.set(id, { status: deriveStatus(tasks), tasks });
    return ok();
  }

  const host: Host = {
    async start(id) {
      if (runs.has(id)) return refuse('run already exists');
      runs.set(id, { status: 'queued', tasks: ['queued', 'queued', 'queued'] });
      return ok();
    },
    async taskStarted(id, task) { return move(id, task, 'queued', 'running'); },
    async taskCompleted(id, task) { return move(id, task, 'running', 'completed'); },
    async taskFailed(id, task) { return move(id, task, 'running', 'failed'); },
    async taskEvicted(id, task) { return move(id, task, 'running', 'evicted'); },
    async taskRequeued(id, task) { return move(id, task, 'evicted', 'queued'); },
    async cancel(id) {
      const r = open(id);
      if (typeof r === 'string') return refuse(r);
      if (!r.tasks.some((t) => IN_FLIGHT.has(t))) return refuse('no task in flight');
      const tasks = r.tasks.map((t) => (IN_FLIGHT.has(t) ? 'cancelled' : t)) as Tasks;
      runs.set(id, { status: deriveStatus(tasks), tasks });
      return ok();
    },
    async run(id): Promise<RunView | null> {
      const r = runs.get(id);
      if (!r) return null;
      return { status: r.status, task0: r.tasks[0], task1: r.tasks[1], task2: r.tasks[2] };
    },
  };
  return host;
};

export default createHost;
