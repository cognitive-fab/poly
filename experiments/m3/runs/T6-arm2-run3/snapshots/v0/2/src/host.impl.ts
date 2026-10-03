import type { CreateHost, Host, JobView, Outcome } from '../host.ts';
import { step } from './jobs.ts';
import type { Command, JobRecord } from './jobs.ts';

/** Observes every command, accepted or refused, after it settles. */
export type StepListener = (event: {
  job: string;
  command: Command;
  maxTries?: number;
  pre: JobRecord | null;
  post: JobRecord | null;
  outcome: Outcome;
}) => void;

export function createSystem(listener: StepListener = () => {}): Host {
  const jobs = new Map<string, JobRecord>();

  function run(job: string, command: Command, maxTries?: number): Outcome {
    const pre = jobs.get(job) ?? null;
    const result = step(pre, command, maxTries);
    let outcome: Outcome;
    if (result.ok) {
      jobs.set(job, result.next);
      outcome = { ok: true };
    } else {
      outcome = { ok: false, reason: result.reason };
    }
    const post = jobs.get(job) ?? null;
    listener({ job, command, maxTries, pre: pre && { ...pre }, post: post && { ...post }, outcome });
    return outcome;
  }

  return {
    async submit(job, maxTries) { return run(job, 'submit', maxTries); },
    async claim(job) { return run(job, 'claim'); },
    async succeed(job) { return run(job, 'succeed'); },
    async fail(job) { return run(job, 'fail'); },
    async lost(job) { return run(job, 'lost'); },
    async cancel(job) { return run(job, 'cancel'); },
    async job(job): Promise<JobView | null> {
      const record = jobs.get(job);
      return record ? { status: record.status, tries: record.tries, maxTries: record.maxTries } : null;
    },
  };
}

const createHost: CreateHost = async () => createSystem();

export default createHost;
