// A run and its two workers, talking only by messages through a network that
// delivers nothing until asked.
import type { CreateHost, Host, Message, Outcome, RunView, TaskStatus } from '../host.ts';

type Send = (from: string, to: string, action: string, data: Record<string, unknown>) => void;
type WorkerStatus = 'idle' | 'busy';
type Report = 'completed' | 'failed' | 'cancelled';

const RUN_ID = 'run';
const WORKERS = ['worker0', 'worker1'];

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

class Run {
  status: RunView['status'] = 'idle';
  tasks: TaskStatus[] = ['idle', 'idle'];
  retried: boolean[] = [false, false];
  processed = 0;
  private send: Send;

  constructor(send: Send) {
    this.send = send;
  }

  start(): Outcome {
    if (this.status !== 'idle') return refuse('the run has already started');
    this.status = 'running';
    this.tasks = ['assigned', 'assigned'];
    WORKERS.forEach((w) => this.send(RUN_ID, w, 'Assign', {}));
    return ok();
  }

  cancel(): Outcome {
    if (this.status !== 'running') return refuse(`the run is ${this.status}, not running`);
    this.status = 'cancelling';
    this.tasks.forEach((t, i) => {
      if (t === 'assigned') this.send(RUN_ID, WORKERS[i], 'Abort', {});
    });
    return ok();
  }

  receive(action: string, data: Record<string, unknown>): void {
    if (action !== 'Report') return;
    if (this.status !== 'running' && this.status !== 'cancelling') return;
    const task = data.task;
    const outcome = data.outcome;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    const items = data.items;
    if (typeof items !== 'number') return;
    if (this.tasks[task] !== 'assigned') return;
    if (outcome === 'failed' && this.status === 'running' && !this.retried[task]) {
      this.retried = this.retried.map((r, i) => r || i === task);
      this.send(RUN_ID, WORKERS[task], 'Assign', {});
      return;
    }
    this.record(task, outcome);
    if (outcome === 'completed') this.processed += items;
  }

  timeout(task: number): Outcome {
    if (task !== 0 && task !== 1) return refuse(`no task ${task}`);
    if (this.status !== 'running' && this.status !== 'cancelling') {
      return refuse(`the run is ${this.status}, not running or cancelling`);
    }
    if (this.tasks[task] !== 'assigned') return refuse(`task ${task} is ${this.tasks[task]}, not assigned`);
    this.record(task, 'failed');
    this.send(RUN_ID, WORKERS[task], 'Abort', {});
    return ok();
  }

  // Record a task's final outcome and recompute the run's status.
  private record(task: number, outcome: Report): void {
    this.tasks = this.tasks.map((t, i) => (i === task ? outcome : t));
    const [a, b] = this.tasks;
    const bothReported = a !== 'assigned' && b !== 'assigned';
    if (a === 'completed' && b === 'completed') this.status = 'completed';
    else if (bothReported && (a === 'failed' || b === 'failed')) this.status = 'failed';
    else if (bothReported) this.status = 'cancelled';
  }

  view(): RunView {
    return {
      status: this.status,
      task0: this.tasks[0],
      task1: this.tasks[1],
      retried0: this.retried[0],
      retried1: this.retried[1],
      processed: this.processed,
    };
  }
}

class Worker {
  status: WorkerStatus = 'idle';
  private id: string;
  private task: number;
  private send: Send;

  constructor(id: string, task: number, send: Send) {
    this.id = id;
    this.task = task;
    this.send = send;
  }

  finish(outcome: Report, items = 0): Outcome {
    if (this.status !== 'busy') return refuse(`${this.id} is not busy`);
    this.report(outcome, items);
    return ok();
  }

  receive(action: string): void {
    if (action === 'Assign' && this.status === 'idle') this.status = 'busy';
    else if (action === 'Abort' && this.status === 'busy') this.report('cancelled', 0);
  }

  private report(outcome: Report, items: number): void {
    this.status = 'idle';
    this.send(this.id, RUN_ID, 'Report', { task: this.task, outcome, items });
  }
}

const createHost: CreateHost = async () => {
  const inFlight = new Map<string, Message>();
  let seq = 0;
  const send: Send = (from, to, action, data) => {
    const id = `m${++seq}`;
    inFlight.set(id, { id, from, to, action, data });
  };

  const run = new Run(send);
  const workers = new Map<string, Worker>(WORKERS.map((w, i) => [w, new Worker(w, i, send)]));

  const deliverOne = (id: string): void => {
    const msg = inFlight.get(id);
    if (!msg) return;
    inFlight.delete(id);
    if (msg.to === RUN_ID) run.receive(msg.action, msg.data);
    else workers.get(msg.to)?.receive(msg.action);
  };

  const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map(copy);
    },
    async deliver(id) {
      deliverOne(id);
    },
    async deliverAll() {
      while (inFlight.size > 0) deliverOne(inFlight.keys().next().value as string);
    },
    async start() {
      return run.start();
    },
    async workDone(worker) {
      const w = workers.get(worker);
      return w ? w.finish('completed') : refuse(`no worker ${worker}`);
    },
    async workFailed(worker) {
      const w = workers.get(worker);
      return w ? w.finish('failed') : refuse(`no worker ${worker}`);
    },
    async cancel() {
      return run.cancel();
    },
    async taskTimeout(task) {
      return run.timeout(task);
    },
    async run() {
      return run.view();
    },
    async worker(worker) {
      const w = workers.get(worker);
      return w ? { status: w.status } : null;
    },
  };
  return host;
};

export default createHost;
