// The stateful core: one job's transitions, as pure functions.
// A refused command returns a reason and leaves the job unchanged.

export type Status = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'held';

export interface JobState {
  status: Status;
  tries: number;
  maxTries: number;
}

export type Step = { ok: true; job: JobState } | { ok: false; reason: string };

const refuse = (reason: string): Step => ({ ok: false, reason });
const accept = (job: JobState): Step => ({ ok: true, job });

export function submit(maxTries: number): Step {
  if (!Number.isInteger(maxTries) || maxTries < 1 || maxTries > 3) {
    return refuse('maxTries must be an integer from 1 to 3');
  }
  return accept({ status: 'queued', tries: 0, maxTries });
}

export function claim(job: JobState): Step {
  if (job.status !== 'queued') return refuse(`cannot claim a ${job.status} job`);
  if (job.tries >= job.maxTries) return refuse('no tries left');
  return accept({ ...job, status: 'running', tries: job.tries + 1 });
}

export function succeed(job: JobState): Step {
  if (job.status !== 'running' && job.status !== 'cancelling') {
    return refuse(`cannot succeed a ${job.status} job`);
  }
  return accept({ ...job, status: 'succeeded' });
}

export function fail(job: JobState): Step {
  if (job.status === 'cancelling') return accept({ ...job, status: 'cancelled' });
  if (job.status !== 'running') return refuse(`cannot fail a ${job.status} job`);
  return accept({ ...job, status: job.tries < job.maxTries ? 'queued' : 'failed' });
}

export function cancel(job: JobState): Step {
  if (job.status === 'queued') return accept({ ...job, status: 'cancelled' });
  if (job.status === 'running') return accept({ ...job, status: 'cancelling' });
  return refuse(`cannot cancel a ${job.status} job`);
}
