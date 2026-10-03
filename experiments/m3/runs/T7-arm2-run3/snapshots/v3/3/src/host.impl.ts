import type { CreateHost, Host, Message, Outcome, RunView } from '../host.ts';
import {
  RUN_ID,
  initialRun,
  initialWorker,
  runCancel,
  runOnReport,
  runStart,
  runTaskTimeout,
  taskOf,
  workerDone,
  workerFailed,
  workerOnAbort,
  workerOnAssign,
} from './core.ts';
import type { Outgoing, RunState, WorkerState } from './core.ts';

const createHost: CreateHost = async () => {
  const run: RunState = initialRun();
  const workers: Record<string, WorkerState> = { worker0: initialWorker(), worker1: initialWorker() };
  const inFlight: Message[] = [];
  let nextId = 1;

  const send = (msgs: Outgoing[]) => {
    for (const m of msgs) inFlight.push({ id: `m${nextId++}`, ...m, data: { ...m.data } });
  };

  const outcome = (r: { ok: true; send: Outgoing[] } | { ok: false; reason: string }): Outcome => {
    if (!r.ok) return { ok: false, reason: r.reason };
    send(r.send);
    return { ok: true };
  };

  const handle = (m: Message) => {
    if (m.to === RUN_ID) {
      if (m.action === 'Report') send(runOnReport(run, m.data.task, m.data.outcome, m.data.items));
      return;
    }
    const w = workers[m.to];
    if (!w) return;
    if (m.action === 'Assign') send(workerOnAssign(w));
    else if (m.action === 'Abort') send(workerOnAbort(m.to, w));
  };

  const finish = (worker: string, kind: 'completed' | 'failed'): Outcome => {
    const w = taskOf(worker) === null ? undefined : workers[worker];
    if (!w) return { ok: false, reason: `unknown worker ${worker}` };
    return outcome(workerFinish(worker, w, kind));
  };

  const host: Host = {
    async inFlight() {
      return inFlight.map((m) => ({ ...m, data: { ...m.data } }));
    },
    async deliver(id: string) {
      const i = inFlight.findIndex((m) => m.id === id);
      if (i < 0) return;
      const [m] = inFlight.splice(i, 1);
      handle(m);
    },
    async deliverAll() {
      while (inFlight.length > 0) handle(inFlight.shift()!);
    },
    async start() {
      return outcome(runStart(run));
    },
    async workDone(worker: string) {
      return finish(worker, 'completed');
    },
    async workFailed(worker: string) {
      return finish(worker, 'failed');
    },
    async cancel() {
      return outcome(runCancel(run));
    },
    async taskTimeout(task: number) {
      return outcome(runTaskTimeout(run, task));
    },
    async run(): Promise<RunView> {
      return { status: run.status, task0: run.tasks[0], task1: run.tasks[1], retried0: run.retried[0], retried1: run.retried[1] };
    },
    async worker(worker: string) {
      if (taskOf(worker) === null) return null;
      return { status: workers[worker].status };
    },
  };
  return host;
};

export default createHost;
