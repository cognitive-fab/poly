// T7, a run and its workers: the host interface every arm implements (PT13, S91).

/** A message sent by one part of the system to another, not yet delivered. */
export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

/** The network: nothing is delivered until deliver or deliverAll is called. */
export interface Network {
  /** Every message in transit, in no promised order. */
  inFlight(): Promise<Message[]>;
  /** Deliver one message in transit, by its id. */
  deliver(id: string): Promise<void>;
  /** Deliver every message in transit, and every message those deliveries send, until none is left. */
  deliverAll(): Promise<void>;
}

/** The outcome of a command: it took effect, or it was refused and changed nothing. */
export type Outcome = { ok: true } | { ok: false; reason: string };

export type TaskStatus = 'idle' | 'assigned' | 'completed' | 'failed' | 'cancelled';

export interface RunView {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  task0: TaskStatus;
  task1: TaskStatus;
}

export interface Host extends Network {
  start(): Promise<Outcome>;
  workDone(worker: string): Promise<Outcome>;
  workFailed(worker: string): Promise<Outcome>;
  cancel(): Promise<Outcome>;
  run(): Promise<RunView>;
  /** The worker "worker0" or "worker1", or null for any other id. */
  worker(worker: string): Promise<{ status: 'idle' | 'busy' } | null>;
}

/** The module's default export: a factory of a fresh system, with the run and its two workers. */
export type CreateHost = () => Promise<Host>;
