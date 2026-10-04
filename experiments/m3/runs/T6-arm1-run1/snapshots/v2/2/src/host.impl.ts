import type { CreateHost, Host, JobView, Outcome } from '../host.ts';

const OK: Outcome = { ok: true };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const jobs = new Map<string, JobView>();

  // A try ended without the work being done (fail or lost).
  // A permanent failure leaves no retry, whatever tries are left.
  function endTry(id: string, permanent: boolean): Outcome {
    const j = jobs.get(id);
    if (!j) return refuse('unknown job');
    if (j.status === 'running') {
      j.status = !permanent && j.tries < j.maxTries ? 'queued' : 'failed';
      return OK;
    }
    if (j.status === 'cancelling') {
      j.status = 'cancelled';
      return OK;
    }
    return refuse(`job is ${j.status}`);
  }

  const host: Host = {
    async submit(id, maxTries) {
      if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) {
        return refuse('maxTries must be an integer from 1 to 3');
      }
      if (jobs.has(id)) return refuse('job already exists');
      jobs.set(id, { status: 'queued', tries: 0, maxTries });
      return OK;
    },
    async claim(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'queued') return refuse(`job is ${j.status}`);
      if (j.tries >= j.maxTries) return refuse('no tries left');
      j.status = 'running';
      j.tries += 1;
      return OK;
    },
    async succeed(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'running' && j.status !== 'cancelling') return refuse(`job is ${j.status}`);
      j.status = 'succeeded';
      return OK;
    },
    async fail(id) {
      return endTry(id, false);
    },
    async failPermanently(id) {
      return endTry(id, true);
    },
    async lost(id) {
      return endTry(id, false);
    },
    async cancel(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status === 'queued' || j.status === 'held') j.status = 'cancelled';
      else if (j.status === 'running') j.status = 'cancelling';
      else return refuse(`job is ${j.status}`);
      return OK;
    },
    async hold(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'queued') return refuse(`job is ${j.status}`);
      j.status = 'held';
      return OK;
    },
    async release(id) {
      const j = jobs.get(id);
      if (!j) return refuse('unknown job');
      if (j.status !== 'held') return refuse(`job is ${j.status}`);
      j.status = 'queued';
      return OK;
    },
    async job(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },
  };
  return host;
};

export default createHost;
