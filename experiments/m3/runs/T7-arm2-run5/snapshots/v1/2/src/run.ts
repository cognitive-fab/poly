// The run: owns the two tasks' statuses and talks to the workers by messages.
import type { RunView, TaskStatus, Outcome } from '../host.ts';

export type Send = (to: string, action: string, data: Record<string, unknown>) => void;

export const RUN_ID = 'run';
export const WORKERS = ['worker0', 'worker1'] as const;

export type RunState = RunView;

export const initialRun = (): RunState => ({ status: 'idle', task0: 'idle', task1: 'idle' });

/** The run's status after a report, from the two task statuses. */
export function settle(status: RunState['status'], t0: TaskStatus, t1: TaskStatus): RunState['status'] {
  const reported = (t: TaskStatus) => t === 'completed' || t === 'failed' || t === 'cancelled';
  if (t0 === 'completed' && t1 === 'completed') return 'completed';
  if (!(reported(t0) && reported(t1))) return status;
  if (t0 === 'failed' || t1 === 'failed') return 'failed';
  return 'cancelled';
}

export class Run {
  state: RunState = initialRun();
  private send: Send;
  constructor(send: Send) {
    this.send = send;
  }

  start(): Outcome {
    if (this.state.status !== 'idle') return { ok: false, reason: 'run already started' };
    this.state = { ...this.state, status: 'running', task0: 'assigned', task1: 'assigned' };
    for (const w of WORKERS) this.send(w, 'Assign', {});
    return { ok: true };
  }

  cancel(): Outcome {
    if (this.state.status !== 'running') return { ok: false, reason: `run is ${this.state.status}, not running` };
    this.state = { ...this.state, status: 'cancelling' };
    if (this.state.task0 === 'assigned') this.send(WORKERS[0], 'Abort', {});
    if (this.state.task1 === 'assigned') this.send(WORKERS[1], 'Abort', {});
    return { ok: true };
  }

  receive(action: string, data: Record<string, unknown>): void {
    if (action !== 'Report') return;
    if (this.state.status !== 'running' && this.state.status !== 'cancelling') return;
    const task = data.task;
    const outcome = data.outcome;
    if (task !== 0 && task !== 1) return;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'cancelled') return;
    const next = { ...this.state };
    if (outcome === 'failed' && next.status === 'running') {
      const retried = task === 0 ? next.retried0 : next.retried1;
      if (!retried) {
        // First failure while running: one more chance; the task stays assigned.
        if (task === 0) next.retried0 = true;
        else next.retried1 = true;
        this.state = next;
        this.send(WORKERS[task], 'Assign', {});
        return;
      }
    }
    if (task === 0) next.task0 = outcome;
    else next.task1 = outcome;
    next.status = settle(next.status, next.task0, next.task1);
    this.state = next;
  }

  view(): RunView {
    return { ...this.state };
  }
}
