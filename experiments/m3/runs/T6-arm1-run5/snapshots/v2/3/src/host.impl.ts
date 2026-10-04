// Jobs with retries and cancellation: an in-memory implementation of the host interface.

export type Outcome = { ok: true } | { ok: false; reason: string };

export type Status = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'held';

export interface JobView {
  status: Status;
  tries: number;
  maxTries: number;
}

export interface Host {
  submit(job: string, maxTries: number): Promise<Outcome>;
  claim(job: string): Promise<Outcome>;
  succeed(job: string): Promise<Outcome>;
  fail(job: string): Promise<Outcome>;
  failPermanently(job: string): Promise<Outcome>;
  lost(job: string): Promise<Outcome>;
  cancel(job: string): Promise<Outcome>;
  hold(job: string): Promise<Outcome>;
  release(job: string): Promise<Outcome>;
  job(job: string): Promise<JobView | null>;
}

interface Job {
  status: Status;
  tries: number;
  maxTries: number;
}

const ok: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

export default async function createHost(): Promise<Host> {
  const jobs = new Map<string, Job>();

  function failTry(id: string, permanent: boolean): Outcome {
    const j = jobs.get(id);
    if (!j) return refuse(`no job ${id}`);
    if (j.status === 'running') {
      j.status = !permanent && j.tries < j.maxTries ? 'queued' : 'failed';
      return ok;
    }
    if (j.status === 'cancelling') {
      j.status = 'cancelled';
      return ok;
    }
    return refuse(`job ${id} is ${j.status}, not running or cancelling`);
  }

  return {
    async submit(id, maxTries) {
      if (typeof id !== 'string') return refuse('job id must be a string');
      if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) {
        return refuse('maxTries must be an integer from 1 to 3');
      }
      if (jobs.has(id)) return refuse(`job ${id} already exists`);
      jobs.set(id, { status: 'queued', tries: 0, maxTries });
      return ok;
    },

    async claim(id) {
      const j = jobs.get(id);
      if (!j) return refuse(`no job ${id}`);
      if (j.status !== 'queued') return refuse(`job ${id} is ${j.status}, not queued`);
      if (j.tries >= j.maxTries) return refuse(`job ${id} has no tries left`);
      j.status = 'running';
      j.tries += 1;
      return ok;
    },

    async succeed(id) {
      const j = jobs.get(id);
      if (!j) return refuse(`no job ${id}`);
      if (j.status !== 'running' && j.status !== 'cancelling') {
        return refuse(`job ${id} is ${j.status}, not running or cancelling`);
      }
      j.status = 'succeeded';
      return ok;
    },

    async fail(id) {
      return failTry(id, false);
    },

    async failPermanently(id) {
      return failTry(id, true);
    },

    async lost(id) {
      return failTry(id, false);
    },

    async cancel(id) {
      const j = jobs.get(id);
      if (!j) return refuse(`no job ${id}`);
      if (j.status === 'queued' || j.status === 'held') {
        j.status = 'cancelled';
        return ok;
      }
      if (j.status === 'running') {
        j.status = 'cancelling';
        return ok;
      }
      return refuse(`job ${id} is ${j.status}, cannot be cancelled`);
    },

    async hold(id) {
      const j = jobs.get(id);
      if (!j) return refuse(`no job ${id}`);
      if (j.status !== 'queued') return refuse(`job ${id} is ${j.status}, not queued`);
      j.status = 'held';
      return ok;
    },

    async release(id) {
      const j = jobs.get(id);
      if (!j) return refuse(`no job ${id}`);
      if (j.status !== 'held') return refuse(`job ${id} is ${j.status}, not held`);
      j.status = 'queued';
      return ok;
    },

    async job(id) {
      const j = jobs.get(id);
      return j ? { status: j.status, tries: j.tries, maxTries: j.maxTries } : null;
    },
  };
}
