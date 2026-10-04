import type { CreateHost, Host, Outcome, RunView } from '../host.ts';
import { applyCancel, applyCancelTask, applyPause, applyTaskMove, initialRun } from './core.ts';
import type { RunState, Step, TaskMove } from './core.ts';

const createHost: CreateHost = async () => {
  const runs = new Map<string, RunState>();

  const commit = (run: string, step: (s: RunState) => Step): Outcome => {
    const state = runs.get(run);
    if (state === undefined) return { ok: false, reason: 'no such run' };
    const result = step(state);
    if (!result.ok) return { ok: false, reason: result.reason };
    runs.set(run, result.state);
    return { ok: true };
  };

  const move = (m: TaskMove) => async (run: string, task: number): Promise<Outcome> =>
    commit(run, (s) => applyTaskMove(s, m, task));

  const host: Host = {
    async start(run) {
      if (runs.has(run)) return { ok: false, reason: 'run already exists' };
      runs.set(run, initialRun());
      return { ok: true };
    },
    taskStarted: move('taskStarted'),
    taskCompleted: move('taskCompleted'),
    taskFailed: move('taskFailed'),
    taskEvicted: move('taskEvicted'),
    taskRequeued: move('taskRequeued'),
    taskRetried: move('taskRetried'),
    async cancel(run) {
      return commit(run, applyCancel);
    },
    async cancelTask(run, task) {
      return commit(run, (s) => applyCancelTask(s, task));
    },
    async pause(run) {
      return commit(run, (s) => applyPause(s, true));
    },
    async resume(run) {
      return commit(run, (s) => applyPause(s, false));
    },
    async run(run): Promise<RunView | null> {
      const s = runs.get(run);
      if (s === undefined) return null;
      return { status: s.status, task0: s.tasks[0], task1: s.tasks[1], task2: s.tasks[2], paused: s.paused };
    },
  };
  return host;
};

export default createHost;
