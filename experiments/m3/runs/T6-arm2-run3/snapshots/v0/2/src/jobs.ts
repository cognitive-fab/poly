// The stateful core: one pure step function over a single job's record.
// host.impl.ts keeps one record per job id and routes every command through step().

export type Status = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord {
  status: Status;
  tries: number;
  maxTries: number;
}

export type Command = 'submit' | 'claim' | 'succeed' | 'fail' | 'lost' | 'cancel';

export type StepResult = { ok: true; next: JobRecord } | { ok: false; reason: string };

export const MIN_TRIES = 1;
export const MAX_TRIES = 3;

function refuse(reason: string): StepResult {
  return { ok: false, reason };
}

function accept(next: JobRecord): StepResult {
  return { ok: true, next };
}

/** Applies a command to a job; `job` is null when no job has that id. */
export function step(job: JobRecord | null, command: Command, maxTries?: number): StepResult {
  if (command === 'submit') {
    if (job !== null) return refuse('job already exists');
    if (typeof maxTries !== 'number' || !Number.isInteger(maxTries) || maxTries < MIN_TRIES || maxTries > MAX_TRIES) {
      return refuse(`maxTries must be an integer from ${MIN_TRIES} to ${MAX_TRIES}`);
    }
    return accept({ status: 'queued', tries: 0, maxTries });
  }
  if (job === null) return refuse('no such job');

  switch (command) {
    case 'claim':
      if (job.status !== 'queued') return refuse(`cannot claim a ${job.status} job`);
      if (job.tries >= job.maxTries) return refuse('no tries left');
      return accept({ ...job, status: 'running', tries: job.tries + 1 });
    case 'succeed':
      if (job.status !== 'running' && job.status !== 'cancelling') return refuse(`cannot succeed a ${job.status} job`);
      return accept({ ...job, status: 'succeeded' });
    case 'fail':
    case 'lost':
      if (job.status === 'cancelling') return accept({ ...job, status: 'cancelled' });
      if (job.status !== 'running') return refuse(`cannot ${command} a ${job.status} job`);
      return accept({ ...job, status: job.tries < job.maxTries ? 'queued' : 'failed' });
    case 'cancel':
      if (job.status === 'queued') return accept({ ...job, status: 'cancelled' });
      if (job.status === 'running') return accept({ ...job, status: 'cancelling' });
      return refuse(`cannot cancel a ${job.status} job`);
    default:
      return refuse(`unknown command ${String(command)}`);
  }
}
