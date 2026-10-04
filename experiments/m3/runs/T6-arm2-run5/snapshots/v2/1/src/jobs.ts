// The stateful core: a pure transition function over one job's record.
// host.impl.ts keeps a map of these; spec/jobs.spec.cjs models the same steps.

export type Status = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'held';

export interface JobRecord {
  status: Status;
  tries: number;
  maxTries: number;
}

export type Step = { ok: true; job: JobRecord } | { ok: false; reason: string };

const refuse = (reason: string): Step => ({ ok: false, reason });
const to = (job: JobRecord, patch: Partial<JobRecord>): Step => ({ ok: true, job: { ...job, ...patch } });

export function submit(existing: JobRecord | undefined, maxTries: number): Step {
  if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) return refuse('maxTries must be 1 to 3');
  if (existing) return refuse('job already exists');
  return { ok: true, job: { status: 'queued', tries: 0, maxTries } };
}

export function claim(job: JobRecord): Step {
  if (job.status !== 'queued') return refuse(`cannot claim a ${job.status} job`);
  if (job.tries >= job.maxTries) return refuse('no tries left');
  return to(job, { status: 'running', tries: job.tries + 1 });
}

export function succeed(job: JobRecord): Step {
  if (job.status !== 'running' && job.status !== 'cancelling') return refuse(`cannot succeed a ${job.status} job`);
  return to(job, { status: 'succeeded' });
}

export function fail(job: JobRecord): Step {
  if (job.status === 'cancelling') return to(job, { status: 'cancelled' });
  if (job.status !== 'running') return refuse(`cannot fail a ${job.status} job`);
  return to(job, { status: job.tries < job.maxTries ? 'queued' : 'failed' });
}

export function failPermanently(job: JobRecord): Step {
  if (job.status === 'cancelling') return to(job, { status: 'cancelled' });
  if (job.status !== 'running') return refuse(`cannot fail a ${job.status} job`);
  return to(job, { status: 'failed' });
}

export function hold(job: JobRecord): Step {
  if (job.status !== 'queued') return refuse(`cannot hold a ${job.status} job`);
  return to(job, { status: 'held' });
}

export function release(job: JobRecord): Step {
  if (job.status !== 'held') return refuse(`cannot release a ${job.status} job`);
  return to(job, { status: 'queued' });
}

export function cancel(job: JobRecord): Step {
  if (job.status === 'queued' || job.status === 'held') return to(job, { status: 'cancelled' });
  if (job.status === 'running') return to(job, { status: 'cancelling' });
  return refuse(`cannot cancel a ${job.status} job`);
}
