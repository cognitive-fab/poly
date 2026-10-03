import type { CreateHost, Host, JobView, Outcome } from '../host.ts';

type Status = JobView['status'];

interface Job {
  status: Status;
  tries: number;
  maxTries: number;
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const jobs = new Map<string, Job>();

  // succeed, fail and lost share the same precondition: running or cancelling.
  const finish = (id: string, onRunning: (j: Job) => Status, onCancelling: Status): Outcome => {
    const j = jobs.get(id);
    if (!j) return refuse('unknown job');
    if (j.status === 'running') j.status = onRunning(j);
    else if (j.status === 'cancelling') j.status = onCancelling;
    else return refuse(`job is ${j.status}, not running or cancelling`);
    return ok;
  };

  const failTry = (id: string): Outcome =>
    finish(id, (j) => (j.tries < j.maxTries ? 'queued' : 'failed'), 'cancelled');

  const host: Host = {
    async submit(id, maxTries) {
      if (typeof maxTries !== 'number' || !Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) {
        return refuse('maxTries must be an integer from 1 to 3');
      }
      if (jobs.has(id)) return refuse('job already exists');
      jobs.set(id, { status: 'queued', tries: 0, maxTries });
      return ok;
    },
    async claim(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'queued') return refuse(`job is ${j.status}, not queued`);
      j.status = 'running';
      j.tries += 1;
      return ok;
    },
    async succeed(id) {
      return finish(id, () => 'succeeded', 'succeeded');
    },
    async fail(id) {
      return failTry(id);
    },
    async lost(id) {
      return failTry(id);
    },
    async cancel(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status === 'queued' || j.status === 'held') j.status = 'cancelled';
      else if (j.status === 'running') j.status = 'cancelling';
      else return refuse(`job is ${j.status}, cannot be cancelled`);
      return ok;
    },
    async hold(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'queued') return refuse(`job is ${j.status}, not queued`);
      j.status = 'held';
      return ok;
    },
    async release(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'held') return refuse(`job is ${j.status}, not held`);
      j.status = 'queued';
      return ok;
    },
    async job(id) {
      const j = jobs.get(id);
      return j ? { status: j.status, tries: j.tries, maxTries: j.maxTries } : null;
    },
  };
  return host;
};

export default createHost;
