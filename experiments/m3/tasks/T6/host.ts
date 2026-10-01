// T6, jobs with retries and cancellation: the host interface every arm implements (PT13).

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export interface JobView {
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  tries: number;
  maxTries: number;
}

export interface Host {
  submit(job: string, maxTries: number): Promise<Outcome>;
  claim(job: string): Promise<Outcome>;
  succeed(job: string): Promise<Outcome>;
  fail(job: string): Promise<Outcome>;
  lost(job: string): Promise<Outcome>;
  cancel(job: string): Promise<Outcome>;
  /** The job, or null when no job has that id. */
  job(job: string): Promise<JobView | null>;
}

/** The module's default export: a factory of a fresh system, with no jobs. */
export type CreateHost = () => Promise<Host>;
