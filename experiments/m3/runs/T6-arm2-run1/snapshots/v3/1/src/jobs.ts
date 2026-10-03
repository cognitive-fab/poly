// The stateful core: a pure transition function over one job's state.
// The host keeps one JobState per id and routes every command through step().
// spec/jobs.spec.cjs mirrors this function as a SAM module for polygraph.

import type { JobView } from '../host.ts';

export type Status = JobView['status'];

export interface JobState {
  status: Status;
  tries: number;
  maxTries: number;
}

export type Command = 'claim' | 'succeed' | 'fail' | 'failPermanently' | 'lost' | 'cancel' | 'hold' | 'release' | 'resubmit';

export type StepResult = { ok: true; next: JobState } | { ok: false; reason: string };

export const MIN_TRIES = 1;
export const MAX_TRIES = 3;

export function create(maxTries: number): StepResult {
  if (!Number.isInteger(maxTries) || maxTries < MIN_TRIES || maxTries > MAX_TRIES) {
    return { ok: false, reason: `maxTries must be an integer from ${MIN_TRIES} to ${MAX_TRIES}` };
  }
  return { ok: true, next: { status: 'queued', tries: 0, maxTries } };
}

/** A worker's try ended without success (fail, lost, or failPermanently when `permanent`). */
function tryEnded(s: JobState, permanent: boolean): StepResult {
  if (s.status === 'running') {
    const status: Status = !permanent && s.tries < s.maxTries ? 'queued' : 'failed';
    return { ok: true, next: { ...s, status } };
  }
  if (s.status === 'cancelling') return { ok: true, next: { ...s, status: 'cancelled' } };
  return { ok: false, reason: `job is ${s.status}, not running or cancelling` };
}

export function step(s: JobState, command: Command): StepResult {
  switch (command) {
    case 'claim':
      if (s.status !== 'queued') return { ok: false, reason: `job is ${s.status}, not queued` };
      if (s.tries >= s.maxTries) return { ok: false, reason: 'no tries left' };
      return { ok: true, next: { ...s, status: 'running', tries: s.tries + 1 } };
    case 'succeed':
      if (s.status === 'running' || s.status === 'cancelling') {
        return { ok: true, next: { ...s, status: 'succeeded' } };
      }
      return { ok: false, reason: `job is ${s.status}, not running or cancelling` };
    case 'fail':
    case 'lost':
      return tryEnded(s, false);
    case 'failPermanently':
      return tryEnded(s, true);
    case 'cancel':
      if (s.status === 'queued' || s.status === 'held') return { ok: true, next: { ...s, status: 'cancelled' } };
      if (s.status === 'running') return { ok: true, next: { ...s, status: 'cancelling' } };
      return { ok: false, reason: `job is ${s.status}, cannot be cancelled` };
    case 'hold':
      if (s.status !== 'queued') return { ok: false, reason: `job is ${s.status}, not queued` };
      return { ok: true, next: { ...s, status: 'held' } };
    case 'release':
      if (s.status !== 'held') return { ok: false, reason: `job is ${s.status}, not held` };
      return { ok: true, next: { ...s, status: 'queued' } };
  }
}
