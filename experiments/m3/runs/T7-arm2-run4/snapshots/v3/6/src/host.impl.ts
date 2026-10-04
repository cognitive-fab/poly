// A run and its two workers, talking by messages over a network that delivers
// nothing until asked to.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export type TaskStatus = 'idle' | 'assigned' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type ReportOutcome = 'completed' | 'failed' | 'cancelled';

export interface RunView {
  status: RunStatus;
  task0: TaskStatus;
  task1: TaskStatus;
  retried0: boolean;
  retried1: boolean;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  start(): Promise<Outcome>;
  workDone(worker: string): Promise<Outcome>;
  workFailed(worker: string): Promise<Outcome>;
  cancel(): Promise<Outcome>;
  taskTimeout(task: number): Promise<Outcome>;
  run(): Promise<RunView>;
  worker(worker: string): Promise<{ status: 'idle' | 'busy' } | null>;
}

const RUN_ID = 'run';
const WORKERS = ['worker0', 'worker1'] as const;

type Send = (to: string, action: string, data: Record<string, unknown>) => void;

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const isTerminal = (s: RunStatus): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';

class Run {
  status: RunStatus = 'idle';
  tasks: TaskStatus[] = ['idle', 'idle'];
  retried: boolean[] = [false, false];
  processed = 0;

  start(send: Send): Outcome {
    if (this.status !== 'idle') return refuse('run already started');
    this.status = 'running';
    this.tasks = ['assigned', 'assigned'];
    WORKERS.forEach((w) => send(w, 'Assign', {}));
    return ok;
  }

  cancel(send: Send): Outcome {
    if (this.status !== 'running') return refuse(`run is ${this.status}, not running`);
    this.status = 'cancelling';
    this.tasks.forEach((t, i) => {
      if (t === 'assigned') send(WORKERS[i], 'Abort', {});
    });
    return ok;
  }

  receive(action: string, data: Record<string, unknown>, send: Send): void {
    if (action !== 'Report') return;
    // A finished run ignores further reports (and an unstarted run has none to take).
    if (this.status === 'idle' || isTerminal(this.status)) return;
    const task = data.task;
    const outcome = data.outcome;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    // Once a task's status is recorded, later reports for it are ignored.
    if (this.tasks[task] !== 'assigned') return;
    // A first failure while running is retried once: the task stays assigned.
    if (outcome === 'failed' && this.status === 'running' && !this.retried[task]) {
      this.retried[task] = true;
      send(WORKERS[task], 'Assign', {});
      return;
    }
    this.record(task, outcome);
    // Only a recorded completion counts its items.
    if (outcome === 'completed' && typeof data.items === 'number') this.processed += data.items;
  }

  timeout(task: number, send: Send): Outcome {
    if (task !== 0 && task !== 1) return refuse(`unknown task ${task}`);
    if (this.status !== 'running' && this.status !== 'cancelling') return refuse(`run is ${this.status}`);
    if (this.tasks[task] !== 'assigned') return refuse(`task ${task} is ${this.tasks[task]}, not assigned`);
    // A final failure: recorded without retry, and the worker is told to stop.
    this.record(task, 'failed');
    send(WORKERS[task], 'Abort', {});
    return ok;
  }

  private record(task: number, outcome: ReportOutcome): void {
    this.tasks[task] = outcome;
    const [t0, t1] = this.tasks;
    const reported = t0 !== 'assigned' && t1 !== 'assigned';
    if (t0 === 'completed' && t1 === 'completed') this.status = 'completed';
    else if (reported && (t0 === 'failed' || t1 === 'failed')) this.status = 'failed';
    else if (reported) this.status = 'cancelled';
  }
}

class Worker {
  status: 'idle' | 'busy' = 'idle';
  readonly task: number;
  constructor(task: number) {
    this.task = task;
  }

  finish(outcome: 'completed' | 'failed', items: number, send: Send): Outcome {
    if (this.status !== 'busy') return refuse('worker is not busy');
    this.status = 'idle';
    send(RUN_ID, 'Report', { task: this.task, outcome, items });
    return ok;
  }

  receive(action: string, send: Send): void {
    if (action === 'Assign') {
      if (this.status === 'idle') this.status = 'busy';
    } else if (action === 'Abort') {
      if (this.status !== 'busy') return;
      this.status = 'idle';
      send(RUN_ID, 'Report', { task: this.task, outcome: 'cancelled', items: 0 });
    }
  }
}

export default async function createHost(): Promise<Host> {
  const run = new Run();
  const workers = new Map<string, Worker>(WORKERS.map((w, i) => [w, new Worker(i)]));
  const network = new Map<string, Message>();
  let seq = 0;

  const sender = (from: string): Send => (to, action, data) => {
    const id = `m${++seq}`;
    network.set(id, { id, from, to, action, data: { ...data } });
  };

  const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

  const deliverOne = (id: string): void => {
    const m = network.get(id);
    if (!m) return;
    network.delete(id);
    if (m.to === RUN_ID) {
      run.receive(m.action, m.data, sender(RUN_ID));
    } else {
      const w = workers.get(m.to);
      if (w) w.receive(m.action, sender(m.to));
    }
  };

  const finish = (id: string, outcome: 'completed' | 'failed', items: number): Outcome => {
    const w = workers.get(id);
    if (!w) return refuse(`unknown worker ${id}`);
    return w.finish(outcome, items, sender(id));
  };

  return {
    async inFlight() {
      return [...network.values()].map(copy);
    },
    async deliver(id: string) {
      deliverOne(id);
    },
    async deliverAll() {
      while (network.size > 0) {
        const [id] = network.keys();
        deliverOne(id);
      }
    },
    async start() {
      return run.start(sender(RUN_ID));
    },
    async workDone(worker: string, items: number) {
      if (items !== 1 && items !== 2) return refuse(`items must be 1 or 2, not ${items}`);
      return finish(worker, 'completed', items);
    },
    async workFailed(worker: string) {
      return finish(worker, 'failed', 0);
    },
    async cancel() {
      return run.cancel(sender(RUN_ID));
    },
    async taskTimeout(task: number) {
      return run.timeout(task, sender(RUN_ID));
    },
    async run() {
      return {
        status: run.status,
        task0: run.tasks[0],
        task1: run.tasks[1],
        retried0: run.retried[0],
        retried1: run.retried[1],
      };
    },
    async worker(worker: string) {
      const w = workers.get(worker);
      return w ? { status: w.status } : null;
    },
  };
}
