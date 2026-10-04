import type { CreateHost, Host, Message, Outcome, RunView, TaskStatus } from './types.ts';

const RUN = 'run';
const WORKERS = ['worker0', 'worker1'] as const;
type WorkerId = (typeof WORKERS)[number];
type Outcome3 = 'completed' | 'failed' | 'cancelled';

function isWorker(id: string): id is WorkerId {
  return (WORKERS as readonly string[]).includes(id);
}

const ok: Outcome = { ok: true };
function refuse(reason: string): Outcome {
  return { ok: false, reason };
}

const createHost: CreateHost = async () => {
  // The network.
  const inFlight: Message[] = [];
  let nextId = 1;
  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    inFlight.push({ id: `m${nextId++}`, from, to, action, data });
  }

  // The run's state.
  const run: {
    status: RunView['status'];
    tasks: [TaskStatus, TaskStatus];
    retried: [boolean, boolean];
    processed: number;
  } = {
    status: 'idle',
    tasks: ['idle', 'idle'],
    retried: [false, false],
    processed: 0,
  };

  // The workers' state.
  const workers: Record<WorkerId, 'idle' | 'busy'> = { worker0: 'idle', worker1: 'idle' };

  function taskOf(w: WorkerId): 0 | 1 {
    return w === 'worker0' ? 0 : 1;
  }

  function runReceive(msg: Message): void {
    if (msg.action !== 'Report') return;
    if (run.status !== 'running' && run.status !== 'cancelling') return;
    const task = msg.data.task;
    const outcome = msg.data.outcome as Outcome3;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    if (run.tasks[task] !== 'assigned') return;
    if (outcome === 'failed' && run.status === 'running' && !run.retried[task]) {
      run.retried[task] = true;
      send(RUN, WORKERS[task], 'Assign', {});
      return;
    }
    if (outcome === 'completed') {
      const items = msg.data.items;
      if (typeof items === 'number') run.processed += items;
    }
    record(task, outcome);
  }

  /** Records a task's final outcome and recomputes the run's status. */
  function record(task: 0 | 1, outcome: Outcome3): void {
    run.tasks[task] = outcome;
    const [a, b] = run.tasks;
    const bothReported = a !== 'assigned' && b !== 'assigned';
    if (a === 'completed' && b === 'completed') run.status = 'completed';
    else if (bothReported && (a === 'failed' || b === 'failed')) run.status = 'failed';
    else if (bothReported) run.status = 'cancelled';
  }

  function workerReceive(w: WorkerId, msg: Message): void {
    if (msg.action === 'Assign') {
      if (workers[w] === 'idle') workers[w] = 'busy';
    } else if (msg.action === 'Abort') {
      if (workers[w] === 'busy') {
        workers[w] = 'idle';
        send(w, RUN, 'Report', { task: taskOf(w), outcome: 'cancelled', items: 0 });
      }
    }
  }

  function receive(msg: Message): void {
    if (msg.to === RUN) runReceive(msg);
    else if (isWorker(msg.to)) workerReceive(msg.to, msg);
  }

  function finish(worker: string, outcome: Outcome3, items: number): Outcome {
    if (!isWorker(worker)) return refuse(`unknown worker ${worker}`);
    if (workers[worker] !== 'busy') return refuse(`${worker} is not busy`);
    workers[worker] = 'idle';
    send(worker, RUN, 'Report', { task: taskOf(worker), outcome, items });
    return ok;
  }

  const host: Host = {
    async inFlight() {
      return inFlight.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      const i = inFlight.findIndex((m) => m.id === id);
      if (i < 0) return;
      const [msg] = inFlight.splice(i, 1);
      receive(msg);
    },
    async deliverAll() {
      while (inFlight.length > 0) receive(inFlight.shift()!);
    },
    async start() {
      if (run.status !== 'idle') return refuse('the run has already started');
      run.status = 'running';
      run.tasks = ['assigned', 'assigned'];
      for (const w of WORKERS) send(RUN, w, 'Assign', {});
      return ok;
    },
    async workDone(worker: string, items: number) {
      if (items !== 1 && items !== 2) return refuse(`items must be 1 or 2, not ${items}`);
      return finish(worker, 'completed', items);
    },
    async workFailed(worker: string) {
      return finish(worker, 'failed', 0);
    },
    async cancel() {
      if (run.status !== 'running') return refuse(`the run is ${run.status}, not running`);
      run.status = 'cancelling';
      WORKERS.forEach((w, i) => {
        if (run.tasks[i] === 'assigned') send(RUN, w, 'Abort', {});
      });
      return ok;
    },
    async taskTimeout(task: number) {
      if (task !== 0 && task !== 1) return refuse(`unknown task ${task}`);
      if (run.status !== 'running' && run.status !== 'cancelling') {
        return refuse(`the run is ${run.status}, not running or cancelling`);
      }
      if (run.tasks[task] !== 'assigned') return refuse(`task ${task} is ${run.tasks[task]}, not assigned`);
      record(task, 'failed');
      send(RUN, WORKERS[task], 'Abort', {});
      return ok;
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
      if (!isWorker(worker)) return null;
      return { status: workers[worker] };
    },
  };
  return host;
};

export default createHost;
