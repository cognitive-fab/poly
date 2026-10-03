import type { CreateHost, Host, JobView, Outcome } from '../host.ts';

type Status = JobView['status'];

interface Job {
  status: Status;
  tries: number;
  maxTries: number;
}

const ok = (): Outcome => ({ ok: true });
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const jobs = new Map<string, Job>();

  // Ends a try that did not succeed: shared by fail and lost.
  const endTry = (id: string): Outcome => {
    const j = jobs.get(id);
    if (!j) return refuse('unknown job');
    if (j.status === 'cancelling') {
      j.status = 'cancelled';
      return ok();
    }
    if (j.status !== 'running') return refuse(`job is ${j.status}`);
    j.status = j.tries < j.maxTries ? 'queued' : 'failed';
    return ok();
  };

  const host: Host = {
    async submit(id, maxTries) {
      if (typeof id !== 'string') return refuse('job id must be a string');
      if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) {
        return refuse('maxTries must be 1 to 3');
      }
      if (jobs.has(id)) return refuse('job already exists');
      jobs.set(id, { status: 'queued', tries: 0, maxTries });
      return ok();
    },
    async claim(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'queued') return refuse(`job is ${j.status}`);
      if (j.tries >= j.maxTries) return refuse('no tries left');
      j.status = 'running';
      j.tries += 1;
      return ok();
    },
    async succeed(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'running' && j.status !== 'cancelling') return refuse(`job is ${j.status}`);
      j.status = 'succeeded';
      return ok();
    },
    async fail(id) {
      return endTry(id);
    },
    async lost(id) {
      return endTry(id);
    },
    async cancel(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status === 'queued') j.status = 'cancelled';
      else if (j.status === 'running') j.status = 'cancelling';
      else return refuse(`job is ${j.status}`);
      return ok();
    },
    async job(id) {
      const j = jobs.get(id);
      return j ? { status: j.status, tries: j.tries, maxTries: j.maxTries } : null;
    },
  };
  return host;
};

export default createHost;
