// The system: one run, two workers, and the network between them.
import type { CreateHost, Host, Message } from '../host.ts';
import { Run, RUN_ID } from './run.ts';
import { Worker } from './worker.ts';

const createHost: CreateHost = async () => {
  const inFlight = new Map<string, Message>();
  let seq = 0;
  const send = (from: string) => (to: string, action: string, data: Record<string, unknown>) => {
    const id = `m${++seq}`;
    inFlight.set(id, { id, from, to, action, data: { ...data } });
  };

  const run = new Run(send(RUN_ID));
  const workers = new Map<string, Worker>([
    ['worker0', new Worker('worker0', 0, send('worker0'))],
    ['worker1', new Worker('worker1', 1, send('worker1'))],
  ]);

  const deliverOne = (id: string) => {
    const m = inFlight.get(id);
    if (!m) return;
    inFlight.delete(id);
    if (m.to === RUN_ID) run.receive(m.action, m.data);
    else workers.get(m.to)?.receive(m.action);
  };

  const copy = (m: Message): Message => ({ ...m, data: { ...m.data } });

  const host: Host = {
    async inFlight() {
      return [...inFlight.values()].map(copy);
    },
    async deliver(id: string) {
      deliverOne(id);
    },
    async deliverAll() {
      while (inFlight.size > 0) deliverOne(inFlight.keys().next().value as string);
    },
    async start() {
      return run.start();
    },
    async cancel() {
      return run.cancel();
    },
    async workDone(worker: string) {
      const w = workers.get(worker);
      return w ? w.workDone() : { ok: false, reason: `unknown worker ${worker}` };
    },
    async workFailed(worker: string) {
      const w = workers.get(worker);
      return w ? w.workFailed() : { ok: false, reason: `unknown worker ${worker}` };
    },
    async run() {
      return run.view();
    },
    async worker(worker: string) {
      const w = workers.get(worker);
      return w ? { status: w.status } : null;
    },
  };
  return host;
};

export default createHost;
