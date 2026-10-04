// A copy of the host interface of host.ts, so src/ imports nothing outside itself.

export interface Message {
  id: string;
  from: string;
  to: string;
  action: string;
  data: Record<string, unknown>;
}

export interface Network {
  inFlight(): Promise<Message[]>;
  deliver(id: string): Promise<void>;
  deliverAll(): Promise<void>;
}

export type Outcome = { ok: true } | { ok: false; reason: string };

export type TaskStatus = 'idle' | 'assigned' | 'completed' | 'failed' | 'cancelled';

export interface RunView {
  status: 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  task0: TaskStatus;
  task1: TaskStatus;
  retried0: boolean;
  retried1: boolean;
}

export interface Host extends Network {
  start(): Promise<Outcome>;
  workDone(worker: string): Promise<Outcome>;
  workFailed(worker: string): Promise<Outcome>;
  cancel(): Promise<Outcome>;
  taskTimeout(task: number): Promise<Outcome>;
  run(): Promise<RunView>;
  worker(worker: string): Promise<{ status: 'idle' | 'busy' } | null>;
}

export type CreateHost = () => Promise<Host>;
