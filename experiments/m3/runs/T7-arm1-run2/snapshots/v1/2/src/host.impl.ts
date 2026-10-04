import type { CreateHost, Host, Message, Outcome, RunView, TaskStatus } from '../host.ts';

type WorkerId = 'worker0' | 'worker1';
const WORKERS: WorkerId[] = ['worker0', 'worker1'];
const RUN = 'run';

function taskOf(w: WorkerId): 0 | 1 {
  return w === 'worker0' ? 0 : 1;
}

function isWorker(id: string): id is WorkerId {
  return id === 'worker0' || id === 'worker1';
}

const createHost: CreateHost = async () => {
  let nextId = 1;
  const inFlight: Message[] = [];

  const run: { status: RunView['status']; tasks: [TaskStatus, TaskStatus]; retried: [boolean, boolean] } = {
    status: 'idle',
    tasks: ['idle', 'idle'],
    retried: [false, false],
  };
  const workers: Record<WorkerId, 'idle' | 'busy'> = { worker0: 'idle', worker1: 'idle' };

  function send(from: string, to: string, action: string, data: Record<string, unknown>): void {
    inFlight.push({ id: `m${nextId++}`, from, to, action, data });
  }

  const ok: Outcome = { ok: true };
  const refuse = (reason: string): Outcome => ({ ok: false, reason });

  // --- the run ---
  function runReceive(msg: Message): void {
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
    run.tasks[task] = outcome;
    const [a, b] = run.tasks;
    const bothReported = a !== 'assigned' && b !== 'assigned';
    if (a === 'completed' && b === 'completed') run.status = 'completed';
    else if (bothReported && (a === 'failed' || b === 'failed')) run.status = 'failed';
    else if (bothReported) run.status = 'cancelled';
  }

  // --- a worker ---
  function workerReceive(w: WorkerId, msg: Message): void {
    if (msg.action === 'Assign') {
      if (workers[w] === 'idle') workers[w] = 'busy';
    } else if (msg.action === 'Abort') {
      if (workers[w] === 'busy') {
        workers[w] = 'idle';
        send(w, RUN, 'Report', { task: taskOf(w), outcome: 'cancelled' });
      }
    }
  }

  function dispatch(msg: Message): void {
    if (msg.to === RUN) runReceive(msg);
    else if (isWorker(msg.to)) workerReceive(msg.to, msg);
  }

  function workerFinish(worker: string, outcome: 'completed' | 'failed'): Outcome {
    if (!isWorker(worker)) return refuse(`unknown worker ${worker}`);
    if (workers[worker] !== 'busy') return refuse(`${worker} is not busy`);
    workers[worker] = 'idle';
    send(worker, RUN, 'Report', { task: taskOf(worker), outcome });
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
      dispatch(msg);
    },
    async deliverAll() {
      while (inFlight.length > 0) {
        const msg = inFlight.shift()!;
        dispatch(msg);
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
      for (const w of WORKERS) {
        if (run.tasks[taskOf(w)] === 'assigned') send(RUN, w, 'Abort', {});
      }
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
