import type { CreateHost, Host, JobView, Outcome } from '../host.ts';
import * as core from './jobs.ts';
import type { JobState, Step } from './jobs.ts';

const createHost: CreateHost = async () => {
  const jobs = new Map<string, JobState>();

  const apply = (id: string, step: (job: JobState) => Step): Outcome => {
    const job = jobs.get(id);
    if (!job) return { ok: false, reason: `no job ${id}` };
    const result = step(job);
    if (!result.ok) return { ok: false, reason: result.reason };
    jobs.set(id, result.job);
    return { ok: true };
  };

  const host: Host = {
    async submit(id, maxTries) {
      if (jobs.has(id)) return { ok: false, reason: `job ${id} exists` };
      const result = core.submit(maxTries);
      if (!result.ok) return { ok: false, reason: result.reason };
      jobs.set(id, result.job);
      return { ok: true };
    },
    async claim(id) { return apply(id, core.claim); },
    async succeed(id) { return apply(id, core.succeed); },
    async fail(id) { return apply(id, core.fail); },
    async lost(id) { return apply(id, core.fail); },
    async cancel(id) { return apply(id, core.cancel); },
    async job(id): Promise<JobView | null> {
      const job = jobs.get(id);
      return job ? { ...job } : null;
    },
  };
  return host;
};

export default createHost;
