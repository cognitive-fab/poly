import type { CreateHost, Host, JobView, Outcome } from '../host.ts';
import * as core from './jobs.ts';
import type { JobRecord, Step } from './jobs.ts';

const createHost: CreateHost = async () => {
  const jobs = new Map<string, JobRecord>();

  const apply = (id: string, step: (job: JobRecord) => Step): Outcome => {
    const job = jobs.get(id);
    if (!job) return { ok: false, reason: 'no such job' };
    const r = step(job);
    if (!r.ok) return { ok: false, reason: r.reason };
    jobs.set(id, r.job);
    return { ok: true };
  };

  const host: Host = {
    async submit(id, maxTries) {
      const r = core.submit(jobs.get(id), maxTries);
      if (!r.ok) return { ok: false, reason: r.reason };
      jobs.set(id, r.job);
      return { ok: true };
    },
    async claim(id) { return apply(id, core.claim); },
    async succeed(id) { return apply(id, core.succeed); },
    async fail(id) { return apply(id, core.fail); },
    async failPermanently(id) { return apply(id, core.failPermanently); },
    async lost(id) { return apply(id, core.fail); },
    async cancel(id) { return apply(id, core.cancel); },
    async hold(id) { return apply(id, core.hold); },
    async release(id) { return apply(id, core.release); },
    async resubmit(id) { return apply(id, core.resubmit); },
    async job(id): Promise<JobView | null> {
      const j = jobs.get(id);
      return j ? { status: j.status, tries: j.tries, maxTries: j.maxTries } : null;
    },
  };
  return host;
};

export default createHost;
