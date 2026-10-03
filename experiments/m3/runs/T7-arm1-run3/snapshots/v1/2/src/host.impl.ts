import type { CreateHost, Host, Message, Outcome, RunView, TaskStatus } from '../host.ts';

const RUN = 'run';
const WORKERS = ['worker0', 'worker1'] as const;
type WorkerId = (typeof WORKERS)[number];
type Outcome3 = 'completed' | 'failed' | 'cancelled';

function isWorker(id: string): id is WorkerId {
  return (WORKERS as readonly string[]).includes(id);
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  // Network
  const inFlight = new Map<string, Message>();
  let nextId = 1;
  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  };

  // Run state
  const run: { status: RunView['status']; tasks: [TaskStatus, TaskStatus]; retried: [boolean, boolean] } = {
    status: 'idle',
    tasks: ['idle', 'idle'],
    retried: [false, false],
  };

  // Worker state
  const workers: Record<WorkerId, 'idle' | 'busy'> = { worker0: 'idle', worker1: 'idle' };
  const taskOf = (w: WorkerId): 0 | 1 => (w === 'worker0' ? 0 : 1);

  const runReceive = (msg: Message): void => {
    if (msg.action !== 'Report') return;
    if (run.status !== 'running' && run.status !== 'cancelling') return;
    const task = msg.data.task;
    const outcome = msg.data.outcome;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    if (run.tasks[task] !== 'assigned') return;
    if (outcome === 'failed' && run.status === 'running' && !run.retried[task]) {
      run.retried[task] = true;
      send(RUN, WORKERS[task], 'Assign', {});
      return;
    }
    run.tasks[task] = outcome as Outcome3;
    const [a, b] = run.tasks;
    const bothReported = a !== 'assigned' && b !== 'assigned';
    if (a === 'completed' && b === 'completed') run.status = 'completed';
    else if (bothReported && (a === 'failed' || b === 'failed')) run.status = 'failed';
    else if (bothReported) run.status = 'cancelled';
  };

  const workerReceive = (w: WorkerId, msg: Message): void => {
    if (msg.action === 'Assign') {
      if (workers[w] === 'idle') workers[w] = 'busy';
    } else if (msg.action === 'Abort') {
      if (workers[w] === 'busy') {
        workers[w] = 'idle';
        send(w, RUN, 'Report', { task: taskOf(w), outcome: 'cancelled' });
      }
    }
  };

  const deliverOne = (id: string): void => {
    const msg = inFlight.get(id);
    if (!msg) return;
    inFlight.delete(id);
    if (msg.to === RUN) runReceive(msg);
    else if (isWorker(msg.to)) workerReceive(msg.to, msg);
  };

  const workerFinish = (worker: string, outcome: Outcome3): Outcome => {
    if (!isWorker(worker)) return refuse(`unknown worker ${worker}`);
    if (workers[worker] !== 'busy') return refuse(`${worker} is not busy`);
    workers[worker] = 'idle';
    send(worker, RUN, 'Report', { task: taskOf(worker), outcome });
    return ok;
  };

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      deliverOne(id);
    },
    async deliverAll() {
      while (inFlight.size > 0) {
        const id = inFlight.keys().next().value as string;
        deliverOne(id);
      }
    },
    async start() {
      if (run.status !== 'idle') return refuse('run has already started');
      run.status = 'running';
      run.tasks = ['assigned', 'assigned'];
      for (const w of WORKERS) send(RUN, w, 'Assign', {});
      return ok;
    },
    async workDone(worker: string) {
      return workerFinish(worker, 'completed');
    },
    async workFailed(worker: string) {
      return workerFinish(worker, 'failed');
    },
    async cancel() {
      if (run.status !== 'running') return refuse(`run is ${run.status}, not running`);
      run.status = 'cancelling';
      run.tasks.forEach((t, i) => {
        if (t === 'assigned') send(RUN, WORKERS[i], 'Abort', {});
      });
      return ok;
    },
    async run() {
      return { status: run.status, task0: run.tasks[0], task1: run.tasks[1] };
    },
    async worker(worker: string) {
      if (!isWorker(worker)) return null;
      return { status: workers[worker] };
    },
  };
  return host;
};

export default createHost;
