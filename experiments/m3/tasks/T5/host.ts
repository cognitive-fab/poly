// T5, workflow run status: the host interface every arm implements (PT13).

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export type Status = 'queued' | 'running' | 'evicted' | 'completed' | 'failed' | 'cancelled';

export interface RunView {
  status: Status;
  task0: Status;
  task1: Status;
  task2: Status;
}

export interface Host {
  start(run: string): Promise<Outcome>;
  taskStarted(run: string, task: number): Promise<Outcome>;
  taskCompleted(run: string, task: number): Promise<Outcome>;
  taskFailed(run: string, task: number): Promise<Outcome>;
  taskEvicted(run: string, task: number): Promise<Outcome>;
  taskRequeued(run: string, task: number): Promise<Outcome>;
  cancel(run: string): Promise<Outcome>;
  /** The run, or null when no run has that id. */
  run(run: string): Promise<RunView | null>;
}

/** The module's default export: a factory of a fresh system, with no runs. */
export type CreateHost = () => Promise<Host>;
