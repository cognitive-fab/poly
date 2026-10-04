import type { Host, Message, Outcome, RunView, TaskStatus } from '../host.ts';

type WorkerStatus = 'idle' | 'busy';
const WORKERS = ['worker0', 'worker1'];
const RUN = 'run';

export default async function createHost(): Promise<Host> {
  let nextId = 1;
  const inFlight = new Map<string, Message>();
  const send = (from: string, to: string, action: string, data: Record<string, unknown>): void => {
    const id = `m${nextId++}`;
    inFlight.set(id, { id, from, to, action, data });
  };

  const run: RunView = { status: 'idle', task0: 'idle', task1: 'idle', retried0: false, retried1: false, processed: 0 };
  const workers: Record<string, WorkerStatus> = { worker0: 'idle', worker1: 'idle' };

  const taskKey = (t: number): 'task0' | 'task1' => (t === 0 ? 'task0' : 'task1');

  const runReceive = (msg: Message): void => {
    if (msg.action !== 'Report') return;
    if (run.status !== 'running' && run.status !== 'cancelling') return;
    const task = msg.data.task;
    const outcome = msg.data.outcome as TaskStatus;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    const key = taskKey(task);
    if (run[key] !== 'assigned') return;
    const retriedKey = task === 0 ? 'retried0' : 'retried1';
    if (outcome === 'failed' && run.status === 'running' && !run[retriedKey]) {
      run[retriedKey] = true;
      send(RUN, WORKERS[task], 'Assign', {});
      return;
    }
    if (outcome === 'completed') {
      const items = msg.data.items;
      if (typeof items === 'number') run.processed += items;
    }
    record(key, outcome);
  };

  const record = (key: 'task0' | 'task1', outcome: TaskStatus): void => {
    run[key] = outcome;
    const tasks = [run.task0, run.task1];
    const allReported = tasks.every((s) => s === 'completed' || s === 'failed' || s === 'cancelled');
    if (tasks.every((s) => s === 'completed')) run.status = 'completed';
    else if (allReported && tasks.includes('failed')) run.status = 'failed';
    else if (allReported) run.status = 'cancelled';
  };

  const workerReceive = (w: string, msg: Message): void => {
    if (msg.action === 'Assign') {
      if (workers[w] === 'idle') workers[w] = 'busy';
    } else if (msg.action === 'Abort') {
      if (workers[w] === 'busy') {
        workers[w] = 'idle';
        send(w, RUN, 'Report', { task: WORKERS.indexOf(w), outcome: 'cancelled', items: 0 });
      }
    }
  };

  const deliver = async (id: string): Promise<void> => {
    const msg = inFlight.get(id);
    if (!msg) return;
    inFlight.delete(id);
    if (msg.to === RUN) runReceive(msg);
    else if (WORKERS.includes(msg.to)) workerReceive(msg.to, msg);
  };

  const finish = (w: string, outcome: 'completed' | 'failed'): Outcome => {
    if (!WORKERS.includes(w)) return { ok: false, reason: `unknown worker ${w}` };
    if (workers[w] !== 'busy') return { ok: false, reason: `${w} is not busy` };
    workers[w] = 'idle';
    send(w, RUN, 'Report', { task: WORKERS.indexOf(w), outcome });
    return { ok: true };
  };

  return {
    async inFlight() {
      return [...inFlight.values()].map((m) => ({ ...m, data: { ...m.data } }));
    },
    deliver,
    async deliverAll() {
      while (inFlight.size > 0) {
        const [id] = inFlight.keys();
        await deliver(id);
      }
    },
    async start() {
      if (run.status !== 'idle') return { ok: false, reason: 'run already started' };
      run.status = 'running';
      run.task0 = 'assigned';
      run.task1 = 'assigned';
      for (const w of WORKERS) send(RUN, w, 'Assign', {});
      return { ok: true };
    },
    async workDone(w: string) {
      return finish(w, 'completed');
    },
    async workFailed(w: string) {
      return finish(w, 'failed');
    },
    async cancel() {
      if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}, not running` };
      run.status = 'cancelling';
      if (run.task0 === 'assigned') send(RUN, 'worker0', 'Abort', {});
      if (run.task1 === 'assigned') send(RUN, 'worker1', 'Abort', {});
      return { ok: true };
    },
    async taskTimeout(task: number) {
      if (task !== 0 && task !== 1) return { ok: false, reason: `unknown task ${task}` };
      if (run.status !== 'running' && run.status !== 'cancelling') {
        return { ok: false, reason: `run is ${run.status}` };
      }
      const key = taskKey(task);
      if (run[key] !== 'assigned') return { ok: false, reason: `task ${task} is ${run[key]}` };
      record(key, 'failed');
      send(RUN, WORKERS[task], 'Abort', {});
      return { ok: true };
    },
    async run() {
      return { ...run };
    },
    async worker(w: string) {
      return WORKERS.includes(w) ? { status: workers[w] } : null;
    },
  };
}
