import type { CreateHost, Host, Outcome, RunView } from '../host.ts';
import { applyCancel, applyCancelTask, applyPaused, applyTaskEvent, initialRun } from './core.ts';
import type { RunState, StepResult, TaskEvent } from './core.ts';

const refuse = (reason: string): Outcome => ({ ok: false, reason });

const createHost: CreateHost = async () => {
  const runs = new Map<string, RunState>();

  const commit = (id: string, step: (run: RunState) => StepResult): Outcome => {
    const run = runs.get(id);
    if (!run) return refuse(`no run ${JSON.stringify(id)}`);
    const result = step(run);
    if (!result.ok) return refuse(result.reason);
    runs.set(id, result.state);
    return { ok: true };
  };

  const report = (event: TaskEvent) => async (id: string, task: number): Promise<Outcome> =>
    commit(id, (run) => applyTaskEvent(run, event, task));

  const host: Host = {
    async start(id) {
      if (runs.has(id)) return refuse(`run ${JSON.stringify(id)} exists`);
      runs.set(id, initialRun());
      return { ok: true };
    },
    taskStarted: report('taskStarted'),
    taskCompleted: report('taskCompleted'),
    taskFailed: report('taskFailed'),
    taskEvicted: report('taskEvicted'),
    taskRequeued: report('taskRequeued'),
    taskRetried: report('taskRetried'),
    async cancel(id) {
      return commit(id, applyCancel);
    },
    async cancelTask(id, task) {
      return commit(id, (run) => applyCancelTask(run, task));
    },
    async pause(id) {
      return commit(id, (run) => applyPaused(run, true));
    },
    async resume(id) {
      return commit(id, (run) => applyPaused(run, false));
    },
    async run(id): Promise<RunView | null> {
      const run = runs.get(id);
      if (!run) return null;
      return { status: run.status, task0: run.tasks[0], task1: run.tasks[1], task2: run.tasks[2], paused: run.paused };
    },
  };
  return host;
};

export default createHost;
