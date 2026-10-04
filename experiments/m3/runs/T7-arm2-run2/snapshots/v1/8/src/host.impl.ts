// The system: one run, two workers, and a network that holds messages until delivered.

import type { CreateHost, Host, Message, Outcome as CommandOutcome, RunView } from '../host.ts';
import {
  RUN_ID,
  WORKER_IDS,
  initialRun,
  initialWorker,
  runCancel,
  runReport,
  runStart,
  workerDone,
  workerFailed,
  workerReceive,
  type Outcome,
  type Outgoing,
  type RunState,
  type WorkerState,
} from './core.ts';

const createHost: CreateHost = async () => {
  let run: RunState = initialRun();
  const workers = new Map<string, WorkerState>(WORKER_IDS.map((id) => [id, initialWorker()]));
  const inFlight = new Map<string, Message>();
  let nextId = 1;

  const send = (from: string, out: Outgoing[]) => {
    for (const m of out) {
      const id = `m${nextId++}`;
      inFlight.set(id, { id, from, to: m.to, action: m.action, data: { ...m.data } });
    }
  };

  const receive = (m: Message) => {
    if (m.to === RUN_ID) {
      if (m.action === 'Report') {
        const r = runReport(run, m.data.task as number, m.data.outcome as Outcome);
        run = r.state;
        send(RUN_ID, r.send);
      }
      return;
    }
    const w = workers.get(m.to);
    if (!w) return;
    const r = workerReceive(w, m.to, m.action);
    workers.set(m.to, r.state);
    send(m.to, r.send);
  };

  const deliver = async (id: string) => {
    const m = inFlight.get(id);
    if (!m) return;
    inFlight.delete(id);
    receive(m);
  };

  const finishWork = (worker: string, step: typeof workerDone): CommandOutcome => {
    const w = workers.get(worker);
    if (!w) return { ok: false, reason: `unknown worker ${worker}` };
    const r = step(w, worker);
    if (!r.ok) return r;
    workers.set(worker, r.state);
    send(worker, r.send);
    return { ok: true };
  };

  const host: Host = {
    async start() {
      const r = runStart(run);
      if (!r.ok) return r;
      run = r.state;
      send(RUN_ID, r.send);
      return { ok: true };
    },
    async cancel() {
      const r = runCancel(run);
      if (!r.ok) return r;
      run = r.state;
      send(RUN_ID, r.send);
      return { ok: true };
    },
    async workDone(worker) {
      return finishWork(worker, workerDone);
    },
    async workFailed(worker) {
      return finishWork(worker, workerFailed);
    },
    async run(): Promise<RunView> {
      return {
        status: run.status,
        task0: run.tasks[0],
        task1: run.tasks[1],
        retried0: run.retried[0],
        retried1: run.retried[1],
      };
    },
    async worker(worker) {
      const w = workers.get(worker);
      return w ? { status: w.status } : null;
    },
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
  };
  return host;
};

export default createHost;
