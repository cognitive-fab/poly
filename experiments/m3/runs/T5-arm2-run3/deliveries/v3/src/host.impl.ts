import type { CreateHost, Host, Outcome, RunView, Status } from '../host.ts';

const IN_FLIGHT: ReadonlySet<Status> = new Set<Status>(['queued', 'running', 'evicted']);
/** Run statuses that refuse every command (a failed run can still retry). */
const CLOSED: ReadonlySet<Status> = new Set<Status>(['completed', 'cancelled']);

type Tasks = [Status, Status, Status];

interface Run {
  status: Status;
  tasks: Tasks;
  paused: boolean;
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

  function setTasks(id: string, r: Run, tasks: Tasks): Outcome {
    runs.set(id, { ...r, status: deriveStatus(tasks), tasks });
    return ok();
  }

  /** Moves one task from a status in `from` to `to`, then derives the run's status. */
  function move(id: string, task: number, from: Status | ReadonlySet<Status>, to: Status): Outcome {
    const r = open(id);
    if (typeof r === 'string') return refuse(r);
    if (!Number.isInteger(task) || task < 0 || task > 2) return refuse('no such task');
    const allowed = typeof from === 'string' ? r.tasks[task] === from : from.has(r.tasks[task]);
    if (!allowed) return refuse(`task ${task} is ${r.tasks[task]}`);
    const tasks = [...r.tasks] as Tasks;
    tasks[task] = to;
    return setTasks(id, r, tasks);
  }

  function setPaused(id: string, paused: boolean): Outcome {
    const r = open(id);
    if (typeof r === 'string') return refuse(r);
    if (r.paused === paused) return refuse(paused ? 'run is already paused' : 'run is not paused');
    runs.set(id, { ...r, paused });
    return ok();
  }

  const host: Host = {
    async start(id) {
      if (runs.has(id)) return refuse('run already exists');
      runs.set(id, { status: 'queued', tasks: ['queued', 'queued', 'queued'], paused: false });
      return ok();
    },
    async taskStarted(id, task) {
      if (runs.get(id)?.paused) return refuse('run is paused');
      return move(id, task, 'queued', 'running');
    },
    async taskCompleted(id, task) { return move(id, task, 'running', 'completed'); },
    async taskFailed(id, task) { return move(id, task, 'running', 'failed'); },
    async taskEvicted(id, task) { return move(id, task, 'running', 'evicted'); },
    async taskRequeued(id, task) { return move(id, task, 'evicted', 'queued'); },
    async taskRetried(id, task) { return move(id, task, 'failed', 'queued'); },
    async cancelTask(id, task) { return move(id, task, IN_FLIGHT, 'cancelled'); },
    async cancel(id) {
      const r = open(id);
      if (typeof r === 'string') return refuse(r);
      if (!r.tasks.some((t) => IN_FLIGHT.has(t))) return refuse('no task in flight');
      return setTasks(id, r, r.tasks.map((t) => (IN_FLIGHT.has(t) ? 'cancelled' : t)) as Tasks);
    },
    async pause(id) { return setPaused(id, true); },
    async resume(id) { return setPaused(id, false); },
    async run(id): Promise<RunView | null> {
      const r = runs.get(id);
      if (!r) return null;
      return { status: r.status, task0: r.tasks[0], task1: r.tasks[1], task2: r.tasks[2], paused: r.paused };
    },
  };
  return host;
};

export default createHost;
