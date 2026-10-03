// T7: a run and its workers, talking by messages over an explicit network.

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

export interface RunView {
  status: RunStatus;
  task0: TaskStatus;
  task1: TaskStatus;
}

export interface Host {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
  start(): Promise<Outcome>;
  workDone(worker: string): Promise<Outcome>;
  workFailed(worker: string): Promise<Outcome>;
  cancel(): Promise<Outcome>;
  run(): Promise<RunView>;
  worker(worker: string): Promise<{ status: 'idle' | 'busy' } | null>;
}

const RUN = 'run';
const WORKERS = ['worker0', 'worker1'];
const TERMINAL: RunStatus[] = ['completed', 'failed', 'cancelled'];

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  let seq = 0;
  const queue: Message[] = [];
  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    queue.push({ id: `m${++seq}`, from, to, action, data });
  };

  const runState: { status: RunStatus; tasks: TaskStatus[] } = { status: 'idle', tasks: ['idle', 'idle'] };
  const workers = new Map<string, { status: 'idle' | 'busy' }>(WORKERS.map((w) => [w, { status: 'idle' }]));

  const report = (worker: string, outcome: 'completed' | 'failed' | 'cancelled'): void => {
    send(worker, RUN, 'Report', { task: WORKERS.indexOf(worker), outcome });
  };

  const onRun = (msg: Message): void => {
    if (msg.action !== 'Report') return;
    if (runState.status === 'idle' || TERMINAL.includes(runState.status)) return;
    const task = msg.data.task;
    const outcome = msg.data.outcome;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    if (runState.tasks[task] !== 'assigned') return;
    runState.tasks[task] = outcome;
    const t = runState.tasks;
    const allReported = t.every((s) => s !== 'assigned');
    if (t.every((s) => s === 'completed')) runState.status = 'completed';
    else if (allReported && t.includes('failed')) runState.status = 'failed';
    else if (allReported) runState.status = 'cancelled';
  };

  const onWorker = (id: string, msg: Message): void => {
    const w = workers.get(id)!;
    if (msg.action === 'Assign') {
      if (w.status === 'idle') w.status = 'busy';
    } else if (msg.action === 'Abort') {
      if (w.status === 'busy') {
        w.status = 'idle';
        report(id, 'cancelled');
      }
    }
  };

  const dispatch = (msg: Message): void => {
    if (msg.to === RUN) onRun(msg);
    else if (workers.has(msg.to)) onWorker(msg.to, msg);
  };

  const finish = (worker: string, outcome: 'completed' | 'failed'): Outcome => {
    const w = workers.get(worker);
    if (!w) return refuse(`unknown worker ${worker}`);
    if (w.status !== 'busy') return refuse(`worker ${worker} is not busy`);
    w.status = 'idle';
    report(worker, outcome);
    return ok();
  };

  return {
    async inFlight() {
      return queue.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      const i = queue.findIndex((m) => m.id === id);
      if (i < 0) return;
      const [msg] = queue.splice(i, 1);
      dispatch(msg);
    },
    async deliverAll() {
      while (queue.length > 0) dispatch(queue.shift()!);
    },
    async start() {
      if (runState.status !== 'idle') return refuse('run already started');
      runState.status = 'running';
      runState.tasks = ['assigned', 'assigned'];
      for (const w of WORKERS) send(RUN, w, 'Assign', {});
      return ok();
    },
    async workDone(worker: string) {
      return finish(worker, 'completed');
    },
    async workFailed(worker: string) {
      return finish(worker, 'failed');
    },
    async cancel() {
      if (runState.status !== 'running') return refuse(`run is ${runState.status}, not running`);
      runState.status = 'cancelling';
      runState.tasks.forEach((s, i) => {
        if (s === 'assigned') send(RUN, WORKERS[i], 'Abort', {});
      });
      return ok();
    },
    async run() {
      return { status: runState.status, task0: runState.tasks[0], task1: runState.tasks[1] };
    },
    async worker(worker: string) {
      const w = workers.get(worker);
      return w ? { status: w.status } : null;
    },
  };
}
