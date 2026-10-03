import type { CreateHost, Host, JobView, Outcome } from '../host.ts';
import { create, step } from './jobs.ts';
import type { Command, JobState, StepResult } from './jobs.ts';

const createHost: CreateHost = async () => {
  const jobs = new Map<string, JobState>();

  const commit = (job: string, r: StepResult): Outcome => {
    if (!r.ok) return { ok: false, reason: r.reason };
    jobs.set(job, r.next);
    return { ok: true };
  };

  const run = async (job: string, command: Command): Promise<Outcome> => {
    const s = jobs.get(job);
    if (!s) return { ok: false, reason: `no job ${JSON.stringify(job)}` };
    return commit(job, step(s, command));
  };

  const host: Host = {
    async submit(job, maxTries) {
      if (jobs.has(job)) return { ok: false, reason: `job ${JSON.stringify(job)} already exists` };
      return commit(job, create(maxTries));
    },
    claim: (job) => run(job, 'claim'),
    succeed: (job) => run(job, 'succeed'),
    fail: (job) => run(job, 'fail'),
    failPermanently: (job) => run(job, 'failPermanently'),
    lost: (job) => run(job, 'lost'),
    cancel: (job) => run(job, 'cancel'),
    hold: (job) => run(job, 'hold'),
    release: (job) => run(job, 'release'),
    resubmit: (job) => run(job, 'resubmit'),
    async job(job): Promise<JobView | null> {
      const s = jobs.get(job);
      return s ? { status: s.status, tries: s.tries, maxTries: s.maxTries } : null;
    },
  };
  return host;
};

export default createHost;
