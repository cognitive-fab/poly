import type { CreateHost, Host, Outcome, RunView } from '../host.ts';
import { applyCancel, applyTaskEvent, initialRun } from './core.ts';
import type { RunState, StepResult, TaskEvent } from './core.ts';

const createHost: CreateHost = async () => {
  const runs = new Map<string, RunState>();

  function commit(run: string, step: (state: RunState) => StepResult): Outcome {
    const state = runs.get(run);
    if (state === undefined) return { ok: false, reason: `no run ${run}` };
    const result = step(state);
    if (!result.ok) return { ok: false, reason: result.reason };
    runs.set(run, result.state);
    return { ok: true };
  }

  const report = (event: TaskEvent) => async (run: string, task: number): Promise<Outcome> =>
    commit(run, (s) => applyTaskEvent(s, event, task));

  const host: Host = {
    async start(run) {
      if (runs.has(run)) return { ok: false, reason: `run ${run} exists` };
      runs.set(run, initialRun());
      return { ok: true };
    },
    taskStarted: report('started'),
    taskCompleted: report('completed'),
    taskFailed: report('failed'),
    taskEvicted: report('evicted'),
    taskRequeued: report('requeued'),
    taskRetried: report('retried'),
    async cancel(run) {
      return commit(run, applyCancel);
    },
    async cancelTask(run, task) {
      return commit(run, (s) => applyCancelTask(s, task));
    },
    async run(run): Promise<RunView | null> {
      const state = runs.get(run);
      if (state === undefined) return null;
      const [task0, task1, task2] = state.tasks;
      return { status: state.status, task0, task1, task2 };
    },
  };
  return host;
};

export default createHost;
