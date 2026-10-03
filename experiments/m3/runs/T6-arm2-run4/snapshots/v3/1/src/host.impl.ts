import type { CreateHost, Host, JobView, Outcome } from '../host.ts';

type Status = JobView['status'];
interface Job { status: Status; tries: number; maxTries: number }

const ok = (): Outcome => ({ ok: true });
const no = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const jobs = new Map<string, Job>();

  // A failed or lost try: retry if tries remain, else fail; a cancelling job is cancelled.
  // A permanent failure never retries.
  const endTry = (id: string, permanent: boolean): Outcome => {
    const j = jobs.get(id);
    if (!j) return no('unknown job');
    if (j.status === 'cancelling') { j.status = 'cancelled'; return ok(); }
    if (j.status !== 'running') return no(`job is ${j.status}`);
    j.status = !permanent && j.tries < j.maxTries ? 'queued' : 'failed';
    return ok();
  };

  const host: Host = {
    async submit(id, maxTries) {
      if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) return no('maxTries must be 1 to 3');
      if (jobs.has(id)) return no('job exists');
      jobs.set(id, { status: 'queued', tries: 0, maxTries });
      return ok();
    },
    async claim(id) {
      const j = jobs.get(id);
      if (!j) return no('unknown job');
      if (j.status !== 'queued') return no(`job is ${j.status}`);
      if (j.tries >= j.maxTries) return no('no tries left');
      j.status = 'running';
      j.tries += 1;
      return ok();
    },
    async succeed(id) {
      const j = jobs.get(id);
      if (!j) return no('unknown job');
      if (j.status !== 'running' && j.status !== 'cancelling') return no(`job is ${j.status}`);
      j.status = 'succeeded';
      return ok();
    },
    async fail(id) { return endTry(id, false); },
    async failPermanently(id) { return endTry(id, true); },
    async lost(id) { return endTry(id, false); },
    async cancel(id) {
      const j = jobs.get(id);
      if (!j) return no('unknown job');
      if (j.status === 'queued' || j.status === 'held') j.status = 'cancelled';
      else if (j.status === 'running') j.status = 'cancelling';
      else return no(`job is ${j.status}`);
      return ok();
    },
    async hold(id) {
      const j = jobs.get(id);
      if (!j) return no('unknown job');
      if (j.status !== 'queued') return no(`job is ${j.status}`);
      j.status = 'held';
      return ok();
    },
    async release(id) {
      const j = jobs.get(id);
      if (!j) return no('unknown job');
      if (j.status !== 'held') return no(`job is ${j.status}`);
      j.status = 'queued';
      return ok();
    },
    async resubmit(id) {
      const j = jobs.get(id);
      if (!j) return no('unknown job');
      if (j.status !== 'failed') return no(`job is ${j.status}`);
      j.status = 'queued';
      j.tries = 0;
      return ok();
    },
    async job(id) {
      const j = jobs.get(id);
      return j ? { ...j } : null;
    },
  };
  return host;
};

export default createHost;
