// A worker: does one task, and reports its outcome to the run by message.
import type { Outcome } from '../host.ts';
import { RUN_ID, type Send } from './run.ts';

export type WorkerStatus = 'idle' | 'busy';

export class Worker {
  status: WorkerStatus = 'idle';
  readonly id: string;
  readonly task: number;
  private send: Send;
  constructor(id: string, task: number, send: Send) {
    this.id = id;
    this.task = task;
    this.send = send;
  }

  private finish(outcome: 'completed' | 'failed' | 'cancelled', items = 0): void {
    this.status = 'idle';
    this.send(RUN_ID, 'Report', { task: this.task, outcome, items });
  }

  workDone(items: number): Outcome {
    if (items !== 1 && items !== 2) return { ok: false, reason: `items must be 1 or 2, got ${items}` };
    if (this.status !== 'busy') return { ok: false, reason: `${this.id} is not busy` };
    this.finish('completed', items);
    return { ok: true };
  }

  workFailed(): Outcome {
    if (this.status !== 'busy') return { ok: false, reason: `${this.id} is not busy` };
    this.finish('failed');
    return { ok: true };
  }

  receive(action: string): void {
    if (action === 'Assign') {
      if (this.status === 'idle') this.status = 'busy';
    } else if (action === 'Abort') {
      if (this.status === 'busy') this.finish('cancelled');
    }
  }
}
